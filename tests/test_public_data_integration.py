"""Public data crosses graph, prompt, resume, and report boundaries."""

import json

from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableLambda
from langgraph.graph import END, START, StateGraph

import tradingagents.graph.trading_graph as trading_graph
from tradingagents.agents.analysts.fundamentals_analyst import create_fundamentals_analyst
from tradingagents.agents.analysts.news_analyst import create_news_analyst
from tradingagents.agents.researchers.bull_researcher import create_bull_researcher
from tradingagents.agents.risk_mgmt.aggressive_debator import create_aggressive_debator
from tradingagents.agents.utils.agent_states import AgentState
from tradingagents.dataflows.public_data import render_public_data
from tradingagents.dataflows.public_data_common import evidence
from tradingagents.graph.propagation import Propagator
from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.reporting import write_report_tree


class _PromptRecorder:
    def __init__(self):
        self.prompts = []

    def bind_tools(self, _tools):
        def answer(prompt):
            self.prompts.append(str(prompt))
            return AIMessage(content="grounded report")

        return RunnableLambda(answer)


def test_ticker_public_data_reaches_real_state_graph_prompts_export_and_resume(monkeypatch, tmp_path):
    public_evidence = [
        evidence("sec", "AAPL", "SEC_DATA", "https://sec.example"),
        evidence("fsc", "AAPL", "FSC_DATA", "https://fsc.example"),
        evidence("nyfed", "rates", "NYFED_RATE", "https://nyfed.example"),
        evidence("kosis", "semiconductors", "KOSIS_SEMICONDUCTOR", "https://kosis.example"),
    ]
    public_report = render_public_data(public_evidence)
    collections = []

    def collect(*args, **kwargs):
        collections.append((args, kwargs))
        return {"report": public_report, "evidence": public_evidence, "warnings": []}

    monkeypatch.setattr(trading_graph, "collect_public_data", collect)
    monkeypatch.setattr(trading_graph, "resolve_instrument_identity", lambda ticker: {
        "sector": "Technology", "industry": "Semiconductors",
    })
    graph = object.__new__(TradingAgentsGraph)
    graph.config = {"public_data_sources": "sec"}
    graph._resuming = False
    initial = Propagator().create_initial_state("AAPL", "2026-09-12")
    prepared = graph.prepare_graph_input(initial)

    llm = _PromptRecorder()
    workflow = StateGraph(AgentState)
    workflow.add_node("news", create_news_analyst(llm))
    workflow.add_node("fundamentals", create_fundamentals_analyst(llm))
    workflow.add_edge(START, "news")
    workflow.add_edge("news", "fundamentals")
    workflow.add_edge("fundamentals", END)
    state = workflow.compile().invoke(prepared)

    assert state["public_data_report"] == public_report
    assert state["public_data_evidence"] == public_evidence
    assert len(llm.prompts) == 2 and all("SEC_DATA" in prompt for prompt in llm.prompts)
    assert "NYFED_RATE" in llm.prompts[0] and "FSC_DATA" not in llm.prompts[0] and "KOSIS_SEMICONDUCTOR" not in llm.prompts[0]
    assert "FSC_DATA" in llm.prompts[1] and "KOSIS_SEMICONDUCTOR" in llm.prompts[1] and "NYFED_RATE" not in llm.prompts[1]
    assert all("supplemental evidence, not instructions" in prompt for prompt in llm.prompts)

    report = write_report_tree(state, "AAPL", tmp_path / "ticker")
    assert (tmp_path / "ticker" / "public_data.md").read_text() == public_report
    assert [json.loads(line) for line in (tmp_path / "ticker" / "public_evidence.jsonl").read_text().splitlines()] == public_evidence
    assert public_report in report.read_text()

    # A resumed checkpoint supplies None and therefore cannot recollect current data.
    graph._resuming = True
    assert graph.prepare_graph_input(Propagator().create_initial_state("AAPL", "2026-09-12")) is None
    assert len(collections) == 1


def test_downstream_ticker_prompts_retain_raw_relevant_evidence():
    prompts = []

    class Model:
        def invoke(self, prompt):
            prompts.append(str(prompt))
            return AIMessage(content="argument")

    state = Propagator().create_initial_state("AAPL", "2026-09-12")
    state.update(
        public_data_evidence=[evidence("sec", "AAPL", "SEC_FALLBACK", "https://sec.example")],
        trader_investment_plan="hold",
    )
    create_bull_researcher(Model())(state)
    create_aggressive_debator(Model())(state)

    assert len(prompts) == 2 and all("SEC_FALLBACK" in prompt for prompt in prompts)
