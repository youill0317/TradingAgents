"""Regression checks for source routing, live dates and retained evidence."""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.runnables import RunnableLambda
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode

from tradingagents.agents.analysts import sentiment_analyst
from tradingagents.agents.analysts.news_analyst import create_news_analyst
from tradingagents.agents.analysts.sector_analyst import create_sector_analyst
from tradingagents.agents.market_review import market_evidence
from tradingagents.agents.researchers.bull_researcher import create_bull_researcher
from tradingagents.agents.utils.agent_states import AgentState
from tradingagents.agents.utils.agent_utils import create_msg_delete
from tradingagents.agents.utils.news_data_tools import get_insider_transactions
from tradingagents.agents.utils.prediction_markets_tools import get_prediction_markets
from tradingagents.dataflows import apewisdom, date_window, interface, kalshi, polymarket
from tradingagents.dataflows.config import config_context
from tradingagents.dataflows.global_context import provider_result
from tradingagents.dataflows.public_data_common import evidence
from tradingagents.dataflows.public_digest import render_public_data
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph.market_setup import capture_macro_evidence
from tradingagents.graph.propagation import Propagator
from tradingagents.reporting import write_report_tree


class Recorder:
    def __init__(self):
        self.prompts, self.tools = [], []

    def invoke(self, prompt):
        self.prompts.append(str(prompt))
        return AIMessage(content="Report")

    def bind_tools(self, tools):
        self.tools = [tool.name for tool in tools]
        return RunnableLambda(self.invoke)


def test_insider_binding_and_live_tools_use_injected_date(monkeypatch):
    state = Propagator().create_initial_state("AAPL", "2000-01-01")
    llm = Recorder()
    create_news_analyst(llm)(state)
    assert "get_insider_transactions" in llm.tools
    fetch = Mock(side_effect=AssertionError("Historical call reached live provider"))
    monkeypatch.setitem(interface.VENDOR_METHODS["get_prediction_markets"], "kalshi", fetch)
    monkeypatch.setitem(interface.VENDOR_METHODS["get_insider_transactions"], "yfinance", fetch)
    calls = [{"name": tool.name, "args": args, "id": str(i), "type": "tool_call"}
             for i, (tool, args) in enumerate([
                 (get_prediction_markets, {"topic": "Fed"}),
                 (get_insider_transactions, {"ticker": "AAPL"}),
             ])]
    state["messages"] = [AIMessage(content="", tool_calls=calls)]
    workflow = StateGraph(AgentState)
    workflow.add_node("tools", ToolNode([get_prediction_markets, get_insider_transactions]))
    workflow.add_edge(START, "tools")
    workflow.add_edge("tools", END)
    with config_context(DEFAULT_CONFIG):
        result = workflow.compile().invoke(state)
    replies = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert len(replies) == 2 and all(m.content.startswith("DATA_UNAVAILABLE:") for m in replies)
    fetch.assert_not_called()
    assert "state" not in get_prediction_markets.tool_call_schema.model_json_schema()["properties"]


def test_new_york_live_boundary_and_future_rejection(monkeypatch):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 9, 17, 1, tzinfo=timezone.utc).astimezone(tz)

    monkeypatch.setattr(date_window, "datetime", Clock)
    fetch = Mock(return_value=Mock(json=lambda: {"pages": 1, "results": []}))
    monkeypatch.setattr(apewisdom.requests, "get", fetch)
    assert apewisdom.collect_apewisdom(None, "2026-09-16")["status"] == "empty"
    for day in ("2026-09-15", "2026-09-17"):
        assert apewisdom.collect_apewisdom(None, day)["status"] == "unavailable"
    assert fetch.call_count == 1


def test_polymarket_network_failure_uses_configured_fallback(monkeypatch):
    monkeypatch.setattr(polymarket, "_request", Mock(side_effect=requests.HTTPError("blocked")))
    backup = Mock(return_value="Kalshi quotes")
    monkeypatch.setitem(interface.VENDOR_METHODS["get_prediction_markets"], "kalshi", backup)
    with config_context({"data_vendors": {"prediction_markets": "polymarket,kalshi"}}):
        assert interface.route_to_vendor("get_prediction_markets", "Fed") == "Kalshi quotes"
    backup.assert_called_once()


def test_kalshi_conditions_and_discovery_pagination(monkeypatch):
    series = [{"ticker": f"FED{i}", "title": "Rates", "categories": ["Monetary policy"]}
              for i in range(8)]
    contract = {"ticker": "CONTRACT", "title": "Rate decision", "status": "active",
                    "close_time": "2099-01-01T00:00:00Z", "yes_bid_dollars": "0.4", "yes_ask_dollars": "0.42",
                    "volume_fp": "20", "volume_24h_fp": "5", "open_interest_fp": "10",
                    "yes_sub_title": "Cut by at least 50 basis points", "no_sub_title": "Anything else",
                    "rules_primary": "Use the announced target rate.", "rules_secondary": "Postponement rule."}
    fetch = Mock(side_effect=lambda path, params: {"series": series} if path == "series" else
                 {"events": []} if path == "events" else {"markets": [contract]})
    monkeypatch.setattr(kalshi, "_request", fetch)
    first = kalshi.get_prediction_markets("Monetary policy")
    assert "offset=6" in first and provider_result(first, "get_prediction_markets")[1] == "partial"
    assert all(value in first for value in [contract["yes_sub_title"], contract["rules_primary"], contract["rules_secondary"]])
    fetch.reset_mock()
    second = kalshi.get_prediction_markets("Monetary policy", offset=6)
    assert fetch.call_args_list[2].args[1]["series_ticker"] == "FED6"
    assert "end of matching series" in second
    unmatched = kalshi.get_prediction_markets("unmatched topic")
    assert "Monetary policy" in unmatched
    assert provider_result(unmatched, "get_prediction_markets")[1] == "partial"


def test_apewisdom_includes_movers_beyond_first_page(monkeypatch):
    monkeypatch.setattr(apewisdom, "is_live_date", lambda date: True)
    def row(ticker, rank, mentions, prior):
        return {"ticker": ticker, "rank": rank, "mentions": mentions, "mentions_24h_ago": prior,
                    "rank_24h_ago": rank + 2, "upvotes": -2}
    first = [row(f"TOP{i}", i, 50, 45) for i in range(1, 11)]
    fetch = Mock(side_effect=[Mock(json=lambda: {"pages": 2, "results": first}),
                              Mock(json=lambda: {"pages": 2, "results": [row("MOVER", 150, 40, 1)]})])
    monkeypatch.setattr(apewisdom.requests, "get", fetch)
    result = apewisdom.collect_apewisdom(None, "2026-09-17")
    assert result["status"] == "success" and "MOVER" in result["content"]
    assert "TOP10" in result["content"] and "2/2 pages" in result["content"]
    assert '"upvotes": -2' in result["content"]


def test_sentiment_raw_evidence_survives_clear_reaches_review_and_export(monkeypatch, tmp_path):
    monkeypatch.setattr(sentiment_analyst, "bind_structured", lambda *a: None)
    monkeypatch.setattr(sentiment_analyst, "invoke_structured_or_freetext", lambda *a: "Summary only")
    monkeypatch.setattr(sentiment_analyst, "get_news", SimpleNamespace(func=lambda *a: "RAW_NEWS"))
    monkeypatch.setattr(sentiment_analyst, "fetch_stocktwits_messages", lambda *a, **k: "RAW_STOCKTWITS")
    monkeypatch.setattr(sentiment_analyst, "fetch_reddit_posts", lambda *a, **k: "RAW_REDDIT")
    monkeypatch.setattr(sentiment_analyst, "collect_apewisdom", lambda *a: {
        "source": "apewisdom", "content": "RAW_APE", "status": "success", "url": "https://example.com", "retrieved_at": "now"})
    state = Propagator().create_initial_state("AAPL", "2026-09-17")
    llm = Recorder()
    workflow = StateGraph(AgentState)
    workflow.add_node("sentiment", sentiment_analyst.create_sentiment_analyst(llm))
    workflow.add_node("clear", create_msg_delete())
    workflow.add_node("review", create_bull_researcher(llm))
    for left, right in [(START, "sentiment"), ("sentiment", "clear"), ("clear", "review"), ("review", END)]:
        workflow.add_edge(left, right)
    with config_context({**DEFAULT_CONFIG, "data_vendors": {"news_data": "alpha_vantage"}}):
        result = workflow.compile().invoke(state)
    for marker in ("RAW_NEWS", "RAW_STOCKTWITS", "RAW_REDDIT", "RAW_APE", "alpha_vantage"):
        assert marker in result["sentiment_evidence"] and marker in llm.prompts[-1]
    assert "Yahoo Finance" not in result["sentiment_evidence"]
    write_report_tree(result, "AAPL", tmp_path)
    assert (tmp_path / "sentiment_evidence.md").read_text() == result["sentiment_evidence"]


def test_follow_up_news_and_predictions_reach_sector_and_review():
    state = {"trade_date": "2026-09-17", "messages": [
        AIMessage(content="", tool_calls=[{"name": "get_prediction_markets", "args": {"topic": "Fed"}, "id": "1", "type": "tool_call"}]),
        ToolMessage(name="get_prediction_markets", tool_call_id="1", content="DATA_PARTIAL: capped\nRAW_QUOTES"),
        ToolMessage(name="get_global_news", tool_call_id="2", content="RAW_FOLLOWUP_NEWS"),
        AIMessage(content="Summary only"),
    ], "global_context": "RAW_APE", "global_evidence": []}
    with config_context(DEFAULT_CONFIG):
        state.update(capture_macro_evidence(state))
    assert len(state["global_evidence"]) == 2
    assert state["global_evidence"][1]["arguments"] == {"topic": "Fed"}
    assert state["global_evidence"][1]["status"] == "partial"
    llm = Recorder()
    create_sector_analyst(llm)(state)
    for marker in ("RAW_APE", "RAW_QUOTES", "RAW_FOLLOWUP_NEWS"):
        assert marker in llm.prompts[0] and marker in market_evidence(state)


@pytest.mark.parametrize("source,metadata", [
    ("ecos", [{"classification": "rates"}, {"classification": "activity"}]),
    ("oecd", [{"country": "US"}, {"country": "JP"}]),
    ("cftc", [{}, {}]),
])
def test_digest_rotates_groups_before_repeating_one(source, metadata):
    rows = [evidence(source, f"group{g}/metric{i}", f"VALUE_{g}_{i}", "https://example.com",
                     value=i, observed_at="2026-09-01", **metadata[g])
            for g in range(2) for i in range(4)]
    report = render_public_data(rows, max_chars=4000)
    assert report.index("VALUE_1_0") < report.index("VALUE_0_1")
