"""Cross-stage contracts for the current global scan."""

import json
from datetime import datetime

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from tradingagents.dataflows.config import config_context
from tradingagents.dataflows.market_scan import screen_equities
from tradingagents.graph.market_setup import capture_macro_evidence, capture_screen_evidence
from tradingagents.reporting import write_market_report_tree


def test_partial_screens_and_sector_outage_are_not_silent():
    state = {"data_warnings": ["GLOBAL_GAP"], "messages": [
        ToolMessage(content="## Equity screen\n### Energy\n_No matches._", name="screen_equities", tool_call_id="1"),
        ToolMessage(content="NO_DATA_AVAILABLE: offline", name="screen_equities", tool_call_id="2"),
    ]}
    result = capture_screen_evidence(state)
    assert "GLOBAL_GAP" in result["data_warnings"]
    assert "SCREEN_PARTIAL_FAILURE" in result["data_warnings"]
    assert "SECTOR_DATA_UNAVAILABLE" in result["data_warnings"]
    assert "SCREEN_EVIDENCE_MISSING" not in result["data_warnings"]


def test_macro_capture_preserves_deterministic_global_gaps():
    result = capture_macro_evidence({"global_snapshot": "data", "data_warnings": ["China: missing"],
                                     "messages": [AIMessage(content="report")]})
    assert result["data_warnings"] == ["China: missing"]


def test_screen_uses_pinned_run_date_across_host_and_midnight(monkeypatch):
    import tradingagents.dataflows.market_scan as market

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 9, 5, 9, tzinfo=tz)

    monkeypatch.setattr(market, "datetime", Clock)
    monkeypatch.setattr(market.yf, "screen", lambda *a, **k: {"quotes": [], "total": 0})
    with config_context({"market_scan_date": "2026-09-04"}):
        assert "No matches" in screen_equities(sector="Energy", curr_date="2026-09-04")


def test_report_preserves_global_data_and_validated_json(tmp_path):
    state = {"trade_date": "2026-09-04", "global_snapshot": "Japan data",
             "global_context": "War: summary only", "macro_report": "Global interpretation",
             "sector_report": "US sectors", "market_scan_report": "No candidates",
             "scan_status": "DEGRADED", "scan_warnings": ["missing"],
             "global_evidence": [{"source": "fred", "target": "Japan", "status": "failed",
                                  "content": "unavailable", "retrieved_at": "2026-09-04T12:00:00Z"}],
             "market_scan_result": {"status": "DEGRADED", "warnings": ["missing"], "candidates": []}}
    report = write_market_report_tree(state, tmp_path)
    assert "Global interpretation" in report.read_text(encoding="utf-8")
    assert (tmp_path / "global_data.md").read_text() == "Japan data"
    assert json.loads((tmp_path / "scan.json").read_text())["status"] == "DEGRADED"
    evidence = json.loads((tmp_path / "evidence.jsonl").read_text().splitlines()[0])
    assert evidence["status"] == "failed" and evidence["sha256"]


@pytest.mark.parametrize("date", ["2000-01-01", "2999-01-01"])
def test_cli_rejects_noncurrent_date_before_initializing_models(monkeypatch, date):
    import cli.main as cli

    monkeypatch.setattr(cli, "MarketAnalysisGraph", lambda **k: pytest.fail("must reject before model setup"))
    with pytest.raises(cli.typer.BadParameter):
        cli.run_market_scan(date=date, non_interactive=True)


def test_cli_incomplete_scan_has_failure_exit(monkeypatch):
    from typer.testing import CliRunner

    import cli.main as cli

    monkeypatch.setattr(cli, "run_market_scan", lambda **k: {"scan_status": "INCOMPLETE"})
    result = CliRunner().invoke(cli.app, ["market", "--non-interactive"])
    assert result.exit_code == 1


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("provider,token_key", [("openai", "max_tokens"), ("google", "max_output_tokens")])
def test_global_collection_reaches_real_graph_and_grounded_candidate(
    monkeypatch, tmp_path, stream, provider, token_key
):
    from langchain_core.runnables import RunnableLambda

    import tradingagents.graph.market_graph as mg
    from tradingagents.agents.schemas import MarketScanReport
    from tradingagents.default_config import DEFAULT_CONFIG

    prompts = []

    class Model:
        sector_calls = 0

        def bind_tools(self, tools):
            def answer(prompt):
                prompts.append(str(prompt))
                if any(t.name == "screen_equities" for t in tools):
                    self.sector_calls += 1
                    if self.sector_calls == 1:
                        return AIMessage(content="", tool_calls=[{
                            "name": "screen_equities", "args": {"sector": "Energy"}, "id": "screen",
                        }])
                    return AIMessage(content=[{"type": "text", "text": "US Energy benefits from the global scenario"}] if provider == "google" else "US Energy benefits from the global scenario")
                return AIMessage(content=[{"type": "text", "text": "Japan and oil: a global scenario with uncertainty"}] if provider == "google" else "Japan and oil: a global scenario with uncertainty")
            return RunnableLambda(answer)

        def invoke(self, prompt):
            prompts.append(str(prompt))
            return AIMessage(content=[{"type": "text", "text": "REVIEW: concentration contradicts the headline index; monitor RSP/SPY"}])

        def with_structured_output(self, schema):
            def final(prompt):
                prompts.append(str(prompt))
                return MarketScanReport(regime="Rotation", regime_evidence="Japan and oil",
                                        sector_view="Energy", review_resolution="Accepted concentration finding: monitor RSP/SPY", market_outlook="Conditional market outlook",
                                        participation_assessment="ETF participation", rotation_assessment="Leadership reversal",
                                        catalyst_assessment="Upcoming CPI", scenarios=["Base: stable", "Upside: breadth expands", "Downside: breadth contracts"], candidates=[{
                                            "ticker": "XOM", "sector": "Energy", "conviction": "High",
                                            "thesis": "Global oil scenario transmits to US energy",
                                        }])
            return RunnableLambda(final)

    class Client:
        def get_llm(self):
            return Model()

    calls = []
    client_options = []
    monkeypatch.setattr(mg, "create_llm_client", lambda **k: client_options.append(k) or Client())
    monkeypatch.setattr(mg, "collect_global_snapshot", lambda date: calls.append("snapshot") or {
        "report": "JAPAN_BASELINE", "evidence": [
            {"source": "fred", "status": "success", "content": "Japan growth"},
            {"source": "yfinance", "status": "success", "content": "Equity returns"},
        ], "warnings": [],
    })
    monkeypatch.setattr(mg, "collect_global_context", lambda date: calls.append("context") or {
        "report": "WAR_SUMMARY_ONLY", "evidence": [
            {"source": "get_global_news", "status": "success", "content": "War summary"},
        ], "warnings": [],
    })
    monkeypatch.setattr(mg, "collect_market_diagnostics", lambda date: calls.append("diagnostics") or {
        "report": "PARTICIPATION_ROTATION", "data": {"status": "success"}, "evidence": [], "warnings": [],
        "sector_report": "## Sector performance\n### Sectors (best to worst)\n| 1 | Energy | XLE | +3% | +1% |",
    })
    monkeypatch.setattr(mg, "collect_market_events", lambda date: calls.append("events") or {
        "report": "DATED_CATALYSTS", "data": {"events": []}, "evidence": [], "warnings": [],
    })
    import tradingagents.dataflows.market_scan as market
    monkeypatch.setattr(market.yf, "screen", lambda *a, **k: {"quotes": [{"symbol": "XOM"}], "total": 1})
    config = {**DEFAULT_CONFIG, "data_cache_dir": str(tmp_path / "cache"),
              "results_dir": str(tmp_path / "results"), "checkpoint_enabled": True,
              "llm_provider": provider, "max_tokens": "4096"}
    graph = mg.MarketAnalysisGraph(config=config)
    assert len(client_options) == 2
    assert all(options[token_key] == 4096 for options in client_options)
    other_key = "max_tokens" if token_key == "max_output_tokens" else "max_output_tokens"
    assert all(other_key not in options for options in client_options)
    chunks = []
    state = graph.scan(sectors=["Energy"], candidate_limit=3, on_chunk=chunks.append if stream else None)
    if stream:
        assert chunks[-1] == state
        assert any(c.get("macro_report") and not c.get("sector_report") for c in chunks)
    assert state["requested_sectors"] == ["Energy"] and state["candidate_limit"] == 3
    assert "company_of_interest" not in state
    assert state["trade_date"] == datetime.fromisoformat(state["as_of_utc"]).astimezone(mg.ZoneInfo("America/New_York")).date().isoformat()
    assert calls == ["snapshot", "context", "diagnostics", "events"]
    assert all("PARTICIPATION_ROTATION" in p and "DATED_CATALYSTS" in p for p in prompts)
    assert "JAPAN_BASELINE" in prompts[0] and "WAR_SUMMARY_ONLY" in prompts[0]
    assert "Japan and oil" in prompts[1]
    assert "Japan and oil" in prompts[-1] and "US Energy benefits" in prompts[-1]
    assert state["market_risk_review"].startswith("REVIEW:")
    assert "REVIEW: concentration" in prompts[-1]
    assert "DRAFT:" in prompts[-1] and "RISK REVIEW:" in prompts[-1]
    assert "Accepted concentration" in state["market_scan_report"]
    assert state["market_draft_result"]["candidates"][0]["ticker"] == "XOM"
    assert state["scan_status"] == "COMPLETE"
    assert state["market_scan_result"]["candidates"][0]["ticker"] == "XOM"
    assert not list(tmp_path.rglob("*.db")), "live scans must not resume old checkpoints"
    graph.save_reports(state, tmp_path / "export")
    assert json.loads((tmp_path / "export" / "scan.json").read_text())["candidates"]
    assert json.loads((tmp_path / "export" / "market_diagnostics.json").read_text())["status"] == "success"
    assert json.loads((tmp_path / "export" / "event_calendar.json").read_text())["events"] == []
    report = (tmp_path / "export" / "complete_report.md").read_text()
    assert "Conditional market outlook" in report and "Downside: breadth contracts" in report
    assert "Independent Risk Review" in report and "REVIEW: concentration" in report
    assert (tmp_path / "export" / "risk_review.md").exists()
    if stream:
        draft_chunk = next(c for c in chunks if c.get("market_draft_report") and not c.get("market_risk_review"))
        assert not draft_chunk.get("market_scan_report")
    assert {"complete_report.md", "macro.md", "sector.md", "strategist.md"} <= {p.name for p in (tmp_path / "export").iterdir()}


@pytest.mark.parametrize("kwargs", [
    {"trade_date": "2000-01-01"}, {"trade_date": "2999-01-01"},
    {"trade_date": "not-a-date"}, {"candidate_limit": 0}, {"candidate_limit": 26},
])
def test_graph_rejects_invalid_inputs_before_collection(kwargs):
    from tradingagents.graph.market_graph import MarketAnalysisGraph

    # Invalid input must fail before accessing configuration or collecting data.
    graph = MarketAnalysisGraph.__new__(MarketAnalysisGraph)
    with pytest.raises(ValueError):
        graph.scan(**kwargs)
