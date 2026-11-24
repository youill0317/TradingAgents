"""The ``market`` command: its flags, its unattended checks, and a full CLI run against a real graph."""
from __future__ import annotations

from contextlib import nullcontext

import pytest
from typer.testing import CliRunner

import cli.main as m
import cli.market


def test_bare_command_still_runs_the_ticker_analysis(monkeypatch):
    calls = []
    monkeypatch.setattr(m, "run_analysis", lambda **k: calls.append("analyze"))
    monkeypatch.setattr(cli.market, "run_market_analysis", lambda **k: calls.append("market"))
    result = CliRunner().invoke(m.app, [])
    assert result.exit_code == 0, result.output
    assert calls == ["analyze"]


def test_market_command_passes_its_flags(monkeypatch):
    captured = {}
    monkeypatch.setattr(cli.market, "run_market_analysis", lambda **k: captured.update(k))
    result = CliRunner().invoke(m.app, ["market", "--date", "2024-03-15", "--analysts", "macro,sector",
                                        "--save", "--no-show", "--no-checkpoint"])
    assert result.exit_code == 0, result.output
    assert captured["checkpoint"] is False
    assert captured["flags"] == {"date": "2024-03-15", "analysts": "macro,sector", "save": True,
                                 "show": False, "html": None}


def test_analyst_flag_is_checked_and_ordered():
    assert cli.market.parse_market_analysts("sector, MACRO") == ["macro", "sector"]
    with pytest.raises(ValueError, match="unknown market analyst"):
        cli.market.parse_market_analysts("crypto")


def test_without_a_terminal_every_open_question_is_named(monkeypatch):
    for var in ("TRADINGAGENTS_OUTPUT_LANGUAGE", "TRADINGAGENTS_MAX_DEBATE_ROUNDS", "TRADINGAGENTS_MAX_RISK_ROUNDS",
                "TRADINGAGENTS_LLM_PROVIDER", "TRADINGAGENTS_QUICK_THINK_LLM", "TRADINGAGENTS_DEEP_THINK_LLM"):
        monkeypatch.delenv(var, raising=False)
    gaps = cli.market.unattended_gaps({})
    assert "--date" in gaps and "--analysts" in gaps and "--save or --no-save" in gaps
    assert "TRADINGAGENTS_MAX_DEBATE_ROUNDS and TRADINGAGENTS_MAX_RISK_ROUNDS" in gaps


def test_depth_sets_both_round_counts_unless_the_environment_does(monkeypatch):
    monkeypatch.delenv("TRADINGAGENTS_MAX_DEBATE_ROUNDS", raising=False)
    monkeypatch.setenv("TRADINGAGENTS_MAX_RISK_ROUNDS", "2")
    selections = {"research_depth": 3, "llm_provider": "openai", "backend_url": None, "quick_think_llm": "q",
                  "deep_think_llm": "d", "output_language": "English"}
    config = cli.market.build_market_config(selections, checkpoint=True)
    assert config["max_debate_rounds"] == 3
    assert config["max_risk_discuss_rounds"] != 3
    assert config["checkpoint_enabled"] is True


def test_cli_run_streams_records_and_saves(monkeypatch, tmp_path):
    import tradingagents.llm_clients.factory as factory
    import tradingagents.market.analysts as market_analysts
    import tradingagents.market.tools as market_tools
    from tests.test_market_workflow import FakeModel
    from tradingagents.default_config import DEFAULT_CONFIG

    for name in ("get_regional_macro_report", "_sector_performance"):
        monkeypatch.setattr(market_tools, name, lambda *a: "DATA")
    monkeypatch.setattr(market_tools, "collect_market_events", lambda d: {"report": "EVENTS"})
    monkeypatch.setattr(market_tools, "collect_market_diagnostics", lambda d: {"internals_report": "INTERNALS"})
    monkeypatch.setattr(market_analysts, "collect_market_sentiment", lambda d: {
        "start_date": d, "end_date": d, "vix": "VIX", "stocktwits": "T", "reddit": "R"})

    class Client:
        def get_llm(self):
            return FakeModel([])
    monkeypatch.setattr(factory, "create_llm_client", lambda **k: Client())
    config = {**DEFAULT_CONFIG, "results_dir": str(tmp_path / "results"), "data_cache_dir": str(tmp_path / "cache"),
              "memory_log_path": str(tmp_path / "memory" / "trading_memory.md")}
    monkeypatch.setattr(cli.market, "DEFAULT_CONFIG", config)
    monkeypatch.setattr(cli.market, "get_market_selections", lambda flags: {
        "analysis_date": "2024-03-15", "analysts": ["macro", "market", "news", "sentiment", "sector"], "research_depth": 1,
        "llm_provider": "openai", "backend_url": None, "quick_think_llm": "q", "deep_think_llm": "d",
        "output_language": "English"})
    monkeypatch.setattr(cli.market, "Live", lambda *a, **k: nullcontext())
    monkeypatch.setattr(cli.market.sys.stdin, "isatty", lambda: True, raising=False)

    state = cli.market.run_market_analysis(flags={"save": True, "show": False, "html": False})

    assert state["final_regime"] == "Rotation"
    run_dir = tmp_path / "results" / "MARKET" / "2024-03-15"
    assert (run_dir / "reports" / "final_market_decision.md").exists()
    assert "Tool Call" in (run_dir / "message_tool.log").read_text()
    reports = list((tmp_path / "results" / "reports").iterdir())
    assert len(reports) == 1 and (reports[0] / "market_call.json").exists()
    assert (tmp_path / "memory" / "market_memory.jsonl").exists()


def test_scorecard_flag_prints_past_results_without_running_an_analysis(monkeypatch, tmp_path):
    from tests.test_market_scoring import _record
    from tradingagents.default_config import DEFAULT_CONFIG

    config = {**DEFAULT_CONFIG, "market_memory_log_path": str(tmp_path / "market_memory.jsonl")}
    monkeypatch.setattr(cli.market, "DEFAULT_CONFIG", config)
    monkeypatch.setattr(cli.market, "run_market_analysis", lambda **k: pytest.fail("--scorecard runs no analysis"))
    assert "No settled market calls yet" in CliRunner().invoke(m.app, ["market", "--scorecard"]).output

    import json
    records = [_record("2024-03-01", "Risk-On", True, ("Bullish", 0.02)),
               {"date": "2024-03-08", "regime": "Rotation", "sectors": {}, "decision": "", "days": 5, "pending": True}]
    (tmp_path / "market_memory.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records))
    output = CliRunner().invoke(m.app, ["market", "--scorecard"]).output
    assert "Regime hit rate: 100% (1/1)" in output and "1 call(s) are pending" in output
