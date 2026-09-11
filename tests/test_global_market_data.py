"""Global evidence must preserve boundaries, missing data and provider context."""

import pandas as pd
import pytest

from tradingagents.dataflows import global_market as gm
from tradingagents.dataflows.config import config_context, get_config


def test_calendar_returns_preserve_dates_and_exclude_future(monkeypatch):
    frame = pd.DataFrame({
        "Date": pd.to_datetime(["2026-06-09", "2026-08-07", "2026-09-02", "2026-09-09", "2026-09-10"]),
        "Close": [50, 80, 100, 110, 999],
    })
    monkeypatch.setattr(gm, "load_ohlcv", lambda *args: frame)
    result = gm._asset_observation(("SPY", "US equity ETF", "USD"), "2026-09-09")
    assert result["status"] == "success"
    assert result["observed_at"] == "2026-09-09"
    assert result["returns"] == pytest.approx({"1w": 10, "1mo": 37.5, "3mo": 120})
    assert result["return_start_dates"]["1mo"] == "2026-08-07"
    assert "USD" in result["content"]
    assert result["url"] == "https://finance.yahoo.com/quote/SPY/"
    assert pd.Timestamp(result["retrieved_at"]).utcoffset().total_seconds() == 0


def test_insufficient_history_is_not_a_shorter_return(monkeypatch):
    frame = pd.DataFrame({"Date": pd.to_datetime(["2026-09-08", "2026-09-09"]), "Close": [10, 11]})
    monkeypatch.setattr(gm, "load_ohlcv", lambda *args: frame)
    result = gm._asset_observation(("SPY", "ETF", "USD"), "2026-09-09")
    assert result["status"] == "partial"
    assert all(value is None for value in result["returns"].values())


def test_provider_failure_does_not_expose_request_secret(monkeypatch):
    def fail(*args):
        raise RuntimeError("https://provider.example?api_key=private")
    monkeypatch.setattr(gm, "load_ohlcv", fail)
    result = gm._asset_observation(("SPY", "ETF", "USD"), "2026-09-09")
    assert result["status"] == "failed"
    assert "private" not in str(result)


def test_no_fred_key_never_calls_provider(monkeypatch):
    monkeypatch.delenv("FRED_API_KEY", raising=False)
    def unexpected(*args, **kwargs):
        pytest.fail("FRED must be skipped without its key")
    monkeypatch.setattr(gm, "get_macro_data", unexpected)
    result = gm._macro_observation("US: GDP", "GDPC1", "2026-09-09")
    assert result["status"] == "unavailable"
    assert pd.Timestamp(result["retrieved_at"]).utcoffset().total_seconds() == 0


@pytest.mark.parametrize("content,status", [
    ("## FRED\n- Units: Percent\n- Frequency: Monthly\n**Latest:** 4.1 (2026-08-01)", "success"),
    ("## FRED\n- Frequency: Monthly\n**Latest:** 4.1 (2023-08-01)", "stale"),
    ("## FRED\n- Frequency: Daily\n**Latest:** 4.1 (2026-08-29)", "stale"),
    ("## FRED\n- Frequency: Daily\n**Latest:** 4.1 (2026-09-04)", "success"),
    ("## FRED\n- Frequency: Weekly, Ending Friday\n**Latest:** 4.1 (2026-08-14)", "stale"),
    ("## FRED\n- Frequency: Quarterly\n**Latest:** 4.1 (2026-04-01)", "success"),
    ("## FRED\nNo observations for X in this window.", "empty"),
    ("FRED series 'X' not found.", "failed"),
])
def test_macro_preserves_metadata_and_distinguishes_missing(monkeypatch, content, status):
    monkeypatch.setenv("FRED_API_KEY", "test")
    monkeypatch.setattr(gm, "get_macro_data", lambda *args, **kwargs: content)
    result = gm._macro_observation("US: GDP", "GDPC1", "2026-09-09")
    assert result["status"] == status
    assert content in result["content"]
    assert result["url"] == "https://fred.stlouisfed.org/series/GDPC1"


def test_snapshot_records_every_region_and_retains_thread_context(monkeypatch):
    monkeypatch.delenv("FRED_API_KEY", raising=False)
    monkeypatch.setattr(gm, "GLOBAL_ASSETS", (("SPY", "US ETF", "USD"),))
    def load(*args):
        assert get_config()["data_cache_dir"] == "isolated-test-cache"
        return pd.DataFrame({"Date": pd.to_datetime(["2026-06-09", "2026-08-07", "2026-09-02", "2026-09-09"]), "Close": [50, 80, 100, 110]})
    monkeypatch.setattr(gm, "load_ohlcv", load)
    with config_context({"data_cache_dir": "isolated-test-cache"}):
        result = gm.collect_global_snapshot("2026-09-09")
    assert result["effective_market_session"] == "2026-09-09"
    assert len(result["evidence"]) == 1 + 8 * 4 + len(gm.US_FINANCIAL_SERIES) + len(gm.RESERVE_SERIES)
    assert result["evidence"][0]["status"] == "success"
    assert result["warnings"]
    for region in gm.REGIONAL_MACRO:
        assert any(item["target"].startswith(region + ":") for item in result["evidence"])


def test_macro_report_trimming_preserves_full_evidence_and_stale_warning():
    rows = [f"| 2026-0{month}-01 | {month} |" for month in range(1, 7)]
    content = "- Units: Percent\n- Frequency: Monthly\n**Latest:** 6 (2026-06-01)\n| Date | Value |\n| --- | --- |\n" + "\n".join(rows) + "\nSTALE: do not treat as current."
    evidence = {"source": "fred", "content": content}
    result = gm._report_content(evidence)
    assert rows[0] not in result and rows[1] not in result
    assert all(row in result for row in rows[-4:])
    assert "- Units: Percent" in result and "**Latest:**" in result
    assert "STALE" in result
    assert evidence["content"] == content


def test_unselected_series_do_not_degrade_successful_collection(monkeypatch):
    original = gm._macro_observation
    def macro(target, series, date):
        if series is None:
            return original(target, series, date)
        return {"source": "fred", "target": target, "status": "success", "content": "Available"}
    monkeypatch.setattr(gm, "_macro_observation", macro)
    monkeypatch.setattr(gm, "_asset_observation", lambda asset, date: {
        "source": "yfinance", "target": asset[0], "status": "success", "content": "Available"})
    result = gm.collect_global_snapshot("2026-09-11")
    assert not result["warnings"]
    assert sum(r["status"] == "not_configured" for r in result["evidence"]) == 9
    assert "no comparable series selected" in result["report"]
