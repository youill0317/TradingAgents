"""The market scan's data layer must not lie about what it found.

Three properties matter enough to pin down, all of them learned the hard way
from live responses:

1. Without an exchange filter, ``region=us`` surfaces OTC-quoted foreign ADRs
   that dominate any percent-change sort with illiquid noise.
2. Yahoo leaves every screener row's ``sector`` empty, so the only way to
   attribute a hit to a sector is to have asked for that sector.
3. The screener has no historical mode, so a past-dated candidate scan must
   fail closed instead of mixing today's survivors into a historical report.
"""
from __future__ import annotations

import pandas as pd
import pytest

from tradingagents.dataflows import market_scan as ms


def _fake_quote(symbol, change=1.0):
    return {
        "symbol": symbol,
        "shortName": f"{symbol} Inc.",
        "regularMarketPrice": 100.0,
        "regularMarketChangePercent": change,
        "marketCap": 2.5e10,
        "regularMarketVolume": 5e6,
        "trailingPE": 20.0,
        # Yahoo really does return this as None on every row.
        "sector": None,
    }


@pytest.fixture
def captured_screens(monkeypatch):
    """Capture every query passed to yf.screen and return canned results."""
    calls = []

    def fake_screen(query, **kwargs):
        calls.append({"query": query, "kwargs": kwargs})
        return {"quotes": [_fake_quote("AAA"), _fake_quote("BBB")], "total": 2}

    monkeypatch.setattr(ms.yf, "screen", fake_screen)
    return calls


def _flatten_operands(query):
    """Walk an EquityQuery tree and yield every (operator, operands) pair."""
    yield query.operator, query.operands
    for operand in query.operands:
        if hasattr(operand, "operator"):
            yield from _flatten_operands(operand)


class TestScreenEquities:
    def test_always_constrains_to_real_us_exchanges(self, captured_screens):
        """Regression guard: dropping this filter fills the list with OTC ADRs."""
        ms.screen_equities(sector="Technology", limit=5)

        assert len(captured_screens) == 1
        clauses = list(_flatten_operands(captured_screens[0]["query"]))
        exchange_clauses = [
            operands for op, operands in clauses if operands and operands[0] == "exchange"
        ]
        assert exchange_clauses, "screen must always filter on exchange"
        assert set(exchange_clauses[0][1:]) == set(ms.US_EXCHANGES)

    def test_one_query_per_sector_and_rows_are_attributed(self, captured_screens):
        result = ms.screen_equities(sector=["Technology", "Energy"], limit=3)

        assert len(captured_screens) == 2, "each sector needs its own query"

        queried = []
        for call in captured_screens:
            for _op, operands in _flatten_operands(call["query"]):
                if operands and operands[0] == "sector":
                    queried.append(operands[1])
        assert queried == ["Technology", "Energy"]

        # Sector attribution has to survive into the rendered output, since the
        # response itself carries none.
        assert "### Technology" in result
        assert "### Energy" in result

    def test_past_date_fails_closed(self, captured_screens):
        with pytest.raises(ValueError, match="UNSUPPORTED_HISTORICAL_UNIVERSE"):
            ms.screen_equities(sector="Energy", curr_date="2024-05-10")
        assert captured_screens == []

    def test_one_failing_sector_does_not_lose_the_others(self, monkeypatch):
        def flaky_screen(query, **kwargs):
            for _op, operands in _flatten_operands(query):
                if operands and operands[0] == "sector" and operands[1] == "Energy":
                    raise RuntimeError("Yahoo said no")
            return {"quotes": [_fake_quote("AAA")], "total": 1}

        monkeypatch.setattr(ms.yf, "screen", flaky_screen)
        result = ms.screen_equities(sector=["Technology", "Energy"])

        assert "AAA" in result, "the healthy sector's results must survive"
        assert "Yahoo said no" in result, "the failure must be visible, not swallowed"


    def test_a_single_sector_failure_is_not_reported_as_no_matches(self, monkeypatch):
        """The analyst screens one sector per call, so this is the normal path.

        Reporting a Yahoo outage as "no matches" hands the Sector Analyst an
        empty screen it is instructed to treat as a finding — a broken vendor
        would be written up as a quiet sector.
        """
        def dead_screen(query, **kwargs):
            raise RuntimeError("Yahoo 500: service unavailable")

        monkeypatch.setattr(ms.yf, "screen", dead_screen)
        with pytest.raises(ms.NoMarketDataError) as exc:
            ms.screen_equities(sector="Technology")
        assert "Yahoo 500" in str(exc.value)

    def test_a_genuinely_empty_screen_still_says_no_matches(self, monkeypatch):
        monkeypatch.setattr(
            ms.yf, "screen", lambda q, **k: {"quotes": [], "total": 0}
        )
        result = ms.screen_equities(sector="Technology")
        assert "No matches" in result


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

    import cli.main as cli

    monkeypatch.setenv("FRED_API_KEY", "offline-test")
    reports = {field: agent + " report" for agent, field in cli.MARKET_STAGES}
    state = {"scan_status": "COMPLETE", "run_id": "run-1", "as_of_utc": "2026-09-11T12:00:00+00:00",
             "market_scan_result": {"candidates": [{"ticker": "XOM", "thesis": "Oil transmission"}]}}
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
    handoff = Mock()
    monkeypatch.setattr(cli, "run_analysis", handoff)
    monkeypatch.setattr(cli, "MarketAnalysisGraph", lambda **k: SimpleNamespace(scan=scan, save_reports=save, config=k["config"]))
    monkeypatch.setattr(cli, "Live", live)
    monkeypatch.setattr(cli, "get_market_selections", lambda: {})
    monkeypatch.setattr(cli, "_build_market_config", lambda _: {"results_dir": str(tmp_path)})
    answers = iter(["N", "Y", "XOM"])
    monkeypatch.setattr(cli.typer, "prompt", lambda *a, **k: next(answers))
    console = Console(file=StringIO(), record=True, width=120, height=40)
    monkeypatch.setattr(cli, "console", console)
    assert cli.run_market_scan(show_welcome=False) == state
    save.assert_called_once()
    assert save.call_args.args[0] == state
    run_dir = next((tmp_path / "market_scans").iterdir())
    for _, field in cli.MARKET_STAGES:
        assert (run_dir / cli.SCAN_REPORT_FILES[field]).read_text() == reports[field]
    assert handoff.call_args.kwargs["ticker"] == "XOM"
    assert "Oil transmission" in handoff.call_args.kwargs["market_context"]
    assert "run-1" in handoff.call_args.kwargs["market_context"]


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
