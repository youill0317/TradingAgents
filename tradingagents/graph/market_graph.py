"""Market-wide scan: orchestrates the macro/sector/strategist workflow.

The counterpart to ``TradingAgentsGraph``, for the question that comes before
a ticker exists. Produces a regime call, a sector view, and a shortlist of
names worth analysing in depth; it makes no position call and writes nothing
to the decision log — a shortlist is not a decision.
"""

import hashlib
import json
import os
import subprocess
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from langgraph.prebuilt import ToolNode

from tradingagents.agents.schemas import ScanMode
from tradingagents.agents.utils.agent_utils import (
    get_global_news,
    get_macro_indicators,
    get_prediction_markets,
    get_stock_data,
)
from tradingagents.agents.utils.market_scan_tools import (
    get_sector_performance,
    screen_equities,
)
from tradingagents.dataflows.config import config_context, set_config
from tradingagents.dataflows.global_context import collect_global_context
from tradingagents.dataflows.global_market import collect_global_snapshot
from tradingagents.dataflows.interface import route_to_vendor
from tradingagents.dataflows.market_scan import resolve_sectors
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.llm_clients import create_llm_client
from tradingagents.reporting import write_market_report_tree

from .market_setup import MarketGraphSetup
from .trading_graph import build_provider_kwargs


class MarketAnalysisGraph:
    """Runs the market scan workflow."""

    def __init__(
        self,
        debug: bool = False,
        config: dict[str, Any] = None,
        callbacks: list | None = None,
    ):
        """Initialize the market scan graph.

        Args:
            debug: Whether to pretty-print intermediate messages while streaming
            config: Configuration dictionary. If None, uses default config
            callbacks: Optional callback handlers (e.g. for token/tool stats)
        """
        self.debug = debug
        self.config = config or DEFAULT_CONFIG
        self.callbacks = callbacks or []

        set_config(self.config)
        os.makedirs(self.config["data_cache_dir"], exist_ok=True)
        os.makedirs(self.config["results_dir"], exist_ok=True)

        llm_kwargs = build_provider_kwargs(self.config)
        if self.callbacks:
            llm_kwargs["callbacks"] = self.callbacks

        deep_client = create_llm_client(
            provider=self.config["llm_provider"],
            model=self.config["deep_think_llm"],
            base_url=self.config.get("backend_url"),
            **llm_kwargs,
        )
        quick_client = create_llm_client(
            provider=self.config["llm_provider"],
            model=self.config["quick_think_llm"],
            base_url=self.config.get("backend_url"),
            **llm_kwargs,
        )
        self.deep_thinking_llm = deep_client.get_llm()
        self.quick_thinking_llm = quick_client.get_llm()

        self.tool_nodes = self._create_tool_nodes()
        self.graph_setup = MarketGraphSetup(
            self.quick_thinking_llm, self.deep_thinking_llm, self.tool_nodes
        )
        self.workflow = self.graph_setup.setup_graph()
        self.graph = self.workflow.compile()

        self.curr_state = None

    def _create_tool_nodes(self) -> dict[str, ToolNode]:
        """Tool nodes for the two scan analysts.

        The macro tools are the same objects the per-ticker News Analyst binds;
        only the prompt around them differs.
        """
        return {
            "macro": ToolNode(
                [
                    get_macro_indicators,
                    get_global_news,
                    get_prediction_markets,
                ]
            ),
            "sector": ToolNode(
                [
                    get_sector_performance,
                    screen_equities,
                    get_stock_data,
                ]
            ),
        }

    def scan(
        self,
        trade_date: str | None = None,
        sectors: list[str] | None = None,
        candidate_limit: int = 10,
        on_chunk: Callable[[dict], None] | None = None,
    ) -> dict:
        """Run the market scan and return the final state.

        Args:
            trade_date: Date to scan for (yyyy-mm-dd). Defaults to today.
            sectors: Sectors to restrict screening to; None lets the analyst choose.
            candidate_limit: Maximum shortlist size.
            on_chunk: Optional callback invoked for each streamed graph state.

        Returns:
            The final graph state, including ``market_scan_report``.
        """
        market_today = datetime.now(ZoneInfo("America/New_York")).date()
        if trade_date is None:
            trade_date = market_today.isoformat()
        parsed_date = datetime.strptime(trade_date, "%Y-%m-%d").date()
        if parsed_date != market_today:
            raise ValueError("Market scans support only today's New York date; past/future dates are unsupported")
        if not 1 <= int(candidate_limit) <= 25:
            raise ValueError("candidate_limit must be between 1 and 25")

        scan_mode = ScanMode.LIVE
        as_of_utc = datetime.now(timezone.utc).isoformat()
        run_id = uuid4().hex
        config_hash = hashlib.sha256(
            json.dumps(self.config, sort_keys=True, default=str).encode()
        ).hexdigest()
        try:
            code_commit = subprocess.check_output(
                ["git", "-C", self.config["project_dir"], "rev-parse", "HEAD"],
                text=True,
                timeout=2,
            ).strip()
        except (OSError, subprocess.SubprocessError):
            code_commit = "unknown"

        initial_state = {
            "messages": [("human", f"Scan the market as of {trade_date}.")],
            "trade_date": str(trade_date),
            "as_of_utc": as_of_utc,
            "effective_market_session": None,
            "scan_mode": scan_mode.value,
            "run_id": run_id,
            "config_hash": config_hash,
            "code_commit": code_commit,
            "quick_model": self.config.get("quick_think_llm"),
            "deep_model": self.config.get("deep_think_llm"),
            "macro_tool_rounds": 0,
            "sector_tool_rounds": 0,
            "requested_sectors": resolve_sectors(sectors) if sectors else [],
            "candidate_limit": int(candidate_limit),
            "macro_report": "",
            "sector_report": "",
            "screen_evidence": "",
            "macro_evidence": "",
            "data_warnings": [],
            "market_scan_report": "",
            "scan_status": "",
            "scan_warnings": [],
            "global_snapshot": "",
            "global_context": "",
            "global_evidence": [],
            "sector_evidence": "",
        }

        graph_config = {"recursion_limit": self.config.get("max_recur_limit", 100)}
        if self.callbacks:
            graph_config["callbacks"] = self.callbacks

        # A live scan always collects fresh inputs, never an old checkpoint.
        with config_context({**self.config, "market_scan_date": str(trade_date),
                             "market_scan_as_of": as_of_utc}):
            snapshot = collect_global_snapshot(str(trade_date))
            context = collect_global_context(str(trade_date))
            initial_state.update(
                global_snapshot=snapshot["report"],
                global_context=context["report"],
                global_evidence=[*snapshot["evidence"], *context["evidence"]],
                data_warnings=[*snapshot["warnings"], *context["warnings"]],
                effective_market_session=snapshot.get("effective_market_session"),
            )
            try:
                initial_state["sector_evidence"] = str(route_to_vendor(
                    "get_sector_performance", str(trade_date)
                ))
            except Exception:
                initial_state["sector_evidence"] = "DATA_UNAVAILABLE: sector collection failed"
            if self.debug or on_chunk is not None:
                final_state = None
                for chunk in self.graph.stream(
                    initial_state, stream_mode="values", config=graph_config
                ):
                    if self.debug and chunk.get("messages"):
                        chunk["messages"][-1].pretty_print()
                    if on_chunk is not None:
                        on_chunk(chunk)
                    final_state = chunk
            else:
                final_state = self.graph.invoke(initial_state, config=graph_config)

        self.curr_state = final_state
        return final_state

    def save_reports(self, final_state: dict, save_path=None) -> Path:
        """Write the scan's markdown report tree; return the complete-report path."""
        if save_path is None:
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            save_path = (
                Path(self.config["results_dir"]) / "market_scans" / stamp
            )
        return write_market_report_tree(final_state, save_path)
