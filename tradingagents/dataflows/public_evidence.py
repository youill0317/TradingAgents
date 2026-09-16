"""Coverage, immutable snapshot reuse and auditable official-evidence references.

These helpers do not call providers or infer unknown release dates. Cache hits
retain the original retrieval time and version; failure results are not cached.
"""

import copy
import hashlib
import json
import re
import time
from collections import OrderedDict, defaultdict
from concurrent.futures import Future
from datetime import date
from threading import RLock

from .public_data_common import failure, number, period_date

_REFERENCE = re.compile(r"\bev-[0-9a-f]{16}\b")
_THRESHOLDS = {"D": 14, "W": 28, "M": 100, "Q": 200, "A": 550}
_REPORT_FIELDS = (
    "news_report", "fundamentals_report", "macro_report", "sector_report",
    "investment_debate_state", "investment_plan", "trader_investment_plan",
    "risk_debate_state", "market_bull_case", "market_bear_case",
    "market_bull_rebuttal", "market_bear_rebuttal", "market_draft_report",
    "market_risk_review", "market_scan_report",
)


def evidence_id(row):
    """Identify the observation and its version, not the time it was downloaded."""
    fields = (
        "source", "target", "observed_at", "published_at", "status", "value",
        "unit", "basis", "period_start", "period_end", "accession", "vintage_date",
        "content", "url", "operands",
    )
    identity = {key: row.get(key) for key in fields}
    identity["value"] = number(row.get("value")) if number(row.get("value")) is not None else row.get("value")
    payload = json.dumps(identity, sort_keys=True,
                         ensure_ascii=False, default=str, separators=(",", ":"))
    return "ev-" + hashlib.sha256(payload.encode()).hexdigest()[:16]


def source_tables(row):
    """Original table families, including pre-lineage saved derived observations."""
    explicit = row.get("source_tables")
    if isinstance(explicit, (list, tuple)) and explicit:
        return tuple(sorted({str(table) for table in explicit if table}))
    target = str(row.get("base_target") or row.get("target", ""))
    if target.startswith("derived/"):
        target = target[len("derived/"):]
    parts = target.split("/")
    if row.get("source") == "bea":
        if parts[0] == "nominal-real":
            return ("NIPA/T20305", "NIPA/T20306")
        return ("/".join(parts[:2]),)
    return (str(row.get("table_id") or parts[0]),)


def require_series(source, rows, expected, url=None):
    """Retain successes and explicitly represent each missing requested series."""
    found = {row["target"] for row in rows if row.get("status") == "success"
             and number(row.get("value")) is not None}
    failures = {row["target"] for row in rows if row.get("status") != "success"}
    return [*rows, *[
        failure(source, target, "Requested series returned no usable numerical observations.",
                status="empty", url=url, coverage_gap=True)
        for target in expected if target not in found and target not in failures
    ]]


def require_dimensions(source, rows, expected, url=None):
    """Check a declared request universe, not just whether any row succeeded.

    ``expected`` maps diagnostic labels to required dimension values. Absence
    is a coverage gap, never a zero or an inferred not-applicable observation.
    Providers must exclude structurally inapplicable combinations from this
    request specification rather than guessing applicability from a null cell.
    """
    result = list(rows)
    good = [r for r in rows if r.get("status") == "success" and number(r.get("value")) is not None]
    for label, dimensions in expected.items():
        explicit_gap = any(r.get("status") != "success" and
                           all(r.get(k) == v for k, v in dimensions.items()) for r in rows)
        if not explicit_gap and not any(all(r.get(k) == v for k, v in dimensions.items()) for r in good):
            result.append(failure(
                source, label, "Requested item returned no usable observations; applicability is unverified.",
                status="empty", url=url, coverage_gap=True, **dimensions,
            ))
    return result


def refresh_frequency(row):
    explicit = row.get("refresh_frequency") or row.get("frequency")
    if explicit in _THRESHOLDS:
        return explicit
    if row.get("source") in {"sec", "dart"} and row.get("evidence_type") in {
        "financial_fact", "derived_financial",
    }:
        # No unconditional 'fresh' state for instant or YTD accounts.
        return "A" if str(row.get("form", "")).startswith(("20-F", "40-F")) else "Q"
    label = str(row.get("observed_at") or "")
    if re.fullmatch(r"\d{4}[-]?Q[1-4]", label):
        return "Q"
    if re.fullmatch(r"\d{4}", label):
        return "A"
    if re.fullmatch(r"\d{6}|\d{4}-\d{2}|\d{4}M\d{1,2}", label):
        return "M"
    if re.fullmatch(r"\d{8}|\d{4}-\d{2}-\d{2}", label):
        return "D"
    return None


def assess_evidence(rows, trade_date):
    """Assign stable IDs and warn on latest-series quality, not old history rows."""
    day = date.fromisoformat(str(trade_date))
    latest = {}
    warnings = []
    for row in rows:
        row["evidence_id"] = evidence_id(row)
        if row.get("status") != "success":
            detail = f"{row['target']}: " if row.get("coverage_gap") else ""
            warnings.append(f"{row['source']}: {detail}{row['content']}")
            continue
        if number(row.get("value")) is None:
            continue
        observed = period_date(row.get("observed_at"))
        row["freshness"] = "unknown"
        if not observed:
            warnings.append(f"PUBLIC_DATE_UNKNOWN:{row['source']}:{row['target']}")
            continue
        age = (day - observed).days
        row["observation_age_days"] = age
        if age < 0:
            row.update(status="unavailable_as_of", freshness="future", stale=True)
            row["evidence_id"] = evidence_id(row)
            warnings.append(f"PUBLIC_FUTURE_OBSERVATION:{row['source']}:{row['target']}")
            continue
        frequency = refresh_frequency(row)
        if frequency:
            row["refresh_frequency"] = frequency
            row["stale"] = age > _THRESHOLDS[frequency]
            row["freshness"] = "stale" if row["stale"] else "current"
        key = (row["source"], row["target"], row.get("unit"), row.get("basis"))
        if key not in latest or observed > period_date(latest[key]["observed_at"]):
            latest[key] = row
    for row in latest.values():
        if row.get("stale"):
            warnings.append(f"PUBLIC_STALE:{row['source']}:{row['target']}:{row['observed_at']}")
        elif row.get("freshness") == "unknown":
            warnings.append(f"PUBLIC_FRESHNESS_UNKNOWN:{row['source']}:{row['target']}")
    return list(dict.fromkeys(warnings))


def coverage_report(rows):
    """Compact, deterministic coverage summary shared by both workflow families."""
    sources = defaultdict(lambda: {"series": set(), "missing": set(), "stale": set()})
    latest = {}
    for row in rows:
        group = sources[row["source"]]
        if row.get("status") != "success":
            group["missing"].add(row["target"])
        elif number(row.get("value")) is not None:
            group["series"].add(row["target"])
            key = (row["source"], row["target"])
            if key not in latest or (period_date(row.get("observed_at")) or date.min) > (period_date(latest[key].get("observed_at")) or date.min):
                latest[key] = row
    for row in latest.values():
        if row.get("stale"):
            sources[row["source"]]["stale"].add(row["target"])
    return "Official coverage (a successful source does not imply all requested series succeeded):\n" + "\n".join(
        f"- {source}: {len(group['series'])} numerical series; "
        f"{len(group['missing'])} gaps; {len(group['stale'])} latest series stale."
        for source, group in sources.items()
    )


def cited_evidence_report(state, rows, max_chars=8000):
    """Rehydrate exact upstream citations outside the general summary budget.

    Only explicit ev-IDs in upstream analysis are treated as citations. Merely
    collecting or looking up a source is not evidence that an analyst used it.
    """
    text = "\n".join(json.dumps(state.get(key, ""), ensure_ascii=False, default=str)
                     for key in _REPORT_FIELDS)
    requested = list(dict.fromkeys(_REFERENCE.findall(text)))
    if not requested:
        if any(state.get(key) for key in _REPORT_FIELDS) and any(number(r.get("value")) is not None for r in rows):
            return "NO_OFFICIAL_CITATIONS: upstream reports contain no exact official observation IDs. Numerical use and analytical coverage remain unverified."
        return ""
    by_id = {row.get("evidence_id") or evidence_id(row): row for row in rows}
    missing = [key for key in requested if key not in by_id]
    lines = ["Exact evidence cited upstream (not new observations):"]
    if missing:
        lines.append("UNRESOLVED_EVIDENCE_REFERENCES: " + ", ".join(missing[:20]))
    selected = [key for key in requested if key in by_id]
    # Derived observations carry IDs for their numerical operands as well.
    for key in selected:
        if len(selected) >= 256:
            break
        for operand in by_id[key].get("operands", []):
            ref = operand.get("evidence_id")
            if ref in by_id and ref not in selected:
                selected.append(ref)
    omitted = 0
    used = sum(map(len, lines))
    for key in selected:
        row = by_id[key]
        if number(row.get("value")) is not None:
            content = f"{row['value']} {row.get('unit', '')}; basis={row.get('basis', 'unspecified')}"
        else:
            content = str(row.get("content", ""))[:700] + " [bounded excerpt]"
        line = (
            f"[{key}] {row['source']}/{row['target']}: {content}; "
            f"observed={row.get('observed_at')}; published={row.get('published_at')}; "
            f"retrieved={row.get('retrieved_at')}; status={row.get('status')}; "
            f"freshness={row.get('freshness', 'unknown')}; {row.get('url') or ''}"
        )
        if used + len(line) > max_chars:
            omitted += 1
            continue
        lines.append(line)
        used += len(line) + 1
    if omitted:
        lines.append(f"{omitted} cited records omitted by audit budget; do not claim they were verified.")
    return "\n".join(lines)


class SnapshotCache:
    """Bounded in-process cache; concurrent callers share one in-flight fetch."""

    def __init__(self, max_entries=32):
        self.max_entries = max_entries
        self._entries = OrderedDict()
        self._pending = {}
        self._lock = RLock()

    def collect(self, key, ttl, loader):
        if ttl <= 0:
            return loader()
        now = time.monotonic()
        with self._lock:
            for expired in [k for k, (created, _) in self._entries.items() if now - created >= ttl]:
                self._entries.pop(expired)
            if key in self._entries:
                self._entries.move_to_end(key)
                return copy.deepcopy(self._entries[key][1])
            owner = key not in self._pending
            if owner:
                self._pending[key] = Future()
            future = self._pending[key]
        if not owner:
            return copy.deepcopy(future.result())
        try:
            rows = loader()
            # A partial failure is retryable on the next run. Keep successes for
            # this run, but do not cache an apparently complete source snapshot.
            if rows and all(row.get("status") == "success" for row in rows):
                saved = copy.deepcopy(rows)
                snapshot = hashlib.sha256("|".join(evidence_id(r) for r in rows).encode()).hexdigest()[:20]
                for row in saved:
                    row["snapshot_id"] = snapshot
                # Bound aggregate cache memory as well as entry count.
                if len(json.dumps(saved, ensure_ascii=False, default=str).encode()) <= 8_000_000:
                    with self._lock:
                        self._entries[key] = (now, saved)
                        while len(self._entries) > self.max_entries:
                            self._entries.popitem(last=False)
                rows = saved
            future.set_result(copy.deepcopy(rows))
            return copy.deepcopy(rows)
        except Exception as exc:
            future.set_exception(exc)
            raise
        finally:
            with self._lock:
                self._pending.pop(key, None)


SNAPSHOTS = SnapshotCache()
