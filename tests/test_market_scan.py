"""The market scan's sector data must not lie about what it found.

A sector whose data is missing must never be indistinguishable from a quiet
one, and every sector failing is a broken data path, not a flat market.
"""
from __future__ import annotations

import pandas as pd
import pytest

from tradingagents.dataflows import market_scan as ms


class TestSectorPerformance:
    def test_ranks_best_to_worst(self, monkeypatch):
        # XLE climbs, everything else is flat, so XLE must lead.
        def fake_load(symbol, curr_date):
            dates = pd.date_range(end=curr_date, periods=40, freq="D")
            closes = list(range(100, 140)) if symbol == "XLE" else [100] * 40
            return pd.DataFrame({"Date": dates, "Close": closes})

        monkeypatch.setattr(ms, "load_ohlcv", fake_load)
        result = ms.get_sector_performance("2026-08-19")

        sector_rows = [ln for ln in result.splitlines() if ln.startswith("| 1 |")]
        assert sector_rows and "Energy" in sector_rows[0]

    def test_a_total_data_outage_raises_instead_of_printing_an_empty_table(
        self, monkeypatch
    ):
        """Every sector failing means the pipe is broken, not that the market is flat."""
        def dead_load(symbol, curr_date):
            raise OSError("cache directory is read-only")

        monkeypatch.setattr(ms, "load_ohlcv", dead_load)
        with pytest.raises(ms.NoMarketDataError):
            ms.get_sector_performance("2026-08-19")

    def test_a_single_missing_sector_degrades_but_is_logged(self, monkeypatch, caplog):
        def partial_load(symbol, curr_date):
            if symbol == "XLU":
                raise RuntimeError("no rows")
            dates = pd.date_range(end=curr_date, periods=40, freq="D")
            return pd.DataFrame({"Date": dates, "Close": [100] * 40})

        monkeypatch.setattr(ms, "load_ohlcv", partial_load)
        with caplog.at_level("WARNING"):
            result = ms.get_sector_performance("2026-08-19")

        assert "n/a" in result
        # Silent degradation is the failure mode that matters here: a missing
        # sector must never be indistinguishable from a quiet one.
        assert any("XLU" in r.getMessage() for r in caplog.records)


def test_cli_streams_reports_and_saves_even_without_optional_export(monkeypatch, tmp_path):
    from contextlib import nullcontext
    from io import StringIO
    from types import SimpleNamespace
    from unittest.mock import Mock

    from langchain_core.messages import AIMessage
    from rich.console import Console

    import cli.market as cli

    monkeypatch.setenv("FRED_API_KEY", "offline-test")
    reports = {field: agent + " report" for agent, field in cli.MARKET_STAGES}
    state = {"scan_status": "COMPLETE", "run_id": "run-1", "as_of_utc": "2026-09-11T12:00:00+00:00",
             "market_scan_result": {"sector_verdicts": [{"sector": "Energy", "outlook": "Bullish"}]}}
    frames = []

    def live(layout, **kwargs):
        frames.append(layout)
        return nullcontext()

    def scan(**kwargs):
        kwargs["on_progress"]("Collecting economic events")
        with console.capture() as capture:
            console.print(frames[0])
        assert "Collecting economic events" in capture.get()
        kwargs["on_progress"]("Analysis")
        for key, content in reports.items():
            state.update({key: content, "messages": [AIMessage(content=content)]})
            kwargs["on_chunk"](state.copy())
        with console.capture() as capture:
            console.print(frames[0])
        rendered = capture.get()
        assert all(agent in rendered for agent, _ in cli.MARKET_STAGES)
        assert frames[0]["progress"].renderable.title == "Progress"
        return state

    save = Mock(return_value=tmp_path / "complete_report.md")
    monkeypatch.setattr(cli, "MarketAnalysisGraph", lambda **k: SimpleNamespace(scan=scan, save_reports=save, config=k["config"]))
    monkeypatch.setattr(cli, "Live", live)
    monkeypatch.setattr(cli, "get_market_selections", lambda: {})
    monkeypatch.setattr(cli, "_build_market_config", lambda _: {"results_dir": str(tmp_path)})
    answers = iter(["N", "Y"])
    monkeypatch.setattr(cli.typer, "prompt", lambda *a, **k: next(answers))
    console = Console(file=StringIO(), record=True, width=120, height=40)
    monkeypatch.setattr(cli, "console", console)
    assert cli.run_market_scan() == state
    save.assert_called_once()
    assert save.call_args.args[0] == state
    run_dir = next((tmp_path / "market_scans").iterdir())
    for _, field in cli.MARKET_STAGES:
        assert (run_dir / cli.SCAN_REPORT_FILES[field]).read_text() == reports[field]
    assert "not position calls" in console.export_text()


@pytest.mark.parametrize("dates,prices,expected", [
    (["2026-09-10", "2026-09-11"], [100, 110], None),
    (["2026-08-11", "2026-08-13", "2026-09-11"], [100, 105, 110], 10),
    (["2026-08-01", "2026-09-11"], [100, 110], None),
    (["2026-08-12", "2026-09-11"], [float("nan"), 110], None),
    (["2026-08-12", "2026-09-11", "2026-09-12"], [100, 110, 999], 10),
])
def test_sector_return_requires_full_window(monkeypatch, dates, prices, expected):
    frame = pd.DataFrame({"Date": pd.to_datetime(dates), "Close": prices})
    monkeypatch.setattr(ms, "load_ohlcv", lambda *args: frame)
    result = ms._pct_return("XLE", "2026-09-11", 30)
    assert result is None if expected is None else result == pytest.approx(expected)
