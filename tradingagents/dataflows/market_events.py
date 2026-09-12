"""Economic catalysts from Yahoo Calendars and FRED release dates.

Provider retrieval snapshots are not archived pre-release consensus. FRED dates
have day precision; they must never be represented as exact announcement times.
"""
import math
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

from .config import get_config
from .fred import _request, get_api_key

MAX_PAGES = 5
PAGE_SIZE = 100
IMPORTANT = re.compile(r"inflation|cpi|pce|gdp|payroll|employment|jobless|interest|rate decision|fomc|retail|pmi|ism|industrial|confidence", re.I)


def _text(value):
    return "" if value is None or (not isinstance(value, (list, dict)) and pd.isna(value)) else str(value)


def _number(value):
    text = _text(value).strip().replace(",", "")
    match = re.fullmatch(r"([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([KMBT%]?)", text, re.I)
    if not match:
        return None, None
    value, unit = float(match[1]), match[2].upper()
    if not math.isfinite(value):
        return None, None
    if unit in "KMBT" and unit:
        value *= {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}[unit]
        unit = ""
    return value, "%" if unit == "%" else "provider units"


def _yahoo_row(name, row, as_of):
    stamp = pd.to_datetime(row.get("Event Time"), errors="coerce")
    if pd.isna(stamp):
        return None
    precise = stamp.tzinfo is not None
    utc = stamp.tz_convert("UTC") if precise else None
    # A naive vendor timestamp is not assumed to be UTC or exchange-local.
    phase = ("released" if utc <= as_of else "upcoming") if precise else "time unverified"
    record = {"source": "yahoo_calendar", "event": str(name), "region": _text(row.get("Region")),
              "period": _text(row.get("Period")), "date": stamp.date().isoformat(),
              "time_utc": utc.isoformat() if precise else None,
              "time_precision": "timestamp" if precise else "date; timezone unavailable",
              "phase": phase, "priority": "major indicator" if IMPORTANT.search(str(name)) else "other",
              "expected": _text(row.get("Expected")), "previous": _text(row.get("Last")),
              "actual": _text(row.get("Actual")) if phase == "released" else "",
              "revised_from": _text(row.get("Revised")) if phase == "released" else "",
              "surprise": None, "surprise_unit": None,
              "url": "https://finance.yahoo.com/calendar/economic"}
    actual, unit = _number(record["actual"])
    expected, expected_unit = _number(record["expected"])
    if phase == "released" and actual is not None and expected is not None and unit == expected_unit:
        record["surprise"] = actual - expected
        record["surprise_unit"] = "percentage points" if unit == "%" else "provider units"
    return record


def collect_market_events(trade_date):
    cfg = get_config()
    as_of = pd.Timestamp(cfg.get("market_scan_as_of") or datetime.now(timezone.utc))
    if as_of.tzinfo is None:
        raise ValueError("market_scan_as_of must include a timezone")
    as_of = as_of.tz_convert("UTC")
    start = (datetime.fromisoformat(trade_date).date() - timedelta(days=7)).isoformat()
    end = (datetime.fromisoformat(trade_date).date() + timedelta(days=14)).isoformat()
    events, evidence, warnings = [], [], []
    retrieved = datetime.now(timezone.utc).isoformat()
    yahoo_status, error = "success", None
    try:
        calendar = yf.Calendars(start=start, end=end)
        for page in range(MAX_PAGES):
            frame = calendar.get_economic_events_calendar(limit=PAGE_SIZE, offset=page * PAGE_SIZE)
            if frame is None:
                raise ValueError("Calendar returned no response")
            if not frame.empty and "Event Time" not in frame.columns:
                raise ValueError("Calendar event times missing")
            for name, row in frame.iterrows():
                record = _yahoo_row(name, row, as_of)
                if record is None:
                    warnings.append("EVENT_CALENDAR_INVALID_DATE:yahoo")
                    yahoo_status = "partial"
                elif record["time_utc"] is None:
                    warnings.append("EVENT_CALENDAR_TIME_UNVERIFIED:yahoo")
                    yahoo_status = "partial"
                if record and start <= record["date"] <= end:
                    events.append(record)
            if len(frame) < PAGE_SIZE:
                break
        else:
            yahoo_status = "partial"
            warnings.append("EVENT_CALENDAR_TRUNCATED:yahoo")
        if not events and yahoo_status == "success":
            yahoo_status = "empty"
    except Exception as exc:
        yahoo_status = "partial" if events else "unavailable"
        error = type(exc).__name__
        warnings.append("EVENT_CALENDAR_UNAVAILABLE:yahoo" if not events else "EVENT_CALENDAR_PARTIAL:yahoo")
    evidence.append({"source": "yahoo_calendar", "status": yahoo_status, "error": error,
                     "retrieved_at": retrieved, "content": f"Economic calendar {start} to {end}: {yahoo_status}; {len(events)} rows"})
    fred_events = []
    try:
        get_api_key()
        truncated = False
        for page in range(MAX_PAGES):
            payload = _request("releases/dates", {
                "realtime_start": trade_date, "realtime_end": end,
                "include_release_dates_with_no_data": "true", "order_by": "release_date", "sort_order": "asc",
                "limit": PAGE_SIZE, "offset": page * PAGE_SIZE,
            })
            rows = payload.get("release_dates")
            if not isinstance(rows, list):
                raise ValueError("Invalid FRED release calendar response")
            for row in rows:
                date, name = row.get("date", ""), row.get("release_name", "")
                if trade_date <= date <= end:
                    fred_events.append({"source": "fred_calendar", "event": name, "date": date,
                        "time_utc": None, "time_precision": "date only", "phase": "scheduled date",
                        "region": "", "period": "", "expected": "", "previous": "", "actual": "",
                        "revised_from": "", "surprise": None, "surprise_unit": None,
                        "priority": "major indicator" if IMPORTANT.search(name) else "other",
                        "url": f"https://fred.stlouisfed.org/release?rid={row.get('release_id', '')}"})
            if len(rows) < PAGE_SIZE:
                break
        else:
            truncated = True
        fred_status = "partial" if truncated else "success" if fred_events else "empty"
        if truncated:
            warnings.append("EVENT_CALENDAR_TRUNCATED:fred")
        error = None
    except Exception as exc:
        fred_status = "partial" if fred_events else "unavailable"
        error = type(exc).__name__
        warnings.append("EVENT_CALENDAR_UNAVAILABLE:fred")
    events.extend(fred_events)
    evidence.append({"source": "fred_calendar", "status": fred_status, "error": error,
                     "retrieved_at": datetime.now(timezone.utc).isoformat(),
                     "content": f"FRED release dates {trade_date} to {end}: {fred_status}; {len(fred_events)} rows"})
    unique = {(r["source"], r["event"], r["region"], r["period"], r["time_utc"] or r["date"]): r for r in events}
    events = sorted(unique.values(), key=lambda r: (r["date"], r["time_utc"] or "", r["event"]))
    available = any(r["status"] in ("success", "empty", "partial") for r in evidence)
    status = "unavailable" if not available else "partial" if warnings else "success" if events else "empty"
    if not available:
        warnings.append("EVENT_CALENDAR_UNAVAILABLE")
    out = [f"## Economic catalysts — {start} to {end}",
           f"Retrieval cutoff: {as_of.isoformat()}. Calendar coverage: {status}.",
           "Actual minus consensus is a numeric surprise, not an automatic bullish/bearish signal.",
           "Values are the latest retrieved snapshot, not archived pre-release forecasts. Do not backtest them as such.",
           "FRED supplements release dates only; it has no consensus or exact release time here.",
           "Time-unverified entries have no surprise calculation. Cross-provider entries may refer to the same event.",
           "Political events not listed here may still matter; use the collected news with explicit source uncertainty."]
    today = as_of.tz_convert(ZoneInfo("America/New_York")).date().isoformat()
    recent = [r for r in events if r["phase"] == "released"]
    upcoming = [r for r in events if r["phase"] != "released" and r["date"] >= today]
    for title, rows in (("Upcoming / time-unverified events", upcoming), ("Recent published figures", recent)):
        rows = sorted(rows, key=lambda r: (r["priority"] != "major indicator", r["date"] if title.startswith("Upcoming") else -int(r["date"].replace("-", ""))))
        out += [f"### {title}", "| Event | Region | Date/time | Expected | Previous | Actual | Surprise | Source |",
                "| --- | --- | --- | --- | --- | --- | --- | --- |"]
        for r in rows[:25]:
            values = [r["event"], r["region"], r["time_utc"] or f"{r['date']} ({r['time_precision']})",
                      r["expected"], r["previous"], r["actual"],
                      f"{r['surprise']:+g} {r['surprise_unit']}" if r["surprise"] is not None else "unavailable", r["url"]]
            out.append("| " + " | ".join(str(v or "unavailable").replace("|", "\\|").replace("\n", " ") for v in values) + " |")
        out.append(f"Shown {min(25, len(rows))} of {len(rows)} retrieved entries; full records saved.")
    out += [f"- {r['source']}: {r['status']}" for r in evidence]
    return {"data": {"status": status, "as_of_utc": as_of.isoformat(), "start": start, "end": end,
                     "events": events, "sources": evidence},
            "report": "\n".join(out), "evidence": evidence, "warnings": list(dict.fromkeys(warnings))}
