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
    missing = [item for item in result if item["status"] != "success"]
    assert {item["target"] for item in missing} == {"WGTSTUS1", "WDISTUS1"}
    result = [item for item in result if item["status"] == "success"]
    assert {item["target"] for item in result} == {"WCESTUS1", "WCRFPUS2"}
    assert all(item["observed_at"] == "2025-01-03" for item in result)
    assert any("410 thousand barrels" in item["content"] and item["api_unit"] == "MBBL"
               for item in result)
    assert any("13.5 thousand barrels per day" in item["content"] and item["api_unit"] == "MBBL/D"
               for item in result)
    assert request.call_args.kwargs["params"]["api_key"] == "secret"


@pytest.mark.unit
def test_collect_nyfed_combines_sofr_rate_and_volume():
    payload = {"refRates": [{"effectiveDate": "2025-01-03", "percentRate": 4.31,
                              "volumeInBillions": 2398, "revisionIndicator": ""}]}
    with patch.object(public_us, "request_json", return_value=payload):
        rows = public_us.collect_nyfed("2025-01-03")
    assert {r["target"] for r in rows} == {"SOFR", "SOFR volume", "EFFR", "EFFR volume", "OBFR", "OBFR volume"}
    assert rows[0]["value"] == 4.31 and rows[0]["unit"] == "percent"
    assert rows[1]["value"] == 2398 and rows[1]["unit"] == "billion USD"
    assert all("Terms of Use" in r["note"] and "no liability" in r["note"] for r in rows)


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
        result = public_us.collect_cftc("2025-01-03")
        item = result[0]
    assert item["observed_at"] == "2024-12-31" and item["published_at"] is None
    assert [r["value"] for r in result] == [40, -20, 100]
    assert all(r["unit"] == "contracts" for r in result)
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
    assert "650277 million USD" in item["content"] and "open_today_bal" in item["note"]


@pytest.mark.unit
def test_collect_ecb_parses_sdmx_csv_and_filters_future():
    text = "PROVIDER_FM_ID,TIME_PERIOD,OBS_VALUE,TITLE,UNIT_MULT\nDFR,2025-01-03,3.0,Deposit rate,0\nMRR_FR,2025-01-03,3.15,Main refinancing rate,0\nDFR,2025-01-04,9.0,Deposit rate,0\n"
    with patch.object(public_us, "request_text", return_value=text):
        rows = public_us.collect_ecb("2025-01-03")
    assert [(r["target"], r["status"]) for r in rows if r["status"] != "success"] == [("MLFR", "empty")]
    rows = [r for r in rows if r["status"] == "success"]
    assert len(rows) == 2
    assert {r["target"] for r in rows} == {"DFR", "MRR_FR"}
    assert all(r["observed_at"] == "2025-01-03" and r["unit"] == "percent" for r in rows)


@pytest.mark.unit
def test_collect_nyfed_rejects_empty_http_200_payload():
    with patch.object(public_us, "request_json", return_value={}):
        rows = public_us.collect_nyfed("2025-01-03")
    assert len(rows) == 3 and all(r["status"] == "error" for r in rows)
