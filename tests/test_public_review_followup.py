"""Boundary regressions from the second official-data review; no live services."""

import io
import json
import zipfile
from datetime import date, timedelta
from unittest.mock import Mock

import pytest
from langchain_core.messages import AIMessage
from langgraph.graph import END, START, StateGraph

from tests.test_market_validation import run as market_run
from tests.test_public_review_fixes import fact, obs
from tradingagents.agents.managers.portfolio_manager import create_portfolio_manager
from tradingagents.agents.utils.agent_states import AgentState
from tradingagents.agents.utils.public_data_tools import get_official_evidence
from tradingagents.agents.utils.rating import parse_rating
from tradingagents.dataflows import public_financials, public_international, public_korea, public_us
from tradingagents.dataflows.public_analysis import build_diagnostics
from tradingagents.dataflows.public_data import public_data_for_agent
from tradingagents.dataflows.public_data_common import evidence, failure, series_changes
from tradingagents.dataflows.public_evidence import assess_evidence, evidence_id
from tradingagents.dataflows.public_financial_metrics import CORE_FINANCIAL_METRICS, derive_metrics
from tradingagents.dataflows.public_quality import (
    MARKET_REPORTS,
    TICKER_REPORTS,
    citation_audit,
    ticker_quality,
)
from tradingagents.graph.market_graph import MarketAnalysisGraph
from tradingagents.graph.propagation import Propagator
from tradingagents.graph.signal_processing import SignalProcessor
from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.reporting import write_market_report_tree, write_report_tree


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr("requests.get", Mock(side_effect=AssertionError("Unexpected HTTP request")))


def test_sec_mixed_taxonomies_collect_ifrs_margins_and_fcf_without_mixing(monkeypatch):
    def concept(value, unit="USD", instant=False):
        point = {"end": "2025-12-31", "filed": "2026-03-01", "val": value, "form": "20-F", "accn": "annual"}
        if not instant:
            point["start"] = "2025-01-01"
        return {"units": {unit: [point]}}

    payload = {"facts": {
        "us-gaap": {"CommonStockSharesOutstanding": concept(10, "shares", True)},
        "ifrs-full": {name: concept(value, instant=name in {"Assets", "Liabilities"}) for name, value in {
            "Revenue": 100, "ProfitLoss": 10, "GrossProfit": 40,
            "ProfitLossFromOperatingActivities": 20,
            "CashFlowsFromUsedInOperatingActivities": 50,
            "PaymentsToAcquirePropertyPlantAndEquipment": 20, "Assets": 200, "Liabilities": 80,
        }.items()},
    }}
    monkeypatch.setattr(public_financials, "request_json", lambda *a, **k: payload)
    rows = public_financials.sec_facts("1", "TEST", "2026-09-16", {})
    assert set(CORE_FINANCIAL_METRICS) <= {r.get("metric") for r in rows if r["status"] == "success"}
    derived = {r["metric"]: r for r in rows if r.get("evidence_type") == "derived_financial"}
    assert derived["operating_margin"]["value"] == 20
    assert derived["free_cashflow"]["value"] == 30
    assert all(r["accounting_standard"] == "ifrs-full" for r in derived.values())
    assert not any(r.get("coverage_gap") for r in rows)
    incompatible = [fact("revenue", 100, accounting_standard="us-gaap"),
                    fact("net_income", 20, accounting_standard="ifrs-full")]
    assert not any(r["metric"] == "net_margin" for r in derive_metrics(incompatible, "TEST"))


@pytest.mark.parametrize("cadence,stale", [("A", False), ("Q", True)])
def test_annual_derived_refresh_inherits_actual_reporting_cadence(cadence, stale):
    rows = [fact(metric, value, "2025-01-01", "2025-12-31", period="annual", refresh_frequency=cadence)
            for metric, value in (("revenue", 100), ("net_income", 20))]
    derived = derive_metrics(rows, "TEST")
    assess_evidence([*rows, *derived], "2026-09-16")
    assert len(derived) == 1 and derived[0]["frequency"] == "A"
    assert all(r["stale"] is stale and r["refresh_frequency"] == cadence for r in [*rows, *derived])


def test_old_observation_window_and_paging_work_in_both_real_tool_nodes():
    rows = [obs("nyfed", "SOFR", 3, (date(2025, 1, 1) + timedelta(days=n)).isoformat()) for n in range(300)]
    state = {"public_data_evidence": rows, "messages": [AIMessage(content="", tool_calls=[{
        "id": "history", "name": "get_official_evidence", "args": {
            "source": "nyfed", "query": "SOFR", "start_date": "2025-01-01", "end_date": "2025-01-10",
            "observations": 5, "observation_offset": 5,
        },
    }])]}
    for cls, role in ((TradingAgentsGraph, "news"), (MarketAnalysisGraph, "macro")):
        graph = object.__new__(cls)
        workflow = StateGraph(AgentState)
        workflow.add_node("lookup", graph._create_tool_nodes()[role])
        workflow.add_edge(START, "lookup")
        workflow.add_edge("lookup", END)
        message = workflow.compile().invoke(state)["messages"][-1]
        assert message.status == "success"
        assert all(evidence_id(row) in message.content for row in rows[:5])
        assert all(evidence_id(row) not in message.content for row in rows[5:])
        assert "end of history" in message.content
    assert "Invalid date range" in get_official_evidence.func("nyfed", state, start_date="2025-02-01", end_date="2025-01-01")


@pytest.mark.parametrize("source", ["ecos", "kosis"])
def test_lagged_monthly_release_retains_yoy_despite_intermediate_gaps(monkeypatch, source):
    monkeypatch.setenv("ECOS_API_KEY", "test")
    monkeypatch.setenv("KOSIS_API_KEY", "test")
    periods = [("202507", 100), ("202601", 105), ("202607", 110)]
    starts = []

    def request(url, params=None):
        if source == "ecos":
            if "722Y001" in url:
                return {"StatisticSearch": {"row": [{"TIME": "20260901", "DATA_VALUE": 3, "UNIT_NAME": "연%"}]}}
            start = url.split("/")[-3]
            starts.append(start)
            return {"StatisticSearch": {"row": [{"TIME": period, "DATA_VALUE": value, "UNIT_NAME": "2020=100"}
                                                for period, value in periods if period >= start]}}
        starts.append(params["startPrdDe"])
        return [{"PRD_DE": period, "C1": "EC", "C1_NM": "반도체", "ITM_ID": "T10", "ITM_NM": "생산", "UNIT_NM": "2020=100", "DT": value}
                for period, value in periods if period >= params["startPrdDe"]]

    monkeypatch.setattr(public_korea, "request_json", request)
    rows = public_korea._collect_ecos_history("2026-09-16") if source == "ecos" else public_korea.collect_kosis("2026-09-16")
    monthly = [r for r in rows if r.get("frequency") == "M"]
    assert starts == ["202309"]
    assert "year (202507): +10" in series_changes(monthly)
    assert "3 months" not in series_changes(monthly)


@pytest.mark.parametrize("source,missing_count", [("ecb", 2), ("oecd", 13), ("bis", 2), ("eurostat", 4)])
def test_multiseries_collectors_expose_partial_coverage_and_retain_zero(monkeypatch, source, missing_count):
    if source == "ecb":
        monkeypatch.setattr(public_us, "request_text", lambda *a, **k: "PROVIDER_FM_ID,TIME_PERIOD,OBS_VALUE\nDFR,2026-09-01,0\n")
        rows = public_us.collect_ecb("2026-09-16")
    elif source == "oecd":
        xml = '<g:Data xmlns:g="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/data/generic"><g:Series><g:SeriesKey><g:Value id="REF_AREA" value="KOR"/><g:Value id="MEASURE" value="LI"/></g:SeriesKey><g:Obs><g:ObsDimension value="2026-08"/><g:ObsValue value="0"/></g:Obs></g:Series></g:Data>'
        monkeypatch.setattr(public_international, "request_text", lambda *a, **k: xml)
        rows = public_international.collect_oecd("2026-09-16")
    elif source == "bis":
        csv = "TIME_PERIOD,OBS_VALUE,UNIT_MEASURE,UNIT_MULT,TITLE,CURR_DENOM,BORROWERS_CTY,BORROWERS_SECTOR\n2026-Q2,0,USD,6,Credit,USD,3P,N\n"
        monkeypatch.setattr(public_international, "request_text", lambda *a, **k: csv)
        rows = public_international.collect_bis("2026-09-16")
    else:
        dims = {"time": "2026-08", "geo": "DE", "unit": "I21", "freq": "M", "s_adj": "SCA", "nace_r2": "B-D"}
        payload = {"id": list(dims), "size": [1] * len(dims), "value": {"0": 0},
                   "dimension": {key: {"category": {"index": [value]}} for key, value in dims.items()}}
        monkeypatch.setattr(public_international, "EUROSTAT_QUERIES", {"sts_inpr_m": {}})
        monkeypatch.setattr(public_international, "request_json", lambda *a, **k: payload)
        rows = public_international.collect_eurostat("2026-09-16")
    assert [r["value"] for r in rows if r["status"] == "success"] == [0]
    missing = [r for r in rows if r["status"] == "empty"]
    assert len(missing) == missing_count and all(r["coverage_gap"] for r in missing)


def test_dart_reads_periodic_and_material_event_instead_of_latest_minor_filing(monkeypatch):
    monkeypatch.setenv("DART_API_KEY", "secret")
    monkeypatch.setattr(public_financials, "request_json", lambda *a, **k: {"status": "000", "list": []})
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as file:
        file.writestr("report.xml", "<html>사업의 내용 " + "공시 원문 " * 100 + "</html>")
    receipts = []

    def download(url, params):
        receipts.append(params["rcept_no"])
        return Mock(content=archive.getvalue())

    monkeypatch.setattr(public_financials, "_request", download)
    filings = [evidence("dart", "TEST", {"report_name": name, "receipt_number": receipt}, "https://dart.fss.or.kr/", published_at=day)
               for name, receipt, day in (("반기보고서 (2026.06)", "periodic", "2026-08-14"),
                                          ("주요사항보고서(유상증자결정)", "event", "2026-09-10"),
                                          ("임원주식소유상황보고서", "minor", "2026-09-15"))]
    rows = public_financials.dart_enrichment("1", "TEST", "2026-09-16", filings)
    assert receipts == ["periodic", "event"]
    assert {r.get("document_role") for r in rows if r.get("excerpt_only")} == {"periodic", "material_event"}


def test_financial_quality_changes_and_limited_debt_definition_retain_operands():
    rows = []
    for year, values in ((2025, (100, 20, 30)), (2026, (120, 25, 31))):
        for metric, value in zip(("revenue", "net_income", "operating_cashflow"), values, strict=True):
            rows.append(fact(metric, value, f"{year}-01-01", f"{year}-03-31", accession=str(year)))
    rows += [fact(metric, value, start=None, period="instant") for metric, value in (
        ("current_portion_long_term_debt", 10), ("long_term_debt_noncurrent", 90), ("cash", 40))]
    out = derive_metrics(rows, "TEST")
    latest = {r["metric"]: r for r in out if r["observed_at"] == "2026-03-31"}
    assert latest["revenue_yoy"]["value"] == pytest.approx(20)
    assert latest["operating_cashflow_yoy"]["value"] == pytest.approx(100 / 30)
    assert latest["cash_conversion"]["value"] == pytest.approx(124)
    assert latest["long_term_debt_less_cash"]["value"] == 60
    assert "not total net debt" in latest["long_term_debt_less_cash"]["note"]
    assert all(r["operands"] for r in out)


def test_industry_changes_require_exact_period_basis_and_match_nominal_real():
    rows = []
    for table, current, unit in (("T20305", 120, "nominal USD"), ("T20306", 110, "chained USD")):
        rows += [obs("bea", f"NIPA/{table}/1/M", value, day, unit=unit, frequency="M", kind="level", title="Consumption", basis=unit)
                 for day, value in (("2025-08", 100), ("2026-08", current))]
    out = build_diagnostics(rows)
    gap = next(r for r in out if "nominal-real" in r["target"])
    assert gap["value"] == pytest.approx(10) and gap["unit"] == "percentage points"
    assert "not an exact price deflator" in gap["note"]
    assert any("missing exact comparison period" in " ".join(r.get("calculation_gaps", [])) for r in rows)
    rows[0]["basis"] = "different adjustment"
    assert not any("nominal-real" in r["target"] for r in build_diagnostics(rows))


def test_core_purpose_digest_precedes_large_source_tables_and_flags_uncited_claims():
    rows = [obs("fred", target, 3, "2026-09-01") for target in ("WALCL", "NFCI", "INDPRO", "T10YIE")]
    rows += [obs("census", f"bulk/{n}", 100, "2026-08", unit="USD", title="Retail sales " + "detail " * 100) for n in range(40)]
    digest = public_data_for_agent({"public_data_evidence": rows}, "macro")
    core = digest.split("Official coverage")[0]
    assert all(evidence_id(row) in core for row in rows[:4])
    audit = citation_audit({"macro_report": "FRED activity increased 3%."}, rows, MARKET_REPORTS)
    assert any("UNCITED_OFFICIAL_NUMBER" in w for w in audit["warnings"])
    assert audit["reports"]["macro_report"]["uncited_topics"]
    audit = citation_audit({"macro_report": f"FRED rose 3% [{evidence_id(rows[2])}] [ev-0000000000000000]"}, rows, MARKET_REPORTS)
    assert any("COMPARISON_ENDPOINTS_UNVERIFIED" in w for w in audit["warnings"])
    assert any("UNKNOWN_IDS" in w for w in audit["warnings"])


def test_ticker_core_gap_is_separate_from_optional_failures_and_blocks_signal(tmp_path):
    rows = [fact(metric, 100) for metric in CORE_FINANCIAL_METRICS]
    optional = failure("ecb", "MLFR", "Missing optional policy rate", status="empty")
    assert ticker_quality({"public_data_evidence": [*rows, optional]})["status"] == "DEGRADED"
    assert ticker_quality({"public_data_evidence": [optional]})["status"] == "DEGRADED"
    rows = [r for r in rows if r["metric"] != "operating_cashflow"]
    state = Propagator().create_initial_state("TEST", "2026-09-16")
    state.update(public_data_evidence=rows, public_data_warnings=["PUBLIC_GAP"], investment_plan="plan", trader_investment_plan="plan")
    llm = Mock()
    llm.with_structured_output.side_effect = NotImplementedError
    llm.invoke.return_value = AIMessage(content="**Rating**: Buy\nSEC revenue 100 USD [" + evidence_id(rows[0]) + "]")
    workflow = StateGraph(AgentState)
    workflow.add_node("manager", create_portfolio_manager(llm))
    workflow.add_edge(START, "manager")
    workflow.add_edge("manager", END)
    final = workflow.compile().invoke(state)
    assert final["analysis_status"] == "REVIEW_REQUIRED"
    assert final["public_data_quality"]["missing_core_metrics"] == ["operating_cashflow"]
    assert SignalProcessor().process_signal(final["final_trade_decision"]) == "REVIEW"
    assert parse_rating(final["final_trade_decision"]) == "REVIEW"
    report = write_report_tree(final, "TEST", tmp_path)
    assert "REVIEW_REQUIRED" in report.read_text()
    assert json.loads((tmp_path / "analysis_quality.json").read_text()) == final["public_data_quality"]


def test_market_citation_audit_affects_status_and_export(monkeypatch, tmp_path):
    rows = [obs("fred", "WALCL", 100)]
    final, _ = market_run(monkeypatch, public_data_evidence=rows)
    assert final["scan_status"] == "DEGRADED"
    assert any("NO_NUMERIC_CITATIONS" in w for w in final["scan_warnings"])
    assert "market_scan_report" in final["public_data_quality"]["reports"]
    write_market_report_tree(final, tmp_path)
    assert json.loads((tmp_path / "validation.json").read_text())["official_data_audit"] == final["public_data_quality"]


def test_citation_coverage_uses_the_same_role_and_industry_routing_as_prompts():
    row = fact("revenue", 100)
    unrelated = obs("customs", "HS8542-US/expDlr", 200, frequency="M", title="Integrated circuits exports", hs_code="8542", sectors=["Technology"])
    state = {"instrument_identity": {"sector": "Technology", "industry": "Software"},
             "fundamentals_report": f"SEC revenue 100 USD [{evidence_id(row)}]",
             "news_report": "Company filing event."}
    audit = citation_audit(state, [row, unrelated], TICKER_REPORTS)
    assert audit["warnings"] == []
    assert "news_report" not in audit["reports"]
