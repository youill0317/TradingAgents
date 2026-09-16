"""Shared SEC/DART financial calculations with accounting and version lineage.

Native facts are retained. Cross-filing YTD bridges and TTM are estimates with
explicit revision-alignment warnings, not assertions of restatement consistency.
"""

from collections import defaultdict
from datetime import date, timedelta

from .public_analysis import operand
from .public_data_common import evidence, failure, number
from .public_evidence import evidence_id, refresh_frequency

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
CORE_FINANCIAL_METRICS = ("revenue", "net_income", "operating_cashflow", "assets", "liabilities")


def financial_coverage(rows, source, ticker):
    """Missing supported facts are visible gaps, not claims of issuer inapplicability."""
    present = {r.get("metric") for r in rows if r.get("status") == "success"
               and number(r.get("value")) is not None}
    return [failure(source, f"{ticker}/coverage/{metric}",
                    f"No supported standard {metric} fact was collected. Custom concepts or issuer applicability require filing review.",
                    status="empty", metric=metric, coverage_gap=True,
                    evidence_type="financial_coverage")
            for metric in CORE_FINANCIAL_METRICS if metric not in present]


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
    r["accounting_standard"] = r.get("accounting_standard") or (
        "ifrs-full" if r.get("source") == "dart" else "us-gaap"
    )
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
    cadences = {refresh_frequency(r) for r in rows}
    cadence = "Q" if "Q" in cadences else "A" if cadences == {"A"} else (
        "A" if period == "annual" else "Q"
    )
    result = evidence(
        first["source"], f"{ticker}/derived/{metric}/{_scope_basis(scope, period)}/{currency}/{first['accounting_standard']}",
        f"Calculated {metric}: {value:.8g} {unit}; {period}. Formula: {formula}.",
        first.get("url"), observed_at=end,
        published_at=max(publications) if all(publications) else None,
        value=value, unit=unit, basis=_scope_basis(scope, period), metric=metric,
        period_basis=period, reporting_scope=scope, period_start=start, period_end=end,
        accounting_standard=first["accounting_standard"],
        frequency="A" if period == "annual" else "Q", refresh_frequency=cadence,
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
                    row["accounting_standard"], row.get("concept") or row.get("account_id"), row["period_start"])].append(row)
    reported = {(r["source"], r.get("metric"), r["unit"], r["reporting_scope"], r["accounting_standard"], r.get("period_end"))
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
            key = (b["source"], b["metric"], b["unit"], b["reporting_scope"], b["accounting_standard"], current)
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
            groups[(r["source"], r["metric"], r["unit"], r["reporting_scope"], r["accounting_standard"])].append(r)
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


def _year_changes(rows, ticker):
    """Compare the same fiscal quarter/year and scope; preserve revision caveats."""
    groups = defaultdict(list)
    for r in rows:
        if r.get("metric") in {"revenue", "net_income", "operating_cashflow", "inventory", "receivables"}:
            groups[(r["source"], r["metric"], r["unit"], r["reporting_scope"],
                    r["accounting_standard"], r["period_basis"])].append(r)
    result, gaps = [], {}
    for batch in groups.values():
        by_end = defaultdict(list)
        for r in batch:
            by_end[r["period_end"]].append(r)
        current = by_end[max(by_end)]
        if len({(r["value"], r.get("period_start"), r["version_key"]) for r in current}) != 1:
            continue
        last = current[0]
        end = date.fromisoformat(last["period_end"])
        # 52/53-week fiscal calendars need a small tolerance, never a missing
        # quarter bridge or a comparison of YTD with a single quarter.
        prior = [r for r in batch if 358 <= (end - date.fromisoformat(r["period_end"])).days <= 372
                 and (not last.get("period_start") or r.get("period_start") and
                      abs((end - date.fromisoformat(last["period_start"])).days -
                          (date.fromisoformat(r["period_end"]) - date.fromisoformat(r["period_start"])).days) <= 7)]
        if len({(r["value"], r["period_end"], r.get("period_start"), r["version_key"]) for r in prior}) != 1:
            gaps[evidence_id(last)] = "YoY unavailable: a unique comparable prior fiscal period was not collected."
            continue
        first = prior[0]
        if first["value"] <= 0:
            gaps[evidence_id(last)] = "YoY percentage unavailable: prior value is zero or negative; use absolute changes."
            continue
        value = (last["value"] / first["value"] - 1) * 100
        row = _derived(ticker, last["metric"] + "_yoy", [first, last], value,
                       last["period_basis"], last.get("period_start"), last["period_end"],
                       "(current / same fiscal period last year - 1) * 100", unit="percent")
        row["base_metric"] = last["metric"]
        result.append(row)
    return result, gaps


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
        key = (r["source"], r["unit"], r["reporting_scope"], r["accounting_standard"], r.get("period_start"),
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
            ("cash_conversion", "operating_cashflow", "net_income", True),
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
        debt = ("current_portion_long_term_debt", "long_term_debt_noncurrent", "cash")
        if all(name in unique and unique[name]["value"] >= 0 for name in debt):
            inputs = [unique[name] for name in debt]
            if inputs[0]["period_basis"] == "instant":
                a, b, cash = inputs
                row = _derived(ticker, "long_term_debt_less_cash", inputs,
                               a["value"] + b["value"] - cash["value"], "instant", None,
                               a["period_end"], "current portion of long-term debt + noncurrent long-term debt - cash")
                row["note"] += " Limited debt definition: excludes other short-term borrowings and uncollected lease liabilities; not total net debt."
                ratios.append(row)
    changes, gaps = _year_changes([*facts, *quarters, *ttm], ticker)
    for row in rows:
        if evidence_id(row) in gaps:
            row["calculation_gaps"] = [gaps[evidence_id(row)]]
    return [*quarters, *ttm, *ratios, *changes]
