"""Report parity: the shared writer produces the report tree for the CLI and the
programmatic API alike (#1037)."""

import json
from types import SimpleNamespace

import pytest

from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.reporting import write_report_tree


def _state():
    return {
        "market_report": "MKT",
        "news_report": "NEWS",
        "investment_debate_state": {"judge_decision": "RM PLAN"},
        "trader_investment_plan": "TRADE",
        "risk_debate_state": {"judge_decision": "PM DECISION"},
    }


@pytest.mark.unit
def test_write_report_tree_creates_files(tmp_path):
    out = write_report_tree(_state(), "AAPL", tmp_path)
    assert out.name == "complete_report.md"
    assert (tmp_path / "1_analysts" / "market.md").read_text() == "MKT"
    assert (tmp_path / "1_analysts" / "news.md").read_text() == "NEWS"
    assert (tmp_path / "2_research" / "manager.md").read_text() == "RM PLAN"
    assert (tmp_path / "3_trading" / "trader.md").read_text() == "TRADE"
    assert (tmp_path / "5_portfolio" / "decision.md").read_text() == "PM DECISION"
    complete = out.read_text()
    assert "Trading Analysis Report: AAPL" in complete
    assert "MKT" in complete and "PM DECISION" in complete


@pytest.mark.unit
def test_save_reports_explicit_path(tmp_path):
    # Unbound: with an explicit save_path, the method doesn't touch self/config.
    out = TradingAgentsGraph.save_reports(None, _state(), "AAPL", save_path=tmp_path)
    assert (tmp_path / "complete_report.md").exists()
    assert out == tmp_path / "complete_report.md"


@pytest.mark.unit
def test_save_reports_defaults_under_results_dir(tmp_path):
    mock_self = SimpleNamespace(config={"results_dir": str(tmp_path)})
    out = TradingAgentsGraph.save_reports(mock_self, _state(), "AAPL")
    assert out.exists()
    assert out.parent.parent.name == "reports"  # results_dir/reports/AAPL_<stamp>/...
    assert out.parent.name.startswith("AAPL_")


@pytest.mark.parametrize("legacy_state", [False, True])
def test_market_export_summarizes_warnings_without_losing_evidence(tmp_path, legacy_state):
    from tradingagents.agents.schemas import MarketScanReport, render_market_scan_report
    from tradingagents.reporting import write_market_report_tree

    reference = "ev-0123456789abcdef"
    row = {"source": "fred", "target": "DGS10", "status": "success",
           "content": "10-year yield", "evidence_id": reference, "value": 4.97}
    warnings = [f"PUBLIC_STALE:tic:series-{i}:2026-06" for i in range(100)] + ["EIA_NOT_CONFIGURED"]
    report = MarketScanReport(regime="Rotation", regime_evidence=f"Yield [{reference}]",
                              sector_view="Energy", warnings=warnings, candidates=[])
    rendered = render_market_scan_report(report)
    state = {"public_data_evidence": [row], "global_evidence": [row] if legacy_state else [],
             "market_scan_result": report.model_dump(), "market_scan_report": rendered,
             "scan_warnings": warnings}
    write_market_report_tree(state, tmp_path)

    assert "100 stale series" in rendered and "EIA_NOT_CONFIGURED" in rendered
    assert "series-99" not in rendered and f"[{reference}]" in rendered
    assert json.loads((tmp_path / "validation.json").read_text())["warnings"] == warnings
    assert json.loads((tmp_path / "scan.json").read_text())["warnings"] == warnings
    saved = [json.loads(line) for line in (tmp_path / "evidence.jsonl").read_text().splitlines()]
    assert len(saved) == 1 and saved[0]["evidence_id"] == reference and saved[0]["value"] == 4.97
