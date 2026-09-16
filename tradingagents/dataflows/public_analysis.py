"""Deterministic cross-series diagnostics with exact-date operand lineage."""

from calendar import monthrange
from collections import defaultdict
from datetime import date

from .public_data_common import evidence, is_percentage, number, period_date
from .public_evidence import evidence_id, source_tables


def operand(row):
    return {key: row.get(key) for key in (
        "source", "target", "value", "unit", "basis", "observed_at", "published_at", "accession",
    )} | {"evidence_id": row.get("evidence_id") or evidence_id(row)}


def calculated(source, target, rows, value, unit, formula, *, kind="level", title=None):
    """A derived value keeps every input's source, date, unit and reference ID."""
    last = rows[-1]
    known_dates = [r.get("published_at") for r in rows]
    return evidence(
        source, target, f"Calculated {title or target}: {value:.8g} {unit}. Formula: {formula}.",
        last.get("url"), observed_at=last.get("observed_at"),
        published_at=max(known_dates) if all(known_dates) else None,
        value=value, unit=unit, kind=kind, frequency=last.get("frequency"),
        basis=last.get("basis"), title=title or target, sectors=last.get("sectors", []),
        evidence_type="derived_indicator", operands=[operand(r) for r in rows],
        base_target=last.get("base_target") or last["target"],
        source_tables=sorted({table for row in rows for table in source_tables(row)}),
        point_in_time=all(r.get("point_in_time", False) for r in rows),
        note="Calculated from aligned observations, not an independent provider release or causal forecast.",
    )


def _unique_points(rows):
    """Conflicting same-date values are not silently resolved by row order."""
    dates = defaultdict(list)
    for row in rows:
        observed = period_date(row.get("observed_at"))
        if row.get("status") == "success" and observed and number(row.get("value")) is not None:
            dates[observed].append(row)
    return {day: batch[0] for day, batch in dates.items()
            if len({(number(r["value"]), r.get("unit"), r.get("basis")) for r in batch}) == 1}


def build_diagnostics(rows):
    grouped = defaultdict(list)
    for row in rows:
        if row.get("status") == "success" and row.get("evidence_type") != "derived_indicator":
            grouped[(row["source"], row["target"])].append(row)
    result = []
    for source, left, right, name in (
        ("nyfed", "SOFR", "EFFR", "SOFR minus EFFR"),
        ("fred", "DGS10", "DGS2", "10y minus 2y Treasury yield"),
    ):
        a = _unique_points(grouped.get((source, left), []))
        b = _unique_points(grouped.get((source, right), []))
        for day in sorted(a.keys() & b.keys()):
            x, y = a[day], b[day]
            if x.get("unit", "").casefold() != y.get("unit", "").casefold():
                continue
            if "percent" not in x.get("unit", "").casefold() and x.get("unit") != "%":
                continue
            result.append(calculated(source, "derived/" + name, [y, x],
                                     float(x["value"]) - float(y["value"]),
                                     "percentage points", left + " - " + right,
                                     kind="spread", title=name))
    # Sum monthly net securities TRANSACTIONS only. No holdings, valuation
    # changes, weekly/monthly overlap, or annualized economic levels enter this.
    for (source, target), batch in grouped.items():
        if source not in {"tic", "mof_japan"} or not batch or batch[0].get("frequency") != "M":
            continue
        if source == "tic" and batch[0].get("metric") != "Net U.S. Sales":
            continue
        if source == "mof_japan" and batch[0].get("kind") != "flow":
            continue
        points = _unique_points(batch)
        if not points:
            continue
        last = max(points)
        index = last.year * 12 + last.month - 1
        for months in (3, 12):
            dates = [date((index - n) // 12, (index - n) % 12 + 1, 1)
                     for n in reversed(range(months))]
            if not all(day in points for day in dates):
                continue
            inputs = [points[day] for day in dates]
            if len({(r.get("unit"), r.get("basis")) for r in inputs}) != 1:
                continue
            result.append(calculated(source, f"derived/{target}/{months}m net transactions",
                                     inputs, sum(float(r["value"]) for r in inputs),
                                     inputs[-1]["unit"], f"sum of {months} consecutive monthly net transactions",
                                     kind="flow"))
    result.extend(_calendar_changes(grouped))
    result.extend(_nominal_real_changes(result))
    return result


def _calendar_changes(grouped):
    """Turn comparable industry/credit histories into exact-endpoint diagnostics.

    No ratios between unrelated index bases, inventory months from arbitrary
    indexes, sums of annualized levels, or inferred causal turning points.
    """
    result = []
    for (source, target), batch in grouped.items():
        if source not in {"census", "bea", "bls", "eurostat", "customs", "kosis", "bis", "tic"}:
            continue
        points = _unique_points(batch)
        if not points:
            continue
        day = max(points)
        latest = points[day]
        if latest.get("frequency") not in {"M", "Q", "A"}:
            continue
        months = {"M": (1, 3, 12), "Q": (3, 12), "A": (12,)}[latest["frequency"]]
        gaps = []
        for lag in months:
            index = day.year * 12 + day.month - 1 - lag
            year, month = index // 12, index % 12 + 1
            prior_day = date(year, month, min(day.day, monthrange(year, month)[1]))
            prior = points.get(prior_day)
            if prior is None:
                gaps.append(f"{lag}m change unavailable: missing exact comparison period {prior_day}.")
                continue
            if not latest.get("unit") or any(prior.get(k) != latest.get(k) for k in ("unit", "basis", "frequency")):
                gaps.append(f"{lag}m change unavailable: units or basis differ.")
                continue
            absolute = float(latest["value"]) - float(prior["value"])
            percent = not is_percentage(latest) and latest.get("kind", "level") in {"level", "index"} and float(prior["value"]) > 0
            value = absolute / float(prior["value"]) * 100 if percent else absolute
            unit = "percent" if percent else "percentage points" if is_percentage(latest) else latest["unit"]
            row = calculated(source, f"derived/{target}/{lag}m change", [prior, latest], value, unit,
                             "(current / prior - 1) * 100" if percent else "current - prior",
                             kind="rate" if unit in {"percent", "percentage points"} else latest.get("kind", "level"),
                             title=f"{latest.get('title') or target}: {lag}m change")
            row.update(base_target=target, comparison_months=lag, country=latest.get("country"),
                       metric=latest.get("metric"), dimensions=latest.get("dimensions", {}))
            result.append(row)
        if gaps:
            latest["calculation_gaps"] = gaps
    return result


def _nominal_real_changes(rows):
    """Matched BEA consumption growth gap; not a price index or volume estimate."""
    grouped = defaultdict(dict)
    for row in rows:
        target = row.get("base_target", "").split("/")
        if row["source"] != "bea" or len(target) != 4 or target[1] not in {"T20305", "T20306"} or row.get("unit") != "percent":
            continue
        grouped[(target[2], target[3], row["observed_at"], row["comparison_months"])][target[1]] = row
    result = []
    for (line, frequency, _day, months), pair in grouped.items():
        if set(pair) != {"T20305", "T20306"}:
            continue
        nominal, real = pair["T20305"], pair["T20306"]
        if nominal.get("title") != real.get("title"):
            continue
        row = calculated("bea", f"derived/nominal-real/{line}/{frequency}/{months}m", [real, nominal],
                         nominal["value"] - real["value"], "percentage points",
                         "nominal consumption growth minus real consumption growth", kind="spread",
                         title=f"{nominal['title']}: nominal-real growth gap")
        row["note"] += " A growth-rate gap, not an exact price deflator or issuer sales attribution; chain-dollar components are not additive."
        result.append(row)
    return result


def baseline_overlap_report(state, rows):
    """Disclose overlapping baseline series without parsing or guessing values.

    Raw baseline FRED records are report strings, not normalized observations.
    Consequently they are not silently overwritten or asserted to agree.
    """
    official = {r["target"] for r in rows if r["source"] == "fred" and r.get("status") == "success"}
    overlap = sorted({r.get("series_id") for r in state.get("global_evidence", [])
                      if r.get("source") == "fred" and r.get("series_id") in official})
    if not overlap:
        return ""
    return (
        "Overlapping baseline/official FRED IDs: " + ", ".join(overlap) + ". "
        "These are repeated views of the SAME series, not independent confirmation. "
        "For numerical history use the structured official observations with their observation/vintage dates; "
        "a different date, vintage, unit or value is a discrepancy to explain, not a value to average."
    )
