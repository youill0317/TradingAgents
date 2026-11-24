"""The market analysts' division of evidence, mirroring the ticker analysts'."""
import pandas as pd

import tradingagents.market.tools as market_tools
from tradingagents.dataflows import market_diagnostics as md
from tradingagents.dataflows.market_scan import SECTOR_ETFS
from tradingagents.market.analysts import ANALYST_SPECS


def _tools(key):
    return {tool.name for tool in ANALYST_SPECS[key].tools}


def test_each_analyst_covers_one_kind_of_evidence_without_overlap():
    assert list(ANALYST_SPECS) == ["macro", "market", "news", "sentiment", "sector"]
    assert _tools("macro") == {"get_macro_indicators", "get_regional_macro"}
    assert _tools("market") == {"get_market_internals", "get_global_asset_returns", "get_macro_indicators"}
    assert _tools("news") == {"get_global_news", "get_economic_calendar", "get_prediction_markets"}
    assert _tools("sector") == {"get_sector_performance", "get_sector_rotation"}
    # Like the ticker Sentiment Analyst, it takes its sources up front.
    assert ANALYST_SPECS["sentiment"].tools == () and ANALYST_SPECS["sentiment"].factory is not None
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
