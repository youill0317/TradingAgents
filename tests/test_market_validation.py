"""Candidate grounding and deterministic scan completion."""
from unittest.mock import Mock

import pytest

from tradingagents.agents.managers import market_strategist as strategist
from tradingagents.agents.schemas import MarketScanReport
from tradingagents.agents.utils.structured import StructuredOutputError

SCREEN = "## Equity screen\n### Energy\n| Symbol | Name |\n| --- | --- |\n| XOM | Exxon |"


EVIDENCE = [
    {"source": "fred", "target": "US: policy rate", "status": "success", "content": "Rate: 4%"},
    {"source": "yfinance", "target": "SPY", "status": "success", "content": "SPY: +2%"},
    {"source": "get_global_news", "status": "success", "content": "Policy announcement"},
]


def report(tickers=("XOM",), **overrides):
    return MarketScanReport(**{
        "regime": "Risk-On", "regime_evidence": "Global context", "sector_view": "Energy",
        "candidates": [{"ticker": t, "sector": "Energy", "thesis": "Evidence",
                        "conviction": "High"} for t in tickers], **overrides,
    })


def run(monkeypatch, answer=None, **overrides):
    monkeypatch.setattr(strategist, "bind_structured", lambda *a: None)
    invoke = Mock(return_value=answer or report())
    monkeypatch.setattr(strategist, "invoke_structured_required", invoke)
    state = {"macro_report": "Global conditions", "sector_report": "Energy report",
             "screen_evidence": SCREEN, "global_evidence": EVIDENCE, **overrides}
    return strategist.create_market_strategist(None)(state), invoke


def test_candidate_filters_record_every_drop():
    result = strategist._ground_candidates(report(("XOM", "XOM", "FAKE")), SCREEN, 1)
    assert [c.ticker for c in result.candidates] == ["XOM"]
    assert result.warnings == ["CANDIDATE_DUPLICATE:XOM", "CANDIDATE_NOT_GROUNDED:FAKE"]
    restricted = strategist._ground_candidates(report(), SCREEN, 10, ["Technology"])
    assert not restricted.candidates
    assert restricted.warnings == ["CANDIDATE_SECTOR_NOT_REQUESTED:XOM"]


@pytest.mark.parametrize("warning", ["SCREEN_EVIDENCE_MISSING", "SECTOR_DATA_UNAVAILABLE"])
def test_required_data_failure_blocks_candidates(monkeypatch, warning):
    result, _ = run(monkeypatch, data_warnings=[warning])
    assert result["scan_status"] == "INCOMPLETE"
    assert not result["market_scan_result"]["candidates"]


@pytest.mark.parametrize("field", ["macro_report", "sector_report", "screen_evidence"])
def test_missing_required_evidence_blocks_candidates(monkeypatch, field):
    result, _ = run(monkeypatch, **{field: ""})
    assert result["scan_status"] == "INCOMPLETE"
    assert not result["market_scan_result"]["candidates"]


def test_model_cannot_set_completion_status(monkeypatch):
    result, _ = run(monkeypatch, report(status="INCOMPLETE", warnings=["invented"]))
    assert result["scan_status"] == "COMPLETE"
    assert result["scan_warnings"] == []


def test_optional_gap_preserves_conviction_and_global_context(monkeypatch):
    result, invoke = run(monkeypatch, data_warnings=["FRED_MISSING"],
                         global_snapshot="Japan\nGrowth: uncertain")
    assert result["scan_status"] == "DEGRADED"
    assert result["market_scan_result"]["candidates"][0]["conviction"] == "High"
    assert "Japan\nGrowth: uncertain" in invoke.call_args.args[1]


def test_successful_empty_screen_is_complete(monkeypatch):
    result, _ = run(monkeypatch, report(()),
                    screen_evidence="## Equity screen\n### Energy\nNo matches.")
    assert result["scan_status"] == "COMPLETE"
    assert not result["market_scan_result"]["candidates"]


def test_invalid_output_preserves_data_warnings(monkeypatch):
    monkeypatch.setattr(strategist, "bind_structured", lambda *a: None)
    monkeypatch.setattr(strategist, "invoke_structured_required",
                        Mock(side_effect=StructuredOutputError("invalid")))
    result = strategist.create_market_strategist(None)({"data_warnings": ["FRED_MISSING"]})
    assert result["scan_status"] == "INCOMPLETE"
    assert "FRED_MISSING" in result["scan_warnings"]
    assert "STRUCTURED_OUTPUT_INVALID" in result["scan_warnings"]


@pytest.mark.parametrize("sector_return", ["n/a", "nan%", "bad%"])
def test_candidate_needs_own_sector_performance(monkeypatch, sector_return):
    sector_table = (
        "## Sector performance\n### Sectors (best to worst)\n"
        "| Rank | Sector | ETF | Return | vs SPY |\n"
        f"| 1 | Energy | XLE | {sector_return} | n/a |\n"
        "| 2 | Technology | XLK | +2.00% | +1.00% |"
    )
    result, _ = run(monkeypatch, sector_evidence=sector_table)
    assert result["scan_status"] == "DEGRADED"
    assert result["market_scan_result"]["candidates"] == []
    assert "CANDIDATE_SECTOR_DATA_MISSING:XOM" in result["scan_warnings"]


def test_candidate_with_sector_return_survives_missing_benchmark(monkeypatch):
    result, _ = run(monkeypatch, sector_evidence=(
        "## Sector performance\n### Sectors (best to worst)\n"
        "| 1 | Energy | XLE | +2.00% | n/a |"
    ), data_warnings=["SECTOR_DATA_PARTIAL"])
    assert [c["ticker"] for c in result["market_scan_result"]["candidates"]] == ["XOM"]
    assert result["scan_status"] == "DEGRADED"


@pytest.mark.parametrize("tickers,evidence,limit,kept,warning", [
    ((" xom ",), SCREEN, 10, ["XOM"], None),
    (("GDP", "VIX", "ETF"), "GDP weakened while VIX rose; the ETF lagged.", 10, [], "CANDIDATE_NOT_GROUNDED"),
    (("XOM",), SCREEN.replace("### Energy", "### Technology"), 10, [], "CANDIDATE_NOT_GROUNDED"),
    (("XOM", "CVX"), SCREEN + "\n| CVX | Chevron |", 1, ["XOM"], "CANDIDATE_LIMIT_EXCEEDED"),
])
def test_grounding_rejects_prose_wrong_sectors_and_excess_candidates(tickers, evidence, limit, kept, warning):
    result = strategist._ground_candidates(report(tickers), evidence, limit)
    assert [c.ticker for c in result.candidates] == kept
    assert result.regime_evidence == "Global context"
    if warning:
        assert any(w.startswith(warning + ":") for w in result.warnings)


@pytest.mark.parametrize("stage", ["sector", "strategist"])
def test_historical_state_is_rejected_before_model_invocation(monkeypatch, stage):
    from tradingagents.agents.analysts.sector_analyst import create_sector_analyst

    monkeypatch.setattr(strategist, "bind_structured", lambda *a: None)
    node = (create_sector_analyst if stage == "sector" else strategist.create_market_strategist)(None)
    with pytest.raises(ValueError, match="only live analysis"):
        node({"scan_mode": "historical"})


@pytest.mark.parametrize("source", ["fred", "yfinance", "get_global_news"])
@pytest.mark.parametrize("status", ["failed", "stale", "unavailable"])
def test_missing_input_family_blocks_candidates_despite_reports(monkeypatch, source, status):
    evidence = [dict(row, status=status) if row["source"] == source else row for row in EVIDENCE]
    result, _ = run(monkeypatch, global_evidence=evidence)
    assert result["scan_status"] == "INCOMPLETE"
    assert result["market_scan_result"]["candidates"] == []


def test_empty_news_search_is_observed_coverage(monkeypatch):
    evidence = [dict(row, status="empty", content="No matching news")
                if row["source"] == "get_global_news" else row for row in EVIDENCE]
    result, _ = run(monkeypatch, global_evidence=evidence)
    assert result["scan_status"] == "COMPLETE"


def test_sector_recovery_reaches_grounding_and_saved_evidence(monkeypatch, tmp_path):
    import json

    from langchain_core.messages import ToolMessage

    from tradingagents.graph.market_setup import capture_screen_evidence
    from tradingagents.reporting import write_market_report_tree

    table = "## Sector performance\n### Sectors (best to worst)\n| 1 | Energy | XLE | +3% | +1% |"
    captured = capture_screen_evidence({
        "sector_evidence": "DATA_UNAVAILABLE: failed", "data_warnings": ["SECTOR_DATA_UNAVAILABLE"],
        "messages": [ToolMessage(content=table, name="get_sector_performance", tool_call_id="s"),
                     ToolMessage(content=SCREEN, name="screen_equities", tool_call_id="e")],
    })
    result, _ = run(monkeypatch, **captured)
    assert result["scan_status"] == "COMPLETE"
    assert result["market_scan_result"]["candidates"][0]["ticker"] == "XOM"
    write_market_report_tree({**captured, **result}, tmp_path)
    saved = [json.loads(line) for line in (tmp_path / "evidence.jsonl").read_text().splitlines()]
    assert next(r["content"] for r in saved if r["source"] == "yahoo_sectors") == table


def test_candidate_conviction_only_changes_for_its_missing_benchmark(monkeypatch):
    table = "## Sector performance\n### Sectors (best to worst)\n| 1 | Energy | XLE | +3% | n/a |\n| 2 | Technology | XLK | +2% | +1% |"
    answer = report(candidates=[
        {"ticker": "XOM", "sector": "Energy", "thesis": "Energy", "conviction": "High"},
        {"ticker": "MSFT", "sector": "Technology", "thesis": "Technology", "conviction": "High"},
    ])
    result, _ = run(monkeypatch, answer, sector_evidence=table,
                    screen_evidence=SCREEN + "\n### Technology\n| MSFT | Microsoft |")
    assert [(c["ticker"], c["conviction"]) for c in result["market_scan_result"]["candidates"]] == [
        ("XOM", "Low"), ("MSFT", "High")]


def test_new_market_scan_cannot_silently_omit_market_assessment(monkeypatch):
    result, _ = run(monkeypatch, market_diagnostics_data={"status": "success"})
    assert result["scan_status"] == "DEGRADED"
    assert "MARKET_ASSESSMENT_MISSING:market_outlook" in result["scan_warnings"]
    assert "MARKET_SCENARIOS_INCOMPLETE" in result["scan_warnings"]


def test_market_assessment_survives_empty_shortlist(monkeypatch):
    result, _ = run(monkeypatch, report((), market_outlook="Range with downside risk",
        participation_assessment="Narrow participation", rotation_assessment="Defensives improving",
        catalyst_assessment="CPI expected tomorrow", scenarios=["Base: flat", "Upside: broadening", "Downside: breakdown"]),
        market_diagnostics_data={"status": "success"})
    assert result["scan_status"] == "COMPLETE"
    assert "Narrow participation" in result["market_scan_report"]
    assert "Downside: breakdown" in result["market_scan_report"]
    assert result["market_scan_result"]["candidates"] == []


@pytest.mark.parametrize("missing", ["market_risk_review", "market_bear_rebuttal", "market_draft_report", "resolution"])
def test_final_review_cannot_be_skipped(monkeypatch, missing):
    from tradingagents.agents.market_review import REVIEW_FIELDS

    state = dict.fromkeys(REVIEW_FIELDS, "Review available")
    state.update(market_review_enabled=True, market_draft_report="Provisional outlook")
    answer = report(review_resolution="Accepted; revised claim")
    if missing == "resolution":
        answer.review_resolution = ""
    else:
        state[missing] = ""
    result, _ = run(monkeypatch, answer, **state)
    assert result["scan_status"] == "INCOMPLETE"
    assert result["market_scan_result"]["candidates"] == []


def test_draft_does_not_publish_final_result(monkeypatch):
    monkeypatch.setattr(strategist, "bind_structured", lambda *a: None)
    monkeypatch.setattr(strategist, "invoke_structured_required", lambda *a: report())
    result = strategist.create_market_strategist(None, stage="draft")({"market_review_enabled": True})
    assert "market_draft_report" in result
    assert "market_scan_report" not in result and "scan_status" not in result
