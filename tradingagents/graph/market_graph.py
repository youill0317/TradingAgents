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

from tradingagents.agents.managers.market_strategist import _required_evidence_warnings
from tradingagents.agents.schemas import (
    MarketScanReport,
    ScanMode,
    ScanStatus,
    render_market_scan_report,
)
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
from tradingagents.dataflows.market_diagnostics import collect_market_diagnostics
from tradingagents.dataflows.market_events import collect_market_events
from tradingagents.dataflows.market_scan import resolve_sectors
from tradingagents.dataflows.public_data import collect_public_data
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.llm_clients import create_llm_client
from tradingagents.reporting import write_market_report_tree

from .checkpointer import get_checkpointer, thread_id
from .market_setup import MARKET_STAGES, MarketGraphSetup
from .trading_graph import build_provider_kwargs


def validate_market_credentials():
    if not os.getenv("FRED_API_KEY", "").strip():
        raise ValueError("FRED_API_KEY is required for market analysis. Configure it before starting; no LLM calls were made.")


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
        on_progress: Callable[[str], None] | None = None,
        resume: bool = False,
    ) -> dict:
        """Run the market scan and return the final state.

        Args:
            trade_date: Date to scan for (yyyy-mm-dd). Defaults to today.
            sectors: Sectors to restrict screening to; None lets the analyst choose.
            candidate_limit: Maximum shortlist size.
            on_chunk: Optional callback invoked for each streamed graph state.
            on_progress: Collection and resume status callback.
            resume: Continue an interrupted scan with the same date, code and settings.

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

        validate_market_credentials()
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
            "market_review_enabled": True,
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

        # Checkpoint identity includes the working diff so local edits cannot resume
        # a different graph under the same commit.
        working_diff = subprocess.check_output(
            ["git", "-C", self.config["project_dir"], "diff", "HEAD", "--", ":/tradingagents", ":/cli"],
            timeout=2,
        ) if code_commit != "unknown" else b""
        signature = hashlib.sha256(json.dumps([
            config_hash, code_commit, hashlib.sha256(working_diff).hexdigest(),
            initial_state["requested_sectors"], int(candidate_limit),
        ]).encode()).hexdigest()
        tid = thread_id("MARKET-SCAN", trade_date, signature)
        graph_config["configurable"] = {"thread_id": tid}
        with get_checkpointer(self.config["data_cache_dir"], "MARKET-SCAN") as saver:
            graph = self.workflow.compile(checkpointer=saver)
            saved = graph.get_state(graph_config)
            if resume:
                if not saved.values or not saved.next:
                    raise ValueError("No interrupted market scan matches today's date, code and settings. Start a fresh scan without --resume.")
                initial_state = dict(saved.values)
                as_of_utc = initial_state["as_of_utc"]
                if on_progress:
                    on_progress(f"Resuming snapshot collected at {as_of_utc}")
                if on_chunk:
                    on_chunk(initial_state)
            else:
                saver.delete_thread(tid)
            with config_context({**self.config, "market_scan_date": str(trade_date),
                                 "market_scan_as_of": as_of_utc}):
                if not resume:
                    if on_progress:
                        on_progress("Collecting global prices and FRED indicators")
                    snapshot = collect_global_snapshot(str(trade_date))
                    if on_progress:
                        on_progress("Collecting news and community context")
                    context = collect_global_context(str(trade_date))
                    initial_state.update(
                        global_snapshot=snapshot["report"],
                        global_context=context["report"],
                        global_evidence=[*snapshot["evidence"], *context["evidence"]],
                        data_warnings=[*snapshot["warnings"], *context["warnings"]],
                        effective_market_session=snapshot.get("effective_market_session"),
                    )
                    if self.config.get("public_data_sources") and on_progress:
                        on_progress("Collecting official US, global and Korean public data")
                    public = collect_public_data(str(trade_date), self.config)
                    initial_state.update(public_data_report=public["report"],
                                         public_data_evidence=public["evidence"])
                    initial_state["global_evidence"].extend(public["evidence"])
                    initial_state["data_warnings"].extend(public["warnings"])
                    if on_progress:
                        on_progress("Computing market participation and sector trends")
                    diagnostics = collect_market_diagnostics(str(trade_date))
                    if on_progress:
                        on_progress("Collecting economic events")
                    events = collect_market_events(str(trade_date))
                    initial_state.update(
                        market_diagnostics=diagnostics["report"],
                        market_diagnostics_data=diagnostics["data"],
                        event_calendar=events["report"],
                        event_calendar_data=events["data"],
                        sector_evidence=diagnostics["sector_report"],
                        global_evidence=[*initial_state["global_evidence"], *diagnostics["evidence"], *events["evidence"]],
                        data_warnings=[*initial_state["data_warnings"], *diagnostics["warnings"], *events["warnings"]],
                    )
                    missing = _required_evidence_warnings(initial_state)
                    if missing:
                        report = MarketScanReport(
                            status=ScanStatus.INCOMPLETE,
                            warnings=[*initial_state["data_warnings"], *missing],
                            regime="Range-Bound", regime_evidence="Analysis not started: required data unavailable.",
                            sector_view="No LLM analysis or candidate selection was performed.", candidates=[],
                        )
                        initial_state.update(market_scan_report=render_market_scan_report(report),
                                             market_scan_result=report.model_dump(mode="json"),
                                             scan_status=report.status.value, scan_warnings=report.warnings)
                        self.curr_state = initial_state
                        if on_chunk:
                            on_chunk(initial_state)
                        return initial_state
                if on_progress:
                    on_progress("Analysis")
                if self.debug or on_chunk is not None:
                    final_state = initial_state
                    for chunk in graph.stream(None if resume else initial_state, stream_mode="values", config=graph_config):
                        if self.debug and chunk.get("messages"):
                            chunk["messages"][-1].pretty_print()
                        if on_chunk is not None:
                            on_chunk(chunk)
                        final_state = chunk
                else:
                    final_state = graph.invoke(None if resume else initial_state, config=graph_config)
                # A handled LLM failure also needs a retry point, not just an exception.
                warnings = final_state.get("scan_warnings", [])
                retry = next((i for i, (_, field) in enumerate(MARKET_STAGES[2:], 2)
                              if not final_state.get(field)), None)
                if "MARKET_DRAFT_UNAVAILABLE" in warnings:
                    retry = min(retry if retry is not None else 6, 6)
                if retry is None and any(w in warnings for w in (
                    "STRUCTURED_OUTPUT_INVALID", "MARKET_REVIEW_RESOLUTION_MISSING",
                )):
                    retry = 8
                if retry is not None:
                    reset = {field: "" for _, field in MARKET_STAGES[retry:]}
                    reset.update(scan_status="", scan_warnings=[], market_scan_result={},
                                 data_warnings=[w for w in final_state.get("data_warnings", [])
                                                if not w.startswith("MARKET_REVIEW_UNAVAILABLE:")])
                    if retry <= 7:
                        reset["market_risk_findings"] = []
                    if retry <= 6:
                        reset["market_draft_result"] = {}
                    predecessor = "Msg Clear Sector" if retry == 2 else MARKET_STAGES[retry - 1][0]
                    graph.update_state(graph_config, reset, as_node=predecessor)
                    if on_progress:
                        on_progress("Incomplete LLM output saved for retry with --resume")
                else:
                    saver.delete_thread(tid)

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
