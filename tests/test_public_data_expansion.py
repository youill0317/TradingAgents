"""Official schemas and the analytical boundaries that can change a decision."""

import io
import zipfile
from unittest.mock import Mock

from langchain_core.messages import AIMessage
from langgraph.graph import END, START, StateGraph

from tradingagents.agents.utils.agent_states import AgentState
from tradingagents.dataflows import (
    fred,
    public_data,
    public_financials,
    public_international,
    public_macro,
)
from tradingagents.dataflows.public_data_common import (
    collect_parts,
    evidence,
    numeric_rows,
    series_changes,
)
from tradingagents.graph.market_graph import MarketAnalysisGraph
from tradingagents.graph.trading_graph import TradingAgentsGraph


def test_census_bulk_decodes_units_basis_and_skips_sampling_errors():
    text = """CATEGORIES
cat_idx,cat_code,cat_desc,cat_indent
1,34,Computer and electronic products,0
DATA TYPES
dt_idx,dt_code,dt_desc,dt_unit
1,NO,New Orders,MLN$
2,MPCNO,Monthly change,PCT
GEO LEVELS
geo_idx,geo_code,geo_desc
1,US,U.S. Total
TIME PERIODS
per_idx,per_name
1,Jul-2026
2,Aug-2026
3,Oct-2026
DATA
per_idx,cat_idx,dt_idx,et_idx,geo_idx,is_adj,val
1,1,1,0,1,0,98
1,1,1,0,1,1,100
2,1,1,0,1,1,0
2,1,1,1,1,1,999
2,1,2,0,1,1,-100
3,1,1,0,1,1,200
"""
    rows = public_macro.census_bulk_rows(text, "M3ADV", "2026-09-15", "https://www.census.gov/")
    assert [r["value"] for r in rows] == [100, 0]
    assert all(r["unit"] == "million USD" and r["basis"] == "seasonally adjusted" for r in rows)
    assert rows[0]["sectors"] == ["Technology"]
    assert rows[0]["published_at"] is None
    annualized = public_macro.census_bulk_rows(text, "VIP", "2026-09-15", "https://www.census.gov/")
    assert annualized[0]["unit"] == "million USD per year (annualized)"
    assert annualized[0]["basis"] == "seasonally adjusted annual rate"


def test_sparse_eurostat_dimensions_do_not_turn_missing_cells_into_zero():
    payload = {
        "id": ["time", "geo"],
        "size": [2, 2],
        "dimension": {
            "time": {"category": {"index": {"2026-08": 1, "2026-07": 0}}},
            "geo": {"category": {"index": ["DE", "FR"]}},
        },
        "value": {"0": 100, "3": 0},
    }
    assert list(public_international.jsonstat_rows(payload)) == [
        ({"geo": "DE", "time": "2026-07"}, 100),
        ({"geo": "FR", "time": "2026-08"}, 0),
    ]


def test_bis_keeps_native_currency_levels_separate(monkeypatch):
    header = "TIME_PERIOD,OBS_VALUE,UNIT_MEASURE,UNIT_MULT,TITLE,CURR_DENOM,BORROWERS_CTY,BORROWERS_SECTOR\n"
    text = (
        header
        + "2026-Q1,100,USD,6,USD credit,USD,3P,N\n2026-Q1,200,EUR,6,EUR credit,EUR,3P,N\n2026-Q1,220,USD,6,Converted EUR credit,EUR,3P,N\n"
    )
    monkeypatch.setattr(public_international, "request_text", lambda *a, **k: text)
    rows = public_international.collect_bis("2026-09-15")
    assert [(r["target"], r["status"]) for r in rows if r["status"] != "success"] == [("GLI/JPY", "empty")]
    rows = [r for r in rows if r["status"] == "success"]
    assert [(r["target"], r["unit"], r["value"]) for r in rows] == [
        ("GLI/USD", "USD; scale 10^6", 100),
        ("GLI/EUR", "EUR; scale 10^6", 200),
    ]


def test_tic_transactions_are_not_holdings_or_valuation(monkeypatch):
    asset_names = [
        "Total U.S. Securities",
        "U.S. Treasuries",
        "U.S. Agency Bonds",
        "U.S. Corp. & Other Bonds",
        "U.S. Corp. Equity",
    ]
    text = (
        "Millions of dollars\n"
        + "\t".join(["", "", ""] + [asset for asset in asset_names for _ in range(3)])
        + "\n"
    )
    text += (
        "\t".join(
            ["Country", "Country Code", "Date"]
            + ["Holdings", "Net U.S. Sales", "Valuation Change"] * 5
        )
        + "\n"
    )
    text += "\t".join(["Japan", "1110", "2026-07"] + ["100", "-5", "10"] * 5) + "\n"
    monkeypatch.setattr(public_international, "request_text", lambda *a, **k: text)
    rows = public_international.collect_tic("2026-09-15")
    assert len(rows) == 15
    assert [(r["metric"], r["value"], r["kind"]) for r in rows[:3]] == [
        ("Holdings", 100, "level"),
        ("Net U.S. Sales", -5, "flow"),
        ("Valuation Change", 10, "flow"),
    ]
    assert "foreign net acquisition" in rows[1]["note"]


def test_fred_pins_metadata_and_observations_and_retains_partial_failure(monkeypatch):
    calls = []

    def request(path, params):
        calls.append((path, params))
        if params["series_id"] == "BAD":
            raise ValueError("https://provider?key=SECRET")
        if path == "series":
            return {"seriess": [{"units": "Percent", "frequency_short": "M", "title": "Test rate"}]}
        return {
            "observations": [
                {"date": "2024-01-01", "value": "3.5"},
                {"date": "2024-02-01", "value": "."},
            ]
        }

    monkeypatch.setattr(fred, "_request", request)
    monkeypatch.setattr(fred, "_fred_today", lambda: "2026-09-15")
    monkeypatch.setattr(public_macro, "FRED_SERIES", {"GOOD": "good", "BAD": "bad"})
    rows = public_macro.collect_fred("2024-03-01")
    assert [r["status"] for r in rows] == ["success", "error"]
    assert rows[0]["point_in_time"] and rows[0]["vintage_date"] == "2024-03-01"
    assert all(p["realtime_start"] == p["realtime_end"] == "2024-03-01" for _, p in calls)
    assert "SECRET" not in str(rows)


def test_bea_months_quarters_and_scaling_are_distinct(monkeypatch):
    monkeypatch.setenv("BEA_API_KEY", "SECRET")
    rows = [
        {
            "TimePeriod": period,
            "DataValue": "1,200",
            "LineNumber": "4",
            "LineDescription": "Motor vehicles",
            "CL_UNIT": "Level",
            "UNIT_MULT": "9",
            "Metric_Name": "Current Dollars",
        }
        for period in ("2026M4", "2026Q2")
    ]
    monkeypatch.setattr(
        public_macro, "request_json", lambda *a, **k: {"BEAAPI": {"Results": {"Data": rows}}}
    )
    result = public_macro.collect_bea("2026-09-15")
    assert len(result) == 6
    assert len({r["target"] for r in result}) == 6
    assert {r["frequency"] for r in result} == {"M", "Q"}
    assert all(
        r["value"] == 1200 and r["unit"] == "Current Dollars; Level; scale 10^9" for r in result
    )
    assert all(r["sectors"] == ["Consumer Cyclical"] for r in result)
    assert "SECRET" not in str(result)


def test_bea_industry_quarter_labels_and_table_units(monkeypatch):
    monkeypatch.setenv("BEA_API_KEY", "SECRET")

    def request(url, params):
        if params["datasetname"] == "NIPA":
            return {"BEAAPI": {"Results": {"Error": {}}}}
        return {
            "BEAAPI": {
                "Results": [
                    {
                        "Data": [
                            {
                                "Year": "2026",
                                "Quarter": "II",
                                "Industry": "31G",
                                "IndustrYDescription": "Manufacturing",
                                "DataValue": "1,200",
                                "Frequency": "Q",
                            },
                        ]
                    }
                ]
            }
        }

    monkeypatch.setattr(public_macro, "request_json", request)
    result = public_macro.collect_bea("2026-09-15")
    assert [r["status"] for r in result] == ["error", "error", "success"]
    assert result[-1]["observed_at"] == "2026Q2"
    assert result[-1]["unit"] == "billion current USD; seasonally adjusted annual rate"


def test_sec_facts_exclude_future_restatements_and_do_not_mix_ytd(monkeypatch):
    def point(value, start="2025-01-01", filed="2025-05-01", accn="original"):
        return {
            "val": value,
            "start": start,
            "end": "2025-03-31",
            "filed": filed,
            "accn": accn,
            "form": "10-Q",
        }

    payload = {
        "facts": {
            "us-gaap": {
                "RevenueFromContractWithCustomerExcludingAssessedTax": {
                    "label": "Revenue",
                    "units": {
                        "USD": [
                            point(100),
                            point(500, filed="2025-09-01", accn="future-restatement"),
                        ]
                    },
                },
                "NetIncomeLoss": {"label": "Profit", "units": {"USD": [point(20)]}},
                "NetCashProvidedByUsedInOperatingActivities": {
                    "label": "CFO",
                    "units": {"USD": [point(30)]},
                },
                "PaymentsToAcquirePropertyPlantAndEquipment": {
                    "label": "Capex",
                    "units": {"USD": [point(8, start="2024-10-01")]},
                },
            }
        }
    }
    monkeypatch.setattr(public_financials, "request_json", lambda *a, **k: payload)
    rows = public_financials.sec_facts("0000000001", "TEST", "2025-06-01", {})
    assert max(r["value"] for r in rows if r.get("evidence_type") == "financial_fact") == 100
    margin = next(r for r in rows if "/net_margin/" in r["target"])
    assert margin["value"] == 20 and margin["unit"] == "percent"
    assert all("/free_cashflow/" not in r["target"] for r in rows)
    assert all(r["published_at"] <= "2025-06-01" for r in rows if r.get("published_at"))
    assert margin["operands"][0]["accession"] == "original"


def test_dart_keeps_consolidation_quarter_and_ytd_bases(monkeypatch):
    monkeypatch.setenv("DART_API_KEY", "SECRET")
    calls = []

    def request(url, params):
        calls.append(params)
        if params["fs_div"] == "CFS":
            return {"status": "013"}
        return {
            "status": "000",
            "list": [
                {
                    "rcept_no": "20260814000001",
                    "sj_div": "IS",
                    "account_id": "Revenue",
                    "account_nm": "매출",
                    "currency": "KRW",
                    "thstrm_amount": "100",
                    "thstrm_add_amount": "180",
                },
                {
                    "rcept_no": "20260814000001",
                    "sj_div": "CF",
                    "account_id": "CFO",
                    "account_nm": "현금",
                    "currency": "KRW",
                    "thstrm_amount": "70",
                },
                {
                    "rcept_no": "20261014000001",
                    "sj_div": "BS",
                    "account_id": "Assets",
                    "thstrm_amount": "999",
                },
            ],
        }

    monkeypatch.setattr(public_financials, "request_json", request)
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("report.xml", "<html><body>" + "사업의 내용 " * 100 + "</body></html>")
    monkeypatch.setattr(
        public_financials, "_request", lambda *a, **k: Mock(content=archive.getvalue())
    )
    filings = [
        evidence(
            "dart",
            "005930",
            {"report_name": "반기보고서 (2026.06)", "receipt_number": "20260814000001"},
            "https://dart.fss.or.kr/",
            published_at="2026-08-14",
        )
    ]
    rows = public_financials.dart_enrichment("00126380", "005930", "2026-09-15", filings)
    facts = [r for r in rows if r.get("evidence_type") == "financial_fact"]
    assert [(r["basis"], r["value"]) for r in facts] == [
        ("OFS/quarter", 100),
        ("OFS/half-year YTD", 180),
        ("OFS/half-year YTD", 70),
    ]
    assert all(r["observed_at"] == "2026-06-30" for r in facts)
    assert calls[0]["reprt_code"] == "11012"
    assert any(r.get("excerpt_only") for r in rows) and "SECRET" not in str(rows)


def test_changes_use_percentage_points_and_matching_calendar_periods():
    rows = numeric_rows(
        "test",
        "rate",
        [("2025-08", 3), ("2026-06", 3.25), ("2026-08", 3.5)],
        "",
        trade_date="2026-09-15",
        unit="percent",
        frequency="M",
    )
    changes = series_changes(rows)
    assert "year (2025-08): +0.5 percentage points" in changes
    assert "3 months" not in changes and "(+" not in changes
    rows[0]["basis"] = "different"
    assert series_changes(rows) == ""


def test_industry_filters_and_real_tool_nodes_preserve_history():
    rows = numeric_rows(
        "census",
        "M3ADV/computers/orders",
        [("2025-08", 100), ("2026-08", 125)],
        "",
        trade_date="2026-09-15",
        unit="million USD",
        frequency="M",
        sectors=["Technology"],
    )
    rows += numeric_rows(
        "census",
        "MRTS/food/sales",
        [("2026-08", 500)],
        "",
        trade_date="2026-09-15",
        unit="million USD",
        frequency="M",
        sectors=["Consumer Defensive"],
    )
    state = {
        "public_data_evidence": rows,
        "instrument_identity": {"sector": "Technology", "industry": "Semiconductors"},
    }
    report = public_data.public_data_for_agent(state, "fundamentals")
    assert "computers/orders" in report and "food/sales" not in report
    assert "Aggregate industry data" in report
    state["messages"] = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "official",
                    "name": "get_official_evidence",
                    "args": {"source": "census", "query": "computers", "observations": 13},
                }
            ],
        )
    ]
    for cls, roles in (
        (TradingAgentsGraph, ("news", "fundamentals")),
        (MarketAnalysisGraph, ("macro", "sector")),
    ):
        graph = object.__new__(cls)
        nodes = graph._create_tool_nodes()
        for role in roles:
            workflow = StateGraph(AgentState)
            workflow.add_node("official_tools", nodes[role])
            workflow.add_edge(START, "official_tools")
            workflow.add_edge("official_tools", END)
            result = workflow.compile().invoke(state)["messages"][-1]
            assert result.status == "success"
            assert "2025-08: 100" in result.content and "2026-08: 125" in result.content
            assert "food/sales" not in result.content


def test_partial_failure_keeps_good_observation_and_hides_exception_url():
    def fail():
        raise ValueError("https://agency.test?key=SECRET")

    rows = collect_parts(
        "test", [("good", lambda: [evidence("test", "good", "observed", "")]), ("bad", fail)]
    )
    assert [r["status"] for r in rows] == ["success", "error"]
    assert "SECRET" not in str(rows)


def test_bounded_digest_rotates_across_census_programs():
    rows = []
    for program in ("M3ADV", "MRTS", "MWTS", "RESCONST", "VIP"):
        for index in range(20):
            rows += numeric_rows(
                "census",
                f"{program}/category{index}/level",
                [("2026-08", 100)],
                "https://www.census.gov/",
                trade_date="2026-09-15",
                unit="million USD",
                frequency="M",
            )
    for source in (
        "ofr",
        "bls",
        "ecb",
        "bis",
        "tic",
        "nyfed",
        "treasury",
        "fred",
        "oecd",
        "eurostat",
        "eia",
    ):
        rows.append(evidence(source, "test", "context", "https://example.test"))
    report = public_data.render_public_data(rows, max_chars=28000)
    assert all(
        f"**{program}/category0/level**" in report
        for program in ("M3ADV", "MRTS", "MWTS", "RESCONST", "VIP")
    )
    assert "omitted by prompt budget" in report and "Available table groups" in report
