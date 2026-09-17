from datetime import datetime
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

import pytest
import requests

from tradingagents.dataflows import apewisdom as social


def row(ticker):
    return {
        "ticker": ticker,
        "rank": 4,
        "mentions": 20,
        "upvotes": 30,
        "rank_24h_ago": None,
        "mentions_24h_ago": 10,
    }


def test_ape_pagination_and_attention_not_sentiment():
    today = datetime.now(ZoneInfo("America/New_York")).date().isoformat()
    with patch.object(
        social.requests,
        "get",
        side_effect=[
            Mock(json=lambda: {"pages": 2, "results": [row("OTHER")]}),
            Mock(json=lambda: {"pages": 2, "results": [row("AAPL")]}),
        ],
    ) as fetch:
        result = social.collect_apewisdom("AAPL", today)
    assert fetch.call_count == 2
    assert result["status"] == "success" and '"mentions": 20' in result["content"]
    assert "not bullish/bearish" in result["content"]
    assert "2/2 pages" in result["content"]


def test_ape_absent_ticker_does_not_invent_zero():
    today = datetime.now(ZoneInfo("America/New_York")).date().isoformat()
    with patch.object(
        social.requests, "get", return_value=Mock(json=lambda: {"pages": 20, "results": []})
    ) as fetch:
        result = social.collect_apewisdom("AAPL", today)
    assert fetch.call_count == 10
    assert result["status"] == "partial" and "do not infer zero" in result["content"]


@pytest.mark.parametrize("error", [requests.HTTPError("secret"), ValueError("secret")])
def test_failures_are_unavailable_not_sentiment_and_redacted(error):
    today = datetime.now(ZoneInfo("America/New_York")).date().isoformat()
    with patch.object(social.requests, "get", side_effect=error):
        result = social.collect_apewisdom("AAPL", today)
    assert result["status"] == "failed" and "secret" not in str(result)
