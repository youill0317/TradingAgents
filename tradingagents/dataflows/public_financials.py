"""Issuer financial facts and bounded filing excerpts with explicit accounting bases."""

import io
import os
import re
import zipfile
from calendar import monthrange
from datetime import date

from parsel import Selector

from .public_data_common import (
    _request,
    collect_parts,
    evidence,
    failure,
    number,
    request_json,
    request_text,
)

SEC_CONCEPTS = {
    "revenue": (
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
    ),
    "gross_profit": ("GrossProfit",),
    "operating_income": ("OperatingIncomeLoss",),
    "net_income": ("NetIncomeLoss", "ProfitLoss"),
    "operating_cashflow": ("NetCashProvidedByUsedInOperatingActivities",),
    "capital_expenditure": ("PaymentsToAcquirePropertyPlantAndEquipment",),
    "cash": ("CashAndCashEquivalentsAtCarryingValue",),
    "assets": ("Assets",),
    "liabilities": ("Liabilities",),
    "equity": ("StockholdersEquity",),
    "inventory": ("InventoryNet",),
    "receivables": ("AccountsReceivableNetCurrent",),
    "current_portion_long_term_debt": ("LongTermDebtCurrent",),
    "long_term_debt_noncurrent": ("LongTermDebtNoncurrent",),
    "diluted_eps": ("EarningsPerShareDiluted",),
    "shares": ("CommonStockSharesOutstanding",),
}


def sec_facts(cik, ticker, trade_date, headers):
    url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
    facts = request_json(url, headers=headers).get("facts", {})
    taxonomy = facts.get("us-gaap", {})
    # IFRS concepts have different semantics; retain their native names separately.
    selected = [
        (metric, "us-gaap", tag)
        for metric, tags in SEC_CONCEPTS.items()
        for tag in tags
        if tag in taxonomy
    ]
    if not selected:
        selected = [
            (tag, "ifrs-full", tag)
            for tag in (
                "Revenue",
                "ProfitLoss",
                "Assets",
                "Liabilities",
                "Equity",
                "CashAndCashEquivalents",
                "CashFlowsFromUsedInOperatingActivities",
                "Inventories",
            )
            if tag in facts.get("ifrs-full", {})
        ]
    result = []
    for metric, namespace, tag in selected:
        concept = facts[namespace][tag]
        for unit, points in concept.get("units", {}).items():
            latest = {}
            for point in points:
                end, start, filed = point.get("end"), point.get("start"), point.get("filed")
                if (
                    not filed
                    or filed > trade_date
                    or not end
                    or end > trade_date
                    or number(point.get("val")) is None
                ):
                    continue
                if (date.fromisoformat(trade_date) - date.fromisoformat(end)).days > 1100:
                    continue
                duration = (
                    (date.fromisoformat(end) - date.fromisoformat(start)).days + 1 if start else 0
                )
                basis = (
                    "instant"
                    if not start
                    else "quarter"
                    if 60 <= duration <= 110
                    else "half-year YTD"
                    if 150 <= duration <= 210
                    else "nine-month YTD"
                    if 240 <= duration <= 310
                    else "annual"
                    if 330 <= duration <= 400
                    else f"duration {duration} days"
                )
                key = (start, end, basis)
                if key not in latest or (filed, point.get("accn", "")) > (
                    latest[key].get("filed", ""),
                    latest[key].get("accn", ""),
                ):
                    latest[key] = point
            for (start, end, basis), point in sorted(
                latest.items(), key=lambda item: item[0][1], reverse=True
            )[:16]:
                result.append(
                    evidence(
                        "sec",
                        f"{ticker}/{namespace}:{tag}/{unit}/{basis}",
                        f"{concept.get('label', tag)}: {point['val']} {unit}; {basis}; period {start or end} to {end}.",
                        url,
                        observed_at=end,
                        published_at=point["filed"],
                        value=point["val"],
                        raw_value=point["val"],
                        unit=unit,
                        basis=basis,
                        frequency={"quarter": "Q", "annual": "A"}.get(basis, ""),
                        period_start=start,
                        period_end=end,
                        metric=metric,
                        concept=tag,
                        accession=point.get("accn"),
                        form=point.get("form"),
                        point_in_time=True,
                        fiscal_year=point.get("fy"),
                        fiscal_period=point.get("fp"),
                        evidence_type="financial_fact",
                        title=concept.get("label", tag),
                    )
                )
    if not result:
        return [
            failure(
                "sec",
                ticker + "/financials",
                "No supported standard financial facts; custom tags may require reading the filing.",
                status="empty",
            )
        ]
    return result + derive_financial_metrics(result, ticker)


def derive_financial_metrics(rows, ticker):
    """Only same-period/currency/basis facts enter ratios; retain operand lineage."""
    groups = {}
    for row in rows:
        if row.get("basis") not in {"quarter", "annual"} or row.get("unit") not in {
            "USD",
            "KRW",
            "EUR",
            "JPY",
            "GBP",
        }:
            continue
        key = (row.get("period_start"), row.get("period_end"), row["unit"], row["basis"])
        metric = row.get("metric")
        if metric:
            groups.setdefault(key, {}).setdefault(metric, row)
    result = []
    for (start, end, currency, basis), facts in groups.items():
        for name, left, right, ratio in (
            ("gross_margin", "gross_profit", "revenue", True),
            ("operating_margin", "operating_income", "revenue", True),
            ("net_margin", "net_income", "revenue", True),
            ("free_cashflow", "operating_cashflow", "capital_expenditure", False),
        ):
            if left not in facts or right not in facts:
                continue
            a, b = facts[left], facts[right]
            if a.get("accession") != b.get("accession"):
                continue  # Do not combine independently restated versions.
            x, y = number(a["value"]), number(b["value"])
            if x is None or y is None or (ratio and y <= 0):
                continue
            value = x / y * 100 if ratio else x - y
            unit = "percent" if ratio else currency
            result.append(
                evidence(
                    a["source"],
                    f"{ticker}/derived/{name}/{basis}/{currency}",
                    f"Calculated {name}: {value:.6g} {unit}; {basis}. Formula: {left} {'/ ' + right + ' * 100' if ratio else '- ' + right}.",
                    a["url"],
                    observed_at=end,
                    published_at=max(a.get("published_at") or "", b.get("published_at") or "")
                    or None,
                    value=value,
                    unit=unit,
                    basis=basis,
                    period_start=start,
                    period_end=end,
                    frequency="Q" if basis == "quarter" else "A",
                    evidence_type="derived_financial",
                    operands=[
                        {
                            "target": r["target"],
                            "value": r["value"],
                            "accession": r.get("accession"),
                        }
                        for r in (a, b)
                    ],
                    point_in_time=a.get("point_in_time", False) and b.get("point_in_time", False),
                )
            )
    return result


def filing_excerpt(source, ticker, text, url, published_at, report_name):
    selector = Selector(text=text)
    pieces = selector.xpath(
        "//text()[not(ancestor::script) and not(ancestor::style) and not(ancestor::*[local-name()='header'])]"
    ).getall()
    plain = re.sub(r"\s+", " ", " ".join(pieces)).strip()
    if len(plain) < 200:
        raise ValueError("Filing contains no usable text")
    # Full source remains at URL; explicitly label excerpts and omitted content.
    sections = []
    for pattern in (
        r"management.{0,30}discussion",
        r"risk factors",
        r"results of operations",
        r"liquidity and capital",
        r"사업의 내용",
        r"재무에 관한 사항",
        r"주요사항",
    ):
        matches = list(re.finditer(pattern, plain, flags=re.IGNORECASE))
        if matches:
            match = matches[-1] if len(matches) <= 3 else matches[1]
            sections.append(plain[max(0, match.start() - 80) : match.start() + 2500])
    excerpt = "\n[…]\n".join(sections) if sections else plain[:7000]
    return [
        evidence(
            source,
            ticker + "/filing excerpt/" + report_name,
            excerpt[:12000],
            url,
            published_at=published_at,
            evidence_type="filing_excerpt",
            excerpt_only=True,
            full_text_characters=len(plain),
            note="Bounded extracts; not a full-document review or evidence that omitted sections were read.",
        )
    ]


def sec_enrichment(cik, ticker, trade_date, headers, filings):
    chosen = sorted(filings, key=lambda row: row.get("published_at", ""), reverse=True)
    # One periodic report and one event report; amendments stay attached to their version.
    selected = []
    for forms in (
        {"10-K", "10-Q", "20-F", "40-F", "10-K/A", "10-Q/A", "20-F/A"},
        {"8-K", "6-K", "8-K/A"},
    ):
        selected.extend([row for row in chosen if row["content"].get("form") in forms][:1])
    parts = [("financial facts", lambda: sec_facts(cik, ticker, trade_date, headers))]
    for row in selected:
        parts.append(
            (
                row["target"] + "/excerpt",
                lambda r=row: filing_excerpt(
                    "sec",
                    ticker,
                    request_text(r["url"], headers=headers),
                    r["url"],
                    r["published_at"],
                    r["content"]["form"],
                ),
            )
        )
    return collect_parts("sec", parts)


def dart_enrichment(corp_code, ticker, trade_date, filings):
    key = os.environ["DART_API_KEY"]
    url = "https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json"

    def financials(year, report):
        params = {
            "crtfc_key": key,
            "corp_code": corp_code,
            "bsns_year": str(year),
            "reprt_code": report,
        }
        payload = request_json(url, params={**params, "fs_div": "CFS"})
        basis = "CFS"
        if payload.get("status") == "013":
            payload = request_json(url, params={**params, "fs_div": "OFS"})
            basis = "OFS"
        if payload.get("status") != "000":
            raise ValueError("OpenDART financial response unavailable")
        result = []
        for row in payload.get("list", []):
            receipt = row.get("rcept_no", "")
            publication = (
                receipt[:4] + "-" + receipt[4:6] + "-" + receipt[6:8] if len(receipt) >= 8 else None
            )
            if not publication or publication > trade_date:
                continue
            for amount_key in ("thstrm_amount", "thstrm_add_amount"):
                if amount_key == "thstrm_add_amount" and (
                    row.get("sj_div") == "BS" or report == "11011"
                ):
                    continue
                value = number(row.get(amount_key))
                if value is None:
                    continue
                statement = row.get("sj_div", "")
                # DART income statement current amount is 3 months, while cash
                # flow current amount is YTD. Never pool them as quarterly facts.
                period_basis = (
                    "instant"
                    if statement == "BS"
                    else "annual"
                    if report == "11011"
                    else "quarter"
                    if statement in {"IS", "CIS"} and amount_key == "thstrm_amount"
                    else {
                        "11013": "quarter YTD",
                        "11012": "half-year YTD",
                        "11014": "nine-month YTD",
                    }[report]
                )
                end_month = {"11013": 3, "11012": 6, "11014": 9, "11011": 12}[report]
                end = date(year, end_month, monthrange(year, end_month)[1]).isoformat()
                account = row.get("account_id") or row.get("account_nm")
                if not account:
                    continue
                if "미사용" in account:
                    account = row.get("account_nm", account)
                detail = row.get("account_detail") or "total"
                result.append(
                    evidence(
                        "dart",
                        f"{ticker}/{basis}/{statement}/{account}/{detail}/{period_basis}",
                        f"{row.get('account_nm')}: {row[amount_key]} {row.get('currency', 'KRW')}; {basis}, {period_basis}; report {year}/{report}.",
                        f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={receipt}",
                        observed_at=end,
                        published_at=publication,
                        value=value,
                        raw_value=row[amount_key],
                        unit=row.get("currency", "KRW"),
                        basis=basis + "/" + period_basis,
                        report_code=report,
                        account_id=row.get("account_id"),
                        account_detail=detail,
                        title=row.get("account_nm"),
                        frequency="A" if period_basis == "annual" else "Q",
                        statement=statement,
                        accession=receipt,
                        evidence_type="financial_fact",
                        point_in_time=False,
                        note="Current DART response checked against receipt date; historical restatement archive not guaranteed.",
                    )
                )
        return result

    parts = []
    seen = set()
    for filing in sorted(filings, key=lambda r: r.get("published_at", ""), reverse=True):
        name = filing["content"].get("report_name", "")
        match = re.search(r"\((\d{4})\.(\d{2})\)", name)
        if not match or not any(
            label in name for label in ("사업보고서", "분기보고서", "반기보고서")
        ):
            continue
        year, month = int(match[1]), int(match[2])
        report = {3: "11013", 6: "11012", 9: "11014", 12: "11011"}.get(month)
        expected_label = {3: "분기보고서", 6: "반기보고서", 9: "분기보고서", 12: "사업보고서"}.get(
            month
        )
        if not expected_label or expected_label not in name:
            parts = [
                (
                    ticker + "/financials",
                    lambda: [
                        failure(
                            "dart",
                            ticker + "/financials",
                            "Non-calendar fiscal reporting detected; numeric extraction is unavailable without a verified fiscal calendar.",
                            status="unsupported",
                        )
                    ],
                )
            ]
            break
        if not report or (year, report) in seen:
            continue
        seen.add((year, report))
        parts.append((f"{year}/{report}", lambda y=year, r=report: financials(y, r)))
        if len(parts) >= 8:
            break
    if filings:
        selected = max(filings, key=lambda r: r.get("published_at", ""))

        def document():
            receipt = selected["content"]["receipt_number"]
            response = _request(
                "https://opendart.fss.or.kr/api/document.xml",
                params={"crtfc_key": key, "rcept_no": receipt},
            )
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                members = [
                    m for m in archive.infolist() if m.filename.lower().endswith((".xml", ".html"))
                ]
                if not members or sum(m.file_size for m in members) > 25_000_000:
                    raise ValueError("DART document archive exceeds bound")
                text = archive.read(max(members, key=lambda m: m.file_size)).decode("utf-8")
            return filing_excerpt(
                "dart",
                ticker,
                text,
                selected["url"],
                selected["published_at"],
                selected["content"]["report_name"],
            )

        parts.append((ticker + "/filing excerpt", document))
    return collect_parts("dart", parts)
