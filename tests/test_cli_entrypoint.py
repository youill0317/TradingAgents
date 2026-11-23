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
        ["market", "--date", "2026-08-19", "--save"],
    )

    assert result.exit_code == 0, result.output
    assert captured["date"] == "2026-08-19"
    assert captured["save"] is True



@pytest.mark.parametrize("option", ["--sectors", "--limit"])
def test_market_has_no_stock_screening_options(option):
    result = CliRunner().invoke(m.app, ["market", option, "5"])
    assert result.exit_code != 0
