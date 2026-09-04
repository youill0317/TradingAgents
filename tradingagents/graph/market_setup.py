"""Graph wiring for the market-wide scan workflow.

Deliberately a separate graph from ``setup.py``. The per-ticker workflow's
state is built around ``company_of_interest``; a scan has no ticker until it
produces one, so bending ``AgentState`` to fit would have meant threading a
placeholder company through every existing node. A parallel five-node graph is
both smaller and leaves the per-ticker path untouched.
"""

from typing import Annotated, Any

from langchain_core.messages import ToolMessage
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
MAX_AGENT_TOOL_ROUNDS = 8


class MarketState(MessagesState):
    """State for the market scan. No ticker — that is the output, not the input."""

    trade_date: Annotated[str, "Date the scan is run for"]
    as_of_utc: Annotated[str, "Timezone-aware retrieval cutoff"]
    effective_market_session: Annotated[str, "US market session represented"]
    scan_mode: Annotated[str, "live or historical point-in-time contract"]
    run_id: Annotated[str, "Unique scan run identifier"]
    config_hash: Annotated[str, "Hash of effective run configuration"]
    code_commit: Annotated[str, "Git commit used for the run"]
    quick_model: Annotated[str, "Model used for analyst calls"]
    deep_model: Annotated[str, "Model used for strategist synthesis"]
    macro_tool_rounds: Annotated[int, "Macro analyst invocation count"]
    sector_tool_rounds: Annotated[int, "Sector analyst invocation count"]

    # Run parameters, set at propagation time.
    requested_sectors: Annotated[list, "Sectors to restrict screening to; empty = analyst's choice"]
    candidate_limit: Annotated[int, "Maximum number of shortlist candidates"]

    # Reports, filled in order.
    macro_report: Annotated[str, "Report from the Macro Analyst"]
    sector_report: Annotated[str, "Report from the Sector Analyst"]
    screen_evidence: Annotated[str, "Raw equity-screener tool results"]
    macro_evidence: Annotated[str, "Raw macro-indicator tool results"]
    data_warnings: Annotated[list[str], "Machine-readable upstream data failures"]
    market_scan_report: Annotated[str, "Final synthesis from the Market Strategist"]
    scan_status: Annotated[str, "COMPLETE, DEGRADED, or INCOMPLETE"]
    scan_warnings: Annotated[list[str], "Machine-readable validation warnings"]


def should_continue_macro(state: MarketState) -> str:
    """Loop the Macro Analyst back through its tools until it stops calling them."""
    if (
        state["messages"][-1].tool_calls
        and state.get("macro_tool_rounds", 0) < MAX_AGENT_TOOL_ROUNDS
    ):
        return "tools_macro"
    return "Capture Macro Evidence"


def _tool_messages(state: MarketState, name: str) -> list[ToolMessage]:
    return [
        message
        for message in state.get("messages", [])
        if isinstance(message, ToolMessage) and message.name == name
    ]


def capture_macro_evidence(state: MarketState) -> dict:
    """Turn optional vendor failure strings into explicit graph state."""
    macro = _tool_messages(state, "get_macro_indicators")
    warnings = []
    if not macro:
        warnings.append("MACRO_DATA_NOT_COLLECTED")
    elif any(
        marker in str(message.content)
        for message in macro
        for marker in ("DATA_UNAVAILABLE", "NO_DATA_AVAILABLE")
    ):
        warnings.append("MACRO_DATA_UNAVAILABLE")
    if (
        state.get("macro_tool_rounds", 0) >= MAX_AGENT_TOOL_ROUNDS
        and getattr(state["messages"][-1], "tool_calls", None)
    ):
        warnings.append("MACRO_TOOL_BUDGET_EXHAUSTED")
    return {
        "macro_evidence": "\n\n".join(str(message.content) for message in macro),
        "data_warnings": warnings,
    }


def should_continue_sector(state: MarketState) -> str:
    """Loop the Sector Analyst back through its tools until it stops calling them."""
    if (
        state["messages"][-1].tool_calls
        and state.get("sector_tool_rounds", 0) < MAX_AGENT_TOOL_ROUNDS
    ):
        return "tools_sector"
    return "Capture Screen Evidence"


def capture_screen_evidence(state: MarketState) -> dict:
    """Preserve raw screener output before the shared message-clear node runs."""
    evidence = []
    for message in _tool_messages(state, "screen_equities"):
        content = str(message.content)
        if "NO_DATA_AVAILABLE" not in content and "DATA_UNAVAILABLE" not in content:
            evidence.append(content)
    warnings = list(state.get("data_warnings", []))
    if state.get("scan_mode") != "historical" and not evidence:
        warnings.append("SCREEN_EVIDENCE_MISSING")
    if (
        state.get("sector_tool_rounds", 0) >= MAX_AGENT_TOOL_ROUNDS
        and getattr(state["messages"][-1], "tool_calls", None)
    ):
        warnings.append("SECTOR_TOOL_BUDGET_EXHAUSTED")
    return {
        "screen_evidence": "\n\n".join(evidence),
        "data_warnings": warnings,
    }


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
        workflow.add_node("Capture Macro Evidence", capture_macro_evidence)
        workflow.add_node("Msg Clear Macro", create_msg_delete(SCAN_CONTEXT))

        workflow.add_node("Sector Analyst", create_sector_analyst(self.quick_thinking_llm))
        workflow.add_node("tools_sector", self.tool_nodes["sector"])
        workflow.add_node("Capture Screen Evidence", capture_screen_evidence)
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
            ["tools_macro", "Capture Macro Evidence"],
        )
        workflow.add_edge("tools_macro", "Macro Analyst")
        workflow.add_edge("Capture Macro Evidence", "Msg Clear Macro")
        workflow.add_edge("Msg Clear Macro", "Sector Analyst")

        workflow.add_conditional_edges(
            "Sector Analyst",
            should_continue_sector,
            ["tools_sector", "Capture Screen Evidence"],
        )
        workflow.add_edge("tools_sector", "Sector Analyst")
        workflow.add_edge("Capture Screen Evidence", "Msg Clear Sector")
        workflow.add_edge("Msg Clear Sector", "Market Strategist")

        workflow.add_edge("Market Strategist", END)

        return workflow
