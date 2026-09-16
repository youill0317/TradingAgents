"""Regression contracts for official-data review fixes. No live providers or LLMs."""

import copy
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from tradingagents.dataflows import (
    public_data,
    public_filings,
    public_financials,
    public_korea,
    public_us,
)
from tradingagents.dataflows.public_analysis import build_diagnostics
from tradingagents.dataflows.public_data_common import evidence, series_changes
from tradingagents.dataflows.public_evidence import (
    SnapshotCache,
    assess_evidence,
    cited_evidence_report,
    evidence_id,
    require_series,
)
from tradingagents.dataflows.public_financial_metrics import derive_metrics
from tradingagents.dataflows.public_relevance import resolved_identity, route_ticker_rows


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("Network is forbidden in these regression tests")
    monkeypatch.setattr("requests.get", blocked)


def obs(source="fred", target="DGS2", value=3, day="2026-09-01", **kwargs):
    return evidence(source, target, f"{target}: {value}", "https://example.test/observation",
                    observed_at=day, value=value, unit=kwargs.pop("unit", "percent"),
                    frequency=kwargs.pop("frequency", "D"), **kwargs)


def fact(metric, value, start="2026-01-01", end="2026-03-31", *, source="sec",
         scope="issuer", period="quarter", accession="filing1", **kwargs):
    return obs(source, f"TEST/{metric}/{scope}/{period}", value, end, unit="USD",
               frequency="Q", published_at="2026-05-01", evidence_type="financial_fact",
               metric=metric, period_start=start, period_end=end, accession=accession,
               basis=f"{scope}/{period}" if scope != "issuer" else period, **kwargs)


def test_ecos_cpi_failure_preserves_policy_and_key_snapshot(monkeypatch):
    monkeypatch.setenv("ECOS_API_KEY", "test-secret")
    def response(url):
        if "722Y001" in url:
            return {"StatisticSearch": {"row": [{"TIME": "20260901", "DATA_VALUE": "3.0", "UNIT_NAME": "연%"}]}}
        if "901Y009" in url:
            raise RuntimeError("test-secret must not escape")
        return {"KeyStatisticList": {"row": [{"KEYSTAT_NAME": "환율", "CYCLE": "20260901", "DATA_VALUE": "1300", "UNIT_NAME": "원"}]}}
    monkeypatch.setattr(public_korea, "request_json", response)
    rows = public_korea.collect_ecos("2026-09-16")
    assert {r["target"] for r in rows if r["status"] == "success"} == {"policy_rate", "key/환율"}
    assert [r["target"] for r in rows if r["status"] != "success"] == ["consumer_prices"]
    assert "test-secret" not in str(rows)
    assert rows[0]["kind"] == "rate"


@pytest.mark.parametrize("unit", ["연%", "연 %", "percent", "%", "Percent per Annum"])
def test_rates_use_percentage_points_without_relative_change(unit):
    text = series_changes([obs(value=3, day="2026-09-01", unit=unit),
                           obs(value=2.75, day="2026-09-02", unit=unit)])
    assert "-0.25 percentage points" in text and "-8.333%" not in text


def test_eia_partial_response_reports_each_missing_series(monkeypatch):
    monkeypatch.setenv("EIA_API_KEY", "key")
    monkeypatch.setattr(public_us, "request_json", lambda *a, **k: {"response": {"data": [
        {"series": "WCESTUS1", "period": "2026-09-04", "value": 0, "units": "MBBL"},
    ]}})
    rows = public_us.collect_eia("2026-09-16")
    assert [(r["target"], r["value"]) for r in rows if r["status"] == "success"] == [("WCESTUS1", 0)]
    assert {r["target"] for r in rows if r["status"] == "empty"} == {"WCRFPUS2", "WGTSTUS1", "WDISTUS1"}
    assert len(require_series("eia", rows, ["WCESTUS1", "WCRFPUS2", "WGTSTUS1", "WDISTUS1"])) == 4


def test_nyfed_keeps_rates_but_reports_missing_volumes(monkeypatch):
    monkeypatch.setattr(public_us, "request_json", lambda *a, **k: {"refRates": [
        {"effectiveDate": "2026-09-01", "percentRate": 3},
    ]})
    rows = public_us.collect_nyfed("2026-09-16")
    assert len(rows) == 6
    assert {r["target"] for r in rows if r["status"] != "success"} == {"SOFR volume", "EFFR volume", "OBFR volume"}


@pytest.mark.parametrize("ticker,expected", [("BRK.B", True), ("brk.b", True), ("BRK-B", True), ("BRK.L", False)])
def test_sec_share_class_alias_is_provider_specific(monkeypatch, ticker, expected):
    monkeypatch.setenv("SEC_USER_AGENT", "Test contact@example.test")
    def request(url, **kwargs):
        if "company_tickers" in url:
            return {"0": {"ticker": "BRK-B", "cik_str": 1067983}}
        return {"filings": {"recent": {}}}
    calls = []
    monkeypatch.setattr(public_filings, "request_json", request)
    monkeypatch.setattr(public_filings, "sec_enrichment", lambda *args: calls.append(args) or [])
    public_filings.collect_sec(ticker, "2026-09-16")
    assert bool(calls) is expected
    if expected:
        assert calls[0][0] == "0001067983" and calls[0][1] == ticker


@pytest.mark.parametrize("basis", ["instant", "half-year YTD", "nine-month YTD"])
def test_stale_issuer_periods_have_refresh_policy_and_latest_warning(basis):
    rows = [obs("sec", "TEST/Assets/" + basis, 100, "2024-09-01", frequency="",
                evidence_type="financial_fact", basis=basis)]
    warnings = assess_evidence(rows, "2026-09-16")
    assert rows[0]["stale"] and rows[0]["refresh_frequency"] == "Q"
    assert any(w.startswith("PUBLIC_STALE:sec:") for w in warnings)


def test_old_history_does_not_warn_when_latest_is_current():
    rows = [obs(day="2020-01-01"), obs(day="2026-09-15")]
    assert not assess_evidence(rows, "2026-09-16")
    assert rows[0]["stale"] and not rows[1]["stale"]


def test_sec_refresh_frequency_follows_reporting_cadence_not_balance_basis(monkeypatch):
    payload = {"facts": {"us-gaap": {"Assets": {"units": {"USD": [
        {"end": "2026-03-31", "filed": "2026-05-01", "val": 10, "form": "10-Q", "accn": "a"},
        {"end": "2025-12-31", "filed": "2026-02-01", "val": 9, "form": "10-K", "accn": "b"},
    ]}}}}}
    monkeypatch.setattr(public_financials, "request_json", lambda *a, **k: payload)
    rows = public_financials.sec_facts("1", "TEST", "2026-09-16", {})
    rows = [r for r in rows if r.get("evidence_type") == "financial_fact"]
    assert all(r["refresh_frequency"] == "Q" and r["basis"] == "instant" for r in rows)


def test_fsc_fallback_routes_semiconductors_but_not_software():
    trade = obs("customs", "HS8542-US/expDlr", 100, unit="USD", frequency="M",
                sectors=["Technology"], hs_code="8542", title="Integrated circuits")
    assert not route_ticker_rows([trade], {"sector": "Technology", "industry": "Software - Application"})
    identity = resolved_identity({}, [evidence("fsc", "TEST", {"sicNm": "반도체 제조업"}, None)])
    rows = route_ticker_rows([trade], identity)
    assert len(rows) == 1 and rows[0]["relevance"].startswith("industry context")
    assert identity["classification_source"].startswith("FSC")
    # Do not overwrite resolved Yahoo identity or infer one sector for a conglomerate.
    assert resolved_identity({"industry": "Software"}, []) == {"industry": "Software"}


def test_broad_context_cap_counts_series_not_observations():
    rows = [obs("eurostat", name, day=f"2026-09-{day:02}", sectors=["Industrials"], title="Aggregate production")
            for name in ("a", "b", "c") for day in (1, 2, 3)]
    assigned = route_ticker_rows(rows, {"sector": "Industrials", "industry": "Unknown"})
    assert len(assigned) == 6 and {r["target"] for r in assigned} == {"a", "b"}
    assert all("unverified" in r["relevance"] for r in assigned)


def test_same_period_ratios_never_mix_scope_or_version():
    rows = [fact("revenue", 100, source="dart", scope="CFS"),
            fact("gross_profit", 30, source="dart", scope="OFS"),
            fact("gross_profit", 50, source="dart", scope="CFS", accession="other")]
    assert not derive_metrics(rows, "TEST")
    rows.append(fact("gross_profit", 20, source="dart", scope="CFS"))
    ratios = derive_metrics(rows, "TEST")
    assert len(ratios) == 1 and ratios[0]["value"] == 20 and ratios[0]["basis"] == "CFS/quarter"
    assert all(operand["evidence_id"] in {evidence_id(r) for r in rows} for operand in ratios[0]["operands"])


def test_ambiguous_revenue_aliases_do_not_choose_first():
    rows = [fact("revenue", 100), fact("revenue", 200), fact("gross_profit", 30)]
    assert not derive_metrics(rows, "TEST")


def test_dart_standard_accounts_ytd_and_member_safety():
    rows = [fact(None, value, end="2026-06-30", source="dart", scope="CFS", period="half-year YTD",
                 account_id=tag, account_detail="-") for tag, value in (
                     ("ifrs-full_CashFlowsFromUsedInOperatingActivities", 120),
                     ("ifrs-full_PaymentsToAcquirePropertyPlantAndEquipment", 50),
                 )]
    out = derive_metrics(rows, "TEST")
    assert len(out) == 1 and out[0]["metric"] == "free_cashflow" and out[0]["value"] == 70
    assert out[0]["basis"] == "CFS/half-year YTD"
    rows[1]["account_detail"] = "subsidiary [member]"
    assert not derive_metrics(rows, "TEST")


def test_ytd_bridge_and_ttm_keep_cross_filing_warning_and_lineage():
    q1 = fact("operating_cashflow", 10, "2025-01-01", "2025-03-31", accession="q1")
    half = fact("operating_cashflow", 30, "2025-01-01", "2025-06-30", period="half-year YTD", accession="q2")
    nine = fact("operating_cashflow", 60, "2025-01-01", "2025-09-30", period="nine-month YTD", accession="q3")
    annual = fact("operating_cashflow", 100, "2025-01-01", "2025-12-31", period="annual", accession="fy")
    out = derive_metrics([q1, half, nine, annual], "TEST")
    quarters = [r for r in out if r["period_basis"] == "quarter"]
    assert [r["value"] for r in quarters] == [20, 30, 40]
    ttm = [r for r in out if r["period_basis"] == "TTM"]
    assert len(ttm) == 1 and ttm[0]["value"] == 100
    assert all(r["revision_alignment"] == "unverified" for r in out)
    rows = [q1, half, nine, annual, *out]
    assess_evidence(rows, "2026-01-01")
    audit = cited_evidence_report({"fundamentals_report": f"[{ttm[0]['evidence_id']}]"}, rows, max_chars=20000)
    assert all(r["evidence_id"] in audit for r in [q1, half, nine, annual])


def test_ttm_rejects_calendar_gap_and_capex_unknown_sign():
    rows = [fact("revenue", 10, start, end) for start, end in (
        ("2025-01-01", "2025-03-31"), ("2025-04-01", "2025-06-30"),
        ("2025-10-01", "2025-12-31"), ("2026-01-01", "2026-03-31"),
    )]
    assert not any(r["period_basis"] == "TTM" for r in derive_metrics(rows, "TEST"))
    assert not derive_metrics([fact("operating_cashflow", 10), fact("capital_expenditure", -2)], "TEST")


def test_rate_spreads_align_dates_and_do_not_mix_units():
    rows = [obs("nyfed", "SOFR", 3.1), obs("nyfed", "EFFR", 3.0),
            obs("nyfed", "SOFR", 9, "2026-09-02")]
    out = build_diagnostics(rows)
    assert len(out) == 1 and out[0]["value"] == pytest.approx(.1)
    assert out[0]["observed_at"] == "2026-09-01"
    assert {x["evidence_id"] for x in out[0]["operands"]} == {evidence_id(r) for r in rows[:2]}
    rows[1]["unit"] = "basis points"
    assert not build_diagnostics(rows)


def test_securities_flow_sums_exclude_holdings_valuation_and_gaps():
    rows = [obs("tic", metric, 10, f"2026-{month:02}", unit="million USD", frequency="M", metric=metric)
            for metric in ("Holdings", "Net U.S. Sales", "Valuation Change") for month in (5, 6, 7)]
    out = build_diagnostics(rows)
    out = [r for r in out if "net transactions" in r["target"]]
    assert len(out) == 1 and out[0]["value"] == 30 and "Net U.S. Sales" in out[0]["target"]
    rows = [r for r in rows if r["observed_at"] != "2026-06"]
    assert not any("net transactions" in r["target"] for r in build_diagnostics(rows))


def test_reference_identity_and_audit_do_not_claim_unseen_evidence():
    first = obs(value=3)
    second = copy.deepcopy(first)
    second.update(value=3.0, retrieved_at="different retrieval")
    assert evidence_id(first) == evidence_id(second)
    second["value"] = 4
    assert evidence_id(first) != evidence_id(second)
    ref = evidence_id(first)
    out = cited_evidence_report({"macro_report": f"[{ref}] [ev-0000000000000000]"}, [first])
    assert ref in out and "UNRESOLVED_EVIDENCE_REFERENCES" in out
    assert cited_evidence_report({}, [first]) == ""


def test_snapshot_cache_reuses_immutable_success_and_retries_failures():
    cache = SnapshotCache()
    calls = []
    def good():
        calls.append(1)
        return [obs()]
    first = cache.collect("same", 300, good)
    first[0]["value"] = 999
    second = cache.collect("same", 300, good)
    assert len(calls) == 1 and second[0]["value"] == 3
    assert second[0]["snapshot_id"]
    def failed():
        calls.append(1)
        return [{"status": "error", "source": "fred", "target": "x"}]
    cache.collect("failed", 300, failed)
    cache.collect("failed", 300, failed)
    assert len(calls) == 3


def test_snapshot_cache_shares_inflight_fetch_and_expires(monkeypatch):
    cache = SnapshotCache()
    entered, release = Event(), Event()
    calls = []
    now = [1.0]
    monkeypatch.setattr("tradingagents.dataflows.public_evidence.time.monotonic", lambda: now[0])
    def loader():
        calls.append(1)
        entered.set()
        assert release.wait(3)
        return [obs()]
    with ThreadPoolExecutor(2) as pool:
        a = pool.submit(cache.collect, "same", 300, loader)
        assert entered.wait(3)
        b = pool.submit(cache.collect, "same", 300, loader)
        release.set()
        assert a.result(timeout=3) == b.result(timeout=3)
    assert len(calls) == 1
    now[0] = 302
    cache.collect("same", 300, loader)
    assert len(calls) == 2


def test_collection_integrates_warnings_derived_values_and_review_receipts(monkeypatch):
    def collector(_):
        return [obs("nyfed", "SOFR", 3.1, "2026-09-15"), obs("nyfed", "EFFR", 3, "2026-09-15"),
                {**evidence("nyfed", "SOFR volume", "Requested series missing", None), "status": "empty"}]
    monkeypatch.setattr(public_data, "PUBLIC_SOURCES", {"nyfed": (collector, ())})
    result = public_data.collect_public_data("2999-01-01", {"public_data_sources": "nyfed", "public_data_cache_ttl_seconds": 0})
    assert any(r.get("evidence_type") == "derived_indicator" for r in result["evidence"])
    assert any("Requested series missing" in w for w in result["warnings"])
    ref = result["evidence"][0]["evidence_id"]
    report = public_data.public_data_for_agent({"public_data_evidence": result["evidence"], "news_report": f"[{ref}]"}, "ticker_review")
    assert "Official coverage" in report and "Exact evidence cited upstream" in report
    assert ref in report


def test_historical_guard_runs_before_cache(monkeypatch):
    monkeypatch.setattr(public_data, "PUBLIC_SOURCES", {"nyfed": (lambda _: pytest.fail("historical fetch forbidden"), ())})
    result = public_data.collect_public_data("2000-01-01", {"public_data_sources": "nyfed"})
    assert result["evidence"][0]["status"] == "unavailable_as_of"


def test_evidence_tool_can_read_exact_id_and_preserves_history_references():
    from tradingagents.agents.utils.public_data_tools import get_official_evidence

    rows = [obs("nyfed", "SOFR", 3, "2026-09-01"), obs("nyfed", "SOFR", 4, "2026-09-02")]
    assess_evidence(rows, "2026-09-03")
    state = {"public_data_evidence": rows}
    ref = rows[0]["evidence_id"]
    text = get_official_evidence.func("nyfed", state, query=ref)
    assert ref in text and "2026-09-01: 3" in text
    assert "2026-09-02: 4" not in text
    text = get_official_evidence.func("nyfed", state, query="SOFR")
    assert all(row["evidence_id"] in text for row in rows)
    assert "Official coverage" in get_official_evidence.func("all", state)


def test_ttm_ratio_requires_matching_versions_for_each_quarter_not_just_same_set():
    periods = [("2025-01-01", "2025-03-31"), ("2025-04-01", "2025-06-30"),
               ("2025-07-01", "2025-09-30"), ("2025-10-01", "2025-12-31")]
    rows = []
    for index, (start, end) in enumerate(periods):
        rows.append(fact("revenue", 100, start, end, accession=str(index)))
        other_version = {0: 1, 1: 0}.get(index, index)
        rows.append(fact("net_income", 20, start, end, accession=str(other_version)))
    results = derive_metrics(rows, "TEST")
    assert any(r["period_basis"] == "TTM" for r in results)
    assert not any(r["period_basis"] == "TTM" and r["metric"] == "net_margin" for r in results)


def test_legacy_snapshot_digest_ids_resolve_in_tool_and_review():
    from tradingagents.agents.utils.public_data_tools import get_official_evidence

    rows = [obs("nyfed", "SOFR", 3, "2026-09-01"), obs("nyfed", "SOFR", 4, "2026-09-02")]
    original = copy.deepcopy(rows)
    ref = evidence_id(rows[-1])
    state = {"public_data_evidence": rows}
    digest = public_data.public_data_for_agent(state, "macro")
    assert f"[{ref}] **SOFR**" in digest
    lookup = get_official_evidence.func("nyfed", state, query=ref)
    assert f"[{ref}] **SOFR**" in lookup
    audit = public_data.public_data_for_agent({**state, "macro_report": f"[{ref}]"}, "market_review")
    assert "Exact evidence cited upstream" in audit
    assert "UNRESOLVED_EVIDENCE_REFERENCES" not in audit
    assert rows == original
