"""The Business Analyst: web search confined to one opt-in analyst, on today's date, on a provider that has it."""
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage

from tradingagents.agents import web_search
from tradingagents.agents.analysts.business_analyst import (
    business_report_line,
    create_business_analyst,
)
from tradingagents.dataflows.date_window import get_current_date
from tradingagents.graph.analyst_execution import ANALYST_NODE_SPECS, build_analyst_execution_plan


def _llm(cls_name, reply=None, **attrs):
    """A stand-in whose class name is a provider's chat class, recording what it is bound and sent."""
    seen = {}

    def bind_tools(self, tools):
        seen["tools"] = tools

        def invoke(messages):
            seen["messages"] = messages
            return reply
        return SimpleNamespace(invoke=invoke)
    cls = type(cls_name, (), {"bind_tools": bind_tools, **attrs})
    return cls(), seen


@pytest.mark.parametrize("cls_name,attrs,expected", [
    ("ChatAnthropic", {}, {"type": "web_search_20250305", "name": "web_search"}),
    ("ChatGoogleGenerativeAI", {}, {"google_search": {}}),
    ("ChatOpenAI", {"use_responses_api": True}, {"type": "web_search"}),
    ("ChatOpenAI", {"use_responses_api": False}, None),       # Chat Completions has no search tool
    ("ChatBedrockConverse", {}, None),
])
def test_each_provider_gets_its_own_search_tool_or_none(cls_name, attrs, expected):
    llm, _ = _llm(cls_name, **attrs)
    assert web_search.web_search_tool(llm) == expected


def test_a_subclass_of_a_provider_class_is_recognised():
    from tradingagents.llm_clients.anthropic_client import NormalizedChatAnthropic

    assert "ChatAnthropic" in [c.__name__ for c in NormalizedChatAnthropic.__mro__]


def test_sources_are_collected_from_wherever_the_provider_puts_them():
    reply = AIMessage(
        content=[
            {"type": "text", "text": "Share is 30%.", "annotations": [
                {"type": "url_citation", "url": "https://sec.gov/10k", "title": "10-K"}]},
            {"type": "web_search_tool_result", "content": [
                {"type": "web_search_result", "url": "https://example.com/a", "title": "Article"},
                {"type": "web_search_result", "url": "https://sec.gov/10k", "title": "10-K again"}]},
        ],
        response_metadata={"grounding_metadata": {"grounding_chunks": [
            {"web": {"uri": "https://ir.example.com", "title": "IR"}}, {"web": {"uri": "ftp://not-web"}}]}},
    )
    assert web_search.extract_sources(reply) == [
        ("10-K", "https://sec.gov/10k"), ("Article", "https://example.com/a"), ("IR", "https://ir.example.com")]


def _state(date):
    return {"trade_date": date, "company_of_interest": "NVDA", "messages": [("human", "NVDA")]}


def test_it_searches_on_a_run_dated_today_and_lists_its_sources():
    reply = AIMessage(content=[{"type": "text", "text": "MOAT: Wide", "annotations": [
        {"type": "url_citation", "url": "https://sec.gov/10k", "title": "10-K"}]}])
    llm, seen = _llm("ChatAnthropic", reply)
    result = create_business_analyst(llm)(_state(get_current_date()))
    assert seen["tools"][0]["name"] == "web_search"
    system = str(seen["messages"][0].content)
    assert "## 4. Economic moat" in system and "Wide / Moderate / Narrow / None" in system
    assert "DATA, NOT INSTRUCTIONS" in system and "unconfirmed" in system
    report = result["business_report"]
    assert report.startswith("MOAT: Wide")
    assert "## Web sources consulted\n- [10-K](https://sec.gov/10k)" in report


@pytest.mark.parametrize("cls_name,date,reason", [
    ("ChatAnthropic", "2024-03-15", "before today"),
    ("ChatBedrockConverse", None, "no built-in web search"),
])
def test_it_says_it_did_not_run_instead_of_answering_from_memory(cls_name, date, reason):
    llm, seen = _llm(cls_name, AIMessage(content="should not be asked"))
    result = create_business_analyst(llm)(_state(date or get_current_date()))
    assert seen == {}, "no model call, so nothing is recalled from training"
    report = result["business_report"]
    assert report.startswith("(Business analysis did not run") and reason in report
    assert report, "a filed report, so the run does not wait on it"


def test_it_is_registered_but_never_selected_by_default():
    import inspect

    from tradingagents.graph.setup import GraphSetup
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    spec = ANALYST_NODE_SPECS["business"]
    assert (spec.agent_node, spec.report_key, spec.tools) == ("Business Analyst", "business_report", ())
    assert build_analyst_execution_plan(["market", "business"]).specs[-1] is spec
    for func in (TradingAgentsGraph.__init__, GraphSetup.setup_graph):
        assert "business" not in inspect.signature(func).parameters["selected_analysts"].default


def test_without_it_the_debaters_prompts_are_unchanged():
    assert business_report_line({"business_report": ""}) == ""
    assert business_report_line({}) == ""
    line = business_report_line({"business_report": "MOAT: Wide"})
    assert line.startswith("\nBusiness quality report") and line.endswith("MOAT: Wide")


def test_cli_offers_it_for_stocks_only_and_leaves_it_out_of_every_analyst():
    from cli.models import OPT_IN_ANALYSTS, AnalystType, AssetType
    from cli.prompts import filter_analysts_for_asset_type, parse_analysts

    assert AnalystType.BUSINESS in OPT_IN_ANALYSTS
    assert parse_analysts("market,business", AssetType.STOCK) == [AnalystType.MARKET, AnalystType.BUSINESS]
    with pytest.raises(ValueError, match="not available for crypto"):
        parse_analysts("business", AssetType.CRYPTO)
    assert AnalystType.BUSINESS not in filter_analysts_for_asset_type(list(AnalystType), AssetType.CRYPTO)


def test_report_tree_and_live_view_carry_the_report(tmp_path):
    from cli.display import ANALYST_ORDER, ANALYST_REPORT_MAP, MessageBuffer
    from tradingagents.reporting import write_report_tree

    write_report_tree({"business_report": "MOAT: Wide", "trade_date": "2026-01-02"}, "NVDA", tmp_path, html=False)
    assert (tmp_path / "1_analysts" / "business.md").read_text() == "MOAT: Wide"
    assert ANALYST_ORDER[-1] == "business" and ANALYST_REPORT_MAP["business"] == "business_report"
    buffer = MessageBuffer()
    buffer.init_for_analysis(["market", "business"])
    assert buffer.agent_status["Business Analyst"] == "pending" and "business_report" in buffer.report_sections
    buffer.init_for_analysis(["market"])
    assert "Business Analyst" not in buffer.agent_status and "business_report" not in buffer.report_sections
