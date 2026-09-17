"""Keyless Kalshi market data. Discover related series, then inspect open contracts."""

import json
import math
import re
from datetime import datetime, timezone
from urllib.parse import quote

from .retry import request_get

API_BASE = "https://external-api.kalshi.com/trade-api/v2"


def _request(path, params):
    response = request_get(f"{API_BASE}/{path}", params=params, timeout=15)
    data = response.json()
    if not isinstance(data, dict) or not isinstance(data.get(path), list):
        raise ValueError(f"Invalid Kalshi {path} response")
    return data


def _terms(text):
    return {
        word.rstrip("s")
        for word in re.findall(r"[^\W_]+", text.lower())
        if not word.isdigit()
        and len(word) > 2
        and word not in {"the", "will", "for", "and", "above", "below", "than"}
    }


def _number(value):
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise ValueError("Invalid Kalshi numeric value")
    return number


def get_prediction_markets(topic: str, limit: int | None = None, offset: int = 0) -> str:
    """Return related live contracts, not an exact natural-language search.

    An exact provider category selects that category; otherwise search titles/tags.
    The public API has no free-text filter;
    numeric/date conditions must be checked against each returned contract.
    HTTP and schema errors propagate to the existing optional-vendor router.
    """
    limit = 6 if limit is None else limit
    if not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("limit must be between 1 and 100")
    if not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be nonnegative")
    terms = _terms(topic)
    if not terms:
        raise ValueError("Provide a descriptive event topic")
    now = datetime.now(timezone.utc)
    series = _request("series", {"include_volume": "true"})["series"]
    categories = {category for item in series
                  for category in [item.get("category"), *(item.get("categories") or [])] if category}
    category = next((c for c in categories if c.casefold() == topic.strip().casefold()), None)
    matches = []
    for item in series:
        words = _terms(
            " ".join(
                [item["title"], item["ticker"], item.get("category", ""),
                 *(item.get("categories") or []), *(item.get("tags") or [])]
            )
        )
        score = (int(category in [item.get("category"), *(item.get("categories") or [])])
                 if category else len(terms & words))
        if score:
            matches.append((score, _number(item.get("volume_fp") or 0), item))
    active = set()
    activity_coverage = ""
    if category:
        # ponytail: one open-event page for priority, not a full exchange-wide activity index.
        events = _request("events", {"status": "open", "limit": 200})
        active = {event["series_ticker"] for event in events["events"]}
        activity_coverage = "Prioritized series confirmed in one page of open events; other series activity is unverified.\n"
    matches.sort(key=lambda row: (-row[0], row[2]["ticker"] not in active, -row[1], row[2]["ticker"]))
    # ponytail: six series/two contract pages per call; series offsets allow focused follow-up.
    selected = matches[offset:offset + 6]
    candidates, truncated, skipped = {}, offset > 0 or len(matches) > len(selected), 0
    for _, _, item in selected:
        cursor = ""
        for _ in range(2):
            data = _request(
                "markets",
                {"series_ticker": item["ticker"], "status": "open", "limit": 100, "cursor": cursor},
            )
            for market in data["markets"]:
                try:
                    close = datetime.fromisoformat(market["close_time"].replace("Z", "+00:00"))
                    if market["status"] not in {"open", "active"} or close <= now:
                        continue
                    bid = _number(market["yes_bid_dollars"])
                    ask = _number(market["yes_ask_dollars"])
                    volume = _number(market["volume_fp"])
                    recent = _number(market["volume_24h_fp"])
                    interest = _number(market["open_interest_fp"])
                    if not 0 < bid <= ask < 1 or recent == 0:
                        continue
                    candidates[market["ticker"]] = (recent, volume, interest, bid, ask, market, item)
                except (KeyError, ValueError, TypeError):
                    skipped += 1
            cursor = data.get("cursor")
            if not cursor:
                break
        truncated = truncated or bool(cursor)
    next_offset = offset + len(selected)
    coverage = (
        f"Series offset {offset}; "
        + (f"continue with offset={next_offset}. " if next_offset < len(matches) else "end of matching series. ")
    )
    if truncated or skipped or not matches:
        coverage = "DATA_PARTIAL: Discovery is bounded; absence is not proof that no matching event exists.\n" + coverage
    if not matches:
        coverage += "No series keyword match. Retry with a specific event or provider category: " + ", ".join(sorted(categories)) + ". "
    header = (
        coverage + "\n" + activity_coverage
        + f'## Kalshi prediction markets: "{topic}"\n'
        f"Retrieved {now.isoformat()}. Live data, not historical evidence.\n"
        f"{'Provider category ' + category if category else 'Related series keyword search'}: inspected {len(selected)}/{len(matches)} matching series; "
        f"coverage {'partial (request cap reached)' if truncated else 'limited to matching series'}. "
        f"Skipped {skipped} malformed contracts.\n"
        "Contracts may differ from the requested event or date; check their wording. "
        "YES bid/ask are market-implied prices, not a confidence interval. "
        "Volume/open interest count contracts, not dollars or unique participants. "
        "High volume does not guarantee accuracy; wide spreads weaken the signal. "
        "Only future open contracts with two-sided quotes and trading in the last 24h are shown.\n\n"
    )
    if not candidates:
        return (
            header
            + "No open prediction markets with usable quotes and recent trading found in the inspected scope."
        )
    lines = []
    for recent, volume, interest, bid, ask, market, item in sorted(
        candidates.values(), key=lambda row: (row[0], row[1]), reverse=True
    )[:limit]:
        source = f"{API_BASE}/markets/{quote(market['ticker'], safe='')}"
        conditions = "\n".join(
            f"  {label}: {market[key]}" for key, label in (
                ("subtitle", "Contract subtitle"), ("yes_sub_title", "YES subtitle"),
                ("no_sub_title", "NO subtitle"), ("rules_primary", "Settlement rules"),
                ("rules_secondary", "Additional rules"), ("expected_expiration_time", "Expected settlement"),
            ) if market.get(key)
        )
        if market.get("custom_strike"):
            conditions += "\n  Strike: " + json.dumps(market["custom_strike"], ensure_ascii=False)
        if not market.get("rules_primary"):
            conditions += "\n  Settlement rules unavailable; verify the contract before interpreting its prices."
        lines.append(
            f"- **{market.get('title') or item['title']}** — YES bid {bid:.1%}, ask {ask:.1%}, "
            f"spread {(ask - bid) * 100:.1f}pp; 24h {recent:,.2f} contracts, "
            f"total {volume:,.2f}, open interest {interest:,.2f}; "
            f"closes {market['close_time']}. Source: {source}\n"
            f"  Series: {item['title']}; event: {market.get('event_ticker', 'not supplied')}.\n{conditions}"
        )
    return header + "\n".join(lines) + "\n"
