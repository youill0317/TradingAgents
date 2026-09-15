import io
import zipfile
from unittest.mock import Mock

from tradingagents.dataflows import public_filings


def _corp_zip():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("CORPCODE.xml", """<result><list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name><stock_code>005930</stock_code></list></result>""")
    return output.getvalue()


def test_sec_maps_ticker_filters_cutoff_and_builds_document_link(monkeypatch):
    monkeypatch.setenv("SEC_USER_AGENT", "Researcher contact@example.com")
    calls = []

    def fake_json(url, **kwargs):
        calls.append((url, kwargs))
        if "company_tickers" in url:
            return {"0": {"ticker": "AAPL", "cik_str": 320193, "title": "Apple Inc."}}
        return {"name": "Apple Inc.", "filings": {"recent": {
            "form": ["10-Q", "10-Q/A", "8-K"],
            "filingDate": ["2024-05-03", "2024-05-04", "2024-06-01"],
            "accessionNumber": ["0000320193-24-000069", "amended", "future"],
            "primaryDocument": ["aapl-20240330.htm", "amendment.htm", "future.htm"],
            "reportDate": ["2024-03-30", "2024-03-30", "2024-05-31"],
        }}}

    monkeypatch.setattr(public_filings, "request_json", fake_json)
    enrich = Mock(return_value=[])
    monkeypatch.setattr(public_filings, "sec_enrichment", enrich)
    rows = public_filings.collect_sec("AAPL", "2024-05-31")
    assert enrich.call_args.args[0] == "0000320193"

    assert len(rows) == 2
    assert rows[1]["content"]["form"] == "10-Q/A"
    assert rows[0]["source"] == "sec"
    assert rows[0]["url"].endswith("/320193/000032019324000069/aapl-20240330.htm")
    assert calls[0][1]["headers"]["User-Agent"] == "Researcher contact@example.com"


def test_dart_maps_stock_code_and_marks_corrections(monkeypatch):
    monkeypatch.setenv("DART_API_KEY", "dart-secret")
    monkeypatch.setattr(public_filings.requests, "get", Mock(return_value=Mock(content=_corp_zip())))
    monkeypatch.setattr(public_filings, "request_json", lambda url, **kwargs: {
        "status": "000", "list": [
            {"rcept_dt": "20240501", "rcept_no": "20240501000001", "corp_name": "삼성전자", "report_nm": "분기보고서"},
            {"rcept_dt": "20240502", "rcept_no": "20240502000001", "corp_name": "삼성전자", "report_nm": "[기재정정]분기보고서"},
            {"rcept_dt": "20240601", "rcept_no": "future", "corp_name": "삼성전자", "report_nm": "사업보고서"},
        ]})

    rows = public_filings.collect_dart("005930.KS", "2024-05-31")

    assert [row["content"]["correction"] for row in rows] == [False, True]
    assert rows[1]["url"].endswith("20240502000001")
    assert "dart-secret" not in str(rows)


def test_fsc_uses_dart_registration_number_and_keeps_small_payload(monkeypatch):
    monkeypatch.setenv("DART_API_KEY", "dart-secret")
    monkeypatch.setenv("DATA_GO_KR_API_KEY", "fsc-secret")
    monkeypatch.setattr(public_filings.requests, "get", Mock(return_value=Mock(content=_corp_zip())))
    calls = []

    def fake_json(url, **kwargs):
        calls.append((url, kwargs.get("params", {})))
        if "company.json" in url:
            return {"status": "000", "jurir_no": "1301110006246"}
        return {"response": {"header": {"resultCode": "00"}, "body": {"items": {"item": {
            "corpNm": "삼성전자", "crno": "1301110006246", "enpRprFnm": "대표", "unused": "large"
        }}}}}

    monkeypatch.setattr(public_filings, "request_json", fake_json)
    rows = public_filings.collect_fsc("005930", "2024-05-31")

    assert rows[0]["content"] == {"corpNm": "삼성전자", "crno": "1301110006246", "enpRprFnm": "대표"}
    assert rows[0]["point_in_time"] is False
    assert calls[-1][1]["crno"] == "1301110006246"
    assert "secret" not in str(rows)


def test_provider_errors_are_not_returned_as_evidence(monkeypatch):
    monkeypatch.setenv("DART_API_KEY", "key")
    monkeypatch.setattr(public_filings.requests, "get", Mock(return_value=Mock(content=_corp_zip())))
    monkeypatch.setattr(public_filings, "request_json", lambda *args, **kwargs: {"status": "010", "message": "bad key"})

    rows = public_filings.collect_dart("005930", "2024-05-31")
    assert len(rows) == 2 and all(r["status"] == "error" for r in rows)
    assert "bad key" not in str(rows)


def test_non_equities_have_no_corporate_filings():
    assert public_filings.collect_sec("BTC-USD", "2024-05-31") == []
    assert public_filings.collect_dart("BTC-USD", "2024-05-31") == []
    assert public_filings.collect_fsc("BTC-USD", "2024-05-31") == []
