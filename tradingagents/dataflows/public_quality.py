"""Purpose-based official-data coverage and exact citation traceability.

These checks establish availability and traceability, not truth of a model's
reasoning. Optional providers are not treated as mandatory issuer fundamentals.
"""

import json
import re
from collections import defaultdict
from datetime import date

from .public_data_common import number, period_date
from .public_evidence import evidence_id, summarize_warnings
from .public_financial_metrics import CORE_FINANCIAL_METRICS
from .public_relevance import assigned_public_rows, selected_public_sectors

_REF = re.compile(r"(?<=\[)ev-[^\]\s]+(?=\])|\bev-[0-9a-f]{16}\b")
_MACRO = ("liquidity", "credit_stress", "activity", "prices_labor", "cross_border")
_INDUSTRY = ("demand", "production", "inventory_costs")
_ISSUER = ("earnings", "cash_flow", "balance_sheet")
_CORE_SERIES = {"WALCL", "WRESBAL", "RRPONTSYD", "SOFR", "NFCI", "STLFSI4",
                "DRTSCILM", "INDPRO", "T10YIE", "consumer_prices", "WPSFD4"}


def topics(row):
    """Inspectable classifications; labels never assert company revenue exposure."""
    source = row["source"]
    target = row.get("base_target") or row["target"]
    metric = str(row.get("metric") or "")
    label = (str(row.get("title", "")) + " " + target).casefold()
    found = set()
    if source in {"sec", "dart"}:
        metric = row.get("base_metric") or metric
        if metric in {"revenue", "gross_profit", "operating_income", "net_income", "gross_margin", "operating_margin", "net_margin"}:
            found.add("earnings")
        if metric in {"operating_cashflow", "capital_expenditure", "free_cashflow", "cash_conversion"}:
            found.add("cash_flow")
        if metric in {"assets", "liabilities", "cash", "equity", "inventory", "receivables", "liabilities_to_assets", "long_term_debt_less_cash"}:
            found.add("balance_sheet")
        return found
    # Table contracts, not words in the industry name, establish analytical
    # purpose. GDPbyIndustry table 1 is nominal value added, NOT output volume.
    # Derived observations retain base_target, so the same routing applies.
    if source == "bea":
        if target.startswith("GDPbyIndustry/1/"):
            return {"activity", "production"}
        if target.startswith(("NIPA/T20305/", "NIPA/T20306/")):
            return {"activity", "demand"}
    if source in {"nyfed", "treasury", "ecb"} or source == "fred" and target in {"WALCL", "WRESBAL", "RRPONTSYD", "DGS2", "DGS10"} or source == "ecos" and target == "policy_rate":
        found.add("liquidity")
    if source in {"ofr", "bis"} or source == "fred" and target in {"NFCI", "STLFSI4", "DRTSCILM", "DRTSCIS", "DRSDCILM", "BUSLOANS"}:
        found.add("credit_stress")
    if source in {"census", "bea", "oecd", "eurostat", "kosis"} or source == "fred" and target in {"INDPRO", "TCU"}:
        found.add("activity")
    if source == "bls" or source == "ecos" and target == "consumer_prices" or source == "fred" and target in {"T10YIE", "DFII10"} or "une_rt" in target:
        found.add("prices_labor")
    if source in {"tic", "mof_japan"}:
        found.add("cross_border")
    if source in {"census", "bea", "customs", "eurostat", "kosis", "eia", "bls"}:
        if any(word in label for word in ("order", "retail", "sales", "consumption", "export", "expdlr", "출하", "수출", "소비")) or source == "bea" and target.startswith("NIPA/"):
            found.add("demand")
        if any(word in label for word in ("production", "shipment", "industrial", "construction", "생산")) or source == "eurostat" and target.startswith(("sts_inpr", "sts_copr")):
            found.add("production")
        if any(word in label for word in ("inventor", "stock", "price", "wage", "earnings", "재고", "물가", "임금")):
            found.add("inventory_costs")
    return found


def role_topics(role):
    if role == "fundamentals":
        return (*_ISSUER, *_INDUSTRY)
    if role == "ticker_review":
        return (*_ISSUER, *_MACRO, *_INDUSTRY)
    if role == "sector":
        return _INDUSTRY
    if role == "market_review":
        return (*_MACRO, *_INDUSTRY)
    return _MACRO


def latest_series(rows):
    latest = {}
    for row in rows:
        if row.get("status") != "success" or number(row.get("value")) is None:
            continue
        key = (row["source"], row["target"], row.get("unit"), row.get("basis"))
        if key not in latest or (period_date(row.get("observed_at")) or date.min) > (period_date(latest[key].get("observed_at")) or date.min):
            latest[key] = row
    return list(latest.values())


def core_evidence_report(rows, role, state=None):
    """Reserve a small digest by analytical purpose before source character budgets."""
    groups = defaultdict(list)
    for row in latest_series(rows):
        for topic in topics(row):
            groups[topic].append(row)
    lines = ["Core official evidence by analysis purpose (availability is not proof of use):"]
    for topic in role_topics(role):
        candidates = sorted(groups[topic], key=lambda r: (
            bool(r.get("stale") or r.get("comparative_only")), r["target"] not in _CORE_SERIES and r.get("metric") not in CORE_FINANCIAL_METRICS,
            -(period_date(r.get("observed_at")) or date.min).toordinal(),
            r.get("evidence_type") not in {"derived_financial", "derived_indicator"},
            r["source"], r["target"],
        ))
        if not candidates:
            lines.append(f"- {topic}: unavailable in the selected/routed evidence; do not infer a neutral reading.")
            continue
        # Prefer different metrics/sources to multiple near-identical annual and
        # quarterly variants crowding out the purpose's other inputs.
        selected, seen, sources = [], set(), set()
        for diversify in (True, False):
            for row in candidates:
                key = (row["source"], row.get("metric") or row["target"])
                if len(selected) == 3 or key in seen or diversify and row["source"] in sources:
                    continue
                seen.add(key)
                sources.add(row["source"])
                selected.append(row)
        lines.append(f"- {topic}: " + " | ".join(
            f"[{r.get('evidence_id') or evidence_id(r)}] {r['source']}/{r['target']}: "
            f"{r['value']} {r.get('unit', '')}; {r.get('observed_at')}; "
            f"{r.get('basis') or 'basis unspecified'}; {r.get('freshness', 'unknown')}"
            for r in selected
        ))
    if role in {"fundamentals", "ticker_review", "sector", "market_review"}:
        lines.append("The production purpose includes industry output/value added on its native basis. "
                     "BEA GDPbyIndustry table 1 is nominal value added, not physical production volume; "
                     "do not infer real volume growth from its current-dollar change.")
    if role in {"sector", "market_review"}:
        lines.append(sector_core_report(rows, state or {}))
    if role in {"fundamentals", "ticker_review"}:
        lines.append("Industry/country observations are context. Revenue geography, product shares and cost weights remain unverified unless explicitly documented in issuer evidence; never infer exposure percentages from sector labels.")
    return "\n".join(lines)


def sector_core_report(rows, state):
    """Reserve each sector's demand/production/cost evidence before bulk digests.

    Before screening, show the tagged available sectors as an exploration menu.
    Once sectors are requested or screened, include explicit gaps for those
    sectors. One compact observation per purpose bounds the context size.
    """
    latest = latest_series(rows)
    focus = selected_public_sectors(state)
    if not focus:
        focus = sorted({s for r in latest for s in r.get("sectors", [])})[:11]
    if not focus:
        return "Sector-purpose evidence: no classified industry observations were collected."
    lines = ["Sector-purpose evidence (aggregate context, not verified issuer exposure):"]
    for sector in focus:
        lines.append(f"Sector: {sector}")
        seen_sources = set()
        for topic in _INDUSTRY:
            candidates = [r for r in latest if sector.casefold() in
                          {s.casefold() for s in r.get("sectors", [])} and topic in topics(r)]
            candidates.sort(key=lambda r: (
                bool(r.get("stale")), r["source"] in seen_sources,
                -(period_date(r.get("observed_at")) or date.min).toordinal(),
                r.get("evidence_type") != "derived_indicator", r["source"], r["target"],
            ))
            if not candidates:
                lines.append(f"- {sector}/{topic}: unavailable; no neutral reading or inferred company exposure.")
                continue
            r = candidates[0]
            seen_sources.add(r["source"])
            lines.append(
                f"- {sector}/{topic}: [{r.get('evidence_id') or evidence_id(r)}] "
                f"{r['source']}/{r['target'][:160]}: {r['value']} {str(r.get('unit', ''))[:90]}; "
                f"{r.get('observed_at')}; {str(r.get('basis') or 'basis unspecified')[:70]}; "
                f"{r.get('freshness', 'unknown')}"
            )
    return "\n".join(lines)


def citation_audit(state, rows, fields):
    """Warn when a report lacks a usable assigned numeric evidence ID."""
    by_id = {r.get("evidence_id") or evidence_id(r): r for r in rows}
    numeric = {key for key, r in by_id.items() if r.get("status") == "success" and number(r.get("value")) is not None}
    reports, warnings = {}, []
    for field, role in fields.items():
        content = state.get(field, "")
        if not content:
            continue
        assigned, _, _ = assigned_public_rows({**state, "public_data_evidence": rows}, role)
        role_numeric = {r.get("evidence_id") or evidence_id(r) for r in assigned} & numeric
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        refs = set(_REF.findall(text))
        if not role_numeric and not refs:
            continue
        known = refs & by_id.keys()
        usable = known & role_numeric
        issues = []
        if role_numeric and not usable:
            issues.append("NO_NUMERIC_CITATIONS")
        if refs - by_id.keys():
            issues.append("UNKNOWN_IDS:" + ",".join(sorted(refs - by_id.keys())[:10]))
        reports[field] = {"ids": sorted(known), "issues": issues}
        warnings.extend(f"OFFICIAL_AUDIT:{field}:{issue}" for issue in issues)
    return {"warnings": warnings, "reports": reports}


TICKER_REPORTS = {"news_report": "news", "fundamentals_report": "fundamentals",
                  "final_trade_decision": "ticker_review"}
MARKET_REPORTS = {"macro_report": "macro", "sector_report": "sector",
                  "market_scan_report": "market_review"}


def ticker_quality(state):
    """Issuer fundamentals are critical only if an applicable issuer source ran."""
    rows = state.get("public_data_evidence", [])
    if not rows:
        return {"status": "NOT_ASSESSED", "warnings": [], "missing_core_metrics": [], "citation_audit": {}}
    issuer = {r["source"] for r in rows} & {"sec", "dart"}
    fresh = {r.get("metric") for r in latest_series(rows) if r["source"] in issuer
             and r.get("evidence_type") == "financial_fact" and not r.get("stale") and not r.get("comparative_only")
             and period_date(r.get("observed_at"))}
    missing = sorted(set(CORE_FINANCIAL_METRICS) - fresh) if issuer else []
    warnings = list(state.get("public_data_warnings", []))
    warning_set = set(warnings)
    warnings.extend(f"OFFICIAL_GAP:{r['source']}:{r['target']}:{r['status']}" for r in rows
                    if r.get("status") not in {"success", "not_applicable"}
                    and f"{r['source']}: " + (f"{r['target']}: " if r.get("coverage_gap") else "")
                    + str(r.get("content", "")) not in warning_set
                    and f"PUBLIC_FUTURE_OBSERVATION:{r['source']}:{r['target']}" not in warning_set)
    warnings.extend(f"OFFICIAL_STALE:{r['source']}:{r['target']}" for r in latest_series(rows)
                    if r.get("stale") and not r.get("comparative_only")
                    and f"PUBLIC_STALE:{r['source']}:{r['target']}:{r.get('observed_at')}" not in warning_set)
    warnings.extend(f"ISSUER_CORE_UNAVAILABLE:{metric}" for metric in missing)
    audit = citation_audit(state, rows, TICKER_REPORTS)
    warnings.extend(audit["warnings"])
    status = "REVIEW_REQUIRED" if missing else "DEGRADED" if warnings else "COMPLETE"
    return {"status": status, "scope": "selected official evidence", "warnings": list(dict.fromkeys(warnings)),
            "missing_core_metrics": missing, "citation_audit": audit,
            "issuer_sources": sorted(issuer),
            "core_metrics_satisfied": bool(issuer) and not missing}


def render_quality(quality):
    lines = [f"**Analysis status**: {quality['status']}"]
    lines.append("Coverage scope: selected official evidence; vendor price/news coverage is assessed separately.")
    if not quality.get("issuer_sources"):
        lines.append("Issuer fundamental checks were not requested or no applicable issuer source was selected.")
    if quality["status"] == "REVIEW_REQUIRED":
        lines.append("Decision requires review: fresh core issuer metrics are missing. A neutral rating must not stand in for missing evidence.")
    raw_warnings = quality.get("warnings", [])
    warnings = summarize_warnings(raw_warnings)
    lines.extend("- " + warning for warning in warnings[:30])
    if len(raw_warnings) > len(warnings[:30]):
        lines.append("Further diagnostics are retained in the structured quality record.")
    return "\n".join(lines)
