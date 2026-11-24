"""The analysis subjects the ticker workflow now covers, in the upstream analysts' own prompt style."""
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest

import tradingagents.dataflows.vendors.yahoo.market as yahoo_market


def _system(create, state=None):
    """The system message an upstream analyst sends, captured from its prompt."""
    from langchain_core.messages import AIMessage
    from langchain_core.runnables import RunnableLambda

    captured = {}

    class LLM:
        def bind_tools(self, tools):
            def answer(prompt):
                captured["system_message"] = prompt.to_messages()[0].content
                return AIMessage(content="report")
            return RunnableLambda(answer)

    create(LLM())(state or {"trade_date": "2024-03-15", "company_of_interest": "NVDA", "messages": []})
    return captured["system_message"]


@pytest.mark.parametrize("indicator", ["close_5_sma", "close_20_sma", "close_60_sma", "kdjk", "kdjd", "cci", "wr",
                                       "close_10_roc", "obv"])
def test_new_indicators_are_served_and_described_like_the_existing_ones(indicator):
    dates = pd.bdate_range("2023-01-02", periods=300)
    closes = 100 + np.cumsum(np.random.default_rng(1).normal(0, 1, 300))
    frame = pd.DataFrame({"Date": dates, "Open": closes, "High": closes + 1, "Low": closes - 1, "Close": closes,
                          "Volume": np.full(300, 1e6)})
    with patch.object(yahoo_market, "load_ohlcv", lambda s, d: frame.copy()):
        out = yahoo_market.get_stock_stats_indicators_window("X", indicator, "2024-02-23", 3)
    value = out.splitlines()[2].split(": ", 1)[1]
    assert value not in ("N/A", "") and float(value) == float(value)
    assert "Usage:" in out and "Tips:" in out


def test_obv_adds_volume_on_up_closes_and_subtracts_it_on_down_closes():
    from stockstats import wrap

    frame = pd.DataFrame({"Date": pd.bdate_range("2024-01-01", periods=4), "Open": 1.0, "High": 1.0, "Low": 1.0,
                          "Close": [10.0, 11.0, 10.5, 10.5], "Volume": [100, 200, 300, 400]})
    obv = yahoo_market._with_derived(wrap(frame), "obv")["obv"].tolist()
    assert obv == [0, 200, -100, -100]


def test_market_analyst_catalog_and_volume_and_structure():
    from tradingagents.agents.analysts.market_analyst import create_market_analyst

    system = _system(create_market_analyst)
    for entry in ("- close_5_sma:", "- close_20_sma:", "- close_60_sma:", "- kdjk:", "- cci:", "- wr:",
                  "- close_10_roc:", "- obv:"):
        assert entry in system, entry
    assert "Volume:" in system and "Chart structure:" in system and '"no clear pattern"' in system
    assert "are one source of evidence" in system


def test_fundamentals_analyst_covers_the_statement_analysis():
    from tradingagents.agents.analysts.fundamentals_analyst import create_fundamentals_analyst

    system = _system(create_fundamentals_analyst)
    for piece in ("vertical analysis", "profitability", "stability", "growth", "activity", "market-value ratios",
                  "cash conversion", "working capital", "per-share value", "earnings quality",
                  "do not annualize a single quarter", "not meaningful"):
        assert piece in system, piece


def test_news_analyst_reviews_three_months_of_company_news():
    from tradingagents.agents.analysts.news_analyst import create_news_analyst

    system = _system(create_news_analyst)
    assert "past three months" in system and "results, guidance, filings" in system
    assert "new information or already expected" in system
