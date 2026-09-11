"""The market scan's data layer must not lie about what it found.

Three properties matter enough to pin down, all of them learned the hard way
from live responses:

1. Without an exchange filter, ``region=us`` surfaces OTC-quoted foreign ADRs
   that dominate any percent-change sort with illiquid noise.
2. Yahoo leaves every screener row's ``sector`` empty, so the only way to
   attribute a hit to a sector is to have asked for that sector.
3. The screener has no historical mode, so a past-dated scan is a present-day
   snapshot and must say so.
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

    def test_past_date_is_labelled_as_a_present_day_snapshot(self, captured_screens):
        result = ms.screen_equities(sector="Energy", curr_date="2024-05-10")
        assert "survivorship bias" in result.lower()
        assert "2024-05-10" in result

    def test_today_gets_no_warning(self, captured_screens, monkeypatch):
        today = ms.datetime.now().strftime("%Y-%m-%d")
        result = ms.screen_equities(sector="Energy", curr_date=today)
        assert "survivorship bias" not in result.lower()

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
        with pytest.raises(ms.NoMarketDataError) as exc:
            ms.screen_equities(sector="Technology")
        assert "no matches" in str(exc.value)


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
            dates = pd.date_range(end=curr_date, periods=10, freq="D")
            closes = list(range(100, 110)) if symbol == "XLE" else [100] * 10
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
            dates = pd.date_range(end=curr_date, periods=10, freq="D")
            return pd.DataFrame({"Date": dates, "Close": [100] * 10})

        monkeypatch.setattr(ms, "load_ohlcv", partial_load)
        with caplog.at_level("WARNING"):
            result = ms.get_sector_performance("2026-08-19")

        assert "n/a" in result
        # Silent degradation is the failure mode that matters here: a missing
        # sector must never be indistinguishable from a quiet one.
        assert any("XLU" in r.getMessage() for r in caplog.records)


class TestStrategistGrounding:
    """The shortlist is the one field a user is told to feed into ``analyze``.

    The prompt forbids inventing a symbol and caps the list, but prompts are
    not enforcement — the per-ticker schemas put their rating vocabularies in
    an Enum for the same reason.
    """

    @staticmethod
    def _report(tickers):
        from tradingagents.agents.schemas import MarketScanReport

        return MarketScanReport(
            regime="Rotation",
            regime_evidence="ev",
            sector_view="sv",
            candidates=[
                {"ticker": t, "sector": "Energy", "thesis": "t",
                 "conviction": "High"}
                for t in tickers
            ],
        )

    def test_a_ticker_absent_from_the_sector_report_is_dropped(self, caplog):
        from tradingagents.agents.managers.market_strategist import _ground_candidates

        report = self._report(["XOM", "FAKE1"])
        with caplog.at_level("WARNING"):
            grounded = _ground_candidates(report, "| XOM | Exxon |", limit=10)

        assert [c.ticker for c in grounded.candidates] == ["XOM"]
        # A dropped candidate must be visible, not silently vanish.
        assert any("FAKE1" in r.getMessage() for r in caplog.records)

    def test_the_candidate_limit_is_enforced_not_merely_requested(self):
        from tradingagents.agents.managers.market_strategist import _ground_candidates

        names = ["AAA", "BBB", "CCC", "DDD"]
        grounded = _ground_candidates(self._report(names), " ".join(names), limit=2)

        assert len(grounded.candidates) == 2

    def test_a_lowercase_or_padded_symbol_still_matches(self):
        """The schema normalises the symbol so grounding is not defeated by spacing."""
        from tradingagents.agents.managers.market_strategist import _ground_candidates

        grounded = _ground_candidates(self._report([" xom "]), "| XOM |", limit=10)

        assert [c.ticker for c in grounded.candidates] == ["XOM"]

    def test_grounding_never_raises_the_report_away(self):
        """A raising validator would cost the regime call too, so it must not raise."""
        from tradingagents.agents.managers.market_strategist import _ground_candidates

        grounded = _ground_candidates(self._report(["NOPE"]), "", limit=10)

        assert grounded.candidates == []
        assert grounded.regime_evidence == "ev", "the rest of the report survives"


class TestMarketGraph:
    """The scan graph reuses nodes built for the per-ticker workflow.

    That reuse is the risky seam: a shared node that reaches into the ticker
    state (``company_of_interest``) blows up only once the graph actually runs,
    which unit-testing the nodes in isolation never reveals.
    """

    @staticmethod
    def _build(tool_plan):
        from langchain_core.messages import AIMessage
        from langchain_core.runnables import RunnableLambda
        from langchain_core.tools import tool as _tool
        from langgraph.prebuilt import ToolNode

        from tradingagents.agents.schemas import MarketScanReport
        from tradingagents.graph.market_setup import MarketGraphSetup

        seen_prompts = []

        class _Stub:
            def __init__(self, name, plan=()):
                self.name, self.plan, self.turn = name, list(plan), 0

            def _respond(self, _prompt):
                self.turn += 1
                if self.turn == 1 and self.plan:
                    return AIMessage(content="", tool_calls=[
                        {"name": n, "args": a, "id": f"{self.name}-{i}"}
                        for i, (n, a) in enumerate(self.plan)
                    ])
                # Name the ticker the stub strategist returns: the real node
                # drops any candidate the Sector Analyst never mentioned.
                return AIMessage(
                    content=f"{self.name} report | XOM |", tool_calls=[]
                )

            def bind_tools(self, tools):
                return RunnableLambda(self._respond)

            def with_structured_output(self, schema):
                def _final(prompt):
                    seen_prompts.append(str(prompt))
                    return MarketScanReport(
                        regime="Rotation",
                        regime_evidence="ev",
                        sector_view="sv",
                        candidates=[{
                            "ticker": "XOM", "sector": "Energy",
                            "thesis": "t", "conviction": "High",
                        }],
                    )
                return RunnableLambda(_final)

        class _Quick:
            """Analysts re-bind tools every turn, so hand out macro then sector."""
            def __init__(self):
                self.stubs = [_Stub("Macro"), _Stub("Sector", tool_plan)]
                self.n = 0

            def bind_tools(self, tools):
                stub = self.stubs[min(self.n, len(self.stubs) - 1)]
                self.n += 1
                return stub.bind_tools(tools)

        @_tool
        def fake_sector_performance(curr_date: str) -> str:
            """Stubbed sector performance."""
            return "## sectors"

        nodes = {"macro": ToolNode([]), "sector": ToolNode([fake_sector_performance])}
        graph = MarketGraphSetup(_Quick(), _Stub("Strategist"), nodes).setup_graph().compile()
        return graph, seen_prompts

    def test_runs_end_to_end_without_a_ticker_in_state(self):
        """Regression: the shared message-clear node used to require a ticker."""
        graph, _ = self._build([("fake_sector_performance", {"curr_date": "2026-08-19"})])

        state = graph.invoke(
            {
                "messages": [("human", "Scan the market.")],
                "trade_date": "2026-08-19",
                "requested_sectors": ["Energy"],
                "candidate_limit": 5,
                "macro_report": "",
                "sector_report": "",
                "market_scan_report": "",
            },
            config={"recursion_limit": 30},
        )

        assert state["macro_report"], "macro report must reach the final state"
        assert state["sector_report"], "sector report must reach the final state"
        assert "XOM" in state["market_scan_report"]

    def test_strategist_receives_both_upstream_reports(self):
        """The synthesis is worthless if either report silently fails to arrive."""
        graph, prompts = self._build([])

        graph.invoke(
            {
                "messages": [("human", "Scan the market.")],
                "trade_date": "2026-08-19",
                "requested_sectors": [],
                "candidate_limit": 5,
                "macro_report": "",
                "sector_report": "",
                "market_scan_report": "",
            },
            config={"recursion_limit": 30},
        )

        assert prompts, "the strategist must be reached"
        assert "Macro report" in prompts[0]
        assert "Sector report" in prompts[0]


class TestMarketAnalysisGraphScan:
    """``scan()`` owns the initial-state contract: a missing key fails at runtime."""

    @staticmethod
    def _patched_graph(monkeypatch, tmp_path):
        from langchain_core.messages import AIMessage
        from langchain_core.runnables import RunnableLambda

        import tradingagents.graph.market_graph as mg
        from tradingagents.agents.schemas import MarketScanReport

        class _LLM:
            def bind_tools(self, tools):
                return RunnableLambda(
                    lambda _p: AIMessage(content="report", tool_calls=[])
                )

            def with_structured_output(self, schema):
                return RunnableLambda(lambda _p: MarketScanReport(
                    regime="Rotation",
                    regime_evidence="ev",
                    sector_view="sv",
                    candidates=[],
                ))

        class _Client:
            def __init__(self, *a, **k):
                pass

            def get_llm(self):
                return _LLM()

        monkeypatch.setattr(mg, "create_llm_client", _Client)

        # Pass the directories explicitly rather than via TRADINGAGENTS_* env
        # vars: DEFAULT_CONFIG is built at import time, so setting them here
        # would be a no-op and the test would quietly write to the real
        # ~/.tradingagents — passing on the author's machine and failing (or
        # polluting) anywhere else.
        from tradingagents.default_config import DEFAULT_CONFIG

        config = DEFAULT_CONFIG.copy()
        config["data_cache_dir"] = str(tmp_path / "cache")
        config["results_dir"] = str(tmp_path / "results")
        config["memory_log_path"] = str(tmp_path / "memory.md")
        return mg.MarketAnalysisGraph(config=config)

    def test_scan_fills_every_report_key(self, monkeypatch, tmp_path):
        graph = self._patched_graph(monkeypatch, tmp_path)

        state = graph.scan(trade_date="2026-08-19", sectors=["Energy"], candidate_limit=3)

        assert state["macro_report"]
        assert state["sector_report"]
        assert state["market_scan_report"]
        # Run parameters must survive into the state the analysts read.
        assert state["requested_sectors"] == ["Energy"]
        assert state["candidate_limit"] == 3

    def test_scan_calls_progress_callback_for_every_chunk(self, monkeypatch, tmp_path):
        graph = self._patched_graph(monkeypatch, tmp_path)
        chunks = [
            {
                "macro_report": "macro",
                "sector_report": "",
                "market_scan_report": "",
            },
            {
                "macro_report": "macro",
                "sector_report": "sector",
                "market_scan_report": "",
            },
            {
                "macro_report": "macro",
                "sector_report": "sector",
                "market_scan_report": "strategy",
            },
        ]

        class _StreamOnlyGraph:
            def stream(self, *args, **kwargs):
                yield from chunks

            def invoke(self, *args, **kwargs):
                raise AssertionError("a progress callback must use graph streaming")

        graph.graph = _StreamOnlyGraph()
        seen = []

        state = graph.scan(trade_date="2026-08-19", on_chunk=seen.append)

        assert seen == chunks
        assert state == chunks[-1]
        assert all(
            state[key]
            for key in ("macro_report", "sector_report", "market_scan_report")
        )

    def test_scan_defaults_to_today(self, monkeypatch, tmp_path):
        graph = self._patched_graph(monkeypatch, tmp_path)

        state = graph.scan()

        assert state["trade_date"] == ms.datetime.now().strftime("%Y-%m-%d")

    def test_scan_rejects_a_malformed_date(self, monkeypatch, tmp_path):
        graph = self._patched_graph(monkeypatch, tmp_path)

        with pytest.raises(ValueError):
            graph.scan(trade_date="19-08-2026")

    def test_save_reports_writes_the_tree(self, monkeypatch, tmp_path):
        graph = self._patched_graph(monkeypatch, tmp_path)
        state = graph.scan(trade_date="2026-08-19")

        complete = graph.save_reports(state, save_path=tmp_path / "out")

        assert complete.exists()
        written = {f.name for f in (tmp_path / "out").iterdir()}
        assert {"complete_report.md", "macro.md", "sector.md", "strategist.md"} <= written


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


def test_messages_panel_agent_column_is_market_only():
    from io import StringIO

    from rich.console import Console

    import cli.main as cli

    buffer = cli.MessageBuffer()
    buffer.add_tool_call(
        "screen_equities", {"sector": "Energy"}, agent="Sector Analyst"
    )

    def render(show_agent):
        console = Console(file=StringIO(), record=True, width=120)
        console.print(cli.create_messages_panel(buffer, show_agent=show_agent))
        return console.export_text()

    market_panel = render(True)
    ticker_panel = render(False)

    assert "Agent" in market_panel
    assert "Sector Analyst" in market_panel
    assert "Agent" not in ticker_panel
    assert "Sector Analyst" not in ticker_panel
    assert "screen_equities" in market_panel
    assert "screen_equities" in ticker_panel


def test_market_scan_wall_time_summary_reports_pending_before_any_stage_lands():
    import cli.main as cli

    assert cli.format_scan_wall_time({}) == "Scan wall time: pending"
    assert cli.format_scan_wall_time({"Macro Analyst": 1.5, "Market Strategist": 2.0}) == (
        "Scan wall time: Macro 1.50s | Market Strategist 2.00s"
    )


@pytest.mark.parametrize("display_full", [True, False], ids=["full", "final-only"])
def test_market_scan_routes_reports_out_of_messages_and_into_current_report(
    monkeypatch, tmp_path, display_full
):
    from io import StringIO
    from pathlib import Path

    from langchain_core.messages import AIMessage
    from rich.console import Console
    from rich.markdown import Markdown
    from rich.panel import Panel
    from rich.rule import Rule

    import cli.main as cli

    macro_report = "# Macro Report\nMACRO_REPORT_BODY"
    sector_report = "# Sector Report\nSECTOR_REPORT_BODY"
    market_report = "# Market Report\nMARKET_REPORT_BODY"
    chunks = (
        {
            "messages": [AIMessage(id="macro-report", content=macro_report)],
            "macro_report": macro_report,
            "sector_report": "",
            "market_scan_report": "",
        },
        {
            "messages": [
                AIMessage(
                    id="sector-tool",
                    content="",
                    tool_calls=[
                        {
                            "name": "screen_equities",
                            "args": {"sector": "Energy"},
                            "id": "sector-call",
                            "type": "tool_call",
                        }
                    ],
                )
            ],
            "macro_report": macro_report,
            "sector_report": "",
            "market_scan_report": "",
        },
        {
            "messages": [AIMessage(id="sector-report", content=sector_report)],
            "macro_report": macro_report,
            "sector_report": sector_report,
            "market_scan_report": "",
        },
        {
            "messages": [AIMessage(id="market-report", content=market_report)],
            "macro_report": macro_report,
            "sector_report": sector_report,
            "market_scan_report": market_report,
        },
    )
    captured = {"prompts": []}

    class _RecordingConsole(Console):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.renderables = []

        def print(self, *objects, **kwargs):
            self.renderables.extend(objects)
            return super().print(*objects, **kwargs)

    class _Graph:
        def __init__(self, *args, **kwargs):
            self.config = kwargs.get("config") or {"results_dir": str(tmp_path)}

        def scan(self, **kwargs):
            for chunk in chunks:
                kwargs["on_chunk"](chunk)
            return chunks[-1]

        def save_reports(self, final_state, save_path=None):
            captured["saved_state"] = final_state
            captured["save_path"] = save_path
            return Path(save_path) / "complete_report.md"

    class _Live:
        def __init__(self, renderable, **kwargs):
            captured["layout"] = renderable

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(cli, "MarketAnalysisGraph", _Graph)
    monkeypatch.setattr(cli, "Live", _Live)
    monkeypatch.setattr(cli, "get_market_selections", lambda: {})
    monkeypatch.setattr(
        cli, "_build_market_config", lambda selections: {"results_dir": str(tmp_path)}
    )
    # Accept every default, the way a user pressing Enter through the prompts would.
    def accept_default(text, default=None):
        captured["prompts"].append(text)
        if "Display full report" in text:
            return "Y" if display_full else "N"
        return default

    monkeypatch.setattr(cli.typer, "prompt", accept_default)
    monkeypatch.setattr(
        cli,
        "console",
        _RecordingConsole(file=StringIO(), record=True, width=120, height=40),
    )

    result = cli.run_market_scan(date="2026-08-22", show_welcome=False)

    def render(renderable):
        console = Console(file=StringIO(), record=True, width=120, height=40)
        console.print(renderable)
        return console.export_text()

    layout = captured["layout"]
    messages = render(layout["messages"].renderable)
    analysis = render(layout["analysis"].renderable)
    full_display = render(layout)

    assert result == chunks[-1]
    assert "MARKET_REPORT_BODY" in analysis
    assert "REPORT_BODY" not in messages
    assert "screen_equities" in messages
    assert "Agent" in messages
    assert "Sector Analyst" in messages
    assert "Market Strategist" in full_display
    assert "completed" in full_display
    assert "Market Strate…" not in full_display
    assert "complet…" not in full_display

    # The ticker workflow's footer, section heading, run banner and completion
    # line all have to show up here too, or the two screens stop matching.
    footer = render(layout["footer"].renderable)
    assert "Agents: 3/3" in footer
    assert "Reports: 3/3" in footer
    footer_fields = ("Agents:", "LLM:", "Tools:", "Tokens:", "Reports:", "⏱")
    assert [footer.index(field) for field in footer_fields] == sorted(
        footer.index(field) for field in footer_fields
    )
    assert analysis.index("Market Strategist") < analysis.index("MARKET_REPORT_BODY")
    assert "Scan date: 2026-08-22" in messages
    assert "Sectors: analyst's choice" in messages
    assert "Candidate limit: 10" in messages
    assert "Completed market scan for 2026-08-22" in messages
    # Nothing is still running once the scan returned, so no spinner row.
    assert "in_progress" not in full_display

    # The live trail under results_dir, so a crash mid-scan still leaves reports.
    run_dir = next((tmp_path / "market_scans").iterdir())
    log_text = (run_dir / "message_tool.log").read_text(encoding="utf-8")
    assert "[Tool Call] screen_equities(sector=Energy)" in log_text
    assert "[System] Scan date: 2026-08-22" in log_text
    assert "MACRO_REPORT_BODY" in (run_dir / "macro.md").read_text(encoding="utf-8")
    assert "SECTOR_REPORT_BODY" in (run_dir / "sector.md").read_text(encoding="utf-8")
    assert "MARKET_REPORT_BODY" in (run_dir / "strategist.md").read_text(encoding="utf-8")

    # Per-stage wall time and the ticker-matching save/display prompt order.
    assert "Scan wall time: Macro " in messages
    assert captured["saved_state"] == chunks[-1]
    assert Path(captured["save_path"]).name.startswith("market_scan_")
    printed = cli.console.export_text()
    assert "Scan wall time:" in printed
    assert "MARKET_REPORT_BODY" in printed
    assert "Final Market Scan Report" in printed
    assert "III. Market Strategist" in printed
    assert printed.index("Final Market Scan Report") < printed.index("Report saved to:")
    assert [prompt.strip() for prompt in captured["prompts"]] == [
        "Save report?",
        "Save path (press Enter for default)",
        "Display full report on screen?",
    ]

    rules = [item for item in cli.console.renderables if isinstance(item, Rule)]
    assert rules[0].title == "Final Market Scan Report"
    assert rules[0].style == "bold green"

    if display_full:
        assert "MACRO_REPORT_BODY" in printed
        assert "SECTOR_REPORT_BODY" in printed
        assert "Complete Market Scan Report" in printed
        assert printed.index("Report saved to:") < printed.index(
            "Complete Market Scan Report"
        )
        assert [item.title for item in rules] == [
            "Final Market Scan Report",
            "Complete Market Scan Report",
        ]
    else:
        assert "MACRO_REPORT_BODY" not in printed
        assert "SECTOR_REPORT_BODY" not in printed
        assert "Complete Market Scan Report" not in printed
        assert [item.title for item in rules] == ["Final Market Scan Report"]

    section_panels = [
        item
        for item in cli.console.renderables
        if isinstance(item, Panel)
        and isinstance(item.renderable, str)
        and item.renderable.startswith("[bold]")
    ]
    expected_section_colors = ["green", "cyan", "magenta", "green"]
    assert [item.border_style for item in section_panels] == expected_section_colors[
        : 4 if display_full else 1
    ]

    report_panels = [
        item
        for item in cli.console.renderables
        if isinstance(item, Panel)
        and item.title in ("Macro Analyst", "Sector Analyst", "Market Strategist")
    ]
    expected_agents = [
        "Market Strategist",
        "Macro Analyst",
        "Sector Analyst",
        "Market Strategist",
    ]
    assert [item.title for item in report_panels] == expected_agents[
        : 4 if display_full else 1
    ]
    assert all(isinstance(item.renderable, Markdown) for item in report_panels)
    assert all(item.border_style == "blue" for item in report_panels)
    assert all(item.padding == (1, 2) for item in report_panels)
