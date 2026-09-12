from unittest.mock import patch

import pytest

from tradingagents.dataflows import public_us


@pytest.mark.unit
def test_collect_eia_preserves_units_and_filters_future(monkeypatch):
    monkeypatch.setenv("EIA_API_KEY", "secret")
    payload = {"response": {"data": [
        {"series": "WCESTUS1", "period": "2025-01-10", "value": 420, "units": "MBBL"},
        {"series": "WCESTUS1", "period": "2025-01-03", "value": 410, "units": "MBBL"},
        {"series": "WCRFPUS2", "period": "2025-01-03", "value": 13.5, "units": "MBBL/D"},
    ]}}
    with patch.object(public_us, "request_json", return_value=payload) as request:
        result = public_us.collect_eia("2025-01-03")
    assert {item["target"] for item in result} == {"WCESTUS1", "WCRFPUS2"}
    assert all(item["observed_at"] == "2025-01-03" for item in result)
    assert any("410 thousand barrels" in item["content"] and item["api_unit"] == "MBBL"
               for item in result)
    assert any("13.5 thousand barrels per day" in item["content"] and item["api_unit"] == "MBBL/D"
               for item in result)
    assert request.call_args.kwargs["params"]["api_key"] == "secret"


@pytest.mark.unit
def test_collect_nyfed_combines_sofr_rate_and_volume():
    rate = {"refRates": [{"effectiveDate": "2025-01-03", "percentRate": 4.31,
                           "revisionIndicator": ""}]}
    volume = {"refRates": [{"effectiveDate": "2025-01-03", "volumeInBillions": 2398}]}
    with patch.object(public_us, "request_json", side_effect=[rate, volume]):
        item = public_us.collect_nyfed("2025-01-03")[0]
    assert item["observed_at"] == "2025-01-03"
    assert "4.31%" in item["content"] and "2398 billion USD" in item["content"]
    assert "Terms of Use" in item["content"] and "no liability" in item["content"]


@pytest.mark.unit
def test_collect_cftc_uses_release_lag_and_calculates_nets():
    rows = [{
        "market_and_exchange_names": "E-MINI S&P 500",
        "report_date_as_yyyy_mm_dd": "2024-12-31T00:00:00.000",
        "open_interest_all": "100", "asset_mgr_positions_long": "60",
        "asset_mgr_positions_short": "20", "lev_money_positions_long": "10",
        "lev_money_positions_short": "30", "contract_units": "$50 x index",
    }]
    with patch.object(public_us, "request_json", return_value=rows) as request:
        item = public_us.collect_cftc("2025-01-03")[0]
    assert item["observed_at"] == "2024-12-31" and item["published_at"] is None
    assert "asset-manager net +40" in item["content"] and "leveraged-money net -20" in item["content"]
    assert "2024-12-31" in request.call_args.kwargs["params"]["$where"]


@pytest.mark.unit
def test_collect_treasury_uses_tga_account_field_and_units():
    payload = {"data": [{
        "record_date": "2025-01-03", "account_type": "Treasury General Account (TGA) Closing Balance",
        "open_today_bal": "650277", "close_today_bal": "null",
    }], "meta": {"dataFormats": {"open_today_bal": "$1,000,000"}}}
    with patch.object(public_us, "request_json", return_value=payload):
        item = public_us.collect_treasury("2025-01-03")[0]
    assert item["observed_at"] == "2025-01-03"
    assert "650277 million USD" in item["content"] and "close_today_bal is null" in item["content"]


@pytest.mark.unit
def test_collect_ecb_parses_sdmx_json_and_filters_future():
    payload = {
        "structure": {"dimensions": {"observation": [{"values": [
            {"id": "2025-01-02"}, {"id": "2025-01-03"}, {"id": "2025-01-04"},
        ]}]}},
        "dataSets": [{"series": {"0:0": {"observations": {"0": [3.0], "1": [3.0], "2": [9.0]}}}}],
    }
    with patch.object(public_us, "request_json", return_value=payload):
        item = public_us.collect_ecb("2025-01-03")[0]
    assert item["observed_at"] == "2025-01-03" and "3.0%" in item["content"]


@pytest.mark.unit
def test_collect_nyfed_rejects_empty_http_200_payload():
    with patch.object(public_us, "request_json", return_value={}), pytest.raises(ValueError):
        public_us.collect_nyfed("2025-01-03")
