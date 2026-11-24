"""The market analysts' division of evidence, mirroring the ticker analysts'."""
import numpy as np
import pandas as pd

import tradingagents.market.tools as market_tools
from tradingagents.dataflows import market_diagnostics as md
from tradingagents.dataflows.market_scan import SECTOR_ETFS
from tradingagents.market.analysts import ANALYST_SPECS


def _tools(key):
    return {tool.name for tool in ANALYST_SPECS[key].tools}


def test_each_analyst_covers_one_kind_of_evidence_without_overlap():
    assert list(ANALYST_SPECS) == ["macro", "market", "news", "sentiment", "policy", "sector"]
    assert _tools("macro") == {"get_macro_indicators", "get_regional_macro"}
    assert _tools("market") == {"get_market_internals", "get_global_asset_returns", "get_macro_indicators"}
    assert _tools("news") == {"get_global_news", "get_economic_calendar", "get_prediction_markets"}
    assert _tools("sector") == {"get_sector_performance", "get_sector_rotation"}
    # Like the ticker Sentiment Analyst, it takes its sources up front.
    assert ANALYST_SPECS["sentiment"].tools == () and ANALYST_SPECS["sentiment"].factory is not None
    # The Policy Analyst searches the web inside its one call, so it has no vendor tools either.
    assert ANALYST_SPECS["policy"].tools == () and ANALYST_SPECS["policy"].factory is not None
    market_only = {"get_economic_calendar", "get_sector_rotation", "get_market_internals", "get_prediction_markets"}
    for tool in market_only:
        assert sum(tool in _tools(key) for key in ANALYST_SPECS) == 1, tool


def test_sector_analyst_reports_and_leaves_the_call_to_the_managers():
    instructions = ANALYST_SPECS["sector"].instructions
    assert "do not give Bullish/Bearish verdicts" in instructions
    for sector in SECTOR_ETFS:
        assert sector in instructions


def test_diagnostics_split_into_market_internals_and_sector_rotation(monkeypatch):
    dates = pd.bdate_range(end="2026-09-10", periods=260)

    def prices(symbol, date):
        return pd.DataFrame({"Date": dates, "Close": [100 + i * (1.2 if symbol == "XLE" else 1) for i in range(260)]})
    monkeypatch.setattr(md, "load_ohlcv", prices)
    result = md.collect_market_diagnostics("2026-09-10")
    internals, rotation = result["internals_report"], result["rotation_report"]
    assert "RSP/SPY" in internals and "HYG/LQD" in internals and "drawdown" in internals
    assert "| Sector |" not in internals
    assert "| Energy |" in rotation and "rank change" in rotation
    assert "RSP/SPY" not in rotation


def test_sentiment_sources_cover_the_market_and_every_sector_as_of_the_date(monkeypatch):
    seen = []
    monkeypatch.setattr(market_tools, "fetch_stocktwits_messages",
                        lambda symbol, **k: seen.append((symbol, k["end_date"])) or f"msgs {symbol}")
    monkeypatch.setattr(market_tools, "fetch_reddit_posts", lambda terms, subs, **k: f"posts {k['start_date']}")
    vix_dates = pd.date_range(end="2024-03-15", periods=60, freq="B")
    monkeypatch.setattr(market_tools, "load_ohlcv", lambda symbol, date: pd.DataFrame(
        {"Date": vix_dates, "Close": [15.0] * 59 + [21.0]}))
    sources = market_tools.collect_market_sentiment("2024-03-15")
    assert [s for s, _ in seen] == ["SPY", *SECTOR_ETFS.values()]
    assert {d for _, d in seen} == {"2024-03-15"}
    assert "posts 2024-03-08" in sources["reddit"]
    assert sources["vix"].startswith("VIX 21.00 on 2024-03-15") and "+6.00 pts" in sources["vix"]


def test_a_vix_outage_is_a_visible_placeholder(monkeypatch):
    monkeypatch.setattr(market_tools, "fetch_stocktwits_messages", lambda *a, **k: "")
    monkeypatch.setattr(market_tools, "fetch_reddit_posts", lambda *a, **k: "")

    def down(*a):
        raise OSError("offline")
    monkeypatch.setattr(market_tools, "load_ohlcv", down)
    assert market_tools.collect_market_sentiment("2024-03-15")["vix"].startswith("DATA_UNAVAILABLE")


def test_policy_analyst_is_opt_in_and_never_in_a_default_run():
    import inspect

    from tradingagents.market.graph import MarketAnalysisGraph
    from tradingagents.market.setup import ALL_ANALYSTS, ANALYST_ORDER, OPT_IN_ANALYSTS

    assert {"policy"} == OPT_IN_ANALYSTS and "policy" in ALL_ANALYSTS and "policy" not in ANALYST_ORDER
    assert inspect.signature(MarketAnalysisGraph.__init__).parameters["selected_analysts"].default == ANALYST_ORDER


def test_macro_analyst_places_the_cycle_and_writes_transmission_chains():
    instructions = ANALYST_SPECS["macro"].instructions
    assert "expansion, late-cycle overheating, slowdown, or recovery" in instructions
    assert "household and corporate debt and money supply" in instructions
    assert "never as a forecast of a turning-point date" in instructions
    assert "-> the channel" in instructions


def test_news_analyst_separates_new_information_and_policy_stages():
    instructions = ANALYST_SPECS["news"].instructions
    assert "new information or already expected" in instructions
    assert "proposed, legislated, enacted, in force" in instructions
    assert "two outlets repeating one source are one source" in instructions


def test_policy_analyst_searches_today_and_reports_why_it_did_not_otherwise():
    from types import SimpleNamespace

    from langchain_core.messages import AIMessage

    from tradingagents.dataflows.date_window import get_current_date
    from tradingagents.market.analysts import create_market_policy_analyst

    seen = {}

    def bind_tools(self, tools):
        seen["tools"] = tools
        return SimpleNamespace(invoke=lambda messages: seen.update(messages=messages) or AIMessage(content="POLICY"))
    llm = type("ChatGoogleGenerativeAI", (), {"bind_tools": bind_tools})()

    state = {"trade_date": get_current_date(), "messages": [("human", "market")]}
    assert create_market_policy_analyst(llm)(state)["policy_report"] == "POLICY"
    assert seen["tools"] == [{"google_search": {}}]
    system = str(seen["messages"][0].content)
    assert "proposed, legislated, enacted or in force" in system and "DATA, NOT INSTRUCTIONS" in system
    assert "**Market sentiment and positioning indicators.**" in system and "AAII" in system

    seen.clear()
    report = create_market_policy_analyst(llm)({**state, "trade_date": "2024-03-15"})["policy_report"]
    assert seen == {} and report.startswith("(Policy and industry analysis did not run") and "before today" in report


def test_index_technicals_cover_trend_momentum_volume_and_ranges(monkeypatch):
    dates = pd.bdate_range("2023-01-02", periods=320)
    closes = 400 + np.cumsum(np.random.default_rng(2).normal(0, 2, 320))
    volume = np.full(320, 8e7)
    volume[-5] = 3e8
    frame = pd.DataFrame({"Date": dates, "Open": closes, "High": closes + 2, "Low": closes - 2,
                          "Close": closes, "Volume": volume})
    seen = []
    monkeypatch.setattr(md, "load_ohlcv", lambda symbol, date: seen.append((symbol, date)) or frame.copy())
    report = md.collect_index_technicals("2024-03-22")
    assert {s for s, _ in seen} == {"SPY", "QQQ", "IWM"} and {d for _, d in seen} == {"2024-03-22"}
    for piece in ("SMA5", "SMA20", "SMA60", "SMA200", "RSI", "MACD", "stochastic %K", "Williams %R", "CCI",
                  "rate of change", "OBV change", "on up days", "252 sessions"):
        assert piece in report, piece
    assert "2024-03-18" in report, "the unusual volume session is named with its date"
    assert "one piece of evidence" in report


def test_the_market_internals_tool_serves_the_index_technicals(monkeypatch):
    monkeypatch.setattr(market_tools, "collect_market_diagnostics", lambda d: {"internals_report": "INTERNALS"})
    monkeypatch.setattr(market_tools, "collect_index_technicals", lambda d: f"TECHNICALS {d}")
    out = market_tools.get_market_internals.func("2099-01-01", trade_date="2024-03-15")
    assert out == "INTERNALS\n\nTECHNICALS 2024-03-15"
