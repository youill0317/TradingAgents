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

    def test_rejects_an_unknown_sector(self):
        with pytest.raises(ValueError) as exc:
            ms.screen_equities(sector="Tech Stuff")
        # The error has to teach the caller the vocabulary, not just say "no".
        assert "Technology" in str(exc.value)

    def test_past_date_fails_closed(self, captured_screens):
        with pytest.raises(ValueError, match="UNSUPPORTED_HISTORICAL_UNIVERSE"):
            ms.screen_equities(sector="Energy", curr_date="2024-05-10")
        assert captured_screens == []

    @pytest.mark.parametrize("limit", [0, -1, 101])
    def test_rejects_out_of_range_limit(self, limit):
        with pytest.raises(ValueError, match="limit must be between"):
            ms.screen_equities(sector="Energy", limit=limit)

    @pytest.mark.parametrize("value", [float("nan"), float("inf"), -1])
    def test_rejects_invalid_numeric_filters(self, value):
        with pytest.raises(ValueError, match="finite non-negative"):
            ms.screen_equities(sector="Energy", min_volume=value)

    def test_rejects_unknown_sort_field(self):
        with pytest.raises(ValueError, match="sort_field"):
            ms.screen_equities(sector="Energy", sort_field="marketCap;drop")

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
    def test_covers_every_sector_etf_and_the_benchmarks(self, monkeypatch):
        requested = []

        def fake_load(symbol, curr_date):
            requested.append(symbol)
            dates = pd.date_range(end=curr_date, periods=40, freq="D")
            return pd.DataFrame({"Date": dates, "Close": range(100, 140)})

        monkeypatch.setattr(ms, "load_ohlcv", fake_load)
        result = ms.get_sector_performance("2026-08-19")

        assert set(ms.SECTOR_ETFS.values()) <= set(requested)
        assert set(ms.BENCHMARKS) <= set(requested)
        for sector in ms.SECTOR_ETFS:
            assert sector in result

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


def test_market_scan_message_panel_survives_graph_message_clears():
    from langchain_core.messages import AIMessage, HumanMessage
    from rich.console import Console

    import cli.main as cli

    macro = AIMessage(
        id="macro-message",
        content="Checking inflation and rates.",
        tool_calls=[
            {
                "name": "get_fred_indicators",
                "args": {"series": "FEDFUNDS"},
                "id": "macro-call",
                "type": "tool_call",
            }
        ],
    )
    placeholder = HumanMessage(id="macro-cleared", content="Proceed to sector analysis.")
    sector = AIMessage(
        id="sector-message",
        content="Screening the Energy sector.",
        tool_calls=[
            {
                "name": "screen_equities",
                "args": {"sector": "Energy"},
                "id": "sector-call",
                "type": "tool_call",
            }
        ],
    )
    chunks = (
        {"messages": [macro]},
        {"messages": [macro]},  # values mode repeats the full current state
        {"messages": [placeholder]},  # Msg Clear Macro removed the old history
        {"messages": [placeholder, sector]},
    )

    buffer = cli.MessageBuffer()
    for chunk in chunks:
        cli.accumulate_stream_messages(buffer, chunk)

    rendered = Console(record=True, width=160)
    rendered.print(cli.create_messages_panel(buffer))
    output = rendered.export_text()

    assert output.count("get_fred_indicators") == 1
    assert output.count("screen_equities") == 1
    assert "Checking inflation and rates." in output
    assert "Screening the Energy sector." in output


@pytest.mark.parametrize("display_full", [True, False])
def test_cli_streams_reports_and_saves_even_without_optional_export(monkeypatch, tmp_path, display_full):
    from contextlib import nullcontext
    from io import StringIO
    from types import SimpleNamespace
    from unittest.mock import Mock

    from langchain_core.messages import AIMessage
    from rich.console import Console

    import cli.main as cli

    reports = {"macro_report": "MACRO_BODY", "sector_report": "SECTOR_BODY", "market_scan_report": "FINAL_BODY"}
    state = {"scan_status": "COMPLETE"}
    layouts = []

    def scan(**kwargs):
        for key, content in reports.items():
            state.update({key: content, "messages": [AIMessage(content=content)]})
            kwargs["on_chunk"](state.copy())
        return state

    save = Mock(return_value=tmp_path / "complete_report.md")
    monkeypatch.setattr(cli, "MarketAnalysisGraph", lambda **k: SimpleNamespace(scan=scan, save_reports=save, config=k["config"]))
    monkeypatch.setattr(cli, "Live", lambda layout, **k: layouts.append(layout) or nullcontext())
    monkeypatch.setattr(cli, "get_market_selections", lambda: {})
    monkeypatch.setattr(cli, "_build_market_config", lambda _: {"results_dir": str(tmp_path)})
    monkeypatch.setattr(cli.typer, "prompt", lambda text, default=None:
                        ("Y" if display_full else "N") if "Display full report" in text else "N")
    console = Console(file=StringIO(), record=True, width=120)
    monkeypatch.setattr(cli, "console", console)
    assert cli.run_market_scan(show_welcome=False) == state
    save.assert_called_once()
    assert save.call_args.args[0] == state
    run_dir = next((tmp_path / "market_scans").iterdir())
    assert (run_dir / "macro.md").read_text(encoding="utf-8") == "MACRO_BODY"
    assert (run_dir / "sector.md").read_text(encoding="utf-8") == "SECTOR_BODY"
    assert (run_dir / "strategist.md").read_text(encoding="utf-8") == "FINAL_BODY"
    output = console.export_text(clear=True)
    assert "FINAL_BODY" in output
    assert ("MACRO_BODY" in output) == display_full
    assert ("SECTOR_BODY" in output) == display_full
    console.print(layouts[0]["messages"].renderable)
    assert "_BODY" not in console.export_text(clear=True)
    console.print(layouts[0]["analysis"].renderable)
    assert "FINAL_BODY" in console.export_text()


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
