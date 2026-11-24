"""MarketAnalysisGraph: the ticker workflow's ``TradingAgentsGraph``, for the market as a whole.

It is a subclass, so a market run is dated, checkpointed, streamed, settled and
recorded by the same code as a ticker run; only what is analysed differs. The
run's subject is ``MARKET`` wherever the ticker workflow keys on a ticker
(checkpoints, state logs).
"""

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from tradingagents.agents.rating import RATING_REVIEW
from tradingagents.agents.state import InvestDebateState, RiskDebateState
from tradingagents.dataflows.config import run_config, set_config
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph.conditional_logic import ConditionalLogic
from tradingagents.graph.propagation import Propagator
from tradingagents.graph.trading_graph import TradingAgentsGraph, _validate_trade_date
from tradingagents.llm_clients import create_tier_client
from tradingagents.market.memory import (
    MarketReflector,
    market_memory_log,
    past_market_context,
    verdict_entries,
)
from tradingagents.market.reporting import write_market_report_tree
from tradingagents.market.schemas import SECTORS
from tradingagents.market.setup import ANALYST_ORDER, MarketGraphSetup

logger = logging.getLogger(__name__)

SUBJECT = "MARKET"
ASSET_TYPE = "market"


class MarketAnalysisGraph(TradingAgentsGraph):
    """Runs the market workflow: analysts, debate, strategist, risk debate, final call."""

    def __init__(self, selected_analysts=ANALYST_ORDER, debug=False,
                 config: dict[str, Any] | None = None, callbacks: list | None = None):
        self.debug = debug
        self.config = config or DEFAULT_CONFIG
        self.callbacks = callbacks or []
        set_config(self.config)
        os.makedirs(self.config["data_cache_dir"], exist_ok=True)
        os.makedirs(self.config["results_dir"], exist_ok=True)

        extra = {"callbacks": self.callbacks} if self.callbacks else {}
        self.deep_thinking_llm = create_tier_client(self.config, "deep", **extra).get_llm()
        self.quick_thinking_llm = create_tier_client(self.config, "quick", **extra).get_llm()

        self.memory_log = market_memory_log(self.config)
        self.reflector = MarketReflector(self.quick_thinking_llm)
        self.conditional_logic = ConditionalLogic(
            max_debate_rounds=self.config["max_debate_rounds"],
            max_risk_discuss_rounds=self.config["max_risk_discuss_rounds"],
        )
        max_tool_rounds, max_recur_limit = self.config["max_tool_rounds"], self.config["max_recur_limit"]
        if 2 * max_tool_rounds + 2 >= max_recur_limit:
            raise ValueError(
                f"max_tool_rounds={max_tool_rounds} needs max_recur_limit above {2 * max_tool_rounds + 2}")
        self.graph_setup = MarketGraphSetup(
            self.quick_thinking_llm, self.deep_thinking_llm, self.conditional_logic, max_tool_rounds)
        self.propagator = Propagator(max_recur_limit=max_recur_limit)
        self.selected_analysts = tuple(selected_analysts)
        self.workflow = self.graph_setup.setup_graph(self.selected_analysts, memory_node=self._memory_step)
        self.graph = self.workflow.compile()
        self._checkpointer_ctx = None
        self._resuming = False

    # --- A run ---------------------------------------------------------------

    def propagate(self, trade_date):
        """Analyse the market as of ``trade_date``; return ``(final_state, call)``.

        ``call`` holds the final ``regime`` and each sector's rating, ``REVIEW``
        wherever the final decision gave none it could be read from.
        """
        trade_date = _validate_trade_date(trade_date)
        with run_config(self.config), self.checkpoint_scope(SUBJECT, trade_date, ASSET_TYPE) as tid:
            init_state = self.create_run_state(trade_date)
            args = self.propagator.get_graph_args()
            if tid is not None:
                args.setdefault("config", {}).setdefault("configurable", {})["thread_id"] = tid
            graph_input = self.checkpoint_input(init_state)
            if self.debug:
                final_state = {}
                for _messages, state in self.stream_run(graph_input, **args):
                    if state is not None:
                        final_state.update(state)
            else:
                final_state = self.graph.invoke(graph_input, **args)
            self.record_decision(trade_date, final_state)
            self.clear_checkpoint_on_success(SUBJECT, trade_date, ASSET_TYPE)
        return final_state, market_call(final_state)

    def create_run_state(self, trade_date, *_args, **_kwargs):
        trade_date = _validate_trade_date(trade_date)
        return {
            "messages": [("human", f"Analyse the market as of {trade_date}.")],
            "trade_date": str(trade_date),
            "past_context": "",
            "memory_note": "",
            "investment_debate_state": InvestDebateState(
                bull_history="", bear_history="", history="", current_response="", count=0),
            "risk_debate_state": RiskDebateState(
                aggressive_history="", conservative_history="", neutral_history="", history="",
                latest_speaker="", current_aggressive_response="", current_conservative_response="",
                current_neutral_response="", count=0),
            "macro_report": "", "global_report": "", "news_report": "", "sector_report": "",
        }

    def _memory_step(self, state):
        """Settle past market calls whose holding window has traded, then load their lessons."""
        note = ""
        try:
            done = self.settle_all_pending(wait=False)
            if done.failed:
                note = f"{len(done.failed)} past sector verdict(s) could not be settled this run and stay pending."
        except Exception as exc:
            logger.warning("Settling past market calls failed: %s", exc)
            note = f"Past market calls could not be settled this run ({type(exc).__name__}); they stay pending."
        try:
            past_context = past_market_context(self.memory_log, self._memory_as_of(state["trade_date"]))
        except Exception as exc:
            logger.warning("Reading the market memory log failed: %s", exc)
            past_context = ""
            note = note or f"The market memory log could not be read this run ({type(exc).__name__})."
        return {"past_context": past_context, "memory_note": note}

    def record_decision(self, trade_date, final_state, *_args):
        """Record a finished run: its state log, and each sector verdict in the market memory log."""
        self._log_state(trade_date, final_state)
        entries = verdict_entries(final_state)
        if not entries:
            logger.warning("No readable sector verdict for %s; nothing added to the market memory log", trade_date)
        for etf, rating, text in entries:
            self.memory_log.store_decision(ticker=etf, trade_date=trade_date,
                                           final_trade_decision=text, rating=rating)

    def run_settings(self) -> dict:
        return {**super().run_settings(), "workflow": "market"}

    def _log_state(self, trade_date, final_state):
        keys = ("trade_date", "macro_report", "global_report", "news_report", "sector_report",
                "market_plan", "sector_proposal", "final_market_decision")
        entry = {key: final_state.get(key, "") for key in keys}
        entry["investment_debate_state"] = {k: (final_state.get("investment_debate_state") or {}).get(k, "")
                                            for k in ("bull_history", "bear_history", "history", "current_response")}
        entry["risk_debate_state"] = {k: (final_state.get("risk_debate_state") or {}).get(k, "")
                                      for k in ("aggressive_history", "conservative_history",
                                                "neutral_history", "history")}
        entry.update(market_call(final_state))
        entry["run_settings"] = self.run_settings()
        directory = Path(self.config["results_dir"]) / SUBJECT / "MarketAnalysis_logs"
        directory.mkdir(parents=True, exist_ok=True)
        with open(directory / f"full_states_log_{trade_date}.json", "w", encoding="utf-8") as f:
            json.dump(entry, f, indent=4, ensure_ascii=False)

    # --- Reports ---------------------------------------------------------------

    def save_reports(self, final_state, save_path=None, html=True) -> Path:
        if save_path is None:
            save_path = self.default_report_path()
        return write_market_report_tree(final_state, save_path, settings=self.run_settings(), html=html)

    def default_report_path(self, *_args) -> Path:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        return Path(self.config["results_dir"]) / "reports" / f"{SUBJECT}_{stamp}"


def market_call(final_state: dict) -> dict:
    """The run's regime and sector ratings, ``REVIEW`` where there is none."""
    ratings = final_state.get("final_sector_ratings") or {}
    return {
        "regime": final_state.get("final_regime") or RATING_REVIEW,
        "sector_ratings": {name: ratings.get(name, RATING_REVIEW) for name in SECTORS},
    }
