"""Read the collected official evidence without another provider request."""

from datetime import date
from typing import Annotated

from langchain_core.tools import tool
from langgraph.prebuilt import InjectedState

from tradingagents.dataflows.public_data import render_public_data
from tradingagents.dataflows.public_data_common import number, period_date
from tradingagents.dataflows.public_evidence import coverage_report, evidence_id


@tool
def get_official_evidence(
    source: str,
    state: Annotated[dict, InjectedState],
    query: str = "",
    offset: int = 0,
    limit: int = 8,
    observations: int = 13,
    start_date: str = "",
    end_date: str = "",
    observation_offset: int = 0,
) -> str:
    """Inspect collected official series or filing excerpts. Use source='all' to list sources.

    query matches an exact ev-ID, or a series ID/title/target. offset and limit paginate matching
    series (not observations). observations controls numeric history per series
    (1 to 60). start_date/end_date are inclusive YYYY-MM-DD observation-date
    bounds, not release dates. observation_offset skips newest matching numeric
    observations per series, allowing older history pages. No fresh network data or
    missing credentials are fetched. Empty query lists the first matching series.
    """
    rows = state.get("public_data_evidence", [])
    if not rows:
        return "Official evidence was not collected for this run."
    sources = sorted({r["source"] for r in rows})
    if source == "all":
        return "Collected sources: " + ", ".join(sources) + "\n" + coverage_report(rows)
    if source not in sources:
        return "Source not collected. Available: " + ", ".join(sources)
    try:
        lower = date.fromisoformat(start_date) if start_date else None
        upper = date.fromisoformat(end_date) if end_date else None
    except ValueError:
        return "Invalid date: use YYYY-MM-DD."
    if lower and upper and lower > upper:
        return "Invalid date range: start_date must not exceed end_date."
    query = query.casefold()
    matched = [
        r
        for r in rows
        if r["source"] == source
        and (query == (r.get("evidence_id") or evidence_id(r))
             or query in (str(r.get("target", "")) + " " + str(r.get("title", ""))).casefold())
    ]
    if lower or upper:
        matched = [r for r in matched if (day := period_date(r.get("observed_at")))
                   and (not lower or day >= lower) and (not upper or day <= upper)]
    targets = list(dict.fromkeys(r["target"] for r in matched))
    start, size = max(0, offset), max(1, min(limit, 12))
    selected = set(targets[start : start + size])
    if not selected:
        return f"No series on this page. Matching series: {len(targets)}."
    selected_rows = [r for r in matched if r["target"] in selected]
    history = []
    page_rows = []
    count = max(1, min(observations, 60))
    skip = max(0, observation_offset)
    for target in targets[start : start + size]:
        numeric = [
            r for r in selected_rows if r["target"] == target and r.get("status") == "success"
            and number(r.get("value")) is not None and period_date(r.get("observed_at"))
        ]
        numeric.sort(key=lambda r: period_date(r.get("observed_at")))
        if numeric:
            end = max(0, len(numeric) - skip)
            page = numeric[max(0, end - count):end]
            page_rows.extend(page)
            history.append(
                target
                + f" ({len(numeric)} matching observations; "
                + (f"next observation_offset={skip + len(page)}" if end > count else "end of history")
                + "; date: value; units/basis as above): "
                + ", ".join(
                    f"[{r.get('evidence_id') or evidence_id(r)}] {r['observed_at']}: {r['value']}"
                    for r in page
                )
            )
        page_rows.extend(r for r in selected_rows if r["target"] == target and r not in numeric)
    return (
        f"Series {start + 1}–{min(start + size, len(targets))} of {len(targets)}; next offset={start + size}.\n"
        + render_public_data(page_rows, max_chars=22000)
        + "\nSelected observations (observation dates, not publication dates):\n"
        + "\n".join(history)
    )
