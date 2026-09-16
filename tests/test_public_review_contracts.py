"""Focused review regressions: real core modules, controlled provider data, no LLM."""

from copy import deepcopy
from xml.etree import ElementTree

import pytest

from tradingagents.dataflows import public_international, public_korea
from tradingagents.dataflows.public_analysis import build_diagnostics
from tradingagents.dataflows.public_data_common import evidence
from tradingagents.dataflows.public_digest import render_public_data
from tradingagents.dataflows.public_evidence import assess_evidence, evidence_id, source_tables
from tradingagents.dataflows.public_financial_metrics import CORE_FINANCIAL_METRICS, derive_metrics
from tradingagents.dataflows.public_quality import (
    MARKET_REPORTS,
    citation_audit,
    core_evidence_report,
    ticker_quality,
)
from tradingagents.dataflows.public_relevance import assigned_public_rows, selected_public_sectors

DAY = "2026-09-16"


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("Unexpected live HTTP request")
    monkeypatch.setattr("requests.get", blocked)


def observation(source, target, value=100, observed="2026-07", **extra):
    return evidence(source, target, target, "https://example.invalid/official",
                    observed_at=observed, value=value, unit=extra.pop("unit", "USD"),
                    frequency=extra.pop("frequency", "M"), **extra)


def fact(metric, value=100, **extra):
    instant = metric in {"assets", "liabilities", "cash"}
    return observation("sec", "TEST/" + metric, value, "2026-06-30",
                       published_at="2026-08-01", period_end="2026-06-30",
                       period_start=None if instant else "2026-04-01",
                       basis="instant" if instant else "quarter", metric=metric,
                       evidence_type="financial_fact", accession="filing", frequency="Q", **extra)


def published_gdp(monkeypatch, value=0.3):
    dims = {"time": "2026-Q2", "geo": "DE", "unit": "CLV_PCH_PRE", "freq": "Q",
            "s_adj": "SCA", "na_item": "B1GQ"}
    payload = {"id": list(dims), "size": [1] * len(dims), "value": {"0": value},
               "dimension": {key: {"category": {"index": [v]}} for key, v in dims.items()}}
    monkeypatch.setattr(public_international, "EUROSTAT_QUERIES", {"namq_10_gdp": {}})
    monkeypatch.setattr(public_international, "EUROSTAT_COUNTRIES", ("DE",))
    monkeypatch.setattr(public_international, "request_json", lambda *a, **k: payload)
    rows = public_international.collect_eurostat(DAY)
    assert len(rows) == 1 and rows[0]["provider_reported_change"]
    return rows[0]


@pytest.mark.parametrize("text,value", [
    ("Eurostat GDP rose 0.3% QoQ.", 0.3),
    ("Eurostat GDP는 전분기 대비 0.3% 증가했다.", 0.3),
    ("Eurostat GDP fell 0.3% quarter-on-quarter.", -0.3),
    ("Eurostat GDP growth was 0% QoQ.", 0),
])
def test_direct_published_change_needs_only_its_own_observation(monkeypatch, text, value):
    row = published_gdp(monkeypatch, value)
    audit = citation_audit({"macro_report": text + f" [{evidence_id(row)}]"}, [row], MARKET_REPORTS)
    assert audit["warnings"] == []
    assert "Provider-reported change: quarter_on_quarter" in render_public_data([row])
    legacy = {k: v for k, v in row.items() if k not in {"provider_reported_change", "change_basis"}}
    assert citation_audit({"macro_report": text + f" [{evidence_id(legacy)}]"}, [legacy], MARKET_REPORTS)["warnings"] == []


@pytest.mark.parametrize("text", [
    "Eurostat GDP growth accelerated by 0.3 percentage points QoQ.",
    "Eurostat GDP growth was 0.3% YoY.",
    "Eurostat GDP growth rose from 0.1% to 0.3% QoQ.",
    "Eurostat GDP growth was 4% QoQ.",
    "Eurostat unemployment increased 0.3% QoQ.",
    "FRED GDP growth was 0.3% QoQ.",
    "Eurostat GDP growth was 0.3% QoQ annualized.",
])
def test_published_change_is_not_a_blanket_comparison_exemption(monkeypatch, text):
    row = published_gdp(monkeypatch)
    audit = citation_audit({"macro_report": text + f" [{evidence_id(row)}]"}, [row], MARKET_REPORTS)
    assert any("COMPARISON_ENDPOINTS_UNVERIFIED" in warning for warning in audit["warnings"])
    plain = observation("nyfed", "SOFR", 0.3, unit="percent")
    audit = citation_audit({"macro_report": f"NYFed rose 0.3% [{evidence_id(plain)}]"}, [plain], MARKET_REPORTS)
    assert any("COMPARISON_ENDPOINTS_UNVERIFIED" in warning for warning in audit["warnings"])


def issuer_rows():
    rows = [fact(metric) for metric in CORE_FINANCIAL_METRICS]
    rows.append(observation("nyfed", "SOFR", 3, unit="percent"))
    assess_evidence(rows, DAY)
    return rows


def issuer_citations(rows):
    return "\n".join(f"SEC {row['metric']} 100 USD [{row['evidence_id']}]" for row in rows
                     if row.get("metric") in {"revenue", "operating_cashflow", "assets"})


def test_final_issuer_purposes_cannot_be_replaced_by_macro_or_exclusions():
    rows = issuer_rows()
    initial = ticker_quality({"public_data_evidence": rows})
    assert initial["status"] == "COMPLETE"  # No final report exists at precollection.
    state = {"public_data_evidence": rows,
             "final_trade_decision": f"Rating: Buy\nNYFed SOFR 3% [{rows[-1]['evidence_id']}]"}
    quality = ticker_quality(state)
    assert quality["status"] == "REVIEW_REQUIRED"
    assert quality["missing_core_metrics"] == []
    assert set(quality["unverified_core_purposes"]) == {"earnings", "cash_flow", "balance_sheet"}
    state["final_trade_decision"] += "\n[official-exclude:cash_flow] This core purpose is not material to my decision."
    assert ticker_quality(state)["status"] == "REVIEW_REQUIRED"
    assert any("INVALID_PURPOSE_EXCLUSION" in w for w in ticker_quality(state)["warnings"])
    # Presence of old cited cash flow is not a fresh review of current cash flow.
    old = deepcopy(next(r for r in rows if r.get("metric") == "operating_cashflow"))
    old.update(observed_at="2020-06-30", stale=True)
    old["evidence_id"] = evidence_id(old)
    state["public_data_evidence"] = [*rows, old]
    state["final_trade_decision"] = issuer_citations(rows).replace(
        next(r['evidence_id'] for r in rows if r.get('metric') == 'operating_cashflow'), old['evidence_id'])
    assert "cash_flow" in ticker_quality(state)["unverified_core_purposes"]


def test_reasoned_optional_exclusions_are_recorded_without_requiring_all_sources():
    rows = issuer_rows()
    state = {"public_data_evidence": rows, "final_trade_decision": issuer_citations(rows)
             + "\n[official-exclude:liquidity] No financing or rate-sensitive claim is made in this narrow assessment."}
    quality = ticker_quality(state)
    assert quality["status"] == "COMPLETE"
    coverage = quality["citation_audit"]["reports"]["final_trade_decision"]["purpose_coverage"]
    assert coverage["liquidity"]["status"] == "excluded_with_reason"
    assert coverage["cash_flow"]["status"] == "cited"
    state["final_trade_decision"] = issuer_citations(rows) + "\n[official-exclude:liquidity] N/A"
    assert any("INVALID_PURPOSE_EXCLUSION" in w for w in ticker_quality(state)["warnings"])
    # An optional-only run does not invent mandatory issuer facts or block a rating.
    assert ticker_quality({"public_data_evidence": [rows[-1]], "final_trade_decision": "Rating: Hold"})["status"] == "DEGRADED"


@pytest.mark.parametrize("currency", ["USD", "CAD", "CNY", "AUD", "CHF", "INR", "HKD", "SGD", "TWD"])
def test_same_currency_financial_metrics_and_lineage(currency):
    rows = [fact(metric, value, unit=currency) for metric, value in (
        ("revenue", 100), ("net_income", 20), ("operating_cashflow", 30), ("capital_expenditure", 10))]
    derived = {r["metric"]: r for r in derive_metrics(rows, "TEST")}
    assert derived["net_margin"]["value"] == 20
    assert derived["free_cashflow"]["value"] == 20
    assert derived["free_cashflow"]["unit"] == currency
    assert all(op["unit"] == currency for row in derived.values() for op in row["operands"])
    mixed = [fact("revenue", 100, unit=currency), fact("net_income", 20, unit="EUR")]
    assert not any(r.get("metric") == "net_margin" for r in derive_metrics(mixed, "TEST"))


def test_unsupported_monetary_units_are_visible_but_shares_are_not_false_failures():
    rows = [fact("revenue", unit="USD/shares"), fact("net_income", unit="XYZ"),
            fact("shares", unit="shares"), fact("diluted_eps", unit="USD/shares")]
    original_ids = [evidence_id(r) for r in rows]
    derived = derive_metrics(rows, "TEST")
    assert len(derived) == 2
    assert {r["reason_code"] for r in derived} == {"UNSUPPORTED_MONETARY_UNIT"}
    assert all(r["status"] == "unsupported" and r["operands"] for r in derived)
    assert [evidence_id(r) for r in rows] == original_ids
    warnings = assess_evidence([*rows, *derived], DAY)
    assert warnings
    assert "unsupported unit" in render_public_data([*rows, *derived])


def test_cny_ttm_preserves_original_currency_and_contiguous_periods():
    rows = []
    for start, end in (("2025-07-01", "2025-09-30"), ("2025-10-01", "2025-12-31"),
                       ("2026-01-01", "2026-03-31"), ("2026-04-01", "2026-06-30")):
        row = fact("revenue", 100, unit="CNY")
        row.update(period_start=start, period_end=end, observed_at=end, accession=end)
        rows.append(row)
    ttm = [r for r in derive_metrics(rows, "TEST") if r.get("period_basis") == "TTM"]
    assert len(ttm) == 1 and ttm[0]["value"] == 400 and ttm[0]["unit"] == "CNY"
    assert len(ttm[0]["operands"]) == 4


def test_kosis_request_items_and_explicit_nulls_not_an_industry_cartesian_product(monkeypatch):
    monkeypatch.setenv("KOSIS_API_KEY", "fixture")
    def row(item, value):
        return {"PRD_DE": "202607", "C1": "EC", "C1_NM": "반도체", "ITM_ID": item,
                "ITM_NM": "생산", "UNIT_NM": "index", "DT": value}
    monkeypatch.setattr(public_korea, "request_json", lambda *a, **k: [row("T10", "0")])
    rows = public_korea.collect_kosis(DAY)
    assert [r["value"] for r in rows if r["status"] == "success"] == [0]
    assert {r["item_id"] for r in rows if r["status"] != "success"} == {"T11", "T12"}
    assert len(assess_evidence(rows, DAY)) == 2
    monkeypatch.setattr(public_korea, "request_json", lambda *a, **k: [row("T10", "1"), row("T11", "-"), row("T12", "2")])
    rows = public_korea.collect_kosis(DAY)
    missing = [r for r in rows if r["status"] != "success"]
    assert len(missing) == 1 and missing[0]["item_id"] == "T11"
    assert missing[0]["observed_at"] == "202607"
    # No invented combination for a category never returned by the provider.
    assert all(r.get("industry_code") in {"EC", None} for r in rows)


def test_customs_partial_month_keeps_other_fields_and_older_success(monkeypatch):
    monkeypatch.setenv("DATA_GO_KR_API_KEY", "fixture")
    monkeypatch.setattr(public_korea, "CUSTOMS_PRODUCTS", {"8542": ("Integrated circuits", ["Technology"])})
    xml = """<response><resultCode>00</resultCode><items>
    <item><year>2026.07</year><expDlr>0</expDlr><impDlr>10</impDlr><balPayments>-10</balPayments><expWgt>4</expWgt><impWgt>5</impWgt></item>
    <item><year>2026.08</year><expDlr>0</expDlr><impDlr>10</impDlr><balPayments>-10</balPayments><expWgt/><impWgt>5</impWgt></item>
    </items></response>"""
    monkeypatch.setattr(public_korea, "request_xml", lambda *a, **k: ElementTree.fromstring(xml))
    rows = public_korea.collect_customs(DAY)
    missing = [r for r in rows if r["status"] != "success"]
    assert len(missing) == 4 and all(r["field_id"] == "expWgt" for r in missing)
    assert all(r["observed_at"] == "202608" for r in missing)
    assert all(r["value"] == 0 for r in rows if r["status"] == "success" and r["field_id"] == "expDlr")
    assert len(assess_evidence(rows, DAY)) == 4
    monkeypatch.setattr(public_korea, "request_xml", lambda *a, **k: ElementTree.fromstring("<r><resultCode>00</resultCode></r>"))
    assert len(public_korea.collect_customs(DAY)) == 4 * 5


def test_derived_table_lineage_survives_summary_budget_and_legacy_snapshots():
    originals = []
    for table, count in (("M3ADV", 30), ("MRTS", 1), ("MWTS", 1), ("RESCONST", 1), ("VIP", 1)):
        for n in range(count):
            for day, value in (("2025-07", 100), ("2026-07", 110)):
                originals.append(observation("census", f"{table}/{n}/sales/1", value, day))
    derived = build_diagnostics(originals)
    assert {tuple(r["source_tables"]) for r in derived} == {(t,) for t in ("M3ADV", "MRTS", "MWTS", "RESCONST", "VIP")}
    for r in derived:
        legacy = {k: v for k, v in r.items() if k not in {"source_tables", "base_target"}}
        assert source_tables(legacy) == tuple(r["source_tables"])
    digest = render_public_data(derived, max_chars=6500)
    for table in ("M3ADV", "MRTS", "MWTS", "RESCONST", "VIP"):
        assert f"**derived/{table}/" in digest
    assert "derived (" not in digest
    # BEA's paired calculation retains both source tables, not a new fake table.
    rows = [observation("bea", f"NIPA/{table}/1/M", value, day, title="Consumption")
            for table, current in (("T20305", 120), ("T20306", 110))
            for day, value in (("2025-07", 100), ("2026-07", current))]
    gap = next(r for r in build_diagnostics(rows) if "nominal-real" in r["target"])
    assert gap["source_tables"] == ["NIPA/T20305", "NIPA/T20306"]


def test_sector_focus_reserves_each_purpose_and_audits_the_same_scope():
    rows = [observation("census", f"M3ADV/{n}/sales", title="Computer sales", sectors=["Technology"]) for n in range(60)]
    energy = observation("eia", "oil-stock", title="Petroleum stocks", sectors=["Energy"])
    health = observation("census", "health-sales", title="Healthcare sales", sectors=["Healthcare"])
    rows += [energy, health]
    state = {"requested_sectors": ["Technology", "Energy"], "public_data_evidence": rows}
    assigned, _, _ = assigned_public_rows(state, "sector")
    assert health not in assigned and energy in assigned
    digest = core_evidence_report(assigned, "sector", state)
    assert f"Energy/inventory_costs: [{evidence_id(energy)}]" in digest
    assert "Energy/demand: unavailable" in digest
    state["sector_report"] = f"Census computer sales 100 USD [{evidence_id(rows[0])}]"
    audit = citation_audit(state, rows, MARKET_REPORTS)
    coverage = audit["reports"]["sector_report"]["purpose_coverage"]
    assert coverage["Technology/demand"]["status"] == "cited"
    assert coverage["Energy/inventory_costs"]["status"] == "missing"
    assert coverage["Energy/demand"]["status"] == "unavailable"
    state["sector_report"] += "\n[official-exclude:Energy/inventory_costs] No oil inventory claim is made for the regulated power thesis."
    coverage = citation_audit(state, rows, MARKET_REPORTS)["reports"]["sector_report"]["purpose_coverage"]
    assert coverage["Energy/inventory_costs"]["status"] == "excluded_with_reason"
    assert selected_public_sectors({"screen_evidence": "## Equity screen\n### Energy (4 matches)\n## Other\n### Healthcare", "sector_report": "### Technology"}) == ["Energy"]
    assert rows[-1] == health  # Raw collected evidence was not removed or mutated.


def test_partial_failure_details_cannot_overrun_prompt_budget():
    rows = [observation("kosis", "T12", observed=f"2025-{month:02d}") for month in range(1, 13)]
    for row in rows:
        row.update(status="empty", value=None, content="Missing requested observation. " * 100)
    digest = render_public_data(rows, max_chars=2500)
    assert len(digest) < 3000
    assert "1 series with gaps" in digest and "omitted by prompt budget" in digest
    assert len(rows) == 12  # Full details stay in evidence, not silently discarded.
