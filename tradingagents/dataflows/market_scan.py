"""Market-wide scan vendor: sector rotation and equity screening (Yahoo).

The per-ticker pipeline answers "is this one name a buy?". This module answers
the question that comes *before* it: what is the market doing, and which names
deserve a look. Two functions:

- ``get_sector_performance`` ranks the SPDR sector ETFs against SPY so rotation
  is visible at a glance. It goes through ``load_ohlcv``, so it inherits the
  existing cache and the curr_date look-ahead filter.
- ``screen_equities`` wraps Yahoo's screener (``yf.screen``) to turn a set of
  criteria into an actual candidate list.

Both hit Yahoo's *unofficial* screener/quote endpoints, which can change or
throttle without notice; failures surface as ``VendorError`` so the routing
layer reports them rather than inventing data.
"""

import logging
import math
from datetime import datetime

import pandas as pd
import yfinance as yf
from yfinance import EquityQuery

from .errors import NoMarketDataError
from .stockstats_utils import load_ohlcv, yf_retry

logger = logging.getLogger(__name__)

# SPDR sector ETFs. Yahoo's own sector objects (``yf.Sector``) expose weights and
# constituents but no return figure, so performance comes from these instead.
# Keyed by the screener's sector label so a row can be traced back to a filter.
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

# Yahoo's screener sector vocabulary, kept as a module constant so a bad
# LLM-supplied sector is rejected with the valid list instead of 400ing Yahoo.
VALID_SECTORS = tuple(SECTOR_ETFS)

# Real US listings only. Without this, ``region=us`` returns OTC-quoted foreign
# ADRs that dominate any percent-change sort with illiquid noise (CSGYY +488%,
# FUWAF, KAKKF ...) and carry no sector at all.
US_EXCHANGES = ("NMS", "NYQ")

# Yahoo caps screener pages; keep requests well under it.
MAX_SCREEN_SIZE = 100
ALLOWED_SORT_FIELDS = ("percentchange", "intradaymarketcap", "dayvolume")
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

    cutoff = pd.to_datetime(curr_date) - pd.Timedelta(days=look_back_days)
    window = data[data["Date"] >= cutoff]
    # Fewer than two rows means no measurable change over the window.
    if len(window) < 2:
        return None
    first = float(window["Close"].iloc[0])
    last = float(window["Close"].iloc[-1])
    if first == 0:
        return None
    return (last - first) / first * 100


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


def _build_query(
    sector: str | None,
    min_market_cap: float,
    min_volume: float,
    min_price: float,
) -> EquityQuery:
    """Assemble the screener query, always constrained to real US listings."""
    clauses = [
        EquityQuery("eq", ["region", "us"]),
        # Non-negotiable: see US_EXCHANGES.
        EquityQuery("is-in", ["exchange", *US_EXCHANGES]),
        EquityQuery("gt", ["intradaymarketcap", min_market_cap]),
        EquityQuery("gt", ["dayvolume", min_volume]),
        EquityQuery("gt", ["intradayprice", min_price]),
    ]
    if sector:
        clauses.append(EquityQuery("eq", ["sector", sector]))
    return EquityQuery("and", clauses)


def resolve_sectors(sector: str | list[str] | None) -> list[str | None]:
    """Normalise the sector argument into a list of queries to run.

    ``None`` means one unsectored sweep. Anything else is validated against
    Yahoo's vocabulary and rejected with the valid list, rather than being
    passed through to 400 the API (mirrors ``fred._resolve_series_id``).

    Public, unlike its ``fred`` counterpart, because the CLI validates
    ``--sectors`` with it: catching a typo at parse time costs nothing, while
    letting it through burns an LLM turn discovering it via a tool error.
    """
    if sector is None:
        return [None]
    requested = [sector] if isinstance(sector, str) else list(sector)

    lookup = {s.lower(): s for s in VALID_SECTORS}
    resolved = []
    for raw in requested:
        canonical = lookup.get(str(raw).strip().lower())
        if canonical is None:
            raise ValueError(
                f"'{raw}' is not a valid sector. Choose from: "
                f"{', '.join(VALID_SECTORS)}."
            )
        resolved.append(canonical)
    return resolved


def screen_equities(
    sector: str | list[str] | None = None,
    min_market_cap: float = 1e10,
    min_volume: float = 1e6,
    min_price: float = 5.0,
    sort_field: str = "intradaymarketcap",
    limit: int = 25,
    curr_date: str | None = None,
) -> str:
    """Screen US-listed equities and return the matches as a markdown table.

    One query is issued per requested sector. That is deliberate: Yahoo leaves
    the ``sector`` field of every screener row empty, so the only reliable way
    to attribute a hit to a sector is to have asked for that sector.

    Args:
        sector: A sector name, a list of them, or None for a market-wide sweep.
        min_market_cap: Minimum intraday market cap (USD).
        min_volume: Minimum day volume (shares).
        min_price: Minimum share price, to drop sub-$5 names.
        sort_field: Screener field to rank by (e.g. ``percentchange``).
        limit: Maximum rows per sector.
        curr_date: The analysis date. Used only to warn when it is not today.

    Returns:
        A markdown report of the matches, ranked within each sector.
    """
    if curr_date:
        requested_date = datetime.strptime(curr_date, "%Y-%m-%d").date()
        today = datetime.now().date()
        if requested_date != today:
            raise ValueError(
                "UNSUPPORTED_HISTORICAL_UNIVERSE: Yahoo's screener is live-only; "
                f"it cannot produce a point-in-time universe for {curr_date}."
            )

    sectors = resolve_sectors(sector)
    if sort_field not in ALLOWED_SORT_FIELDS:
        raise ValueError(
            f"sort_field must be one of: {', '.join(ALLOWED_SORT_FIELDS)}"
        )
    for name, value in (
        ("min_market_cap", min_market_cap),
        ("min_volume", min_volume),
        ("min_price", min_price),
    ):
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{name} must be a finite non-negative number") from exc
        if not math.isfinite(number) or number < 0:
            raise ValueError(f"{name} must be a finite non-negative number")
    size = int(limit)
    if not 1 <= size <= MAX_SCREEN_SIZE:
        raise ValueError(f"limit must be between 1 and {MAX_SCREEN_SIZE}")

    header = [f"## Equity screen ({sort_field}, top {size} per sector)"]

    header.append(
        f"\n_Filters: US listings ({'/'.join(US_EXCHANGES)}), market cap > "
        f"${min_market_cap:,.0f}, volume > {min_volume:,.0f}, price > ${min_price:,.2f}._"
    )

    sections = []
    failures = []
    total = 0
    for sec in sectors:
        query = _build_query(sec, min_market_cap, min_volume, min_price)
        try:
            result = yf_retry(lambda q=query: yf.screen(
                q, size=size, sortField=sort_field, sortAsc=False
            ))
        except Exception as exc:
            # One sector failing should not lose the other ten.
            failures.append(exc)
            sections.append(f"\n### {sec or 'All sectors'}\n\n_Screen failed: {exc}_")
            continue

        quotes = (result or {}).get("quotes", []) or []
        title = sec or "All sectors"
        if not quotes:
            sections.append(f"\n### {title}\n\n_No matches._")
            continue

        total += len(quotes)
        lines = [
            f"\n### {title} ({len(quotes)} of {(result or {}).get('total', len(quotes))} matches)",
            "",
            "| Symbol | Name | Price | Change | Mkt cap | Volume | P/E |",
            "| --- | --- | --- | --- | --- | --- | --- |",
        ]
        for q in quotes:
            lines.append(
                "| {sym} | {name} | {price} | {chg} | {cap} | {vol} | {pe} |".format(
                    sym=q.get("symbol", "?"),
                    name=str(q.get("shortName") or q.get("displayName") or "")[:34],
                    price=_num(q.get("regularMarketPrice"), "${:,.2f}"),
                    chg=_num(q.get("regularMarketChangePercent"), "{:+.2f}%"),
                    cap=_compact(q.get("marketCap")),
                    vol=_compact(q.get("regularMarketVolume")),
                    pe=_num(q.get("trailingPE"), "{:.1f}"),
                )
            )
        sections.append("\n".join(lines))

    # The Sector Analyst is told to screen one sector per call, so this branch is
    # the normal path, not an edge case: reporting a vendor outage as "no
    # matches" would hand the analyst an empty screen it is told to treat as a
    # finding. Carry the real reason instead.
    if total == 0 and len(sectors) == 1:
        raise NoMarketDataError(
            sectors[0] or "market",
            detail=f"screener failed: {failures[0]}"
            if failures
            else "screener returned no matches",
        )

    return "\n".join(header + sections)


def _num(value, spec: str) -> str:
    """Format a numeric screener field, tolerating the Nones Yahoo mixes in."""
    try:
        return spec.format(float(value))
    except (TypeError, ValueError):
        return "n/a"


def _compact(value) -> str:
    """Render a large number as 1.2T / 34.5B / 890.1M so the table stays narrow."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return "n/a"
    for unit, scale in (("T", 1e12), ("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if abs(n) >= scale:
            return f"{n / scale:.1f}{unit}"
    return f"{n:.0f}"
