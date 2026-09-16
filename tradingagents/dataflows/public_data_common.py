"""Small HTTP and evidence helpers for official public data feeds."""

import math
import re
import time
from datetime import date, datetime, timezone
from xml.etree import ElementTree

import requests


def _request(url, params=None, headers=None):
    """Bound requests; retry transient failures once without logging credential URLs."""
    for attempt in range(2):
        try:
            response = requests.get(url, params=params, headers=headers, timeout=(5, 20))
            if response.status_code in {429, 500, 502, 503, 504} and attempt == 0:
                time.sleep(1)
                continue
            response.raise_for_status()
            if len(response.content) > 25_000_000:
                raise ValueError("Official response exceeds the download bound")
            return response
        except (requests.Timeout, requests.ConnectionError):
            if attempt:
                raise
    raise RuntimeError("No official response")


def request_json(url, params=None, headers=None):
    return _request(url, params, headers).json()


def request_text(url, params=None, headers=None, encoding=None):
    response = _request(url, params, headers)
    if encoding:
        return response.content.decode(encoding)
    return response.content.decode("utf-8-sig")


def request_xml(url, params=None, headers=None):
    response = _request(url, params, headers)
    return ElementTree.fromstring(response.content)


def evidence(source, target, content, url, *, observed_at=None, published_at=None, **extra):
    return {
        "source": source,
        "target": target,
        "status": "success",
        "content": content,
        "url": url,
        "observed_at": observed_at,
        "published_at": published_at,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        **extra,
    }


def failure(source, target, message, *, status="error", url=None, **extra):
    return {**evidence(source, target, message, url, **extra), "status": status}


def collect_parts(source, parts):
    """One failed series must not discard other successful series from the agency."""
    result = []
    for target, collect in parts:
        try:
            rows = collect()
            result.extend(
                rows
                or [failure(source, target, "No usable observations returned.", status="empty")]
            )
        except Exception as exc:
            result.append(
                failure(
                    source,
                    target,
                    f"Collection failed ({type(exc).__name__}); check provider access and schema.",
                )
            )
    return result


def number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        numeric = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def period_date(period):
    """Comparable observation labels, not inferred publication dates."""
    value = str(period)
    month_match = re.fullmatch(r"(\d{4})M(\d{1,2})", value)
    if month_match:
        value = f"{month_match[1]}-{int(month_match[2]):02}"
    if re.fullmatch(r"\d{4}Q[1-4]", value):
        value = value[:4] + "-" + value[4:]
    if re.fullmatch(r"\d{4}-Q[1-4]", value):
        try:
            return date(int(value[:4]), 3 * int(value[-1]) - 2, 1)
        except ValueError:
            return None
    if re.fullmatch(r"\d{6}|\d{8}", value):
        value = value[:4] + "-" + value[4:6] + ("-" + value[6:] if len(value) == 8 else "")
    if re.fullmatch(r"\d{4}", value):
        value += "-01-01"
    elif re.fullmatch(r"\d{4}-\d{2}", value):
        value += "-01"
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def numeric_rows(
    source,
    target,
    points,
    url,
    *,
    trade_date,
    unit,
    frequency,
    country=None,
    sectors=(),
    kind="level",
    **extra,
):
    """Keep provider values and provenance; never turn missing values into zero."""
    cutoff = date.fromisoformat(trade_date)
    result = []
    for period, raw in points:
        observed = period_date(period)
        value = number(raw)
        if observed is None or observed > cutoff or value is None:
            continue
        result.append(
            evidence(
                source,
                target,
                f"{target}: {raw} {unit}",
                url,
                observed_at=str(period),
                value=value,
                raw_value=raw,
                unit=unit,
                frequency=frequency,
                country=country,
                sectors=list(sectors),
                kind=kind,
                point_in_time=False,
                **extra,
            )
        )
    return result


def is_percentage(row):
    """Percent levels (not percent changes) require percentage-point differences."""
    unit = str(row.get("unit") or "").strip().casefold()
    return row.get("kind") == "rate" or unit in {
        "%", "percent", "percentage", "연%", "연 %", "% per annum", "percent per annum",
    }
