"""The bare ``tradingagents`` command must keep working.

Typer treats a lone registered command as the default, so before the market
scan existed, ``tradingagents`` with no arguments ran the analysis directly --
which is what README and ``docker compose run --rm tradingagents`` invoke.
Registering a second command silently turns that into "Missing command."
(exit code 2). The ``@app.callback(invoke_without_command=True)`` in cli.main
is what prevents it, and these tests exist to stop it being removed.
"""
from __future__ import annotations

from typer.testing import CliRunner

import cli.main as m


def _runner():
    return CliRunner()


def test_no_arguments_does_not_fail_with_missing_command(monkeypatch):
    """The regression this whole file exists for."""
    monkeypatch.setattr(m, "_show_welcome", lambda *a, **k: None)
    monkeypatch.setattr(m, "select_workflow", lambda: "analyze")
    monkeypatch.setattr(m, "run_analysis", lambda **k: None)

    result = _runner().invoke(m.app, [])

    assert result.exit_code == 0, result.output
    assert "Missing command" not in result.output


def test_no_arguments_asks_which_workflow(monkeypatch):
    asked = []
    monkeypatch.setattr(m, "_show_welcome", lambda *a, **k: None)
    monkeypatch.setattr(m, "select_workflow", lambda: asked.append(True) or "analyze")
    monkeypatch.setattr(m, "run_analysis", lambda **k: None)

    _runner().invoke(m.app, [])

    assert asked, "the no-argument path must offer the workflow choice"


def test_workflow_choice_dispatches_to_the_market_scan(monkeypatch):
    ran = []
    monkeypatch.setattr(m, "_show_welcome", lambda *a, **k: None)
    monkeypatch.setattr(m, "select_workflow", lambda: "market")
    monkeypatch.setattr(m, "run_market_scan", lambda **k: ran.append(k))
    monkeypatch.setattr(m, "run_analysis", lambda **k: ran.append("WRONG"))

    _runner().invoke(m.app, [])

    assert ran and ran[0] != "WRONG"


def test_explicit_subcommands_skip_the_workflow_menu(monkeypatch):
    """A scripted `tradingagents analyze` must not stop to ask a question."""
    def _should_not_run():
        raise AssertionError("select_workflow must not run for an explicit subcommand")

    monkeypatch.setattr(m, "select_workflow", _should_not_run)
    monkeypatch.setattr(m, "run_analysis", lambda **k: None)
    monkeypatch.setattr(m, "run_market_scan", lambda **k: None)

    assert _runner().invoke(m.app, ["analyze"]).exit_code == 0
    assert _runner().invoke(m.app, ["market"]).exit_code == 0


def test_market_command_parses_its_options(monkeypatch):
    captured = {}
    monkeypatch.setattr(m, "select_workflow", lambda: "market")
    monkeypatch.setattr(m, "run_market_scan", lambda **k: captured.update(k))

    result = _runner().invoke(
        m.app,
        ["market", "--date", "2026-08-19", "--sectors", "Technology, Energy",
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

    result = _runner().invoke(m.app, ["market", "--sectors", "Tecnology"])

    assert result.exit_code == 2
    # The error has to teach the vocabulary, not just say no.
    assert "Technology" in result.output


def test_market_command_canonicalises_sector_case(monkeypatch):
    captured = {}
    monkeypatch.setattr(m, "run_market_scan", lambda **k: captured.update(k))

    _runner().invoke(m.app, ["market", "--sectors", "technology,ENERGY"])

    assert captured["sectors"] == ["Technology", "Energy"]


def test_market_command_defaults_sectors_to_none(monkeypatch):
    captured = {}
    monkeypatch.setattr(m, "run_market_scan", lambda **k: captured.update(k))

    _runner().invoke(m.app, ["market"])

    # None, not [] — the Sector Analyst picks for itself when nothing is asked for.
    assert captured["sectors"] is None
