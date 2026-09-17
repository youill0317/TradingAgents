from unittest.mock import Mock, patch

import pytest
import requests

from tradingagents.agents.utils.prediction_markets_tools import get_prediction_markets
from tradingagents.dataflows import kalshi
from tradingagents.dataflows.config import config_context


def market(ticker):
    return dict(
        ticker=ticker,
        title=f"Fed decision {ticker}?",
        status="active",
        close_time="2099-01-01T00:00:00Z",
        yes_bid_dollars="0.55",
        yes_ask_dollars="0.57",
        volume_fp="1000.50",
        volume_24h_fp="50.25",
        open_interest_fp="200.00",
    )


def test_discovery_pagination_filters_and_contract_units():
    valid = market("VALID")
    rows = [
        valid,
        {**valid, "ticker": "CLOSED", "status": "settled"},
        {**valid, "ticker": "PAST", "close_time": "2000-01-01T00:00:00Z"},
        {**valid, "ticker": "ILLQ", "volume_24h_fp": "0"},
        {**valid, "ticker": "BAD", "yes_bid_dollars": "NaN"},
        {**valid, "ticker": "CROSSED", "yes_bid_dollars": ".9"},
    ]
    responses = [
        {
            "series": [
                {"ticker": "NEWFED", "title": "Fed meeting", "tags": []},
                {"ticker": "OTHER", "title": "Football"},
            ]
        },
        {"markets": rows, "cursor": "next"},
        {"markets": [{**valid, "ticker": "BUSY", "title": "Busy?", "volume_24h_fp": "200"}]},
    ]
    with config_context({"data_vendors": {"prediction_markets": "kalshi"}}), \
         patch.object(kalshi, "_request", side_effect=responses) as fetch:
        out = get_prediction_markets.invoke({"topic": "Fed rate cut", "limit": 2})
    assert fetch.call_args_list[2].args[1]["cursor"] == "next"
    assert fetch.call_args_list[1].args[1]["series_ticker"] == "NEWFED"
    assert out.index("Busy?") < out.index("Fed decision VALID?")
    assert "YES bid 55.0%, ask 57.0%" in out
    assert "50.25 contracts" in out and "total 1,000.50" in out
    assert "not dollars or unique participants" in out
    assert "Source: https://external-api.kalshi.com" in out
    for ticker in ["CLOSED", "PAST", "ILLQ", "BAD", "CROSSED"]:
        assert f"/markets/{ticker}" not in out


def test_request_cap_is_visible_and_output_limit_applies():
    series = [{"ticker": str(i), "title": "Fed", "volume_fp": str(i)} for i in range(8)]
    with patch.object(
        kalshi,
        "_request",
        side_effect=lambda path, params: (
            {"series": series}
            if path == "series"
            else {"markets": [market(params["series_ticker"])], "cursor": "more"}
        ),
    ) as fetch:
        out = kalshi.get_prediction_markets("Fed", 1)
    assert fetch.call_count == 13
    assert "inspected 6/8" in out and "partial (request cap reached)" in out
    assert out.count("Source:") == 1


def test_invalid_http_payload_is_not_empty_success():
    response = Mock()
    response.json.return_value = {"error": "unavailable"}
    with (
        patch.object(requests, "get", return_value=response),
        pytest.raises(ValueError, match="Invalid Kalshi"),
    ):
        kalshi._request("series", {})
