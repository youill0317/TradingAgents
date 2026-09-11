"""The bare ``tradingagents`` command must keep working.

Typer treats a lone registered command as the default, so before the market
scan existed, ``tradingagents`` with no arguments ran the analysis directly --
which is what README and ``docker compose run --rm tradingagents`` invoke.
Registering a second command silently turns that into "Missing command."
(exit code 2). The ``@app.callback(invoke_without_command=True)`` in cli.main
is what prevents it, and these tests exist to stop it being removed.
"""
from __future__ import annotations

import pytest
from typer.testing import CliRunner

import cli.main as m


@pytest.mark.parametrize("workflow", ["analyze", "market"])
def test_bare_command_dispatches_selected_workflow(monkeypatch, workflow):
    calls = []
    monkeypatch.setattr(m, "_show_welcome", lambda *a, **k: None)
    monkeypatch.setattr(m, "select_workflow", lambda: calls.append("menu") or workflow)
    monkeypatch.setattr(m, "run_analysis", lambda **k: calls.append("analyze"))
    monkeypatch.setattr(m, "run_market_scan", lambda **k: calls.append("market"))
    result = CliRunner().invoke(m.app, [])
    assert result.exit_code == 0, result.output
    assert calls == ["menu", workflow]


def test_explicit_subcommands_skip_the_workflow_menu(monkeypatch):
    """A scripted `tradingagents analyze` must not stop to ask a question."""
    def _should_not_run():
        raise AssertionError("select_workflow must not run for an explicit subcommand")

    monkeypatch.setattr(m, "select_workflow", _should_not_run)
    monkeypatch.setattr(m, "run_analysis", lambda **k: None)
    calls = []
    monkeypatch.setattr(m, "run_market_scan", lambda **k: calls.append(k))

    assert CliRunner().invoke(m.app, ["analyze"]).exit_code == 0
    assert CliRunner().invoke(m.app, ["market"]).exit_code == 0
    assert calls[0]["sectors"] is None


def test_market_command_parses_its_options(monkeypatch):
    captured = {}
    monkeypatch.setattr(m, "select_workflow", lambda: "market")
    monkeypatch.setattr(m, "run_market_scan", lambda **k: captured.update(k))

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


def test_market_command_rejects_an_unknown_sector_before_running(monkeypatch):
    """A typo must not cost an LLM turn to discover via a tool error."""
    def _should_not_run(**k):
        raise AssertionError("the scan must not start with an invalid sector")

    monkeypatch.setattr(m, "run_market_scan", _should_not_run)

    result = CliRunner().invoke(m.app, ["market", "--sectors", "Tecnology"])

    assert result.exit_code == 2
    # The error has to teach the vocabulary, not just say no.
    assert "Technology" in result.output
