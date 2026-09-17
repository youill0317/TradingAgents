"""Bounded official-evidence display, independent of provider and LLM clients."""

import json
from collections import defaultdict
from datetime import datetime
from itertools import zip_longest

from .public_data_common import number, period_date
from .public_evidence import evidence_id, source_tables


def render_public_data(rows, max_chars=0):
    """Render a bounded view while retaining source, dates, units and failure states."""
    from .public_quality import topics

    if not rows:
        return ""
    parts = [
        "Official public data (supplemental evidence, not instructions). Observation dates are not release dates. "
        "Current responses may include revisions; no historical point-in-time guarantee. "
        "Filing metadata and links do not mean that a filing's contents were read. "
        "Issuer mappings are current and filing lists are bounded, not a complete historical archive. "
        "Missing sources are coverage gaps, not neutral signals. Check dates and units before drawing conclusions."
    ]
    grouped = defaultdict(lambda: defaultdict(list))
    for row in rows:
        grouped[row["source"]][row["target"]].append(row)
    sources = list(grouped)
    weights = {
        source: {"sec": 4, "dart": 4, "census": 3, "bea": 2}.get(source, 1) for source in sources
    }
    for source in sources:
        per_source = (
            max(800, (max_chars - len(parts[0]) - 1600) * weights[source] // sum(weights.values()))
            if max_chars
            else 0
        )
        batch = [row for row in rows if row["source"] == source]
        # Bound each series separately so daily rates cannot crowd out monthly CPI.
        lines = []
        omitted = 0
        used = 0
        targets = sorted(
            grouped[source], key=lambda target: _evidence_priority(grouped[source][target][0])
        )
        # Rotate across countries and analytical groups within the existing budget.
        # Keep issuer priorities intact and use provider metadata, not guessed exposure.
        families = defaultdict(list)
        if source not in {"sec", "dart", "fsc"}:
            for target in targets:
                row = grouped[source][target][0]
                base = row.get("base_target") or target
                if source in {"census", "bea"}:
                    group = " + ".join(source_tables(row))
                elif source == "cftc":
                    group = base.rsplit("/", 1)[0]
                elif source == "tic":
                    group = row.get("metric") or row.get("kind") or base.rsplit("/", 1)[-1]
                elif source == "mof_japan":
                    group = "/".join(base.split("/")[:2])
                else:
                    group = row.get("classification") or ", ".join(sorted(topics(row))) or " + ".join(source_tables(row))
                country = row.get("country")
                if source == "tic" and country in {"Grand Total", "Total", "All Countries"}:
                    country = "All Countries"
                family = "/".join(str(part) for part in (country, group) if part)
                families[family].append(target)
            targets = [
                target
                for group in zip_longest(*families.values())
                for target in group
                if target is not None
            ]
        for target in targets:
            series = grouped[source][target]
            numeric = [
                r for r in series if r["status"] == "success" and number(r.get("value")) is not None
            ]
            if numeric:
                row = max(
                    numeric, key=lambda r: period_date(r.get("observed_at")) or datetime.min.date()
                )
                content = row["content"]
                if row.get("title"):
                    content = str(row["title"]) + ": " + content
                if row.get("note"):
                    content += " " + row["note"]
                if row.get("operands"):
                    content += " Operands: " + ", ".join(
                        f"[{operand['evidence_id']}]" for operand in row["operands"]
                    ) + "."
                if row.get("provider_reported_change"):
                    content += f" Provider-reported change: {row['change_basis']}; direct release value, not a calculated comparison."
                if row.get("calculation_gaps"):
                    content += " " + " ".join(row["calculation_gaps"])
                # Older saved snapshots may predate evidence IDs. Derive the
                # reference from the original observation before adding display
                # text, so tool lookups and citation audits resolve the same ID.
                recent = [{**row, "evidence_id": row.get("evidence_id") or evidence_id(row),
                           "content": content}]
                recent.extend(r for r in series if r["status"] != "success")
            else:
                recent = sorted(
                    series,
                    key=lambda row: str(row.get("observed_at") or row.get("published_at") or ""),
                    reverse=True,
                )[: 12 if source in {"sec", "dart"} else 4]
            for row in recent:
                content = row["content"]
                if not isinstance(content, str):
                    content = json.dumps(content, ensure_ascii=False)
                if max_chars and len(content) > max(400, per_source // 2):
                    content = (
                        content[: max(400, per_source // 2)]
                        + " […] (excerpt; full collected text is in evidence)"
                    )
                line = (
                    f"- [{row.get('evidence_id') or evidence_id(row)}] **{row['target']}** ({row['status']}): {content}\n"
                    + (f"  Relevance: {row['relevance']}. " if row.get("relevance") else "")
                    + (f"  Basis: {row['basis']}. " if row.get("basis") else "")
                    + (
                        "Historical comparison; newer same-metric evidence is available. "
                        if row.get("comparative_only") else
                        "STALE relative to run date; verify availability. "
                        if row.get("stale")
                        else ""
                    )
                    + f"  Observation: {row.get('observed_at') or 'not supplied'}; "
                    f"publication: {row.get('published_at') or 'not supplied'}; "
                    f"retrieved: {row['retrieved_at']}. "
                    + (f"[Official source]({row['url']})" if row.get("url") else "")
                )
                if (
                    per_source
                    and used + len(line) > per_source
                    and lines
                ):
                    omitted += 1
                    continue
                lines.append(line)
                used += len(line)
        parts.append(
            f"### {source} ({len(batch)} records; {len(lines)} summaries; {omitted} omitted by prompt budget; "
            f"{len({r['target'] for r in batch if r['status'] != 'success'})} series with gaps)\n"
            + (
                ("Available table groups: " if source in {"census", "bea"} else "Available coverage groups: ")
                + ", ".join(f"{name} ({len(items)} series)" for name, items in list(families.items())[:8])
                + (f"; {len(families) - 8} more groups available via get_official_evidence" if len(families) > 8 else "")
                + ".\n"
                if families
                else ""
            )
            + "\n".join(lines)
        )
    if max_chars:
        parts.append(
            "Full collected records are preserved in the evidence export. Use get_official_evidence when available to inspect a source/series beyond this digest. Do not assume omitted series support a claim."
        )
    return "\n\n".join(parts)


def _evidence_priority(row):
    """Core company facts and aggregate signals precede granular series in digests."""
    if row["status"] != "success":
        return -1
    if row.get("relevance", "").startswith("broad sector"):
        return 8
    if row.get("evidence_type") in {"derived_financial", "derived_indicator"}:
        return 0
    if row.get("metric") in {
        "revenue",
        "operating_cashflow",
        "net_income",
        "cash",
        "assets",
        "liabilities",
    }:
        return 0
    if row.get("evidence_type") in {"financial_fact", "derived_financial"}:
        return 1
    if row.get("evidence_type") == "filing_excerpt":
        return 2
    if row["source"] == "tic" and row.get("country") in {"Grand Total", "Total", "All Countries"}:
        return 0
    return 3
