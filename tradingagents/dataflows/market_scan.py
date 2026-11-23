"""Market-wide scan vendor: US sector rotation from the SPDR sector ETFs (Yahoo).

The per-ticker pipeline answers "is this one name a buy?". The market scan
answers what the market as a whole and each US sector are doing.
``get_sector_performance`` ranks the sector ETFs against SPY so rotation is
visible at a glance. It goes through ``load_ohlcv``, so it inherits the
existing cache and the curr_date look-ahead filter.
"""

import logging
import math
from datetime import datetime

import pandas as pd

from .errors import NoMarketDataError
from .vendors.yahoo.ohlcv import load_ohlcv

logger = logging.getLogger(__name__)

# SPDR sector ETFs. Yahoo's own sector objects (``yf.Sector``) expose weights and
# constituents but no return figure, so performance comes from these instead.
SECTOR_ETFS = {
    "Technology": "XLK",
    "Financial Services": "XLF",
    "Energy": "XLE",
    "Healthcare": "XLV",
    "Consumer Cyclical": "XLY",
    "Consumer Defensive": "XLP",
    "Industrials": "XLI",
    "Basic Materials": "XLB",
    "Real Estate": "XLRE",
    "Utilities": "XLU",
    "Communication Services": "XLC",
}

# Broad-market references shown alongside the sectors, in display order. SPY is
# also the relative baseline, but it is looked up by name, so reordering this
# only reorders the table.
BENCHMARKS = ("SPY", "QQQ", "IWM")

# The eleven sectors every scan must give a verdict on.
VALID_SECTORS = tuple(SECTOR_ETFS)

MIN_LOOKBACK_DAYS = 5
MAX_LOOKBACK_DAYS = 252


def _pct_return(symbol: str, curr_date: str, look_back_days: int) -> float | None:
    """Percent return for ``symbol`` over the trailing window, or None if unavailable.

    A single missing sector must not abort the whole table, so this degrades to
    None and lets the caller render "n/a" — but it never fails silently: the
    reason is logged, so a broken cache dir or auth problem stays visible
    instead of masquerading as a quiet market.
    """
    try:
        data = load_ohlcv(symbol, curr_date)
    except Exception as exc:
        logger.warning("Sector return unavailable for %s: %s", symbol, exc)
        return None
    if data.empty or "Close" not in data.columns:
        return None

    data = data.copy()
    data["Date"] = pd.to_datetime(data["Date"]).dt.tz_localize(None)
    data = data[data["Date"] <= pd.Timestamp(curr_date)].sort_values("Date")
    data = data.drop_duplicates("Date", keep="last")
    cutoff = pd.Timestamp(curr_date) - pd.Timedelta(days=look_back_days)
    baseline = data[data["Date"] <= cutoff]
    if baseline.empty or data.empty:
        return None
    first_row, last_row = baseline.iloc[-1], data.iloc[-1]
    # Allow weekends/holidays at the boundary, never a shorter history.
    if (cutoff - first_row["Date"]).days > 7 or last_row["Date"] <= cutoff:
        return None
    first, last = float(first_row["Close"]), float(last_row["Close"])
    if not all(math.isfinite(v) and v > 0 for v in (first, last)):
        return None
    return (last / first - 1) * 100


def get_sector_performance(
    curr_date: str,
    look_back_days: int = 30,
) -> str:
    """Rank the SPDR sector ETFs by trailing return, relative to SPY.

    Args:
        curr_date: End of the window (yyyy-mm-dd). Rows after it are filtered
            out upstream by ``load_ohlcv``, so a past date stays honest.
        look_back_days: Trailing window length in days.

    Returns:
        A markdown report with a broad-market table and a sector table sorted
        best-to-worst, including each sector's spread versus SPY.
    """
    datetime.strptime(curr_date, "%Y-%m-%d")  # validate early, fail loudly
    if not MIN_LOOKBACK_DAYS <= int(look_back_days) <= MAX_LOOKBACK_DAYS:
        raise ValueError(
            f"look_back_days must be between {MIN_LOOKBACK_DAYS} and "
            f"{MAX_LOOKBACK_DAYS}"
        )

    bench = {sym: _pct_return(sym, curr_date, look_back_days) for sym in BENCHMARKS}
    spy = bench.get("SPY")

    rows = []
    for sector, etf in SECTOR_ETFS.items():
        ret = _pct_return(etf, curr_date, look_back_days)
        rows.append((sector, etf, ret))

    # Every sector failing means the data path is broken, not that the market is
    # quiet — raise so the router surfaces it instead of printing an empty table.
    if all(ret is None for _, _, ret in rows):
        raise NoMarketDataError(
            "sector ETFs", detail=f"no usable OHLCV for any sector ETF as of {curr_date}"
        )

    # Sort best-to-worst; unavailable sectors sink to the bottom.
    rows.sort(key=lambda r: (r[2] is None, -(r[2] or 0)))

    def fmt(v):
        return f"{v:+.2f}%" if v is not None else "n/a"

    out = [
        f"## Sector performance ({look_back_days}d trailing, as of {curr_date})",
        "",
        "### Broad market",
        "",
        "| Index | Symbol | Return |",
        "| --- | --- | --- |",
    ]
    labels = {"SPY": "S&P 500", "QQQ": "Nasdaq 100", "IWM": "Russell 2000"}
    for sym in BENCHMARKS:
        out.append(f"| {labels[sym]} | {sym} | {fmt(bench.get(sym))} |")

    out += [
        "",
        "### Sectors (best to worst)",
        "",
        "| Rank | Sector | ETF | Return | vs SPY |",
        "| --- | --- | --- | --- | --- |",
    ]
    for i, (sector, etf, ret) in enumerate(rows, start=1):
        rel = fmt(ret - spy) if (ret is not None and spy is not None) else "n/a"
        out.append(f"| {i} | {sector} | {etf} | {fmt(ret)} | {rel} |")

    out += [
        "",
        "_Leadership is the top of this table; the `vs SPY` column separates a "
        "sector that is genuinely leading from one merely riding the index._",
    ]
    return "\n".join(out)

