"""Market participation and rotation computed from the existing Yahoo price feed.

These are sector/ETF proxies, never constituent-level advance/decline breadth.
Comparisons share SPY's session and calendar boundaries; missing history is not
silently replaced by a shorter window.
"""
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from datetime import UTC, datetime

import numpy as np
import pandas as pd

from .market_scan import SECTOR_ETFS
from .vendors.yahoo.ohlcv import load_ohlcv

WINDOWS = {"1w": pd.Timedelta(days=7), "1mo": pd.DateOffset(months=1), "3mo": pd.DateOffset(months=3)}
PROXIES = {"RSP": "equal-weight / cap-weight", "IWM": "small / large caps",
           "QQQ": "Nasdaq-100 / S&P 500", "HYG": "high-yield / investment-grade credit ETFs"}
SYMBOLS = tuple(dict.fromkeys(["SPY", "RSP", "IWM", "QQQ", "HYG", "LQD", *SECTOR_ETFS.values()]))


def _load(symbol, date):
    record = {"source": "yfinance", "target": symbol,
              "url": f"https://finance.yahoo.com/quote/{symbol}/",
              "retrieved_at": datetime.now(UTC).isoformat()}
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
    notes = ["Sector/ETF participation proxies, NOT counts of advancing stocks or measured capital flows.",
             "Returns use calendar 1w/1mo/3mo windows; moving averages use 50/200 observations."]
    rotation_notes = ["Rank change compares the same 1-month window one week apart; unavailable if coverage differs.",
                      "Weekly relative change compares two successive weekly spreads, not cumulative returns of different lengths."]
    breadth_lines = [f"- {w}: {b.get('positive', b.get('above'))}/{b['observed']} observed sectors positive/above MA; universe {b['total']}"
                     for w, b in breadth.items()]
    table = ["| Sector | 1w | 1mo | 3mo | vs SPY 1w / 1mo / 3mo (pp) | weekly spread change (pp) | rank change | observation |",
             "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for r in sorted(sectors, key=lambda r: r.get("rank_1mo", 99)):
        relative = " / ".join("n/a" if r["relative_spy_pp"][w] is None else f"{r['relative_spy_pp'][w]:+.2f}" for w in WINDOWS)
        table.append(f"| {r['sector']} | " + " | ".join(_fmt(r['returns'][w]) for w in WINDOWS)
                     + f" | {relative} | {r['weekly_relative_change_pp']} | {r['rank_change']} | {r['leadership']} |")
    ratio_lines = [f"- {r['pair']} ({r['meaning']}), ratio changes: " + ", ".join(f"{w} {_fmt(r['returns'][w])}" for w in WINDOWS)
                   for r in ratios]
    benchmark_lines = [f"- {symbol}: above MA50={m['above_ma50']}, MA200={m['above_ma200']}; "
                       f"drawdown from 63-session high {_fmt(m['drawdown_63_sessions_pct'])}; realized 20-session annualized volatility {_fmt(m['realized_vol_20_sessions_pct'])}"
                       for symbol, m in data["benchmarks"].items()]
    session = data["session"]
    credit_note = "Daily bars may be intraday. HYG/LQD includes duration effects; it is not a credit spread."
    out = [f"## Market internals and transitions — common session {session}", *notes, *rotation_notes, credit_note,
           *breadth_lines, "", *table, *ratio_lines, *benchmark_lines]
    # The market-wide half and the sector half, for the analyst of each.
    internals = [f"## US market internals — common session {session}", *notes, credit_note,
                 *breadth_lines, *ratio_lines, *benchmark_lines]
    rotation = [f"## US sector rotation — common session {session}", *notes, *rotation_notes, "", *table]
    sector_report = [f"## Sector performance (1mo calendar trailing, as of {data['session']})",
                     "### Sectors (best to worst)", "| Rank | Sector | ETF | Return | vs SPY |", "| --- | --- | --- | --- | --- |"]
    for i, row in enumerate(sorted(sectors, key=lambda r: r.get("rank_1mo", 99)), 1):
        sector_report.append(f"| {i} | {row['sector']} | {row['symbol']} | {_fmt(row['returns']['1mo'])} | {_fmt(row['relative_spy_pp']['1mo'])} |")
    for record in evidence:
        record["content"] = f"{record['target']}: {record['status']}; observed {record.get('observed_at')}; common session {data['session']}"
        record["metrics"] = metrics[record["target"]]
    return {"data": data, "report": "\n".join(out), "sector_report": "\n".join(sector_report),
            "internals_report": "\n".join(internals), "rotation_report": "\n".join(rotation),
            "evidence": evidence, "warnings": warnings}


# --- Index technicals: the indicators the ticker Market Analyst reads, for the indexes ---

INDEXES = {"SPY": "S&P 500", "QQQ": "Nasdaq 100", "IWM": "Russell 2000"}


def _fmt_level(value):
    return "n/a" if value is None or pd.isna(value) else f"{value:,.2f}"


def _fmt_count(value):
    return "n/a" if value is None or pd.isna(value) else f"{value:,.0f}"


def _index_technicals(symbol: str, date: str) -> str:
    """One index's trend, momentum, volume and support/resistance zones as of ``date``."""
    from stockstats import wrap

    frame = load_ohlcv(symbol, date).copy()
    frame["Date"] = pd.to_datetime(frame["Date"]).dt.tz_localize(None)
    frame = frame[frame["Date"] <= pd.Timestamp(date)].sort_values("Date").drop_duplicates("Date", keep="last")
    if len(frame) < 30:
        return f"- {symbol}: too little price history for technicals"
    stats = wrap(frame.reset_index(drop=True))
    last = stats.iloc[-1]
    close, volume = stats["close"].astype(float), stats["volume"].astype(float)
    direction = close.diff().apply(lambda d: 1 if d > 0 else -1 if d < 0 else 0)
    obv = (direction * volume).cumsum()

    def latest(name):
        try:
            return float(stats[name].iloc[-1])
        except Exception:
            return None

    smas = {n: (latest(f"close_{n}_sma") if len(stats) >= n else None) for n in (5, 20, 60, 200)}
    obv_change = obv.iloc[-1] - obv.iloc[-21] if len(obv) > 21 else None
    vol20, vol60 = volume.tail(20).mean(), volume.tail(60).mean() if len(volume) >= 60 else None
    up = volume[direction > 0].tail(20).mean()
    down = volume[direction < 0].tail(20).mean()
    spikes = stats.tail(60)[volume.tail(60) > 2 * volume.tail(60).median()]

    def zone(window):
        recent = stats.tail(window)
        return (f"{_fmt_level(recent['low'].min())} ({recent.loc[recent['low'].idxmin(), 'Date']:%Y-%m-%d}) to "
                f"{_fmt_level(recent['high'].max())} ({recent.loc[recent['high'].idxmax(), 'Date']:%Y-%m-%d})")

    lines = [
        f"- {symbol} ({INDEXES[symbol]}) on {last['Date']:%Y-%m-%d}: close {_fmt_level(last['close'])}; "
        + ", ".join(f"SMA{n} {_fmt_level(v)}" for n, v in smas.items()),
        f"  momentum: RSI {_fmt_level(latest('rsi'))}, MACD {_fmt_level(latest('macd'))} vs signal "
        f"{_fmt_level(latest('macds'))}, stochastic %K {_fmt_level(latest('kdjk'))}, Williams %R "
        f"{_fmt_level(latest('wr'))}, CCI {_fmt_level(latest('cci'))}, 10-day rate of change "
        f"{_fmt_level(latest('close_10_roc'))}%",
        f"  volume: 20-session average {_fmt_count(vol20)} vs 60-session {_fmt_count(vol60)}; "
        f"average volume on up days {_fmt_count(up)} vs down days {_fmt_count(down)} (last 20 sessions); "
        f"OBV change over 20 sessions {_fmt_count(obv_change)}; sessions above twice the 60-session median volume: "
        + (", ".join(f"{d:%Y-%m-%d}" for d in spikes["Date"]) or "none"),
        f"  ranges (low to high, with the dates that set them): 20 sessions {zone(20)}; 60 sessions {zone(60)}; "
        f"252 sessions {zone(252)}",
    ]
    return "\n".join(lines)


def collect_index_technicals(trade_date: str) -> str:
    """Trend, momentum, volume and range for SPY, QQQ and IWM, each as of ``trade_date``."""
    parts = ["## Index technicals",
             "Moving averages, RSI, MACD, stochastic, Williams %R, CCI and rate of change are all computed from the "
             "same closes: agreement among them is one piece of evidence. Ranges are observed lows and highs, not "
             "forecast support or resistance; daily bars may be intraday."]
    for symbol in INDEXES:
        try:
            parts.append(_index_technicals(symbol, trade_date))
        except Exception as exc:
            parts.append(f"- {symbol}: technicals unavailable ({type(exc).__name__})")
    return "\n".join(parts)
