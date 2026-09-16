"""Official schemas and the analytical boundaries that can change a decision."""

import io
import zipfile
from unittest.mock import Mock

from tradingagents.dataflows import (
    fred,
    public_data,
    public_financials,
    public_international,
    public_macro,
)
from tradingagents.dataflows.public_analysis import build_diagnostics
from tradingagents.dataflows.public_data_common import (
    collect_parts,
    evidence,
    numeric_rows,
)
from tradingagents.dataflows.public_digest import render_public_data


def test_census_bulk_decodes_units_basis_and_skips_sampling_errors():
    text = """CATEGORIES
cat_idx,cat_code,cat_desc,cat_indent
1,34S,Computer and electronic products,0
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
    # Classification is independent of descriptions and scoped to the program.
    for program, code, expected in (
        ("MWTS", "4235", ["Basic Materials"]),
        ("MWTS", "4247", ["Energy"]),
        ("MRTS", "4541", ["Consumer Cyclical"]),
        ("MRTS", "443", ["Consumer Cyclical"]),
        ("M3ADV", "DXT", []),
        ("M3ADV", "NXA", []),
        ("M3ADV", "34S", ["Technology"]),
        ("MRTS", "34S", []),
        ("MRTS", "4541999", []),
        ("RESCONST", "AUTHNOTSTD", ["Real Estate", "Industrials"]),
        ("RESCONST", "ASTARTS", ["Real Estate", "Industrials"]),
        ("RESCONST", "UNKNOWN", []),
    ):
        payload = text.replace("34S,Computer and electronic products", f"{code},Petroleum excluding computers")
        classified = public_macro.census_bulk_rows(payload, program, "2026-09-15", "https://www.census.gov/")
        assert classified[0]["sectors"] == expected, (program, code)
    annualized = public_macro.census_bulk_rows(
        text.replace("34S,Computer and electronic products", "A04XX,Health care").replace(
            "New Orders", "Public construction spending"
        ),
        "VIP",
        "2026-09-15",
        "https://www.census.gov/",
    )
    assert annualized[0]["title"] == "Health care: Public construction spending"
    assert annualized[0]["sectors"] == ["Healthcare"]
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
    text = text.replace("100", "")
    rows = public_international.collect_tic("2026-09-15")
    gaps = [r for r in rows if r["status"] != "success"]
    assert len(gaps) == 5 and all(r["target"].endswith("/Holdings") for r in gaps)
    assert sum(r["status"] == "success" for r in rows) == 10


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
    def request(url, params):
        industry = params["datasetname"] == "GDPbyIndustry"
        rows = [
            {
                "TimePeriod": period,
                "DataValue": "1,200",
                "Industry" if industry else "LineNumber": "3361MV" if industry else "4",
                "IndustryDescription" if industry else "LineDescription": "Motor vehicles",
                "CL_UNIT": "Level",
                "UNIT_MULT": "9",
                "Metric_Name": "Current Dollars",
            }
            for period in ("2026M4", "2026Q2")
        ]
        return {"BEAAPI": {"Results": {"Data": rows}}}

    monkeypatch.setattr(public_macro, "request_json", request)
    result = public_macro.collect_bea("2026-09-15")
    assert len(result) == 6
    assert len({r["target"] for r in result}) == 6
    assert {r["frequency"] for r in result} == {"M", "Q"}
    assert all(
        r["value"] == 1200 and r["unit"] == "Current Dollars; Level; scale 10^9" for r in result
    )
    assert all(r["sectors"] == ["Consumer Cyclical"] for r in result)
    assert "SECRET" not in str(result)


def test_bea_sector_tags_use_exact_table_and_item_codes():
    for table in ("T20305", "T20306"):
        assert public_macro.bea_sectors("NIPA", table, "19") == ["Consumer Cyclical"]
        assert public_macro.bea_sectors("NIPA", table, "15") == []
    assert public_macro.bea_sectors("GDPbyIndustry", "1", "22") == ["Utilities"]
    assert public_macro.bea_sectors("GDPbyIndustry", "1", "722") == ["Consumer Cyclical"]
    assert public_macro.bea_sectors("GDPbyIndustry", "1", "325") == []
    assert public_macro.bea_sectors("GDPbyIndustry", "2", "22") == []
    assert public_macro.bea_sectors("GDPbyIndustry", "1", "unknown") == []


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


def test_digest_displays_derived_change_without_calculating_from_raw_history():
    rows = numeric_rows(
        "census",
        "rate",
        [("2025-08", 3), ("2026-06", 3.25), ("2026-08", 3.5)],
        "",
        trade_date="2026-09-15",
        unit="percent",
        frequency="M",
    )
    derived = build_diagnostics(rows)
    digest = render_public_data([*rows, *derived])

    assert rows[-1]["content"] in digest
    assert "previous observation" not in digest
    assert derived[0]["content"] in digest
    assert all(f"[{operand['evidence_id']}]" in digest for operand in derived[0]["operands"])


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


def test_ofr_reports_empty_components_without_losing_other_series(monkeypatch):
    columns = ["OFR FSI", "Credit", "Equity valuation", "Safe assets", "Funding",
               "Volatility", "United States", "Other advanced economies", "Emerging markets"]
    text = ",".join(["Date", *columns]) + "\n2026-09-15," + ",".join(["0", "", *["1"] * 7])
    monkeypatch.setattr(public_macro, "request_text", lambda *a, **k: text)
    monkeypatch.setattr(public_macro, "request_json", lambda *a, **k: [["2026-09-15", "3.1"]])
    rows = public_macro.collect_ofr("2026-09-16")
    assert [r["target"] for r in rows if r["status"] != "success"] == ["Credit"]
    assert sum(r["status"] == "success" for r in rows) == 9


def test_mof_reports_missing_series_in_each_frequency(monkeypatch):
    def response(url, **kwargs):
        weekly = url.endswith("week.csv")
        columns = (3, 6, 10, 11, 14, 17, 21, 22) if weekly else (5, 8, 12, 13, 16, 19, 23, 24)
        header, row = [""] * 25, [""] * 25
        header[1:3] = ["Acquisition", "Disposition"]
        if weekly:
            row[0] = "2026.9.7~2026.9.13"
        else:
            row[0], row[2] = "2026", "Aug"
        for col in columns:
            header[col], row[col] = "Net amount", "0"
        row[columns[0]] = ""
        return "100 million Yen\n" + ",".join(header) + "\n" + ",".join(row)
    monkeypatch.setattr(public_international, "request_text", response)
    rows = public_international.collect_mof_japan("2026-09-16")
    assert {r["target"] for r in rows if r["status"] != "success"} == {
        "W/outward/equity", "M/outward/equity",
    }
    assert sum(r["status"] == "success" for r in rows) == 14
