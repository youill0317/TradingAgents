"""The ``market`` subcommand must not take over the bare ``tradingagents`` command.

Bare ``tradingagents`` runs the ticker analysis, as upstream ships it; the
market scan is reached only through ``tradingagents market``.
"""
from __future__ import annotations

import pytest
from typer.testing import CliRunner

import cli.main as m
import cli.market


def test_bare_command_still_runs_the_analysis(monkeypatch):
    calls = []
    monkeypatch.setattr(m, "run_analysis", lambda **k: calls.append("analyze"))
    monkeypatch.setattr(cli.market, "run_market_scan", lambda **k: calls.append("market"))
    result = CliRunner().invoke(m.app, [])
    assert result.exit_code == 0, result.output
    assert calls == ["analyze"]


def test_market_command_parses_its_options(monkeypatch):
    captured = {}
    monkeypatch.setattr(m, "run_analysis", lambda **k: pytest.fail("market must not run the analysis"))
    monkeypatch.setattr(cli.market, "run_market_scan", lambda **k: captured.update(k))

    result = CliRunner().invoke(
        m.app,
        ["market", "--date", "2026-08-19", "--sectors", "technology, ENERGY",
         "--limit", "5", "--save"],
    )

    assert result.exit_code == 0, result.output
    assert captured["date"] == "2026-08-19"
    # Whitespace around a comma is a normal way to type this; it must not become
    # a sector named " Energy" that the vendor then rejects.
    assert captured["sectors"] == ["Technology", "Energy"]
    assert captured["limit"] == 5
    assert captured["save"] is True


def test_candidate_handoff_puts_the_scan_in_the_instrument_context(monkeypatch):
    import cli.run
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    seen = {}

    def fake_run_analysis(flags=None, **kwargs):
        graph_cls = cli.run.TradingAgentsGraph
        seen["flags"] = flags
        seen["is_subclass"] = graph_cls is not TradingAgentsGraph and issubclass(graph_cls, TradingAgentsGraph)
        graph = graph_cls.__new__(graph_cls)
        monkeypatch.setattr(TradingAgentsGraph, "resolve_instrument_context", lambda self, *a, **k: "BASE")
        seen["context"] = graph.resolve_instrument_context("XOM", "stock", "2026-09-11")

    monkeypatch.setattr(cli.run, "run_analysis", fake_run_analysis)
    cli.market.analyze_candidate("XOM", "2026-09-11", "SCAN FINDINGS")

    assert seen["flags"] == {"ticker": "XOM", "date": "2026-09-11"}
    assert seen["is_subclass"]
    assert seen["context"].startswith("BASE") and "SCAN FINDINGS" in seen["context"]
    assert cli.run.TradingAgentsGraph is TradingAgentsGraph, "the patch must not outlive the hand-off"
