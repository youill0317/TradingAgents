"""A fixed global baseline using the existing Yahoo and FRED clients."""

import math
import os
import re
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from datetime import datetime, timezone
from urllib.parse import quote

import pandas as pd

from .fred import get_macro_data
from .stockstats_utils import load_ohlcv

# ETF returns are USD investor proxies, not local-index returns or fund flows.
GLOBAL_ASSETS = (
    ("SPY", "US equity ETF", "USD"),
    ("EZU", "Eurozone equity ETF", "USD"),
    ("EWU", "UK equity ETF", "USD"),
    ("MCHI", "China equity ETF", "USD"),
    ("EWJ", "Japan equity ETF", "USD"),
    ("EWY", "Korea equity ETF", "USD"),
    ("INDA", "India equity ETF", "USD"),
    ("EEM", "Emerging markets aggregate equity ETF", "USD"),
    ("EURUSD=X", "Euro FX; USD per EUR", "USD/EUR"),
    ("GBPUSD=X", "Sterling FX; USD per GBP", "USD/GBP"),
    ("JPY=X", "Yen FX; JPY per USD", "JPY/USD"),
    ("CNY=X", "Yuan FX; CNY per USD", "CNY/USD"),
    ("KRW=X", "Won FX; KRW per USD", "KRW/USD"),
    ("INR=X", "Rupee FX; INR per USD", "INR/USD"),
    ("IEF", "US 7-10 year Treasury ETF; price, not yield", "USD"),
    ("BWX", "International government bond ETF; price, not yield", "USD"),
    ("EMB", "USD emerging market sovereign bond ETF", "USD"),
    ("GC=F", "Gold futures proxy", "USD/troy oz"),
    ("CL=F", "WTI oil futures proxy", "USD/barrel"),
    ("HG=F", "Copper futures proxy", "USD/lb"),
)

# IDs verified against https://fred.stlouisfed.org/series/<ID>.
# None means no series selected, not that the economic indicator does not exist.
REGIONAL_MACRO = {
    "US": ("GDPC1", "CPIAUCSL", "UNRATE", "FEDFUNDS"),
    "Eurozone": ("CLVMNACSCAB1GQEA19", "CP0000EZ19M086NEST", "LRHUTTTTEZM156S", "ECBDFR"),
    "UK": ("NGDPRSAXDCGBQ", "GBRCPIALLMINMEI", "LRHUTTTTGBM156S", None),
    "China": ("NGDPRXDCCNA", "CHNCPIALLMINMEI", None, None),
    "Japan": ("JPNRGDPEXP", "JPNCPIALLMINMEI", "LRHUTTTTJPM156S", "IRSTCB01JPM156N"),
    "Korea": ("NGDPRSAXDCKRQ", "KORCPIALLMINMEI", "LRHUTTTTKRM156S", None),
    "India": ("NGDPRNSAXDCINQ", "INDCPIALLMINMEI", None, "IRSTCB01INM156N"),
    "Emerging markets aggregate": (None, None, None, None),
}
MACRO_FIELDS = ("real GDP", "consumer prices", "unemployment", "policy rate")
US_FINANCIAL_SERIES = ("M2SL", "DGS2", "DGS10", "T10Y2Y", "VIXCLS", "DTWEXBGS")
RESERVE_SERIES = {
    "UK": "TRESEGGBM052N", "China": "TRESEGCNM052N", "Japan": "TRESEGJPM052N",
    "Korea": "TRESEGKRM052N", "India": "TRESEGINM052N",
}


def _asset_observation(asset, trade_date):
    symbol, label, unit = asset
    record = {
        "source": "yfinance", "target": symbol, "status": "success",
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "url": f"https://finance.yahoo.com/quote/{quote(symbol, safe='')}/",
    }
    try:
        data = load_ohlcv(symbol, trade_date).copy()
        data["Date"] = pd.to_datetime(data["Date"]).dt.tz_localize(None)
        data["Close"] = pd.to_numeric(data["Close"], errors="coerce")
        data = data[data["Date"] <= pd.Timestamp(trade_date)].dropna(subset=["Date", "Close"])
        data = data.sort_values("Date").drop_duplicates("Date", keep="last")
        if data.empty:
            record.update(status="empty", content=f"{label}: no price observations")
            return record
        latest = data.iloc[-1]
        last_date = latest["Date"]
        last_close = float(latest["Close"])
        if not math.isfinite(last_close) or last_close <= 0:
            raise ValueError("invalid latest price")
        record["observed_at"] = last_date.strftime("%Y-%m-%d")
        record["returns"] = {}
        record["return_start_dates"] = {}
        missing = []
        for name, offset in (("1w", pd.Timedelta(days=7)), ("1mo", pd.DateOffset(months=1)), ("3mo", pd.DateOffset(months=3))):
            # Prior session at/before the calendar boundary, never a shorter window.
            cutoff = last_date - offset
            baseline = data[data["Date"] <= cutoff]
            value = None
            if not baseline.empty:
                row = baseline.iloc[-1]
                base = float(row["Close"])
                if math.isfinite(base) and base > 0 and (cutoff - row["Date"]).days <= 7:
                    value = (last_close / base - 1) * 100
                    record["return_start_dates"][name] = row["Date"].strftime("%Y-%m-%d")
            record["returns"][name] = value
            if value is None:
                missing.append(name)
        record["content"] = (
            f"{label} ({symbol}), quote unit {unit}; latest {last_close:g} on "
            f"{record['observed_at']}; "
            + "; ".join(f"{k}: {v:+.2f}%" if v is not None else f"{k}: unavailable" for k, v in record["returns"].items())
            + f"; return start dates: {record['return_start_dates']}"
        )
        if missing:
            record.update(status="partial", warning=f"{symbol}: insufficient history for {', '.join(missing)}")
    except Exception as exc:
        # Provider exceptions can contain credential-bearing request URLs.
        record.update(status="failed", content=f"{label} ({symbol}): {type(exc).__name__}")
    return record


def _macro_observation(target, series, trade_date):
    record = {
        "source": "fred", "target": target, "series_id": series, "status": "unavailable",
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
    }
    if series is None:
        record["content"] = f"{target}: no comparable series selected in the fixed baseline"
        return record
    record["url"] = f"https://fred.stlouisfed.org/series/{series}"
    if not os.getenv("FRED_API_KEY"):
        record["content"] = f"{target}: FRED_API_KEY is not configured"
        return record
    try:
        # Annual GDP needs more than one observation; preserve native frequency/units.
        content = get_macro_data(series, trade_date, look_back_days=3 * 365)
        record["content"] = f"### {target}\nSource: {record['url']}\n{content}"
        if "No observations" in content:
            record["status"] = "empty"
        elif "**Latest:**" not in content:
            record["status"] = "failed"
        else:
            record["status"] = "success"
            match = re.search(r"\*\*Latest:\*\*[^\n]*?\((\d{4}-\d{2}-\d{2})\)", content)
            if match:
                record["observed_at"] = match.group(1)
                # Age refers to the observation period, not a guessed publication date.
                max_age = next((
                    days for frequency, days in (("Daily", 10), ("Weekly", 21), ("Quarterly", 240), ("Annual", 800))
                    if f"- Frequency: {frequency}" in content
                ), 180)
                if (pd.Timestamp(trade_date) - pd.Timestamp(match.group(1))).days > max_age:
                    record["status"] = "stale"
                    record["content"] += "\nSTALE: observation is too old to describe current conditions."
    except Exception as exc:
        record.update(status="failed", content=f"{target}: {type(exc).__name__}")
    return record


def _report_content(item):
    """Keep full evidence on disk, but only four macro table rows in model context."""
    content = item["content"]
    if item["source"] != "fred":
        return content
    lines = content.splitlines()
    observation_rows = [i for i, line in enumerate(lines) if re.match(r"\| \d{4}-\d{2}-\d{2} \|", line)]
    if len(observation_rows) <= 4:
        return content
    omitted = set(observation_rows[:-4])
    return "\n".join(line for i, line in enumerate(lines) if i not in omitted) + "\n(Model context shows four latest rows; full returned table retained in evidence.)"


def collect_global_snapshot(trade_date: str) -> dict:
    """Collect bounded, deterministic evidence; a provider failure remains visible."""
    pd.Timestamp(trade_date)
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(copy_context().run, _asset_observation, asset, trade_date) for asset in GLOBAL_ASSETS]
        futures += [
            pool.submit(copy_context().run, _macro_observation, f"{region}: {field}", series, trade_date)
            for region, series_ids in REGIONAL_MACRO.items()
            for field, series in zip(MACRO_FIELDS, series_ids, strict=True)
        ]
        futures += [pool.submit(copy_context().run, _macro_observation, f"US: {series}", series, trade_date) for series in US_FINANCIAL_SERIES]
        futures += [pool.submit(copy_context().run, _macro_observation, f"{region}: reserves excluding gold", series, trade_date) for region, series in RESERVE_SERIES.items()]
        evidence = [future.result() for future in futures]
    warnings = [item.get("warning", f"{item['target']}: {item['status']}") for item in evidence if item["status"] != "success"]
    report = (
        f"## Global market baseline as of {trade_date}\n"
        "Equity/bond ETFs are USD investor proxies, not local indexes or measured capital flows. "
        "Futures are contract price proxies, not spot prices. FX quote directions are explicit. "
        "Return windows end on each asset's latest observation; dates can differ across assets. "
        "A current-day bar can still be intraday. Macro observation dates are not publication dates; "
        "compare changes within each series, not differently scaled GDP/CPI levels across countries. "
        "China GDP is annual and India GDP is not seasonally adjusted. Eurozone series use their "
        "published country composition. Emerging markets are an ETF aggregate, not a country. "
        "Reserves exclude gold; reserve changes include valuation effects, not only transactions. "
        "STALE observations are historical context only: do not describe them as current conditions. "
        "International capital flows and comprehensive global reserve coverage are not provided.\n\n"
        + "\n\n".join(f"[{item['status']}] {_report_content(item)}" for item in evidence)
    )
    session = next((item.get("observed_at") for item in evidence if item["target"] == "SPY"), None)
    return {"report": report, "evidence": evidence, "warnings": warnings, "effective_market_session": session}
