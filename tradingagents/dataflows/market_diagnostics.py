"""Market participation and rotation computed from the existing Yahoo price feed.

These are sector/ETF proxies, never constituent-level advance/decline breadth.
Comparisons share SPY's session and calendar boundaries; missing history is not
silently replaced by a shorter window.
"""
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .market_scan import SECTOR_ETFS
from .stockstats_utils import load_ohlcv

WINDOWS = {"1w": pd.Timedelta(days=7), "1mo": pd.DateOffset(months=1), "3mo": pd.DateOffset(months=3)}
PROXIES = {"RSP": "equal-weight / cap-weight", "IWM": "small / large caps",
           "QQQ": "Nasdaq-100 / S&P 500", "HYG": "high-yield / investment-grade credit ETFs"}
SYMBOLS = tuple(dict.fromkeys(["SPY", "RSP", "IWM", "QQQ", "HYG", "LQD", *SECTOR_ETFS.values()]))


def _load(symbol, date):
    record = {"source": "yfinance", "target": symbol,
              "url": f"https://finance.yahoo.com/quote/{symbol}/",
              "retrieved_at": datetime.now(timezone.utc).isoformat()}
    try:
        frame = load_ohlcv(symbol, date)
        dates = pd.to_datetime(frame["Date"]).dt.tz_localize(None).dt.normalize()
        prices = pd.to_numeric(frame["Close"], errors="coerce")
        series = pd.Series(prices.to_numpy(), index=dates).sort_index()
        series = series[~series.index.duplicated(keep="last")]
        series = series[series.index <= pd.Timestamp(date)]
        series = series.where(np.isfinite(series) & (series > 0))
        if series.empty or pd.isna(series.iloc[-1]):
            raise ValueError("No usable latest price")
        record.update(status="success", observed_at=series.index[-1].date().isoformat())
        return series, record
    except Exception as exc:
        record.update(status="failed", error=type(exc).__name__)
        return pd.Series(dtype=float), record


def window_return(series, end, offset):
    """Return percent plus actual start date, requiring a shared end session."""
    if end not in series.index or pd.isna(series.loc[end]):
        return None, None
    cutoff = end - offset
    before = series.loc[series.index <= cutoff]
    if before.empty:
        return None, None
    start = before.index[-1]
    if (cutoff - start).days > 7 or pd.isna(before.iloc[-1]):
        return None, None
    return float((series.loc[end] / before.iloc[-1] - 1) * 100), start.date().isoformat()


def _metrics(series, end):
    row = {"returns": {}, "start_dates": {}}
    for window, offset in WINDOWS.items():
        row["returns"][window], row["start_dates"][window] = window_return(series, end, offset)
    history = series.loc[series.index <= end]
    aligned = end in series.index and not pd.isna(series.loc[end])
    for n in (50, 200):
        valid = aligned and len(history) >= n and history.tail(n).notna().all()
        mean = float(history.tail(n).mean()) if valid else None
        row[f"above_ma{n}"] = bool(history.iloc[-1] > mean) if mean else None
    tail = history.tail(64)
    row["drawdown_63_sessions_pct"] = (
        float((tail.iloc[-1] / tail.max() - 1) * 100)
        if aligned and len(tail) == 64 and tail.notna().all() else None
    )
    tail = history.tail(21)
    row["realized_vol_20_sessions_pct"] = (
        float(tail.pct_change(fill_method=None).dropna().std(ddof=1) * np.sqrt(252) * 100)
        if aligned and len(tail) == 21 and tail.notna().all() else None
    )
    return row


def _fmt(value):
    return "n/a" if value is None else f"{value:+.2f}%"


def collect_market_diagnostics(trade_date):
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {symbol: pool.submit(copy_context().run, _load, symbol, trade_date) for symbol in SYMBOLS}
        loaded = {symbol: future.result() for symbol, future in futures.items()}
    prices = {symbol: result[0] for symbol, result in loaded.items()}
    evidence = [result[1] for result in loaded.values()]
    spy = prices["SPY"]
    if spy.empty or (pd.Timestamp(trade_date) - spy.index[-1]).days > 7:
        return {"report": "Market diagnostics unavailable: no current SPY reference session.",
                "sector_report": "DATA_UNAVAILABLE: no common reference session",
                "data": {"status": "unavailable"}, "evidence": evidence,
                "warnings": ["MARKET_DIAGNOSTICS_UNAVAILABLE"]}
    end = spy.index[-1]
    prior = spy.loc[spy.index <= end - pd.Timedelta(days=7)]
    prior_end = prior.index[-1] if not prior.empty else None
    metrics = {symbol: _metrics(series, end) for symbol, series in prices.items()}
    # Reject relative/rank comparisons across different starting sessions.
    for symbol, row in metrics.items():
        if symbol != "SPY":
            for window in WINDOWS:
                if row["start_dates"][window] != metrics["SPY"]["start_dates"][window]:
                    row["returns"][window] = None
    sectors = []
    for name, symbol in SECTOR_ETFS.items():
        row = {"sector": name, "symbol": symbol, **metrics[symbol]}
        row["relative_spy_pp"] = {
            w: row["returns"][w] - metrics["SPY"]["returns"][w]
            if row["returns"][w] is not None and metrics["SPY"]["returns"][w] is not None
            and row["start_dates"][w] == metrics["SPY"]["start_dates"][w] else None
            for w in WINDOWS
        }
        old_return = old_spy = old_month = None
        if prior_end is not None:
            old_return, old_start = window_return(prices[symbol], prior_end, WINDOWS["1w"])
            old_spy, spy_start = window_return(spy, prior_end, WINDOWS["1w"])
            if old_start != spy_start:
                old_return = None
            old_month, month_start = window_return(prices[symbol], prior_end, WINDOWS["1mo"])
            _, month_spy_start = window_return(spy, prior_end, WINDOWS["1mo"])
            if month_start != month_spy_start:
                old_month = None
        relative = row["relative_spy_pp"]["1w"]
        row["weekly_relative_change_pp"] = (relative - (old_return - old_spy)
            if relative is not None and old_return is not None and old_spy is not None else None)
        row["prior_month_return_pct"] = old_month
        week, month = row["relative_spy_pp"]["1w"], row["relative_spy_pp"]["1mo"]
        row["leadership"] = ("unavailable" if week is None or month is None else
            "short-term reversal up" if week > 0 and month <= 0 else
            "short-term reversal down" if week < 0 and month >= 0 else
            "leading" if week > 0 and month > 0 else "lagging" if week < 0 and month < 0 else "mixed")
        sectors.append(row)
    for key, field in (("returns", "rank_1mo"), ("prior_month_return_pct", "prior_rank_1mo")):
        ranked = sorted((r for r in sectors if (r["returns"]["1mo"] if key == "returns" else r[key]) is not None),
                        key=lambda r: -(r["returns"]["1mo"] if key == "returns" else r[key]))
        for rank, row in enumerate(ranked, 1):
            row[field] = rank
    comparable_ranks = all("rank_1mo" in r and "prior_rank_1mo" in r for r in sectors)
    for row in sectors:
        row["rank_change"] = row["prior_rank_1mo"] - row["rank_1mo"] if comparable_ranks else None
    breadth = {}
    for w in WINDOWS:
        valid = [r for r in sectors if r["returns"][w] is not None]
        breadth[w] = {"positive": sum(r["returns"][w] > 0 for r in valid), "observed": len(valid), "total": len(sectors)}
    for n in (50, 200):
        valid = [r for r in sectors if r[f"above_ma{n}"] is not None]
        breadth[f"ma{n}"] = {"above": sum(r[f"above_ma{n}"] for r in valid), "observed": len(valid), "total": len(sectors)}
    ratios = []
    for symbol, label in PROXIES.items():
        denominator = "LQD" if symbol == "HYG" else "SPY"
        aligned = pd.concat([prices[symbol], prices[denominator]], axis=1, keys=["a", "b"])
        ratio = aligned.a / aligned.b
        ratios.append({"pair": f"{symbol}/{denominator}", "meaning": label, **_metrics(ratio, end)})
    missing = [s for s, m in metrics.items() if any(v is None for v in m["returns"].values())]
    warnings = [f"MARKET_DIAGNOSTICS_PARTIAL:{','.join(missing)}"] if missing else []
    if any(v["observed"] < v["total"] for v in breadth.values()) and not warnings:
        warnings.append("MARKET_DIAGNOSTICS_PARTIAL:long-term history")
    data = {"status": "partial" if warnings else "success", "session": end.date().isoformat(),
            "prior_session": prior_end.date().isoformat() if prior_end is not None else None,
            "breadth": breadth, "sectors": sectors, "ratios": ratios,
            "benchmarks": {s: metrics[s] for s in ("SPY", "QQQ", "IWM")}}
    out = [f"## Market internals and transitions — common session {data['session']}",
           "Sector/ETF participation proxies, NOT counts of advancing stocks or measured capital flows.",
           "Returns use calendar 1w/1mo/3mo windows; moving averages use 50/200 observations.",
           "Rank change compares the same 1-month window one week apart; unavailable if coverage differs.",
           "Weekly relative change compares two successive weekly spreads, not cumulative returns of different lengths.",
           "Daily bars may be intraday. HYG/LQD includes duration effects; it is not a credit spread."]
    for w, b in breadth.items():
        out.append(f"- {w}: {b.get('positive', b.get('above'))}/{b['observed']} observed sectors positive/above MA; universe {b['total']}")
    out += ["", "| Sector | 1w | 1mo | 3mo | vs SPY 1w / 1mo / 3mo (pp) | weekly spread change (pp) | rank change | observation |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for r in sorted(sectors, key=lambda r: r.get("rank_1mo", 99)):
        relative = " / ".join("n/a" if r["relative_spy_pp"][w] is None else f"{r['relative_spy_pp'][w]:+.2f}" for w in WINDOWS)
        out.append(f"| {r['sector']} | " + " | ".join(_fmt(r['returns'][w]) for w in WINDOWS)
                   + f" | {relative} | {r['weekly_relative_change_pp']} | {r['rank_change']} | {r['leadership']} |")
    for r in ratios:
        out.append(f"- {r['pair']} ({r['meaning']}), ratio changes: " + ", ".join(f"{w} {_fmt(r['returns'][w])}" for w in WINDOWS))
    for symbol, m in data["benchmarks"].items():
        out.append(f"- {symbol}: above MA50={m['above_ma50']}, MA200={m['above_ma200']}; "
                   f"drawdown from 63-session high {_fmt(m['drawdown_63_sessions_pct'])}; realized 20-session annualized volatility {_fmt(m['realized_vol_20_sessions_pct'])}")
    sector_report = [f"## Sector performance (1mo calendar trailing, as of {data['session']})",
                     "### Sectors (best to worst)", "| Rank | Sector | ETF | Return | vs SPY |", "| --- | --- | --- | --- | --- |"]
    for i, row in enumerate(sorted(sectors, key=lambda r: r.get("rank_1mo", 99)), 1):
        sector_report.append(f"| {i} | {row['sector']} | {row['symbol']} | {_fmt(row['returns']['1mo'])} | {_fmt(row['relative_spy_pp']['1mo'])} |")
    for record in evidence:
        record["content"] = f"{record['target']}: {record['status']}; observed {record.get('observed_at')}; common session {data['session']}"
        record["metrics"] = metrics[record["target"]]
    return {"data": data, "report": "\n".join(out), "sector_report": "\n".join(sector_report),
            "evidence": evidence, "warnings": warnings}
