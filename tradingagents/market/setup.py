"""The market workflow's graph, wired like the ticker workflow's ``GraphSetup``.

The analysts run side by side, each in a graph of its own, with the Memory Log
step beside them; then the bull/bear debate, the research manager, the sector
strategist, the three-way risk debate and the final call. The upstream
``ConditionalLogic`` decides when each debate ends.
"""

import logging
from collections import Counter
from typing import Any, TypedDict

from langchain_core.messages import HumanMessage
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode

from tradingagents.agents.analysts.turn import WRAP_UP
from tradingagents.graph.conditional_logic import ConditionalLogic
from tradingagents.market.agents import (
    create_chief_market_strategist,
    create_market_aggressive_debator,
    create_market_bear_researcher,
    create_market_bull_researcher,
    create_market_conservative_debator,
    create_market_neutral_debator,
    create_market_research_manager,
    create_sector_strategist,
)
from tradingagents.market.analysts import ANALYST_SPECS, create_market_analyst
from tradingagents.market.state import MarketAgentState

logger = logging.getLogger(__name__)

ANALYST_ORDER = tuple(ANALYST_SPECS)

# ConditionalLogic returns the ticker workflow's node names; each maps to its
# market counterpart, every target mapped so no return can miss (#1088).
DEBATE_PATH_MAP = {
    "Bull Researcher": "Market Bull Researcher",
    "Bear Researcher": "Market Bear Researcher",
    "Research Manager": "Market Research Manager",
}
RISK_ANALYSIS_PATH_MAP = {
    "Aggressive Analyst": "Aggressive Analyst",
    "Conservative Analyst": "Conservative Analyst",
    "Neutral Analyst": "Neutral Analyst",
    "Portfolio Manager": "Chief Market Strategist",
}


def selected_specs(selected_analysts):
    specs = []
    for key in selected_analysts:
        if key not in ANALYST_SPECS:
            raise ValueError(f"unknown market analyst key: {key}")
        specs.append(ANALYST_SPECS[key])
    if not specs:
        raise ValueError("at least one market analyst must be selected")
    return specs


def _tools_or_done(state) -> str:
    return "tools" if state["messages"][-1].tool_calls else END


def _analyst_graph(spec, agent, max_tool_rounds: int):
    """One analyst on a private message history, as in the ticker workflow.

    It returns only its report, and after ``max_tool_rounds`` rounds of tool
    calls it is told to write it; that turn ends it whatever it answers.
    """
    output = TypedDict(f"{spec.key.capitalize()}MarketReport", {spec.report_key: str})
    graph = StateGraph(MarketAgentState, output_schema=output)
    graph.add_node("agent", agent)
    graph.add_edge(START, "agent")
    if not spec.tools:   # takes its sources up front, like the ticker Sentiment Analyst
        graph.add_edge("agent", END)
        return graph.compile()

    def rounds(messages) -> int:
        return sum(1 for m in messages if getattr(m, "tool_calls", None))

    def more_or_wrap_up(state) -> str:
        return "wrap_up" if rounds(state["messages"]) >= max_tool_rounds else "agent"

    def wrap_up(state):
        calls = Counter(c["name"] for m in state["messages"] for c in (getattr(m, "tool_calls", None) or []))
        logger.warning("%s used its %d tool rounds (%s); asking for its report", spec.agent_node,
                       max_tool_rounds, ", ".join(f"{n} x{c}" for n, c in calls.most_common()))
        return agent({**state, "messages": [*state["messages"], HumanMessage(WRAP_UP)]})

    graph.add_node("tools", ToolNode(list(spec.tools)))
    graph.add_node("wrap_up", wrap_up)
    graph.add_conditional_edges("agent", _tools_or_done, ["tools", END])
    graph.add_conditional_edges("tools", more_or_wrap_up, ["agent", "wrap_up"])
    graph.add_edge("wrap_up", END)
    return graph.compile()


class MarketGraphSetup:
    def __init__(self, quick_thinking_llm: Any, deep_thinking_llm: Any,
                 conditional_logic: ConditionalLogic, max_tool_rounds: int):
        self.quick_thinking_llm = quick_thinking_llm
        self.deep_thinking_llm = deep_thinking_llm
        self.conditional_logic = conditional_logic
        self.max_tool_rounds = max_tool_rounds

    def setup_graph(self, selected_analysts=ANALYST_ORDER, memory_node=None):
        quick, deep = self.quick_thinking_llm, self.deep_thinking_llm
        workflow = StateGraph(MarketAgentState)

        specs = selected_specs(selected_analysts)
        for spec in specs:
            workflow.add_node(spec.agent_node,
                              _analyst_graph(spec, create_market_analyst(spec, quick), self.max_tool_rounds))

        workflow.add_node("Market Bull Researcher", create_market_bull_researcher(quick))
        workflow.add_node("Market Bear Researcher", create_market_bear_researcher(quick))
        workflow.add_node("Market Research Manager", create_market_research_manager(deep))
        workflow.add_node("Sector Strategist", create_sector_strategist(quick))
        workflow.add_node("Aggressive Analyst", create_market_aggressive_debator(quick))
        workflow.add_node("Conservative Analyst", create_market_conservative_debator(quick))
        workflow.add_node("Neutral Analyst", create_market_neutral_debator(quick))
        workflow.add_node("Chief Market Strategist", create_chief_market_strategist(deep))

        first_steps = [spec.agent_node for spec in specs]
        if memory_node is not None:
            workflow.add_node("Memory Log", memory_node)
            first_steps.append("Memory Log")
        for node in first_steps:
            workflow.add_edge(START, node)
        workflow.add_edge(first_steps, "Market Bull Researcher")

        for node in ("Market Bull Researcher", "Market Bear Researcher"):
            workflow.add_conditional_edges(node, self.conditional_logic.should_continue_debate, DEBATE_PATH_MAP)
        workflow.add_edge("Market Research Manager", "Sector Strategist")
        workflow.add_edge("Sector Strategist", "Aggressive Analyst")
        for node in ("Aggressive Analyst", "Conservative Analyst", "Neutral Analyst"):
            workflow.add_conditional_edges(
                node, self.conditional_logic.should_continue_risk_analysis, RISK_ANALYSIS_PATH_MAP)
        workflow.add_edge("Chief Market Strategist", END)
        return workflow
