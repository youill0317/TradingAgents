"""Review regressions on real collectors/routing/quality; no network or LLM calls."""

from copy import deepcopy
from xml.etree import ElementTree as ET

import pytest

from tradingagents.dataflows import public_korea, public_macro, public_us
from tradingagents.dataflows.public_analysis import build_diagnostics
from tradingagents.dataflows.public_data_common import evidence
from tradingagents.dataflows.public_digest import render_public_data
from tradingagents.dataflows.public_evidence import assess_evidence, coverage_report
from tradingagents.dataflows.public_financial_metrics import CORE_FINANCIAL_METRICS, derive_metrics
from tradingagents.dataflows.public_quality import core_evidence_report, ticker_quality, topics
from tradingagents.dataflows.public_relevance import (
    assigned_public_rows,
    exposures,
    route_ticker_rows,
)

DAY = "2026-09-16"


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("Unexpected HTTP request")
    monkeypatch.setattr("requests.get", blocked)


def _customs_response(params):
    first, last = params["strtYymm"], params["endYymm"]
    start, end = int(first[:4]) * 12 + int(first[4:]) - 1, int(last[:4]) * 12 + int(last[4:]) - 1
    assert 0 <= end - start < 12  # Enforce the provider contract in the fixture.
    root = ET.fromstring("<response><resultCode>00</resultCode><items/></response>")
    for month in range(start, end + 1):
        item = ET.SubElement(root.find("items"), "item")
        values = {"year": f"{month // 12}.{month % 12 + 1:02}", "hsCd": params["hsSgn"],
                  "statCd": params["cntyCd"], **{f: "0" if f == "expWgt" else str(month)
                                                 for f, _, _ in public_korea.CUSTOMS_FIELDS}}
        for key, value in values.items():
            ET.SubElement(item, key).text = value
    root.find("items").append(deepcopy(root.find("items/item")))  # Identical provider duplicate.
    return root


@pytest.mark.parametrize("day,end", [(DAY, "202608"), ("2026-09-12", "202607"), ("2026-01-16", "202512")])
def test_customs_splits_year_boundary_retains_yoy_and_zero(monkeypatch, day, end):
    monkeypatch.setenv("DATA_GO_KR_API_KEY", "test")
    monkeypatch.setattr(public_korea, "CUSTOMS_PRODUCTS", {"8542": ("Integrated circuits", ["Technology"])})
    calls = []
    def request(url, params):
        calls.append(params)
        return _customs_response(params)
    monkeypatch.setattr(public_korea, "request_xml", request)
    rows = public_korea.collect_customs(day)
    assert len(calls) == 8  # Four partners, two independent bounded requests.
    assert all(r["status"] == "success" for r in rows)
    assert len(rows) == 4 * 13 * 5
    assert len({(r["target"], r["observed_at"]) for r in rows}) == len(rows)
    assert max(r["observed_at"] for r in rows) == end
    assert all(r["value"] == 0 for r in rows if r["field_id"] == "expWgt")
    changes = build_diagnostics(rows)
    assert any(r.get("comparison_months") == 12 and r["base_target"] == "HS8542-US/expDlr" for r in changes)


@pytest.mark.parametrize("failure_mode", ["error", "empty"])
def test_customs_latest_window_failure_does_not_erase_history(monkeypatch, failure_mode):
    monkeypatch.setenv("DATA_GO_KR_API_KEY", "secret")
    monkeypatch.setattr(public_korea, "CUSTOMS_PRODUCTS", {"8542": ("Integrated circuits", ["Technology"])})
    def request(url, params):
        if params["strtYymm"] == "202608":
            if failure_mode == "error":
                raise ValueError("credential-bearing URL secret")
            return ET.fromstring("<response><resultCode>00</resultCode><items/></response>")
        return _customs_response(params)
    monkeypatch.setattr(public_korea, "request_xml", request)
    rows = public_korea.collect_customs(DAY)
    assert len([r for r in rows if r["status"] == "success"]) == 4 * 12 * 5
    assert any(r["status"] == failure_mode and "202608" in r["target"] for r in rows)
    assert "secret" not in str(rows)


def _cftc_row(market="A", **updates):
    return {"market_and_exchange_names": market, "report_date_as_yyyy_mm_dd": "2026-09-08T00:00:00.000",
            "open_interest_all": "1000", "asset_mgr_positions_long": "60", "asset_mgr_positions_short": "20",
            "lev_money_positions_long": "10", "lev_money_positions_short": "30", "contract_units": "contracts", **updates}


@pytest.mark.parametrize("bad", [None, "", "nan", "-1", "1.5"])
def test_cftc_bad_leg_preserves_other_metrics_and_valid_components(monkeypatch, bad):
    payload = [_cftc_row(asset_mgr_positions_long=bad), _cftc_row("B")]
    monkeypatch.setattr(public_us, "request_json", lambda *a, **k: payload)
    rows = public_us.collect_cftc(DAY)
    by_target = {r["target"]: r for r in rows}
    assert by_target["A/asset manager net"]["status"] == "empty"
    assert by_target["A/asset manager net"]["position_components"]["asset_mgr_positions_short"] == 20
    assert by_target["A/leveraged money net"]["value"] == -20
    assert by_target["A/open interest"]["value"] == 1000
    assert by_target["B/asset manager net"]["value"] == 40
    assert by_target["B/asset manager net"]["position_components"] == {
        "asset_mgr_positions_long": 60, "asset_mgr_positions_short": 20,
    }
    assert any("Requested position field" in w for w in assess_evidence(rows, DAY))


def test_cftc_invalid_ranking_is_visible_even_outside_top_twelve(monkeypatch):
    payload = [_cftc_row(str(n)) for n in range(12)] + [_cftc_row("bad", open_interest_all="unknown")]
    monkeypatch.setattr(public_us, "request_json", lambda *a, **k: payload)
    rows = public_us.collect_cftc(DAY)
    assert len([r for r in rows if r["status"] == "success"]) == 36
    assert any(r["target"] == "bad/selection" and r.get("coverage_gap") for r in rows)


@pytest.mark.parametrize("spelling", ["nonresidential", "non-residential", "non residential", "NONRESIDENTIAL"])
def test_nonresidential_never_matches_homebuilder_even_with_legacy_sector_tag(spelling):
    title = "Private " + spelling + " construction spending"
    assert exposures(title) == {"nonresidential"}
    row = evidence("census", "VIP/NRXX/T/1", title, None, title=title, sectors=["Real Estate", "Industrials"])
    identity = {"industry": "Residential Construction", "sector": "Real Estate"}
    assert route_ticker_rows([row], identity) == []
    row.update(target="VIP/00XX/T/1", title="Private residential construction spending")
    assert route_ticker_rows([row], identity)[0]["relevance"].startswith("broad sector context")
    assert exposures("Semiconductors and 반도체") == {"semiconductors"}


@pytest.mark.parametrize("derived", [False, True])
def test_census_routing_uses_codes_even_with_excluded_words_and_old_tags(derived):
    title = "Metals and Minerals, Except Petroleum"
    row = evidence("census", "MWTS/4235/IR/1", title, None,
                   title=title, sectors=["Basic Materials", "Energy"])
    if derived:
        row.update(base_target=row["target"], target="derived/MWTS/4235/IR/1/12m change")
    assert route_ticker_rows([row], {"sector": "Energy", "industry": "Oil & Gas"}) == []
    routed = route_ticker_rows([row], {"sector": "Basic Materials", "industry": "Steel"})
    assert routed[0]["sectors"] == ["Basic Materials"]
    assert routed[0]["relevance"].startswith("broad sector context")


def test_bea_quarterly_contract_and_industry_output_reach_both_workflows(monkeypatch):
    monkeypatch.setenv("BEA_API_KEY", "test")
    calls = []
    def request(url, params):
        calls.append(params)
        assert params["Frequency"] == "Q"
        industry = params["datasetname"] == "GDPbyIndustry"
        title = "Computer and electronic products" if industry else "Motor vehicles"
        data = [{"TimePeriod": period, "DataValue": value, "CL_UNIT": "Billion current dollars",
                 "UNIT_MULT": "9", "Industry" if industry else "LineNumber": "334" if industry else "4",
                 "IndustryDescription" if industry else "LineDescription": title}
                for period, value in (("2025Q2", "100"), ("2026Q1", "110"), ("2026Q2", "120"))]
        return {"BEAAPI": {"Results": {"Data": data}}}
    monkeypatch.setattr(public_macro, "request_json", request)
    rows = public_macro.collect_bea(DAY)
    assert len(calls) == 3 and len(rows) == 9
    rows += build_diagnostics(rows)
    assess_evidence(rows, DAY)
    industry = [r for r in rows if (r.get("base_target") or r["target"]).startswith("GDPbyIndustry/1/")]
    assert industry and all(topics(r) == {"activity", "production"} for r in industry)
    assert all(topics(r) == {"activity", "demand"} for r in rows if r["target"].startswith("NIPA/"))
    state = {"public_data_evidence": rows, "requested_sectors": ["Technology"],
             "instrument_identity": {"industry": "Electronic Components", "sector": "Technology"}}
    for role in ("fundamentals", "sector", "market_review"):
        assigned, _, _ = assigned_public_rows(state, role)
        assert any(r["target"].startswith("GDPbyIndustry/") for r in assigned)
        digest = core_evidence_report(assigned, role, state)
        assert "production:" in digest and "nominal value added, not physical production volume" in digest


def _fact(metric, end="2026-06-30", period="quarter", source="sec", **updates):
    instant = metric in {"assets", "liabilities"}
    start_month = 1 if period == "annual" else (int(end[5:7]) - 1) // 3 * 3 + 1
    return evidence(source, f"TEST/{metric}/{period}", metric, None, observed_at=end,
                    published_at="2026-08-01", value=100, unit="USD", metric=metric,
                    period_start=None if instant else f"{end[:4]}-{start_month:02}-01",
                    period_end=end, basis="instant" if instant else period, accession=end,
                    refresh_frequency="Q", accounting_standard="us-gaap", evidence_type="financial_fact", **updates)


@pytest.mark.parametrize("source", ["sec", "dart"])
def test_fresh_quarter_keeps_annual_comparisons_without_quality_downgrade(source):
    annual = [_fact(m, "2025-12-31", "annual", source) for m in CORE_FINANCIAL_METRICS]
    current = [_fact(m, source=source) for m in CORE_FINANCIAL_METRICS]
    rows = [*annual, *current]
    rows += derive_metrics(rows, "TEST")
    warnings = assess_evidence(rows, DAY)
    assert warnings == []
    assert all(r["stale"] and r["comparative_only"] for r in annual)
    assert all(not r["stale"] and not r.get("comparative_only") for r in current)
    assert "0 latest series stale" in coverage_report(rows)
    assert "Historical comparison" in render_public_data(annual)
    state = {"public_data_evidence": rows, "public_data_warnings": warnings}
    assert ticker_quality(state)["status"] == "COMPLETE"
    # A missing current liability cannot be hidden by fresh assets/earnings.
    rows.remove(next(r for r in current if r["metric"] == "liabilities"))
    state["public_data_warnings"] = assess_evidence(rows, DAY)
    assert ticker_quality(state)["missing_core_metrics"] == ["liabilities"]
    assert ticker_quality(state)["status"] == "REVIEW_REQUIRED"


@pytest.mark.parametrize("different", [{"unit": "KRW"}, {"reporting_scope": "OFS"},
                                      {"accounting_standard": "ifrs-full"},
                                      {"target": "OTHER/revenue/quarter"},
                                      {"evidence_type": "derived_financial"}])
def test_different_basis_identity_or_derived_result_cannot_refresh_old_raw_fact(different):
    old = _fact("revenue", "2025-12-31", "annual", reporting_scope="CFS")
    new = _fact("revenue", reporting_scope="CFS")
    new.update(different)
    warnings = assess_evidence([old, new], DAY)
    assert old["stale"] and not old.get("comparative_only") and warnings


@pytest.mark.parametrize('change', [None, 'issuer', 'scope', 'statement', 'account', 'detail',
                                   'unit', 'derived', 'stale', 'missing', 'future'])
def test_unmapped_accounts_use_full_raw_identity_for_comparisons(change):
    def raw(end, period):
        return evidence('dart', f'TEST/CFS/IS/dart_OtherGains/-/{period}', 'Other gains', None,
                        value=100, observed_at=end, unit='KRW', metric=None,
                        basis=f'CFS/{period}', period_basis=period, refresh_frequency='Q',
                        evidence_type='financial_fact', accounting_standard='ifrs-full')
    old = raw('2025-12-31', 'annual')
    new = raw('2026-06-30', 'half-year YTD')
    positions = {'issuer': 0, 'scope': 1, 'statement': 2, 'account': 3, 'detail': 4}
    if change in positions:
        parts = new['target'].split('/')
        parts[positions[change]] = 'different'
        new['target'] = '/'.join(parts)
    elif change == 'unit':
        new['unit'] = 'USD'
    elif change == 'derived':
        new['evidence_type'] = 'derived_financial'
    elif change == 'stale':
        new['observed_at'] = '2026-01-01'
    elif change == 'missing':
        new['status'] = 'empty'
    elif change == 'future':
        new['observed_at'] = '2027-06-30'
    warnings = assess_evidence([old, new], DAY)
    assert old['stale']  # Comparison data never becomes a current fact.
    assert bool(old.get('comparative_only')) is (change is None)
    assert any(w.startswith('PUBLIC_STALE:dart:TEST/') for w in warnings) is (change is not None)
    if change is None:
        assert old['freshness'] == 'historical_comparison'
        assert 'Historical comparison' in render_public_data([old])
        # Reassessment must restore the warning when the newer evidence disappears.
        assert assess_evidence([old], DAY)
        assert old['freshness'] == 'stale' and not old.get('comparative_only')
