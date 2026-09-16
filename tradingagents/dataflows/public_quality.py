"""Purpose-based official-data coverage and structural citation checks.

These checks establish availability and traceability, not truth of a model's
reasoning. Optional providers are not treated as mandatory issuer fundamentals.
"""

import json
import re
from collections import defaultdict
from datetime import date
from math import isclose

from .public_data_common import number, period_date
from .public_evidence import evidence_id
from .public_financial_metrics import CORE_FINANCIAL_METRICS
from .public_relevance import assigned_public_rows, selected_public_sectors

_REF = re.compile(r"\bev-[0-9a-f]{16}\b")
_OFFICIAL = re.compile(
    r"\b(?:SEC|DART|FRED|NYFed|Treasury|ECB|ECOS|OFR|EIA|CFTC|Census|BEA|BLS|KOSIS|OECD|Eurostat|BIS|TIC)\b"
    r"|\b(?:FSC|MOF|customs)\b|관세청|공식\s*(?:자료|통계|데이터)|official\s+(?:data|evidence)", re.I,
)
_NUMBER = re.compile(r"[+-]?\d[\d,.]*\s*(?:%|percent|USD|KRW|EUR|JPY|CAD|CNY|GBP|AUD|CHF|HKD|INR|pp\b|bps?\b|billion|million|조\s*원|억\s*원|달러)", re.I)
_COMPARISON = re.compile(r"\b(?:YoY|MoM|QoQ|rose|fell|increased|decreased|declined|contracted|accelerated|decelerated|growth|change)\b|전년|전월|전분기|증가|감소", re.I)
_PERCENT_VALUE = re.compile(r"([+-]?\d+(?:\.\d+)?)\s*(?:%|percent\b)", re.I)
_SECOND_CHANGE = re.compile(
    r"percentage[- ]?points?|percent[- ]?points?|\b(?:pp|bps?|from|difference|minus|faster|slower)\b"
    r"|accelerat\w*|decelerat\w*|%p|%포인트|퍼센트\s*포인트|가속|둔화|확대|축소|에서.*(?:으로|로)", re.I,
)
_EXCLUSION = re.compile(r"\[official-exclude:([^]\n]+)\]\s*([^\n]*)")
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


def _reported_change_supported(line, cited_rows):
    """Narrow exception for a direct, correctly based provider GDP growth print.

    This is structural validation, not semantic proof. A rate level, a different
    horizon, multiple figures or a change in the growth rate needs endpoints.
    """
    if len(cited_rows) != 1 or _SECOND_CHANGE.search(line):
        return False
    row = cited_rows[0]
    if not (row.get("source") == "eurostat" and row.get("table_id") == "namq_10_gdp"
            and row.get("provider_reported_change", not row.get("operands")) is True
            and row.get("change_basis", "quarter_on_quarter") == "quarter_on_quarter"
            and row.get("frequency") == "Q"
            and row.get("dimensions", {}).get("unit") == "CLV_PCH_PRE"):
        return False
    if not re.search(r"\bEurostat\b", line, re.I) or not re.search(r"(?<![A-Za-z])GDP(?![A-Za-z])|gross domestic product|국내총생산", line, re.I):
        return False
    if not re.search(r"\bQoQ\b|q/q|quarter[- ]on[- ]quarter|previous quarter|전분기", line, re.I):
        return False
    if re.search(r"\b(?:YoY|MoM|annualized)\b|year[- ]on[- ]year|전년|전월|연율", line, re.I):
        return False
    figures = _PERCENT_VALUE.findall(line.replace("−", "-"))
    if len(figures) != 1 or len(_NUMBER.findall(line)) != 1:
        return False
    value = float(figures[0])
    if re.search(r"\b(?:fell|decreased|declined|contracted)\b|감소|하락", line, re.I):
        value = -abs(value)
    return isclose(value, float(row["value"]), rel_tol=1e-9, abs_tol=1e-9)


def _purpose_coverage(text, available, cited_by_topic, required=()):
    """Persist optional exclusion reasons; issuer core purposes cannot be waived."""
    exclusions, issues = {}, []
    for topic, reason in _EXCLUSION.findall(text):
        topic, reason = topic.strip(), reason.strip()
        if topic in required or topic not in available or len(reason) < 12:
            issues.append("INVALID_PURPOSE_EXCLUSION:" + topic)
        else:
            exclusions[topic] = reason
    coverage = {}
    for topic in sorted(available):
        refs = sorted(cited_by_topic.get(topic, set()))
        reason = exclusions.get(topic)
        coverage[topic] = {
            "status": "cited" if refs else "excluded_with_reason" if reason else "missing",
            "evidence_ids": refs, "exclusion_reason": reason,
        }
    return coverage, issues


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
    topic_refs, sector_refs = defaultdict(set), defaultdict(set)
    for ref in numeric:
        for topic in topics(by_id[ref]):
            topic_refs[topic].add(ref)
        for sector in by_id[ref].get("sectors", []):
            sector_refs[sector.casefold()].add(ref)
    reports, warnings = {}, []
    for field, role in fields.items():
        content = state.get(field, "")
        if not content:
            continue
        assigned, _, _ = assigned_public_rows({**state, "public_data_evidence": rows}, role)
        role_numeric = {r.get("evidence_id") or evidence_id(r) for r in assigned} & numeric
        sector_focus = selected_public_sectors(state) if role in {"sector", "market_review"} else []
        if not role_numeric and not sector_focus:
            continue
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        refs = set(_REF.findall(text))
        known = refs & by_id.keys()
        usable = known & role_numeric
        issues = []
        if role_numeric and not usable:
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
                ) and not _reported_change_supported(line, [by_id[ref] for ref in line_refs]):
                    issues.append(f"COMPARISON_ENDPOINTS_UNVERIFIED:line{index}")
        available = set().union(*(topics(by_id[ref]) for ref in role_numeric)) & set(role_topics(role))
        cited_by_topic = defaultdict(set)
        for ref in usable:
            for topic in topics(by_id[ref]):
                cited_by_topic[topic].add(ref)
        sector_missing = []
        if sector_focus:
            # Global 'demand' citations cannot satisfy another screened sector.
            for sector in sector_focus:
                for topic in _INDUSTRY:
                    matching = role_numeric & topic_refs[topic] & sector_refs[sector.casefold()]
                    key = sector + "/" + topic
                    if matching:
                        available.add(key)
                        cited_by_topic[key] = usable & matching
                    else:
                        sector_missing.append(key)
        coverage, exclusion_issues = _purpose_coverage(text, available, cited_by_topic, _ISSUER)
        issues.extend(exclusion_issues)
        for key in sector_missing:
            coverage[key] = {"status": "unavailable", "evidence_ids": [], "exclusion_reason": None}
            issues.append("SECTOR_PURPOSE_UNAVAILABLE:" + key)
        uncovered = sorted(topic for topic, check in coverage.items() if check["status"] == "missing")
        if uncovered:
            issues.append("UNCITED_TOPICS:" + ",".join(uncovered))
        uncited_core = []
        if role == "ticker_review":
            issuer_available = available.intersection(_ISSUER)
            for topic in sorted(issuer_available):
                if not any(not by_id[ref].get("stale") for ref in cited_by_topic.get(topic, ())):
                    uncited_core.append(topic)
            if uncited_core:
                issues.append("ISSUER_PURPOSE_UNVERIFIED:" + ",".join(uncited_core))
        reports[field] = {"ids": sorted(known), "uncited_topics": uncovered,
                          "uncited_core_topics": uncited_core, "purpose_coverage": coverage,
                          "unavailable_sector_purposes": sector_missing,
                          "issues": issues}
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
        issue == "NO_NUMERIC_CITATIONS" or issue.startswith(("UNKNOWN_IDS:", "UNCITED_OFFICIAL_NUMBER:", "COMPARISON_ENDPOINTS_UNVERIFIED:", "ISSUER_PURPOSE_UNVERIFIED:"))
        for issue in final_issues
    )
    status = "REVIEW_REQUIRED" if missing or final_unverified else "DEGRADED" if warnings else "COMPLETE"
    return {"status": status, "scope": "selected official evidence", "warnings": list(dict.fromkeys(warnings)),
            "missing_core_metrics": missing, "citation_audit": audit,
            "unverified_core_purposes": audit["reports"].get("final_trade_decision", {}).get("uncited_core_topics", []),
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
