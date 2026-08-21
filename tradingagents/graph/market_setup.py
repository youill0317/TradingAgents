"""Graph wiring for the market-wide scan workflow.

Deliberately a separate graph from ``setup.py``. The per-ticker workflow's
state is built around ``company_of_interest``; a scan has no ticker until it
produces one, so bending ``AgentState`` to fit would have meant threading a
placeholder company through every existing node. A parallel five-node graph is
both smaller and leaves the per-ticker path untouched.
"""

from typing import Annotated, Any

from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

from tradingagents.agents import (
    create_macro_analyst,
    create_market_strategist,
    create_msg_delete,
    create_sector_analyst,
)

# The per-ticker placeholder anchors on the instrument under analysis; a scan has
# no instrument, so it anchors on the task instead. A bare "Continue" is not an
# option here for the same reason as #888.
SCAN_CONTEXT = (
    "This is a market-wide scan: there is no single ticker under analysis. "
    "Your subject is the market itself."
)


class MarketState(MessagesState):
    """State for the market scan. No ticker — that is the output, not the input."""

    trade_date: Annotated[str, "Date the scan is run for"]

    # Run parameters, set at propagation time.
    requested_sectors: Annotated[list, "Sectors to restrict screening to; empty = analyst's choice"]
    candidate_limit: Annotated[int, "Maximum number of shortlist candidates"]

    # Reports, filled in order.
    macro_report: Annotated[str, "Report from the Macro Analyst"]
    sector_report: Annotated[str, "Report from the Sector Analyst"]
    market_scan_report: Annotated[str, "Final synthesis from the Market Strategist"]


def should_continue_macro(state: MarketState) -> str:
    """Loop the Macro Analyst back through its tools until it stops calling them."""
    if state["messages"][-1].tool_calls:
        return "tools_macro"
    return "Msg Clear Macro"


def should_continue_sector(state: MarketState) -> str:
    """Loop the Sector Analyst back through its tools until it stops calling them."""
    if state["messages"][-1].tool_calls:
        return "tools_sector"
    return "Msg Clear Sector"


class MarketGraphSetup:
    """Builds the market scan workflow."""

    def __init__(
        self,
        quick_thinking_llm: Any,
        deep_thinking_llm: Any,
        tool_nodes: dict[str, ToolNode],
    ):
        self.quick_thinking_llm = quick_thinking_llm
        self.deep_thinking_llm = deep_thinking_llm
        self.tool_nodes = tool_nodes

    def setup_graph(self) -> StateGraph:
        """Wire Macro Analyst -> Sector Analyst -> Market Strategist."""
        workflow = StateGraph(MarketState)

        workflow.add_node("Macro Analyst", create_macro_analyst(self.quick_thinking_llm))
        workflow.add_node("tools_macro", self.tool_nodes["macro"])
        workflow.add_node("Msg Clear Macro", create_msg_delete(SCAN_CONTEXT))

        workflow.add_node("Sector Analyst", create_sector_analyst(self.quick_thinking_llm))
        workflow.add_node("tools_sector", self.tool_nodes["sector"])
        workflow.add_node("Msg Clear Sector", create_msg_delete(SCAN_CONTEXT))

        # The strategist gets the deep model: it is the one call that has to hold
        # both reports at once and commit to a shortlist.
        workflow.add_node(
            "Market Strategist", create_market_strategist(self.deep_thinking_llm)
        )

        workflow.add_edge(START, "Macro Analyst")
        workflow.add_conditional_edges(
            "Macro Analyst",
            should_continue_macro,
            ["tools_macro", "Msg Clear Macro"],
        )
        workflow.add_edge("tools_macro", "Macro Analyst")
        workflow.add_edge("Msg Clear Macro", "Sector Analyst")

        workflow.add_conditional_edges(
            "Sector Analyst",
            should_continue_sector,
            ["tools_sector", "Msg Clear Sector"],
        )
        workflow.add_edge("tools_sector", "Sector Analyst")
        workflow.add_edge("Msg Clear Sector", "Market Strategist")

        workflow.add_edge("Market Strategist", END)

        return workflow
