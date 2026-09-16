from xml.etree import ElementTree

import pytest

from tradingagents.dataflows import public_korea


def test_collect_ecos_filters_future_rows(monkeypatch):
    monkeypatch.setenv("ECOS_API_KEY", "key")
    responses = iter([
        {"StatisticSearch": {"row": [
            {"TIME": "20260910", "ITEM_NAME1": "한국은행 기준금리", "DATA_VALUE": "3", "UNIT_NAME": "연%"},
            {"TIME": "20260913", "ITEM_NAME1": "한국은행 기준금리", "DATA_VALUE": "2.75", "UNIT_NAME": "연%"},
        ]}},
        {"StatisticSearch": {"row": [
            {"TIME": "202608", "ITEM_NAME1": "총지수", "DATA_VALUE": "117.3", "UNIT_NAME": "2020=100"},
        ]}},
        {"KeyStatisticList": {"row": [{"KEYSTAT_NAME": "환율", "CYCLE": "20260910", "DATA_VALUE": "1300", "UNIT_NAME": "원"}]}},
    ])
    monkeypatch.setattr(public_korea, "request_json", lambda url: next(responses))

    rows = public_korea.collect_ecos("2026-09-12")

    assert [(row["target"], row["observed_at"], row["value"]) for row in rows] == [
        ("policy_rate", "20260910", 3.0), ("consumer_prices", "202608", 117.3), ("key/환율", "20260910", 1300.0)
    ]


def test_collect_customs_uses_latest_finalized_month_and_keeps_zero(monkeypatch):
    monkeypatch.setenv("DATA_GO_KR_API_KEY", "key")
    calls = []
    xml = """<response><header><resultCode>00</resultCode></header><body><items><item>
      <year>2026.07</year><hsCd>8542</hsCd><statCd>US</statCd><expDlr>0</expDlr>
      <expWgt>10</expWgt><impDlr>20</impDlr><impWgt>30</impWgt><balPayments>-20</balPayments>
    </item><item><year>2026.08</year></item><item><year>총계</year></item>
    <item><year>합계</year></item><item><year>2026.01~2026.07</year></item></items></body></response>"""

    def fake_request(url, params=None, headers=None):
        calls.append(params)
        return ElementTree.fromstring(xml)

    monkeypatch.setattr(public_korea, "request_xml", fake_request)
    rows = public_korea.collect_customs("2026-09-12")

    good = [r for r in rows if r["status"] == "success"]
    assert len(good) == 5
    assert good[0]["target"] == "HS8542-US/expDlr"
    assert good[0]["value"] == 0
    assert len(rows) == 5 + 23 * 5  # Missing responses now expose each requested measure.
    assert rows[0]["export_valuation"] == "FOB"
    assert rows[0]["import_valuation"] == "CIF"
    assert {call["cntyCd"] for call in calls} == {"US", "CN", "JP", "VN"}
    assert all(call["endYymm"] == "202607" for call in calls)


def test_collect_kosis_selects_industry_production_shipments_inventory(monkeypatch):
    monkeypatch.setenv("KOSIS_API_KEY", "key")
    captured = {}
    payload = [
        {"PRD_DE": "202608", "C1": "EC", "C1_NM": "반도체 및 부품", "ITM_ID": "T10", "ITM_NM": "산업생산지수(원지수)", "DT": "142.1", "UNIT_NM": "2020=100", "LST_CHN_DE": "20260901"},
        {"PRD_DE": "202609", "C1": "EC", "ITM_ID": "T12", "DT": ""},
        {"PRD_DE": "202610", "C1": "EC", "ITM_ID": "T12", "DT": "150.0"},
    ]

    def fake_request(url, params=None, headers=None):
        captured.update(params)
        return payload

    monkeypatch.setattr(public_korea, "request_json", fake_request)
    rows = public_korea.collect_kosis("2026-09-12")

    assert captured["tblId"] == "DT_1F02011"
    assert captured["objL1"] == "ALL"
    assert captured["itmId"] == "T10 T11 T12"
    assert [(row["observed_at"], row["value"]) for row in rows if row["status"] == "success"] == [("202608", 142.1)]
    assert {row["item_id"] for row in rows if row["status"] != "success"} == {"T11", "T12"}
    assert rows[0]["sectors"] == ["Technology"]


def test_provider_body_errors_are_not_treated_as_data(monkeypatch):
    monkeypatch.setenv("KOSIS_API_KEY", "key")
    monkeypatch.setattr(public_korea, "request_json", lambda *args, **kwargs: {"err": "20", "errMsg": "invalid request"})

    with pytest.raises(ValueError, match="KOSIS: invalid request"):
        public_korea.collect_kosis("2026-09-12")
