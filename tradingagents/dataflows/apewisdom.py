"""ApeWisdom stock discussion attention, with explicit provenance."""

import json
import math
import re

import requests

from .retry import request_get

from .date_window import is_live_date
from .public_data_common import evidence

APE_URL = "https://apewisdom.io/api/v1.0/filter/all-stocks"


def _count(value, *, signed=False):
    number = float(value)
    if not math.isfinite(number) or (number < 0 and not signed) or not number.is_integer():
        raise ValueError("Invalid message count")
    return int(number)


def collect_apewisdom(ticker, trade_date):
    """Current rolling 24h mentions; never substitute them for historical data."""
    target = ticker or "US stock discussion rankings"
    status, content = "unavailable", "Current snapshot unavailable for historical analysis."
    if not is_live_date(trade_date):
        return evidence("apewisdom", target, content, APE_URL, status=status)
    if ticker and not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", ticker):
        return evidence(
            "apewisdom", target, "No verified symbol mapping for this instrument.", APE_URL, status=status
        )
    try:
        selected, pages, page, fetched = [], 1, 1, 0
        # ponytail: cap ticker lookup at 10 pages; expose incomplete coverage rather than crawl indefinitely.
        while page <= min(pages, 10):
            response = request_get(f"{APE_URL}/page/{page}", timeout=15)
            payload = response.json()
            rows = payload["results"]
            pages = int(payload["pages"])
            if not isinstance(rows, list) or pages < 1:
                raise ValueError("Invalid ApeWisdom response")
            fetched += 1
            selected.extend(row for row in rows if not ticker or row["ticker"] == ticker)
            if ticker and selected:
                break
            page += 1
        records = []
        for row in selected:
            record = {
                "ticker": row["ticker"],
                "name": row.get("name"),
                "rank": _count(row["rank"]),
                "mentions": _count(row["mentions"]),
                "upvotes": _count(row["upvotes"], signed=True),
            }
            for field in ("rank_24h_ago", "mentions_24h_ago"):
                record[field] = None if row.get(field) is None else _count(row[field])
            records.append(record)
        if not ticker:
            ranked = sorted(records, key=lambda row: row["rank"])
            movers = sorted(
                (row for row in records if row["mentions_24h_ago"] is not None
                 and row["mentions"] > row["mentions_24h_ago"]),
                key=lambda row: row["mentions"] - row["mentions_24h_ago"], reverse=True,
            )[:5]
            climbers = sorted(
                (row for row in records if row["rank_24h_ago"] is not None
                 and row["rank_24h_ago"] > row["rank"]),
                key=lambda row: row["rank_24h_ago"] - row["rank"], reverse=True,
            )[:5]
            records = list({row["ticker"]: row for row in [*ranked[:10], *movers, *climbers]}.values())
        incomplete = pages > fetched and not (ticker and records)
        status = "partial" if incomplete else "success" if records else "empty"
        content = (
            "ApeWisdom: current rolling 24h stock discussion attention, not bullish/bearish sentiment. "
            "Upvotes is a signed provider score; negative values are retained. "
            "Mentions/upvotes are not unique investors or capital flows. Source data may overlap Reddit. Provider publication timestamp is unavailable; retrieval time is not proof "
            "of freshness. "
            + (
                "Top 10 plus largest absolute mention increases and rank gains in inspected pages. "
                if not ticker
                else ""
            )
            + f"Searched {fetched}/{pages} pages. "
            + (
                json.dumps(records)
                if records
                else "Ticker absent from inspected scope; do not infer zero mentions."
            )
        )
    except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
        status, content = "failed", f"ApeWisdom retrieval failed ({type(exc).__name__})."
    return evidence("apewisdom", target, content, APE_URL, status=status)
