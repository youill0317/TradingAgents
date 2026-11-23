"""Sector verdict validation and deterministic scan completion."""
from unittest.mock import Mock

import pytest

from tradingagents.agents.managers import market_strategist as strategist
from tradingagents.agents.market_schemas import MarketScanReport
from tradingagents.agents.market_structured import StructuredOutputError
from tradingagents.dataflows.market_scan import SECTOR_ETFS

SECTORS = list(SECTOR_ETFS)

EVIDENCE = [
    {"source": "fred", "target": "US: policy rate", "status": "success", "content": "Rate: 4%"},
    {"source": "yfinance", "target": "SPY", "status": "success", "content": "SPY: +2%"},
    {"source": "get_global_news", "status": "success", "content": "Policy announcement"},
]


def verdict(sector, outlook="Bullish", conviction="High"):
    return {"sector": sector, "outlook": outlook, "conviction": conviction,
            "rationale": f"{sector} evidence", "invalidation": "Relative strength reverses"}


def report(sectors=SECTORS, **overrides):
    return MarketScanReport(**{
        "regime": "Risk-On", "regime_evidence": "Global context", "sector_view": "Energy leads",
        "sector_verdicts": [verdict(s) for s in sectors], **overrides,
    })


def run(monkeypatch, answer=None, **overrides):
    monkeypatch.setattr(strategist, "bind_structured", lambda *a: None)
    invoke = Mock(return_value=answer or report())
    monkeypatch.setattr(strategist, "invoke_structured_required", invoke)
    state = {"macro_report": "Global conditions", "sector_report": "Sector report",
             "global_evidence": EVIDENCE, **overrides}
    return strategist.create_market_strategist(None)(state), invoke


def test_verdicts_are_canonicalised_and_every_drop_recorded():
    answer = report(sector_verdicts=[
        verdict(" energy "), verdict("XLK"), verdict("Energy"), verdict("Crypto"),
    ])
    result = strategist._validate_sector_verdicts(answer)
    assert [v.sector for v in result.sector_verdicts] == ["Technology", "Energy"]
    assert "SECTOR_VERDICT_DUPLICATE:Energy" in result.warnings
    assert "SECTOR_VERDICT_UNKNOWN:Crypto" in result.warnings
    missing = [w for w in result.warnings if w.startswith("SECTOR_VERDICT_MISSING:")]
    assert len(missing) == len(SECTORS) - 2


def test_verdicts_follow_the_canonical_sector_order():
    result = strategist._validate_sector_verdicts(report(sectors=list(reversed(SECTORS))))
    assert [v.sector for v in result.sector_verdicts] == SECTORS
    assert result.warnings == []


def test_a_missing_sector_degrades_and_no_verdict_is_incomplete(monkeypatch):
    result, _ = run(monkeypatch, report(sectors=SECTORS[:-1]))
    assert result["scan_status"] == "DEGRADED"
    assert f"SECTOR_VERDICT_MISSING:{SECTORS[-1]}" in result["scan_warnings"]
    assert len(result["market_scan_result"]["sector_verdicts"]) == len(SECTORS) - 1

    result, _ = run(monkeypatch, report(sectors=[]))
    assert result["scan_status"] == "INCOMPLETE"
    assert "SECTOR_VERDICTS_MISSING" in result["scan_warnings"]


def test_sector_outage_blocks_verdicts(monkeypatch):
    result, _ = run(monkeypatch, data_warnings=["SECTOR_DATA_UNAVAILABLE"])
    assert result["scan_status"] == "INCOMPLETE"
    assert not result["market_scan_result"]["sector_verdicts"]


@pytest.mark.parametrize("field", ["macro_report", "sector_report"])
def test_missing_required_report_blocks_verdicts(monkeypatch, field):
    result, _ = run(monkeypatch, **{field: ""})
    assert result["scan_status"] == "INCOMPLETE"
    assert not result["market_scan_result"]["sector_verdicts"]


def test_model_cannot_set_completion_status(monkeypatch):
    result, _ = run(monkeypatch, report(status="INCOMPLETE", warnings=["invented"]))
    assert result["scan_status"] == "COMPLETE"
    assert result["scan_warnings"] == []


def test_invalid_output_preserves_data_warnings(monkeypatch):
    monkeypatch.setattr(strategist, "bind_structured", lambda *a: None)
    monkeypatch.setattr(strategist, "invoke_structured_required",
                        Mock(side_effect=StructuredOutputError("invalid")))
    result = strategist.create_market_strategist(None)({"data_warnings": ["FRED_MISSING"]})
    assert result["scan_status"] == "INCOMPLETE"
    assert "FRED_MISSING" in result["scan_warnings"]
    assert "STRUCTURED_OUTPUT_INVALID" in result["scan_warnings"]
    assert result["market_scan_result"]["sector_verdicts"] == []


def _table(rows):
    return ("## Sector performance\n### Sectors (best to worst)\n"
            "| Rank | Sector | ETF | Return | vs SPY |\n"
            + "\n".join(f"| {i} | {name} | {SECTOR_ETFS[name]} | {ret} | {rel} |"
                        for i, (name, ret, rel) in enumerate(rows, 1)))


@pytest.mark.parametrize("sector_return", ["n/a", "nan%", "bad%"])
def test_verdict_without_its_sector_data_drops_to_low_conviction(monkeypatch, sector_return):
    rows = [(name, "+2.00%", "+1.00%") for name in SECTORS]
    rows[SECTORS.index("Energy")] = ("Energy", sector_return, "n/a")
    result, _ = run(monkeypatch, sector_evidence=_table(rows))
    assert result["scan_status"] == "DEGRADED"
    assert "SECTOR_VERDICT_DATA_MISSING:Energy" in result["scan_warnings"]
    by_sector = {v["sector"]: v for v in result["market_scan_result"]["sector_verdicts"]}
    assert by_sector["Energy"]["conviction"] == "Low"
    assert by_sector["Technology"]["conviction"] == "High"


def test_conviction_only_changes_for_the_sector_missing_its_benchmark(monkeypatch):
    rows = [(name, "+2.00%", "+1.00%") for name in SECTORS]
    rows[SECTORS.index("Energy")] = ("Energy", "+3.00%", "n/a")
    result, _ = run(monkeypatch, sector_evidence=_table(rows), data_warnings=["OPTIONAL_REGION_GAP"])
    assert result["scan_status"] == "DEGRADED"
    convictions = {v["sector"]: v["conviction"] for v in result["market_scan_result"]["sector_verdicts"]}
    assert convictions["Energy"] == "Low"
    assert {c for name, c in convictions.items() if name != "Energy"} == {"High"}


@pytest.mark.parametrize("source,status", [("fred", "stale"), ("yfinance", "failed"), ("get_global_news", "unavailable")])
def test_missing_input_family_blocks_verdicts_despite_reports(monkeypatch, source, status):
    evidence = [dict(row, status=status) if row["source"] == source else row for row in EVIDENCE]
    result, _ = run(monkeypatch, global_evidence=evidence)
    assert result["scan_status"] == "INCOMPLETE"
    assert result["market_scan_result"]["sector_verdicts"] == []


def test_empty_news_search_is_observed_coverage(monkeypatch):
    evidence = [dict(row, status="empty", content="No matching news")
                if row["source"] == "get_global_news" else row for row in EVIDENCE]
    result, _ = run(monkeypatch, global_evidence=evidence)
    assert result["scan_status"] == "COMPLETE"


def test_sector_recovery_reaches_validation_and_saved_evidence(monkeypatch, tmp_path):
    import json

    from langchain_core.messages import ToolMessage

    from tradingagents.graph.market_setup import capture_sector_evidence
    from tradingagents.market_reporting import write_market_report_tree

    table = _table([(name, "+3%", "+1%") for name in SECTORS])
    captured = capture_sector_evidence({
        "sector_evidence": "DATA_UNAVAILABLE: failed", "data_warnings": ["SECTOR_DATA_UNAVAILABLE"],
        "messages": [ToolMessage(content=table, name="get_sector_performance", tool_call_id="s")],
    })
    assert "SECTOR_DATA_UNAVAILABLE" not in captured["data_warnings"]
    result, _ = run(monkeypatch, **captured)
    assert result["scan_status"] == "COMPLETE"
    assert len(result["market_scan_result"]["sector_verdicts"]) == len(SECTORS)
    write_market_report_tree({**captured, **result}, tmp_path)
    saved = [json.loads(line) for line in (tmp_path / "evidence.jsonl").read_text().splitlines()]
    assert next(r["content"] for r in saved if r["source"] == "yahoo_sectors") == table
    scan = json.loads((tmp_path / "scan.json").read_text())
    assert [v["sector"] for v in scan["sector_verdicts"]] == SECTORS


def test_sector_outage_is_not_silent():
    from tradingagents.graph.market_setup import capture_sector_evidence

    result = capture_sector_evidence({"data_warnings": ["GLOBAL_GAP"], "messages": []})
    assert "GLOBAL_GAP" in result["data_warnings"]
    assert "SECTOR_DATA_UNAVAILABLE" in result["data_warnings"]


def test_report_renders_the_verdict_table(monkeypatch):
    answer = report(sector_verdicts=[verdict("Energy", "Bearish", "Medium"), verdict("Utilities", "Neutral", "Low")])
    result, _ = run(monkeypatch, answer)
    text = result["market_scan_report"]
    assert "**Market Regime:** **Risk-On**" in text
    assert "| Energy | XLE | Bearish | Medium |" in text
    assert "| Utilities | XLU | Neutral | Low |" in text


def test_new_market_scan_cannot_silently_omit_market_assessment(monkeypatch):
    result, _ = run(monkeypatch, market_diagnostics_data={"status": "success"})
    assert result["scan_status"] == "DEGRADED"
    assert "MARKET_ASSESSMENT_MISSING:market_outlook" in result["scan_warnings"]
    assert "MARKET_SCENARIOS_INCOMPLETE" in result["scan_warnings"]


def test_market_assessment_reaches_the_report(monkeypatch):
    result, _ = run(monkeypatch, report(market_outlook="Range with downside risk",
        participation_assessment="Narrow participation", rotation_assessment="Defensives improving",
        catalyst_assessment="CPI expected tomorrow", scenarios=["Base: flat", "Upside: broadening", "Downside: breakdown"]),
        market_diagnostics_data={"status": "success"})
    assert result["scan_status"] == "COMPLETE"
    assert "Narrow participation" in result["market_scan_report"]
    assert "Downside: breakdown" in result["market_scan_report"]


@pytest.mark.parametrize("missing", ["market_risk_review", "market_bear_rebuttal", "market_draft_report", "resolution"])
def test_final_review_cannot_be_skipped(monkeypatch, missing):
    from tradingagents.agents.market_review import REVIEW_FIELDS

    state = dict.fromkeys(REVIEW_FIELDS, "Review available")
    state.update(market_review_enabled=True, market_draft_report="Provisional outlook", market_risk_findings=[])
    answer = report(review_resolution="Accepted; revised claim")
    if missing == "resolution":
        answer.review_resolution = ""
    else:
        state[missing] = ""
    result, _ = run(monkeypatch, answer, **state)
    assert result["scan_status"] == "INCOMPLETE"
    assert result["market_scan_result"]["sector_verdicts"] == []


@pytest.mark.parametrize("resolutions,complete", [
    ([], False),
    ([{"finding_id": "R2", "decision": "accepted", "rationale": "Observed oil price"}], False),
    ([{"finding_id": "R1", "decision": "accepted", "rationale": " "}], False),
    ([{"finding_id": "R1", "decision": "accepted", "rationale": "Observed oil price"}] * 2, False),
    ([{"finding_id": "R1", "decision": "rejected", "rationale": "Observed oil price on scan date supports the claim"}], True),
])
def test_every_material_risk_finding_needs_one_substantive_response(monkeypatch, resolutions, complete):
    from tradingagents.agents.market_review import REVIEW_FIELDS
    state = dict.fromkeys(REVIEW_FIELDS, "Review available")
    state.update(market_review_enabled=True, market_draft_report="Draft",
                 market_risk_findings=[{"id": "R1", "finding": "Check oil"}])
    result, _ = run(monkeypatch, report(review_resolution="Checked", risk_resolutions=resolutions), **state)
    assert (result["scan_status"] == "COMPLETE") is complete
    assert bool(result["market_scan_result"]["sector_verdicts"]) is complete
