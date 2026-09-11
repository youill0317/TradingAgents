"""Numerical, coverage and release-time contracts for market analysis."""
import json

import pandas as pd
import pytest

from tradingagents.dataflows import market_diagnostics as md, market_events as me
from tradingagents.dataflows.config import config_context


def test_diagnostics_calculates_aligned_breadth_and_ratios(monkeypatch):
    dates = pd.bdate_range(end="2026-09-10", periods=260)
    def prices(symbol, date):
        growth = 1.002 if symbol in md.SECTOR_ETFS.values() or symbol == "RSP" else 1.001
        return pd.DataFrame({"Date": dates, "Close": [100 * growth**i for i in range(len(dates))]})
    monkeypatch.setattr(md, "load_ohlcv", prices)
    result = md.collect_market_diagnostics("2026-09-10")
    data = result["data"]
    assert data["status"] == "success"
    assert data["breadth"]["ma200"] == {"above": 11, "observed": 11, "total": 11}
    assert data["sectors"][0]["relative_spy_pp"]["1w"] == pytest.approx(((1.002**5 - 1) - (1.001**5 - 1)) * 100)
    assert data["ratios"][0]["returns"]["1w"] == pytest.approx(((1.002/1.001)**5 - 1) * 100)
    assert all(r["rank_change"] == 0 for r in data["sectors"])
    assert "NOT counts of advancing stocks" in result["report"]
    json.dumps(result, allow_nan=False)


def test_diagnostics_does_not_fill_missing_or_future_prices(monkeypatch):
    dates = pd.bdate_range(end="2026-09-11", periods=260)
    def prices(symbol, date):
        frame = pd.DataFrame({"Date": dates, "Close": range(100, 360)})
        if symbol == "XLE":
            frame = frame[frame.Date != pd.Timestamp("2026-09-10")]
        return frame
    monkeypatch.setattr(md, "load_ohlcv", prices)
    result = md.collect_market_diagnostics("2026-09-10")
    assert result["data"]["session"] == "2026-09-10"
    assert result["data"]["breadth"]["1mo"]["observed"] == 10
    energy = next(r for r in result["data"]["sectors"] if r["symbol"] == "XLE")
    assert energy["returns"]["1mo"] is None
    assert all(r["rank_change"] is None for r in result["data"]["sectors"])
    assert result["warnings"]
    json.dumps(result, allow_nan=False)


def test_window_return_requires_full_window_and_matching_session():
    s = pd.Series([100., 110.], index=pd.to_datetime(["2026-09-08", "2026-09-10"]))
    assert md.window_return(s, pd.Timestamp("2026-09-10"), md.WINDOWS["1mo"]) == (None, None)
    assert md.window_return(s, pd.Timestamp("2026-09-11"), md.WINDOWS["1w"]) == (None, None)


def test_no_spy_does_not_claim_empty_breadth(monkeypatch):
    monkeypatch.setattr(md, "load_ohlcv", lambda *a: pd.DataFrame())
    result = md.collect_market_diagnostics("2026-09-10")
    assert result["data"]["status"] == "unavailable"
    assert result["warnings"] == ["MARKET_DIAGNOSTICS_UNAVAILABLE"]


@pytest.mark.parametrize("stamp,phase,actual", [
    ("2026-09-10T12:30:00Z", "released", "0%"),
    ("2026-09-10T16:00:00Z", "upcoming", ""),
    ("2026-09-10 12:30:00", "time unverified", ""),
])
def test_calendar_zero_actual_and_future_masking(stamp, phase, actual):
    row = me._yahoo_row("CPI", {"Event Time": stamp, "Actual": "0%", "Expected": "0.2%", "Last": 0}, pd.Timestamp("2026-09-10T14:00:00Z"))
    assert row["phase"] == phase and row["actual"] == actual
    assert row["previous"] == "0"
    assert row["surprise"] == (-0.2 if phase == "released" else None)


def test_surprise_requires_matching_units():
    row = me._yahoo_row("CPI", {"Event Time": "2026-09-10T12:00:00Z", "Actual": "2%", "Expected": "2"}, pd.Timestamp("2026-09-10T14:00:00Z"))
    assert row["surprise"] is None
    assert me._number("200K") == (200000, "provider units")


def test_calendar_pagination_failure_keeps_observations_and_fred_dates(monkeypatch):
    monkeypatch.setattr(me, "PAGE_SIZE", 1)
    class Calendar:
        def __init__(self, **kw):
            assert kw == {"start": "2026-09-03", "end": "2026-09-24"}
        def get_economic_events_calendar(self, limit, offset):
            if offset:
                raise RuntimeError("rate limited")
            return pd.DataFrame([{"Event Time": "2026-09-11T12:30:00Z", "Expected": "2.4%"}], index=["CPI"])
    monkeypatch.setattr(me.yf, "Calendars", Calendar)
    monkeypatch.setattr(me, "get_api_key", lambda: "test")
    def fred(endpoint, args):
        assert endpoint == "releases/dates" and args["include_release_dates_with_no_data"] == "true"
        return {"release_dates": [] if args["offset"] else [{"date": "2026-09-15", "release_name": "Industrial Production", "release_id": 13}]}
    monkeypatch.setattr(me, "_request", fred)
    with config_context({"market_scan_as_of": "2026-09-10T14:00:00Z"}):
        result = me.collect_market_events("2026-09-10")
    assert result["data"]["status"] == "partial"
    assert len(result["data"]["events"]) == 2
    fred_row = result["data"]["events"][1]
    assert fred_row["time_utc"] is None and fred_row["expected"] == ""
    assert "EVENT_CALENDAR_PARTIAL:yahoo" in result["warnings"]
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("frame,expected", [(pd.DataFrame(), "empty"), (pd.DataFrame([{"Event Time": "bad"}]), "partial")])
def test_calendar_empty_vs_invalid_dates(monkeypatch, frame, expected):
    class Calendar:
        def __init__(self, **kw): pass
        def get_economic_events_calendar(self, **kw): return frame
    monkeypatch.setattr(me.yf, "Calendars", Calendar)
    monkeypatch.setattr(me, "get_api_key", lambda: "test")
    monkeypatch.setattr(me, "_request", lambda *a: {"release_dates": []})
    with config_context({"market_scan_as_of": "2026-09-10T14:00:00Z"}):
        result = me.collect_market_events("2026-09-10")
    assert result["data"]["status"] == expected


def test_calendar_outages_are_not_no_events(monkeypatch):
    def offline(*a, **kw): raise RuntimeError("offline")
    monkeypatch.setattr(me.yf, "Calendars", offline)
    monkeypatch.setattr(me, "get_api_key", offline)
    with config_context({"market_scan_as_of": "2026-09-10T14:00:00Z"}):
        result = me.collect_market_events("2026-09-10")
    assert result["data"]["status"] == "unavailable"
    assert "EVENT_CALENDAR_UNAVAILABLE" in result["warnings"]


def test_different_baseline_session_cannot_drive_sector_rank(monkeypatch):
    dates = pd.bdate_range(end="2026-09-10", periods=260)
    def prices(symbol, date):
        frame = pd.DataFrame({"Date": dates, "Close": range(100, 360)})
        return frame[frame.Date != pd.Timestamp("2026-08-10")] if symbol == "XLE" else frame
    monkeypatch.setattr(md, "load_ohlcv", prices)
    result = md.collect_market_diagnostics("2026-09-10")
    energy = next(r for r in result["data"]["sectors"] if r["symbol"] == "XLE")
    assert energy["returns"]["1mo"] is None
    assert energy["relative_spy_pp"]["1mo"] is None
    assert energy["rank_change"] is None
