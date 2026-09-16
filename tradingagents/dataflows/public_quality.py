"""Purpose-based official-data coverage and structural citation checks.

These checks establish availability and traceability, not truth of a model's
reasoning. Optional providers are not treated as mandatory issuer fundamentals.
"""

import json
import re
from collections import defaultdict
from datetime import date

from .public_data_common import number, period_date
from .public_evidence import evidence_id
from .public_financial_metrics import CORE_FINANCIAL_METRICS
from .public_relevance import assigned_public_rows

_REF = re.compile(r"\bev-[0-9a-f]{16}\b")
_OFFICIAL = re.compile(
    r"\b(?:SEC|DART|FRED|NYFed|Treasury|ECB|ECOS|OFR|EIA|CFTC|Census|BEA|BLS|KOSIS|OECD|Eurostat|BIS|TIC)\b"
    r"|관세청|공식\s*(?:자료|통계|데이터)|official\s+(?:data|evidence)", re.I,
)
_NUMBER = re.compile(r"[+-]?\d[\d,.]*\s*(?:%|percent|USD|KRW|EUR|JPY|bp\b|billion|million|조\s*원|억\s*원|달러)", re.I)
_COMPARISON = re.compile(r"\b(?:YoY|MoM|rose|fell|increased|decreased|growth|change)\b|전년|전월|증가|감소", re.I)
_MACRO = ("liquidity", "credit_stress", "activity", "prices_labor", "cross_border")
_INDUSTRY = ("demand", "production", "inventory_costs")
_ISSUER = ("earnings", "cash_flow", "balance_sheet")
_CORE_SERIES = {"WALCL", "WRESBAL", "RRPONTSYD", "SOFR", "NFCI", "STLFSI4",
                "DRTSCILM", "INDPRO", "T10YIE", "consumer_prices", "WPSFD4"}


def topics(row):
    """Inspectable classifications; labels never assert company revenue exposure."""
    source, target, metric = row["source"], row["target"], str(row.get("metric") or "")
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


def core_evidence_report(rows, role):
    """Reserve a small digest by analytical purpose before source character budgets."""
    groups = defaultdict(list)
    for row in latest_series(rows):
        for topic in topics(row):
            groups[topic].append(row)
    lines = ["Core official evidence by analysis purpose (availability is not proof of use):"]
    for topic in role_topics(role):
        candidates = sorted(groups[topic], key=lambda r: (
            bool(r.get("stale")), r["target"] not in _CORE_SERIES and r.get("metric") not in CORE_FINANCIAL_METRICS,
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
    if role in {"fundamentals", "ticker_review"}:
        lines.append("Industry/country observations are context. Revenue geography, product shares and cost weights remain unverified unless explicitly documented in issuer evidence; never infer exposure percentages from sector labels.")
    return "\n".join(lines)


def citation_audit(state, rows, fields):
    """Check explicit IDs, numeric-claim references and available topic coverage.

    Numeric-claim checks only inspect lines explicitly naming official sources;
    vendor prices and arbitrary dates are not forced into this citation system.
    This bounded structural check cannot validate semantics of the prose.
    """
    by_id = {r.get("evidence_id") or evidence_id(r): r for r in rows}
    numeric = {key for key, r in by_id.items() if r.get("status") == "success" and number(r.get("value")) is not None}
    if not numeric:
        return {"warnings": [], "reports": {}}
    reports, warnings = {}, []
    for field, role in fields.items():
        content = state.get(field, "")
        if not content:
            continue
        assigned, _, _ = assigned_public_rows({**state, "public_data_evidence": rows}, role)
        role_numeric = {r.get("evidence_id") or evidence_id(r) for r in assigned} & numeric
        if not role_numeric:
            continue
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        refs = set(_REF.findall(text))
        known = refs & by_id.keys()
        usable = known & numeric
        issues = []
        if not usable:
            issues.append("NO_NUMERIC_CITATIONS")
        if refs - by_id.keys():
            issues.append("UNKNOWN_IDS:" + ",".join(sorted(refs - by_id.keys())[:10]))
        for index, line in enumerate(text.splitlines(), 1):
            line_refs = set(_REF.findall(line)) & numeric
            if _OFFICIAL.search(line) and _NUMBER.search(line):
                if not line_refs:
                    issues.append(f"UNCITED_OFFICIAL_NUMBER:line{index}")
                elif _COMPARISON.search(line) and len(line_refs) < 2 and not any(
                    len(by_id[ref].get("operands", [])) >= 2 for ref in line_refs
                ):
                    issues.append(f"COMPARISON_ENDPOINTS_UNVERIFIED:line{index}")
        available = set().union(*(topics(by_id[ref]) for ref in role_numeric)) & set(role_topics(role))
        cited = set().union(*(topics(by_id[ref]) for ref in usable)) if usable else set()
        uncovered = sorted(available - cited)
        if uncovered:
            issues.append("UNCITED_TOPICS:" + ",".join(uncovered))
        reports[field] = {"ids": sorted(known), "uncited_topics": uncovered, "issues": issues}
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
             and r.get("evidence_type") == "financial_fact" and not r.get("stale")
             and period_date(r.get("observed_at"))}
    missing = sorted(set(CORE_FINANCIAL_METRICS) - fresh) if issuer else []
    warnings = list(state.get("public_data_warnings", []))
    warnings.extend(f"OFFICIAL_GAP:{r['source']}:{r['target']}:{r['status']}" for r in rows
                    if r.get("status") not in {"success", "not_applicable"})
    warnings.extend(f"OFFICIAL_STALE:{r['source']}:{r['target']}" for r in latest_series(rows) if r.get("stale"))
    warnings.extend(f"ISSUER_CORE_UNAVAILABLE:{metric}" for metric in missing)
    audit = citation_audit(state, rows, TICKER_REPORTS)
    warnings.extend(audit["warnings"])
    final_issues = audit["reports"].get("final_trade_decision", {}).get("issues", [])
    final_unverified = bool(issuer) and any(
        issue == "NO_NUMERIC_CITATIONS" or issue.startswith(("UNKNOWN_IDS:", "UNCITED_OFFICIAL_NUMBER:", "COMPARISON_ENDPOINTS_UNVERIFIED:"))
        for issue in final_issues
    )
    status = "REVIEW_REQUIRED" if missing or final_unverified else "DEGRADED" if warnings else "COMPLETE"
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
        lines.append("Decision requires review: core issuer evidence or final numerical citations are insufficient. A neutral rating must not stand in for missing evidence.")
    lines.extend("- " + warning for warning in quality.get("warnings", [])[:30])
    if len(quality.get("warnings", [])) > 30:
        lines.append("Further diagnostics are retained in the structured quality record.")
    return "\n".join(lines)
