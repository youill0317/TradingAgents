"""Bounded official Korean macro and semiconductor-industry evidence."""

import os
import re
from datetime import date, datetime, timedelta

from .public_data_common import evidence, request_json, request_xml

ECOS_URL = "https://ecos.bok.or.kr/api/StatisticSearch"
CUSTOMS_URL = "https://apis.data.go.kr/1220000/nitemtrade/getNitemtradeList"
KOSIS_URL = "https://kosis.kr/openapi/Param/statisticsParameterData.do"


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


def collect_ecos(trade_date):
    """Collect fixed policy-rate and CPI observations available by trade_date."""
    day = datetime.strptime(trade_date, "%Y-%m-%d").date()
    key = os.environ["ECOS_API_KEY"]
    series = (
        ("policy_rate", "722Y001", "D", (day - timedelta(days=45)).strftime("%Y%m%d"), day.strftime("%Y%m%d"), "0101000"),
        ("consumer_prices", "901Y009", "M", _month_offset(day, -12).strftime("%Y%m"), day.strftime("%Y%m"), "0"),
    )
    records = []
    for target, stat_code, cycle, start, end, item_code in series:
        rows = _ecos_rows(key, stat_code, cycle, start, end, item_code)
        for row in rows:
            observed = row.get("TIME", "")
            if observed and observed <= end:
                records.append(evidence(
                    "ecos", target,
                    f"{row.get('ITEM_NAME1', target)}: {row.get('DATA_VALUE', '')} {row.get('UNIT_NAME', '')}".strip(),
                    ECOS_URL, observed_at=observed, stat_code=stat_code, item_code=item_code,
                    frequency=cycle, value=row.get("DATA_VALUE"), unit=row.get("UNIT_NAME"),
                ))
    return records


def collect_customs(trade_date):
    """Collect the last twelve finalized months of HS 8542 trade with the US and China."""
    day = datetime.strptime(trade_date, "%Y-%m-%d").date()
    end_month = _month_offset(day, -1 if day.day >= 15 else -2)
    start_month = _month_offset(end_month, -11)
    records = []
    for country in ("US", "CN"):
        params = {
            "serviceKey": os.environ["DATA_GO_KR_API_KEY"],
            "strtYymm": start_month.strftime("%Y%m"), "endYymm": end_month.strftime("%Y%m"),
            "hsSgn": "8542", "cntyCd": country,
        }
        root = request_xml(CUSTOMS_URL, params=params)
        code = root.findtext(".//resultCode")
        if code != "00":
            raise ValueError(f"Customs: {root.findtext('.//resultMsg') or code or 'invalid response'}")
        for item in root.findall(".//item"):
            raw_period = item.findtext("year") or ""
            if not re.fullmatch(r"\d{4}\.\d{2}", raw_period):
                continue
            period = raw_period.replace(".", "")
            if period > end_month.strftime("%Y%m"):
                continue
            values = {name: item.findtext(name) for name in ("expDlr", "expWgt", "impDlr", "impWgt", "balPayments")}
            records.append(evidence(
                "customs", f"HS8542-{country}",
                f"HS 8542 {country} exports FOB ${values['expDlr']} ({values['expWgt']} kg); imports CIF ${values['impDlr']} ({values['impWgt']} kg); balance ${values['balPayments']}",
                CUSTOMS_URL, observed_at=period, hs_code=item.findtext("hsCd") or "8542",
                country_code=item.findtext("statCd") or country, unit_currency="USD", unit_weight="kg",
                export_valuation="FOB", import_valuation="CIF", **values,
            ))
    return records


def collect_kosis(trade_date):
    """Collect monthly semiconductor production and inventory indexes (2020=100)."""
    day = datetime.strptime(trade_date, "%Y-%m-%d").date()
    end = day.strftime("%Y%m")
    params = {
        "method": "getList", "apiKey": os.environ["KOSIS_API_KEY"], "format": "json", "jsonVD": "Y",
        "orgId": "101", "tblId": "DT_1F02011", "objL1": "EC", "itmId": "T10 T12", "prdSe": "M",
        "startPrdDe": _month_offset(day, -12).strftime("%Y%m"), "endPrdDe": end,
    }
    payload = request_json(KOSIS_URL, params=params)
    if not isinstance(payload, list):
        raise ValueError(f"KOSIS: {payload.get('errMsg', 'invalid response') if isinstance(payload, dict) else 'invalid response'}")
    records = []
    for row in payload:
        period = row.get("PRD_DE", "")
        if not period or period > end:
            continue
        value = row.get("DT")
        records.append(evidence(
            "kosis", f"semiconductors-{row.get('ITM_ID', '')}",
            f"{row.get('C1_NM', '반도체 및 부품')} {row.get('ITM_NM', '')}: {value} {row.get('UNIT_NM', '')}".strip(),
            KOSIS_URL, observed_at=period, table_id="DT_1F02011", item_id=row.get("ITM_ID"),
            industry_code=row.get("C1"), value=value, unit=row.get("UNIT_NM"),
            last_changed_at=row.get("LST_CHN_DE"),
        ))
    return records
