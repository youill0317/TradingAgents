"""Bounded official Korean macro and semiconductor-industry evidence."""

import os
import re
from datetime import date, datetime, timedelta

from .public_data_common import (
    collect_parts,
    evidence,
    failure,
    number,
    numeric_rows,
    request_json,
    request_xml,
)
from .public_evidence import require_dimensions, require_series

ECOS_URL = "https://ecos.bok.or.kr/api/StatisticSearch"
CUSTOMS_URL = "https://apis.data.go.kr/1220000/nitemtrade/getNitemtradeList"
KOSIS_URL = "https://kosis.kr/openapi/Param/statisticsParameterData.do"
KOSIS_ITEMS = ("T10", "T11", "T12")
# Verified from the public DT_1F02011 statHtmlContent metadata on 2026-09-16:
# https://kosis.kr/statHtml/statHtml.do?orgId=101&tblId=DT_1F02011
# C1 is this table's "기타분류별" hierarchy, not a reusable KSIC code.
_KOSIS_INDUSTRIES = {
    ("DT_1F02011", "3"): ("사무회계·통신기기·반도체(C26A, C263, C264)", ("Technology",), ("semiconductors",)),
    ("DT_1F02011", "3C"): ("사무회계·통신기기·반도체(C26A, C263, C264)", ("Technology",), ("semiconductors",)),
    ("DT_1F02011", "A"): ("영상음향(C264+C265=C26B)", ("Technology",), ()),
    ("DT_1F02011", "AC"): ("영상음향(C264+C265=C26B)", ("Technology",), ()),
    ("DT_1F02011", "E"): ("반도체 및 부품(C261+C262=C26A)", ("Technology",), ("semiconductors",)),
    ("DT_1F02011", "EC"): ("반도체 및 부품(C261+C262=C26A)", ("Technology",), ("semiconductors",)),
}
_KOREAN_INDUSTRY_LABELS = {
    " ".join(label.split()): (sectors, groups)
    for label, sectors, groups in _KOSIS_INDUSTRIES.values()
}
# Exact official hierarchy label documented by KOSIS for the semiconductor path.
_KOREAN_INDUSTRY_LABELS["반도체 제조업"] = (("Technology",), ("semiconductors",))
CUSTOMS_FIELDS = (
    ("expDlr", "exports FOB", "USD"), ("impDlr", "imports CIF", "USD"),
    ("balPayments", "trade balance", "USD"),
    ("expWgt", "export weight", "kg"), ("impWgt", "import weight", "kg"),
)


def _month_offset(day, months):
    month = day.year * 12 + day.month - 1 + months
    return date(month // 12, month % 12 + 1, 1)


def _ecos_rows(key, stat_code, cycle, start, end, item_code):
    url = f"{ECOS_URL}/{key}/json/kr/1/100/{stat_code}/{cycle}/{start}/{end}/{item_code}"
    payload = request_json(url)
    if "StatisticSearch" not in payload:
        result = payload.get("RESULT", {})
        raise ValueError(f"ECOS: {result.get('MESSAGE', 'invalid response')}")
    return payload["StatisticSearch"].get("row", [])


def _collect_ecos_history(trade_date):
    """Collect fixed policy-rate and CPI observations available by trade_date."""
    day = datetime.strptime(trade_date, "%Y-%m-%d").date()
    key = os.environ["ECOS_API_KEY"]
    series = (
        (
            "policy_rate",
            "722Y001",
            "D",
            (day - timedelta(days=45)).strftime("%Y%m%d"),
            day.strftime("%Y%m%d"),
            "0101000",
        ),
        (
            "consumer_prices",
            "901Y009",
            "M",
            _month_offset(day, -36).strftime("%Y%m"),
            day.strftime("%Y%m"),
            "0",
        ),
    )
    def collect_series(spec):
        target, stat_code, cycle, start, end, item_code = spec
        records = []
        rows = _ecos_rows(key, stat_code, cycle, start, end, item_code)
        for row in rows:
            observed = row.get("TIME", "")
            if observed and observed <= end and number(row.get("DATA_VALUE")) is not None:
                records.append(
                    evidence(
                        "ecos",
                        target,
                        f"{row.get('ITEM_NAME1', target)}: {row.get('DATA_VALUE', '')} {row.get('UNIT_NAME', '')}".strip(),
                        ECOS_URL,
                        observed_at=observed,
                        stat_code=stat_code,
                        item_code=item_code,
                        frequency=cycle,
                        value=number(row.get("DATA_VALUE")),
                        unit=row.get("UNIT_NAME"),
                        kind="rate" if target == "policy_rate" else "index",
                        point_in_time=False,
                        country="KR",
                        title=row.get("ITEM_NAME1", target),
                    )
                )
        return records

    return collect_parts(
        "ecos", [(spec[0], lambda s=spec: collect_series(s)) for spec in series]
    )


def collect_ecos(trade_date):
    def key_statistics():
        endpoint = f"https://ecos.bok.or.kr/api/KeyStatisticList/{os.environ['ECOS_API_KEY']}/json/kr/1/100"
        payload = request_json(endpoint)
        rows = payload.get("KeyStatisticList", {}).get("row")
        if not isinstance(rows, list):
            raise ValueError("ECOS key-statistics schema changed")
        result = []
        for row in rows:
            period = row.get("CYCLE", "")
            result.extend(
                numeric_rows(
                    "ecos",
                    "key/" + row.get("KEYSTAT_NAME", "unknown"),
                    [(period, row.get("DATA_VALUE"))],
                    "https://ecos.bok.or.kr/",
                    trade_date=trade_date,
                    unit=row.get("UNIT_NAME", "provider units"),
                    frequency="",
                    country="KR",
                    classification=row.get("CLASS_NAME"),
                    note="Latest key-statistics snapshot; historical trend unavailable for this series.",
                )
            )
        return result

    return collect_parts(
        "ecos",
        [
            ("policy and CPI history", lambda: _collect_ecos_history(trade_date)),
            ("100 key statistics", key_statistics),
        ],
    )


CUSTOMS_PRODUCTS = {
    "8542": ("Integrated circuits", ["Technology"]),
    "8703": ("Passenger motor vehicles", ["Consumer Cyclical"]),
    "8507": ("Electric accumulators", ["Industrials", "Consumer Cyclical"]),
    "3004": ("Medicaments", ["Healthcare"]),
    "2710": ("Petroleum oils and preparations", ["Energy"]),
    "7208": ("Hot-rolled flat iron/steel", ["Basic Materials"]),
}


def collect_customs(trade_date):
    """Monthly Korean trade by six product groups and four partner countries."""
    day = date.fromisoformat(trade_date)
    end_month = _month_offset(day, -1 if day.day >= 15 else -2)
    start_month = _month_offset(end_month, -12)

    # Thirteen observations are needed for YoY, but each API request may cover
    # at most one year. Disjoint windows retain both endpoints without duplicates.
    windows = ((start_month, _month_offset(end_month, -1)), (end_month, end_month))

    def window(country, hs_code, first, last):
        root = request_xml(
            CUSTOMS_URL,
            params={
                "serviceKey": os.environ["DATA_GO_KR_API_KEY"],
                "strtYymm": first.strftime("%Y%m"),
                "endYymm": last.strftime("%Y%m"),
                "hsSgn": hs_code,
                "cntyCd": country,
            },
        )
        if root.findtext(".//resultCode") != "00":
            raise ValueError("Customs request unsuccessful")
        result = []
        for item in root.findall(".//item"):
            raw_period = item.findtext("year") or ""
            if not re.fullmatch(r"\d{4}\.\d{2}", raw_period):
                continue
            period = raw_period.replace(".", "")
            if not first.strftime("%Y%m") <= period <= last.strftime("%Y%m"):
                continue
            reported_hs, reported_country = item.findtext("hsCd"), item.findtext("statCd")
            if (reported_hs and not reported_hs.startswith(hs_code)) or (
                reported_country and reported_country != country
            ):
                continue
            for field, label, unit in CUSTOMS_FIELDS:
                if number(item.findtext(field)) is None:
                    result.append(failure(
                        "customs", f"HS{hs_code}-{country}/{field}",
                        "Requested trade field is missing or nonnumeric in a returned month; not a reported zero.",
                        status="empty", url=CUSTOMS_URL, observed_at=period,
                        coverage_gap=True, field_id=field, hs_code=hs_code, country_code=country,
                        unit=unit, frequency="M", sectors=CUSTOMS_PRODUCTS[hs_code][1],
                    ))
                    continue
                result.extend(
                    numeric_rows(
                        "customs",
                        f"HS{hs_code}-{country}/{field}",
                        [(period, item.findtext(field))],
                        CUSTOMS_URL,
                        trade_date=trade_date,
                        unit=unit,
                        frequency="M",
                        country="KR",
                        sectors=CUSTOMS_PRODUCTS[hs_code][1],
                        title=f"Korea {CUSTOMS_PRODUCTS[hs_code][0]} {label} with {country}",
                        kind="flow" if field == "balPayments" else "level",
                        hs_code=hs_code,
                        field_id=field,
                        country_code=country,
                        export_valuation="FOB",
                        import_valuation="CIF",
                    )
                )
        # Preserve identical duplicate cells only once; conflicting observations
        # remain separate so downstream comparison checks can expose ambiguity.
        unique = {}
        for row in result:
            key = (row["target"], row.get("observed_at"), row["status"], row.get("value"))
            unique.setdefault(key, row)
        result = list(unique.values())
        # Each window is checked independently: an older successful window must
        # not conceal an empty latest-month response.
        present = {r.get("observed_at") for r in result}
        for offset in range((last.year - first.year) * 12 + last.month - first.month + 1):
            period = _month_offset(first, offset).strftime("%Y%m")
            if period not in present:
                result.append(failure(
                    "customs", f"HS{hs_code}-{country}/coverage/{period}",
                    "Requested month returned no observations; not a reported zero.",
                    status="empty", url=CUSTOMS_URL, observed_at=period,
                    coverage_gap=True, hs_code=hs_code, country_code=country,
                    frequency="M", sectors=CUSTOMS_PRODUCTS[hs_code][1],
                ))
        return require_series(
            "customs", result,
            [f"HS{hs_code}-{country}/{field}" for field, _, _ in CUSTOMS_FIELDS],
            CUSTOMS_URL,
        )

    def product(country, hs_code):
        return collect_parts("customs", [
            (f"HS{hs_code}-{country}/{first:%Y%m}-{last:%Y%m}",
             lambda first=first, last=last: window(country, hs_code, first, last))
            for first, last in windows
        ])

    return collect_parts(
        "customs",
        [
            (f"HS{hs}-{country}", lambda c=country, h=hs: product(c, h))
            for country in ("US", "CN", "JP", "VN")
            for hs in CUSTOMS_PRODUCTS
        ],
    )


def collect_kosis(trade_date):
    """Monthly industry production, shipment and inventory indexes; retain provider units."""
    day = datetime.strptime(trade_date, "%Y-%m-%d").date()
    end = day.strftime("%Y%m")
    params = {
        "method": "getList",
        "apiKey": os.environ["KOSIS_API_KEY"],
        "format": "json",
        "jsonVD": "Y",
        "orgId": "101",
        "tblId": "DT_1F02011",
        "objL1": "ALL",
        "itmId": " ".join(KOSIS_ITEMS),
        "prdSe": "M",
        # Publication lag must not remove the latest observation's YoY endpoint.
        "startPrdDe": _month_offset(day, -36).strftime("%Y%m"),
        "endPrdDe": end,
    }
    payload = request_json(KOSIS_URL, params=params)
    if not isinstance(payload, list):
        raise ValueError(
            f"KOSIS: {payload.get('errMsg', 'invalid response') if isinstance(payload, dict) else 'invalid response'}"
        )
    records = []
    for row in payload:
        period = row.get("PRD_DE", "")
        if not params["startPrdDe"] <= period <= end or row.get("ITM_ID") not in KOSIS_ITEMS:
            continue
        value = row.get("DT")
        _, sectors, industry_groups = _KOSIS_INDUSTRIES.get(
            ("DT_1F02011", row.get("C1")), (None, (), ())
        )
        if number(value) is None:
            records.append(failure(
                "kosis", f"{row.get('C1', 'unknown')}-{row['ITM_ID']}",
                "Requested item was returned without a numeric value; applicability is unverified, not zero.",
                status="empty", url=KOSIS_URL, observed_at=period, coverage_gap=True,
                table_id="DT_1F02011", item_id=row["ITM_ID"], industry_code=row.get("C1"),
                sectors=list(sectors), industry_groups=list(industry_groups),
            ))
            continue
        records.append(
            evidence(
                "kosis",
                f"{row.get('C1', 'unknown')}-{row.get('ITM_ID', '')}",
                f"{row.get('C1_NM', 'Unknown industry')} {row.get('ITM_NM', '')}: {value} {row.get('UNIT_NM', '')}".strip(),
                KOSIS_URL,
                observed_at=period,
                table_id="DT_1F02011",
                item_id=row.get("ITM_ID"),
                industry_code=row.get("C1"),
                value=number(value),
                raw_value=value,
                unit=row.get("UNIT_NM"),
                point_in_time=False,
                kind="index",
                title=row.get("C1_NM", "") + " " + row.get("ITM_NM", ""),
                last_changed_at=row.get("LST_CHN_DE"),
                frequency="M",
                country="KR",
                sectors=list(sectors), industry_groups=list(industry_groups),
            )
        )
    # At least one usable observation for each explicitly requested indicator.
    # Do not assume all industry/item combinations are structurally available.
    return require_dimensions(
        "kosis", records,
        {f"DT_1F02011/coverage/{item}": {"table_id": "DT_1F02011", "item_id": item}
         for item in KOSIS_ITEMS}, KOSIS_URL,
    )


def korean_industry_classification(label):
    """Classify an exact verified official label; unknown/free prose stays untagged."""
    sectors, groups = _KOREAN_INDUSTRY_LABELS.get(" ".join(str(label or "").split()), ((), ()))
    return list(sectors), list(groups)
