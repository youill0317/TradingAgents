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
