"""Recent official corporate filings and identity records."""

import io
import os
import re
import zipfile
from datetime import date, datetime, timedelta
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

import requests

from tradingagents.dataflows.public_data_common import collect_parts, evidence, request_json
from tradingagents.dataflows.public_financials import dart_enrichment, sec_enrichment

_SEC_TICKERS = "https://www.sec.gov/files/company_tickers.json"
_SEC_SUBMISSIONS = "https://data.sec.gov/submissions/CIK{cik}.json"
_DART_CORP_CODES = "https://opendart.fss.or.kr/api/corpCode.xml"
_DART_LIST = "https://opendart.fss.or.kr/api/list.json"
_DART_COMPANY = "https://opendart.fss.or.kr/api/company.json"
_FSC_OUTLINE = (
    "https://apis.data.go.kr/1160100/service/GetCorpBasicInfoService_V2/getCorpOutline_V2"
)


def _kr_stock_code(ticker):
    match = re.fullmatch(r"(\d{6})(?:\.(?:KS|KQ))?", ticker.upper())
    return match.group(1) if match else None


def _dart_identity(stock_code, key):
    response = requests.get(_DART_CORP_CODES, params={"crtfc_key": key}, timeout=15)
    response.raise_for_status()
    try:
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            root = ElementTree.fromstring(archive.read(archive.namelist()[0]))
    except zipfile.BadZipFile:
        error = ElementTree.fromstring(response.content)
        raise ValueError(
            f"OpenDART error {error.findtext('status')}: {error.findtext('message', '')}"
        ) from None
    for item in root.findall("list"):
        if item.findtext("stock_code", "").strip() == stock_code:
            return item.findtext("corp_code"), item.findtext("corp_name")
    return None, None


def _dart_error(payload):
    status = payload.get("status")
    if status not in (None, "000", "013"):
        raise ValueError(f"OpenDART error {status}: {payload.get('message', '')}")


def collect_sec(ticker, trade_date):
    """Return recent 10-K, 10-Q, and 8-K filing metadata through trade_date."""
    if (
        not re.fullmatch(r"[A-Za-z][A-Za-z0-9.-]*", ticker)
        or ticker.upper().endswith("-USD")
        or _kr_stock_code(ticker)
    ):
        return []
    headers = {"User-Agent": os.environ["SEC_USER_AGENT"]}
    tickers = request_json(_SEC_TICKERS, headers=headers)
    row = next((row for row in tickers.values() if row["ticker"].upper() == ticker.upper()), None)
    if not row:
        return []
    cik = str(row["cik_str"]).zfill(10)
    url = _SEC_SUBMISSIONS.format(cik=cik)
    payload = request_json(url, headers=headers)
    recent = payload.get("filings", {}).get("recent", {})
    results = []
    for form, filed, accession, document, period in zip(
        recent.get("form", []),
        recent.get("filingDate", []),
        recent.get("accessionNumber", []),
        recent.get("primaryDocument", []),
        recent.get("reportDate", []),
        strict=True,
    ):
        if (
            form
            not in {
                "10-K",
                "10-Q",
                "8-K",
                "20-F",
                "40-F",
                "6-K",
                "10-K/A",
                "10-Q/A",
                "8-K/A",
                "20-F/A",
            }
            or filed > trade_date
        ):
            continue
        accession_path = accession.replace("-", "")
        filing_url = (
            f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession_path}/{document}"
        )
        results.append(
            evidence(
                "sec",
                ticker,
                {
                    "company": payload.get("name", row.get("title")),
                    "form": form,
                    "accession_number": accession,
                    "report_date": period,
                },
                filing_url,
                published_at=filed,
                filing_metadata_only=True,
            )
        )
    return results + sec_enrichment(cik, ticker, trade_date, headers, results)


def collect_dart(ticker, trade_date):
    """Return OpenDART filing metadata for a Korean listed stock."""
    stock_code = _kr_stock_code(ticker)
    if not stock_code:
        return []
    key = os.environ["DART_API_KEY"]
    corp_code, corp_name = _dart_identity(stock_code, key)
    if not corp_code:
        return []
    cutoff = date.fromisoformat(trade_date)
    compact_date = cutoff.strftime("%Y%m%d")
    params = {
        "crtfc_key": key,
        "corp_code": corp_code,
        "bgn_de": (cutoff - timedelta(days=1100)).strftime("%Y%m%d"),
        "end_de": compact_date,
        "page_count": 100,
        "sort": "date",
        "sort_mth": "desc",
    }

    def listing(periodic=False):
        payload = request_json(
            _DART_LIST, params={**params, **({"pblntf_ty": "A"} if periodic else {})}
        )
        _dart_error(payload)
        rows = []
        for filing in payload.get("list", []):
            filed = filing.get("rcept_dt", "")
            if filed and filed <= compact_date:
                receipt = filing["rcept_no"]
                rows.append(
                    evidence(
                        "dart",
                        ticker,
                        {
                            "company": filing.get("corp_name", corp_name),
                            "report_name": filing.get("report_nm"),
                            "receipt_number": receipt,
                            "correction": "정정" in filing.get("report_nm", ""),
                        },
                        f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={receipt}",
                        published_at=f"{filed[:4]}-{filed[4:6]}-{filed[6:]}",
                        filing_metadata_only=True,
                    )
                )
        return rows

    # A separate periodic list prevents a busy issuer's event notices from
    # crowding its annual/quarterly reports out of the bounded recent page.
    batches = collect_parts(
        "dart", [("recent filings", listing), ("periodic filings", lambda: listing(True))]
    )
    results, seen = [], set()
    for row in batches:
        receipt = (
            row.get("content", {}).get("receipt_number")
            if isinstance(row.get("content"), dict)
            else None
        )
        if receipt and receipt in seen:
            continue
        seen.add(receipt)
        results.append(row)
    # Current financial endpoints cannot reconstruct all historical restatements.
    # Dated metadata remains available for backtests.
    if cutoff < datetime.now(ZoneInfo("America/New_York")).date():
        return results
    return results + dart_enrichment(
        corp_code, ticker, trade_date, [r for r in results if r["status"] == "success"]
    )


def collect_fsc(ticker, trade_date):
    """Return the FSC's current corporate outline for a Korean listed stock."""
    stock_code = _kr_stock_code(ticker)
    if not stock_code:
        return []
    dart_key = os.environ["DART_API_KEY"]
    corp_code, _ = _dart_identity(stock_code, dart_key)
    if not corp_code:
        return []
    company = request_json(_DART_COMPANY, params={"crtfc_key": dart_key, "corp_code": corp_code})
    _dart_error(company)
    registration_number = company.get("jurir_no")
    if not registration_number:
        return []
    payload = request_json(
        _FSC_OUTLINE,
        params={
            "serviceKey": os.environ["DATA_GO_KR_API_KEY"],
            "resultType": "json",
            "pageNo": 1,
            "numOfRows": 10,
            "crno": registration_number,
        },
    )
    response = payload.get("response", {})
    header = response.get("header", {})
    if str(header.get("resultCode", "00")) != "00":
        raise ValueError(f"FSC error {header.get('resultCode')}: {header.get('resultMsg', '')}")
    items = response.get("body", {}).get("items", {}).get("item", [])
    if isinstance(items, dict):
        items = [items]
    return [
        evidence(
            "fsc",
            ticker,
            {
                key: item.get(key)
                for key in (
                    "corpNm",
                    "crno",
                    "bzno",
                    "enpRprFnm",
                    "sicNm",
                    "enpEstbDt",
                    "enpMainBizNm",
                    "fssCorpChgDtm",
                )
                if item.get(key)
            },
            _FSC_OUTLINE,
            point_in_time=False,
        )
        for item in items
        if item.get("crno") == registration_number
    ]
