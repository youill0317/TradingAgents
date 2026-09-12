"""Graph wiring for market analysis, bounded debate, and risk review."""

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
from tradingagents.agents.market_review import create_market_review

# The per-ticker placeholder anchors on the instrument under analysis; a scan has
# no instrument, so it anchors on the task instead. A bare "Continue" is not an
# option here for the same reason as #888.
SCAN_CONTEXT = (
    "This is a market-wide scan: there is no single ticker under analysis. "
    "Your subject is the market itself."
)
MAX_AGENT_TOOL_ROUNDS = 8
MARKET_STAGES = (
    ("Macro Analyst", "macro_report"), ("Sector Analyst", "sector_report"),
    ("Market Bull Case", "market_bull_case"), ("Market Bear Case", "market_bear_case"),
    ("Market Bull Rebuttal", "market_bull_rebuttal"), ("Market Bear Rebuttal", "market_bear_rebuttal"),
    ("Market Draft", "market_draft_report"), ("Market Risk Review", "market_risk_review"),
    ("Market Strategist", "market_scan_report"),
)


class MarketState(MessagesState):
    """State for the market scan. No ticker — that is the output, not the input."""

    market_review_enabled: bool
    market_bull_case: str
    market_bear_case: str
    market_bull_rebuttal: str
    market_bear_rebuttal: str
    market_draft_report: str
    market_draft_result: dict
    market_risk_review: str
    market_risk_findings: list[dict]
    trade_date: Annotated[str, "Date the scan is run for"]
    as_of_utc: Annotated[str, "Timezone-aware retrieval cutoff"]
    effective_market_session: Annotated[str, "US market session represented"]
    scan_mode: Annotated[str, "live or historical point-in-time contract"]
    run_id: Annotated[str, "Unique scan run identifier"]
    config_hash: Annotated[str, "Hash of effective run configuration"]
    code_commit: Annotated[str, "Git commit used for the run"]
    quick_model: Annotated[str, "Model used for analyst calls"]
    deep_model: Annotated[str, "Model used for strategist synthesis"]
    market_diagnostics: Annotated[str, "Computed participation and transition report"]
    market_diagnostics_data: Annotated[dict, "Structured market metrics and observation dates"]
    event_calendar: Annotated[str, "Upcoming releases and observed surprises"]
    event_calendar_data: Annotated[dict, "Structured event records with source and time precision"]
    global_snapshot: Annotated[str, "Collected regional macro and cross-asset observations"]
    global_context: Annotated[str, "Collected global news and optional social context"]
    global_evidence: Annotated[list[dict], "Per-source collection outcomes and provenance"]
    public_data_report: Annotated[str, "Collected official public data report"]
    public_data_evidence: Annotated[list[dict], "Public-data collection outcomes and provenance"]
    sector_evidence: Annotated[str, "Raw US sector performance collected before analysis"]
    market_scan_result: Annotated[dict, "Validated final structured result"]
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
    warnings = list(state.get("data_warnings", []))
    if not macro and not state.get("global_snapshot"):
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
    warnings = list(state.get("data_warnings", []))
    for message in _tool_messages(state, "screen_equities"):
        content = str(message.content)
        if (
            "## Equity screen" in content
            and "NO_DATA_AVAILABLE" not in content and "DATA_UNAVAILABLE" not in content
        ):
            evidence.append(content)
            if "Screen failed:" in content:
                warnings.append("SCREEN_PARTIAL_FAILURE")
        else:
            warnings.append("SCREEN_PARTIAL_FAILURE")
    sector_data = [state.get("sector_evidence", ""), *[
        str(m.content) for m in _tool_messages(state, "get_sector_performance")
    ]]
    usable = [s for s in sector_data if "## Sector performance" in s]
    # Prefer the latest successful observation, including a tool retry. The
    # same table must drive validation, prompts and persisted evidence.
    sector_evidence = usable[-1] if usable else state.get("sector_evidence", "")
    warnings = [w for w in warnings if w not in {"SECTOR_DATA_UNAVAILABLE", "SECTOR_DATA_PARTIAL"}]
    if not usable:
        warnings.append("SECTOR_DATA_UNAVAILABLE")
    elif "n/a" in sector_evidence:
        warnings.append("SECTOR_DATA_PARTIAL")
    if state.get("scan_mode") != "historical" and not evidence:
        warnings.append("SCREEN_EVIDENCE_MISSING")
    if (
        state.get("sector_tool_rounds", 0) >= MAX_AGENT_TOOL_ROUNDS
        and getattr(state["messages"][-1], "tool_calls", None)
    ):
        warnings.append("SECTOR_TOOL_BUDGET_EXHAUSTED")
    return {
        "sector_evidence": sector_evidence,
        "screen_evidence": "\n\n".join(evidence),
        "data_warnings": list(dict.fromkeys(warnings)),
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
        """Wire analysis, two-sided cases/rebuttals, draft, audit and revision."""
        workflow = StateGraph(MarketState)

        workflow.add_node("Macro Analyst", create_macro_analyst(self.quick_thinking_llm))
        workflow.add_node("tools_macro", self.tool_nodes["macro"])
        workflow.add_node("Capture Macro Evidence", capture_macro_evidence)
        workflow.add_node("Msg Clear Macro", create_msg_delete(SCAN_CONTEXT))

        workflow.add_node("Sector Analyst", create_sector_analyst(self.quick_thinking_llm))
        workflow.add_node("tools_sector", self.tool_nodes["sector"])
        workflow.add_node("Capture Screen Evidence", capture_screen_evidence)
        workflow.add_node("Msg Clear Sector", create_msg_delete(SCAN_CONTEXT))

        review_nodes = (
            ("Market Bull Case", "market_bull_case"),
            ("Market Bear Case", "market_bear_case"),
            ("Market Bull Rebuttal", "market_bull_rebuttal"),
            ("Market Bear Rebuttal", "market_bear_rebuttal"),
        )
        for name, field in review_nodes:
            workflow.add_node(name, create_market_review(self.quick_thinking_llm, field))
        workflow.add_node("Market Draft", create_market_strategist(self.deep_thinking_llm, stage="draft"))
        workflow.add_node("Market Risk Review", create_market_review(self.deep_thinking_llm, "market_risk_review"))

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
        chain = ["Msg Clear Sector", *[name for name, _ in review_nodes],
                 "Market Draft", "Market Risk Review", "Market Strategist"]
        for source, target in zip(chain, chain[1:], strict=False):
            workflow.add_edge(source, target)

        workflow.add_edge("Market Strategist", END)

        return workflow
