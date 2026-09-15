"""Shared SEC/DART financial calculations with accounting and version lineage.

Native facts are retained. Cross-filing YTD bridges and TTM are estimates with
explicit revision-alignment warnings, not assertions of restatement consistency.
"""

from collections import defaultdict
from datetime import date, timedelta

from .public_analysis import operand
from .public_data_common import evidence, number

IFRS_METRICS = {
    "Revenue": "revenue", "GrossProfit": "gross_profit",
    "OperatingIncomeLoss": "operating_income", "ProfitLossFromOperatingActivities": "operating_income",
    "ProfitLoss": "net_income", "CashFlowsFromUsedInOperatingActivities": "operating_cashflow",
    "PaymentsToAcquirePropertyPlantAndEquipment": "capital_expenditure",
    "CashAndCashEquivalents": "cash", "Assets": "assets", "Liabilities": "liabilities",
    "Equity": "equity", "Inventories": "inventory",
}
_FLOW_METRICS = {"revenue", "gross_profit", "operating_income", "net_income",
                 "operating_cashflow", "capital_expenditure"}
_CURRENCIES = {"USD", "KRW", "EUR", "JPY", "GBP"}


def dart_metric(account_id, detail):
    # Member/account-detail breakdowns cannot stand in for company totals.
    if str(detail or "").strip() not in {"", "-", "total"}:
        return None
    namespace, _, tag = str(account_id or "").partition("_")
    if namespace not in {"ifrs-full", "dart"}:
        return None
    return IFRS_METRICS.get(tag)


def _normal(row):
    r = dict(row)
    basis = r.get("basis", "")
    scope, _, duration = basis.partition("/")
    if scope not in {"CFS", "OFS"}:
        scope, duration = "issuer", basis
    r["reporting_scope"] = r.get("reporting_scope", scope)
    r["period_basis"] = r.get("period_basis", duration)
    if r["period_basis"] == "quarter YTD":
        r["period_basis"] = "quarter"
    if r.get("metric") in IFRS_METRICS:
        r["metric"] = IFRS_METRICS[r["metric"]]
    if r.get("source") == "dart":
        r["metric"] = r.get("metric") or dart_metric(r.get("account_id"), r.get("account_detail"))
    r["version_key"] = r.get("version_key") or (
        ((r.get("period_end"), r["accession"]),) if r.get("accession") else ()
    )
    return r


def _scope_basis(scope, period):
    return f"{scope}/{period}" if scope in {"CFS", "OFS"} else period


def _derived(ticker, metric, rows, value, period, start, end, formula, unit=None):
    first = rows[0]
    scope = first["reporting_scope"]
    currency = first["unit"]
    unit = unit or currency
    versions = tuple(sorted({version for r in rows for version in r["version_key"]}))
    inherited_warning = any(r.get("revision_alignment") == "unverified" for r in rows)
    mixed = len({version[1] for version in versions}) > 1 or inherited_warning
    publications = [r.get("published_at") for r in rows]
    result = evidence(
        first["source"], f"{ticker}/derived/{metric}/{_scope_basis(scope, period)}/{currency}",
        f"Calculated {metric}: {value:.8g} {unit}; {period}. Formula: {formula}.",
        first.get("url"), observed_at=end,
        published_at=max(publications) if all(publications) else None,
        value=value, unit=unit, basis=_scope_basis(scope, period), metric=metric,
        period_basis=period, reporting_scope=scope, period_start=start, period_end=end,
        frequency="A" if period == "annual" else "Q", refresh_frequency="Q",
        kind="rate" if unit == "percent" else "level", evidence_type="derived_financial",
        operands=[operand(r) for r in rows], version_key=versions,
        revision_alignment="unverified" if mixed else "same_accession",
        point_in_time=all(r.get("point_in_time", False) for r in rows),
        note=("Cross-filing estimate: operand dates and versions are retained; restatement alignment "
              "is unverified. Do not treat this as a directly reported or revision-consistent result."
              if mixed else "Calculated from same-accession facts; not a separately reported value."),
    )
    return result


def _quarters(rows, ticker):
    groups = defaultdict(list)
    for row in rows:
        if row.get("metric") in _FLOW_METRICS and row.get("period_start"):
            groups[(row["source"], row["metric"], row["unit"], row["reporting_scope"],
                    row.get("concept") or row.get("account_id"), row["period_start"])].append(row)
    reported = {(r["source"], r.get("metric"), r["unit"], r["reporting_scope"], r.get("period_end"))
                for r in rows if r["period_basis"] == "quarter"}
    result = []
    for batch in groups.values():
        by_end = defaultdict(list)
        for row in batch:
            by_end[row["period_end"]].append(row)
        points = {end: values[0] for end, values in by_end.items()
                  if len({(r["value"], r["version_key"]) for r in values}) == 1}
        ordered = sorted(points)
        for previous, current in zip(ordered, ordered[1:], strict=False):
            a, b = points[previous], points[current]
            key = (b["source"], b["metric"], b["unit"], b["reporting_scope"], current)
            delta = (date.fromisoformat(current) - date.fromisoformat(previous)).days
            if key in reported or not 60 <= delta <= 110:
                continue
            if b["period_basis"] not in {"half-year YTD", "nine-month YTD", "annual"}:
                continue
            start = (date.fromisoformat(previous) + timedelta(days=1)).isoformat()
            result.append(_derived(ticker, b["metric"], [a, b], b["value"] - a["value"],
                                   "quarter", start, current, "current YTD - preceding YTD"))
    return result


def _ttm(rows, ticker):
    groups = defaultdict(list)
    for r in rows:
        if r["period_basis"] == "quarter" and r.get("metric") in _FLOW_METRICS:
            groups[(r["source"], r["metric"], r["unit"], r["reporting_scope"])].append(r)
    result = []
    for batch in groups.values():
        by_end = defaultdict(list)
        for r in batch:
            by_end[r["period_end"]].append(r)
        points = [values[0] for _, values in sorted(by_end.items())
                  if len({(r["value"], r["period_start"], r["version_key"]) for r in values}) == 1]
        for index in range(3, len(points)):
            window = points[index - 3:index + 1]
            if any(not r.get("period_start") for r in window):
                continue
            if any(date.fromisoformat(b["period_start"]) != date.fromisoformat(a["period_end"]) + timedelta(days=1)
                   for a, b in zip(window, window[1:], strict=False)):
                continue
            length = (date.fromisoformat(window[-1]["period_end"]) - date.fromisoformat(window[0]["period_start"])).days + 1
            if not 330 <= length <= 400:
                continue
            result.append(_derived(ticker, window[-1]["metric"], window,
                                   sum(r["value"] for r in window), "TTM", window[0]["period_start"],
                                   window[-1]["period_end"], "sum of four contiguous fiscal quarters"))
    return result


def derive_metrics(rows, ticker):
    facts = []
    for row in rows:
        if row.get("status") != "success" or row.get("evidence_type") != "financial_fact":
            continue
        r = _normal(row)
        value = number(r.get("value"))
        if r.get("unit") not in _CURRENCIES or value is None or not r.get("period_end") or not r["version_key"]:
            continue
        r["value"] = value
        facts.append(r)
    quarters = _quarters(facts, ticker)
    ttm = _ttm([*facts, *quarters], ticker)
    groups = defaultdict(lambda: defaultdict(list))
    for r in [*facts, *quarters, *ttm]:
        if not r.get("metric"):
            continue
        key = (r["source"], r["unit"], r["reporting_scope"], r.get("period_start"),
               r["period_end"], r["period_basis"], r["version_key"])
        groups[key][r["metric"]].append(r)
    ratios = []
    for metrics in groups.values():
        unique = {name: batch[0] for name, batch in metrics.items()
                  if len({r["value"] for r in batch}) == 1}
        for name, left, right, ratio in (
            ("gross_margin", "gross_profit", "revenue", True),
            ("operating_margin", "operating_income", "revenue", True),
            ("net_margin", "net_income", "revenue", True),
            ("free_cashflow", "operating_cashflow", "capital_expenditure", False),
            ("liabilities_to_assets", "liabilities", "assets", True),
        ):
            if left not in unique or right not in unique:
                continue
            a, b = unique[left], unique[right]
            if ratio and b["value"] <= 0:
                continue
            if not ratio and b["value"] < 0:
                continue  # Unknown cash-flow sign convention; never use abs().
            value = a["value"] / b["value"] * 100 if ratio else a["value"] - b["value"]
            ratios.append(_derived(ticker, name, [a, b], value, a["period_basis"],
                                   a.get("period_start"), a["period_end"],
                                   f"{left} / {right} * 100" if ratio else f"{left} - {right}",
                                   unit="percent" if ratio else a["unit"]))
    return [*quarters, *ttm, *ratios]
