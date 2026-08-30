"""Market-wide scan: orchestrates the macro/sector/strategist workflow.

The counterpart to ``TradingAgentsGraph``, for the question that comes before
a ticker exists. Produces a regime call, a sector view, and a shortlist of
names worth analysing in depth; it makes no position call and writes nothing
to the decision log — a shortlist is not a decision.
"""

import logging
import os
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from langgraph.prebuilt import ToolNode

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
from tradingagents.dataflows.config import set_config
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.llm_clients import create_llm_client
from tradingagents.reporting import write_market_report_tree

from .market_setup import MarketGraphSetup
from .trading_graph import build_provider_kwargs

logger = logging.getLogger(__name__)


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
        if trade_date is None:
            trade_date = datetime.now().strftime("%Y-%m-%d")
        datetime.strptime(trade_date, "%Y-%m-%d")  # validate, fail loudly

        initial_state = {
            "messages": [("human", f"Scan the market as of {trade_date}.")],
            "trade_date": str(trade_date),
            "requested_sectors": list(sectors or []),
            "candidate_limit": int(candidate_limit),
            "macro_report": "",
            "sector_report": "",
            "market_scan_report": "",
        }

        graph_config = {"recursion_limit": self.config.get("max_recur_limit", 100)}
        if self.callbacks:
            graph_config["callbacks"] = self.callbacks

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
