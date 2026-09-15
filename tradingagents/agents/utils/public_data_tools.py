"""Read the collected official evidence without another provider request."""

from typing import Annotated

from langchain_core.tools import tool
from langgraph.prebuilt import InjectedState

from tradingagents.dataflows.public_data import render_public_data
from tradingagents.dataflows.public_data_common import number, period_date


@tool
def get_official_evidence(
    source: str,
    state: Annotated[dict, InjectedState],
    query: str = "",
    offset: int = 0,
    limit: int = 8,
    observations: int = 13,
) -> str:
    """Inspect collected official series or filing excerpts. Use source='all' to list sources.

    query matches a series ID/title/target. offset and limit paginate matching
    series (not observations). observations controls recent numeric history per
    series (1 to 60); use 13 monthly points for a year. No fresh network data or
    missing credentials are fetched. Empty query lists the first matching series.
    """
    rows = state.get("public_data_evidence", [])
    if not rows:
        return "Official evidence was not collected for this run."
    sources = sorted({r["source"] for r in rows})
    if source == "all":
        return "Collected sources: " + ", ".join(sources)
    if source not in sources:
        return "Source not collected. Available: " + ", ".join(sources)
    query = query.casefold()
    matched = [
        r
        for r in rows
        if r["source"] == source
        and query in (str(r.get("target", "")) + " " + str(r.get("title", ""))).casefold()
    ]
    targets = list(dict.fromkeys(r["target"] for r in matched))
    start, size = max(0, offset), max(1, min(limit, 12))
    selected = set(targets[start : start + size])
    if not selected:
        return f"No series on this page. Matching series: {len(targets)}."
    selected_rows = [r for r in matched if r["target"] in selected]
    history = []
    for target in targets[start : start + size]:
        numeric = [
            r for r in selected_rows if r["target"] == target and number(r.get("value")) is not None
        ]
        numeric.sort(key=lambda r: period_date(r.get("observed_at")))
        if numeric:
            history.append(
                target
                + " (date: value; units/basis as above): "
                + ", ".join(
                    f"{r['observed_at']}: {r['value']}"
                    for r in numeric[-max(1, min(observations, 60)) :]
                )
            )
    return (
        f"Series {start + 1}–{min(start + size, len(targets))} of {len(targets)}; next offset={start + size}.\n"
        + render_public_data(selected_rows, max_chars=22000)
        + "\nRecent observations:\n"
        + "\n".join(history)
    )
