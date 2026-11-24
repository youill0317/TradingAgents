"""The market workflow end to end, offline: the same steps as the ticker workflow.

Analysts gather data with tools as of the run's date, the research debate and
the risk debate run the configured rounds, the final call is typed or read back
from text, and the memory log settles, reflects on and reads back past verdicts.
"""
import json
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableLambda

import tradingagents.llm_clients.factory as factory
import tradingagents.market.analysts as market_analysts
import tradingagents.market.tools as market_tools
from tradingagents.agents.schemas import SentimentReport
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.market import MarketAnalysisGraph
from tradingagents.market.schemas import SECTORS, MarketCall

FIRST_TOOL = ("get_regional_macro", "get_market_internals", "get_sector_performance", "get_economic_calendar")
SENTIMENT = SentimentReport(overall_band="Mildly Bearish", overall_score=4.0, confidence="low",
                            narrative="CROWD MOOD: anxious; VIX elevated")


def _call(**overrides):
    verdicts = [{"sector": s, "outlook": "Bullish" if s == "Energy" else "Neutral", "conviction": "Medium",
                 "rationale": f"{s} figures", "invalidation": "Trend reverses"} for s in SECTORS]
    return MarketCall(**{"regime": "Rotation", "regime_evidence": "Oil up, breadth narrow",
                         "sector_verdicts": verdicts, "summary": "Summary text", **overrides})


class FakeModel:
    def __init__(self, log, structured=True, final_text=""):
        self.log, self.structured, self.final_text = log, structured, final_text

    def bind_tools(self, tools):
        names = {t.name for t in tools}

        def answer(prompt):
            messages = prompt.to_messages() if hasattr(prompt, "to_messages") else prompt
            if not any(getattr(m, "type", "") == "tool" for m in messages):
                tool = next(n for n in FIRST_TOOL if n in names)
                return AIMessage(content="", tool_calls=[{"name": tool, "args": {"curr_date": "2099-01-01"},
                                                          "id": tool}])
            return AIMessage(content=f"REPORT from {sorted(names)}")
        return RunnableLambda(answer)

    def invoke(self, prompt):
        text = str(prompt)
        self.log.append(text)
        if "Chief Market Strategist" in text:
            return AIMessage(content=self.final_text)
        return AIMessage(content="argument")

    def with_structured_output(self, schema):
        if not self.structured:
            raise NotImplementedError

        def run(prompt):
            self.log.append(str(prompt))
            return SENTIMENT if schema is SentimentReport else _call()
        return RunnableLambda(run)


@pytest.fixture
def offline(monkeypatch, tmp_path):
    dates = []

    def record(name, value):
        def fn(date, *a):
            dates.append((name, date))
            return value
        return fn

    monkeypatch.setattr(market_tools, "get_regional_macro_report", record("macro", "MACRO DATA"))
    monkeypatch.setattr(market_tools, "collect_market_diagnostics",
                        lambda d: dates.append(("internals", d)) or {"internals_report": "INTERNALS"})
    monkeypatch.setattr(market_analysts, "collect_market_sentiment", lambda d: dates.append(("sentiment", d)) or {
        "start_date": "2024-03-08", "end_date": d, "vix": "VIX 18", "stocktwits": "TWITS", "reddit": "POSTS"})
    monkeypatch.setattr(market_tools, "collect_market_events", lambda d: dates.append(("events", d)) or {"report": "EVENTS"})
    monkeypatch.setattr(market_tools, "_sector_performance", record("sector", "SECTOR DATA"))
    config = {**DEFAULT_CONFIG, "results_dir": str(tmp_path / "results"), "data_cache_dir": str(tmp_path / "cache"),
              "memory_log_path": str(tmp_path / "memory" / "trading_memory.md"), "llm_provider": "openai",
              "quick_think_llm": "q", "deep_think_llm": "d"}
    return config, dates


def _graph(monkeypatch, config, model, **kwargs):
    class Client:
        def get_llm(self):
            return model
    monkeypatch.setattr(factory, "create_llm_client", lambda **k: Client())
    return MarketAnalysisGraph(config=config, **kwargs)


@pytest.mark.parametrize("debate,risk", [(1, 1), (2, 3)])
def test_a_past_dated_run_follows_the_ticker_workflow(monkeypatch, offline, debate, risk):
    config, dates = offline
    log = []
    graph = _graph(monkeypatch, {**config, "max_debate_rounds": debate, "max_risk_discuss_rounds": risk},
                   FakeModel(log))
    state, call = graph.propagate("2024-03-15")

    # Every analyst gathered its own data, served as of the run's date though the model asked for 2099.
    assert {name for name, _ in dates} == {"macro", "internals", "events", "sentiment", "sector"}
    assert {date for _, date in dates} == {"2024-03-15"}
    for key in ("macro_report", "market_report", "news_report", "sector_report"):
        assert state[key].startswith("REPORT")
    # The sentiment analyst takes its sources up front and answers in the ticker workflow's structured form.
    assert state["sentiment_report"].startswith("**Overall Sentiment:** **Mildly Bearish**")
    assert any("VIX 18" in p and "TWITS" in p for p in log)
    assert any("CROWD MOOD" in p for p in log if p.startswith("You are the Bull Analyst"))

    assert state["investment_debate_state"]["count"] == 2 * debate
    assert state["risk_debate_state"]["count"] == 3 * risk
    speakers = [line.split(":")[0] for line in state["risk_debate_state"]["history"].strip().splitlines()]
    assert speakers == ["Aggressive Analyst", "Conservative Analyst", "Neutral Analyst"] * risk

    assert call["regime"] == "Rotation"
    assert call["sector_ratings"]["Energy"] == "Bullish"
    assert set(call["sector_ratings"]) == set(SECTORS)
    assert "**Market Regime**: Rotation" in state["final_market_decision"]

    # One call is one record: the regime, every sector's verdict against SPY and its conviction, pending.
    (record,) = graph.memory_log.load()
    assert record["date"] == "2024-03-15" and record["pending"] and record["regime"] == "Rotation"
    assert record["sectors"]["Energy"] == {"outlook": "Bullish", "conviction": "Medium"}
    assert record["days"] == 10 and "Energy figures" in record["decision"]
    saved = json.loads((Path(config["results_dir"]) / "MARKET" / "MarketAnalysis_logs"
                        / "full_states_log_2024-03-15.json").read_text())
    assert saved["regime"] == "Rotation" and saved["sector_convictions"]["Energy"] == "Medium"
    # A second run of the same date records nothing more.
    graph.record_decision("2024-03-15", state)
    assert len(graph.memory_log.load()) == 1


def test_every_manager_is_told_what_the_call_claims_over_the_scored_horizon(monkeypatch, offline):
    config, _ = offline
    log = []
    graph = _graph(monkeypatch, {**config, "market_holding_period_days": 15}, FakeModel(log))
    graph.propagate("2024-03-15")
    for manager in ("Market Research Manager", "Sector Strategist", "Chief Market Strategist"):
        prompt = next(p for p in log if manager in p[:400])
        assert "next 15 trading days" in prompt
        assert "RELATIVE TO SPY" in prompt and "Rotation: the sectors' returns diverge more than usual" in prompt
    assert any("over the next 15 trading days" in p for p in log if p.startswith("You are the Bull Analyst"))
    assert graph.memory_log.load()[0]["days"] == 15, "the call is scored over the horizon it was made for"


def test_without_structured_output_the_call_is_read_from_text(monkeypatch, offline):
    config, _ = offline
    text = "**Market Regime**: Risk-Off\n" + "\n".join(
        f"{s}: {'Bearish' if s == 'Technology' else 'Neutral'} (Low conviction) — reason" for s in SECTORS[:-1])
    graph = _graph(monkeypatch, config, FakeModel([], structured=False, final_text=text))
    state, call = graph.propagate("2024-03-15")
    assert call["regime"] == "Risk-Off"
    assert call["sector_ratings"]["Technology"] == "Bearish"
    assert call["sector_convictions"]["Technology"] == "Low"
    assert call["sector_ratings"][SECTORS[-1]] == "REVIEW", "a sector the text never rated is not guessed"
    assert graph.memory_log.load()[0]["sectors"][SECTORS[-1]] == {"outlook": "REVIEW", "conviction": ""}


def _pending_call(graph, date="2024-01-02"):
    sectors = dict.fromkeys(SECTORS, {"outlook": "Neutral", "conviction": "Low"})
    sectors |= {"Energy": {"outlook": "Bullish", "conviction": "High"},
                "Technology": {"outlook": "Bearish", "conviction": "Medium"}}
    graph.memory_log.store_call(date, "Risk-On", sectors, "THE CALL AS MADE", 5)


def test_a_settled_call_is_scored_reflected_on_once_and_reaches_the_final_call(monkeypatch, offline):
    import tradingagents.market.memory as memory
    from tests.test_market_scoring import _prices

    config, _ = offline
    log, reflections = [], []
    graph = _graph(monkeypatch, config, FakeModel(log))
    _pending_call(graph)
    monkeypatch.setattr(memory, "fetch_prices", lambda date, days: _prices({"Energy": 0.003, "Technology": -0.002}))

    def reflect(self, messages):
        reflections.append(messages)
        return AIMessage(content="LESSON: energy leadership held")
    graph.reflector.quick_thinking_llm = type("R", (), {"invoke": reflect})()

    state, _ = graph.propagate("2024-03-15")

    settled = next(r for r in graph.memory_log.load() if r["date"] == "2024-01-02")
    assert not settled["pending"] and settled["resolved"] == "2024-01-10"
    card = settled["scorecard"]
    assert card["sectors"]["Energy"]["hit"] is True and card["sectors"]["Technology"]["hit"] is True
    assert card["sectors"]["Utilities"]["hit"] is None
    assert card["spread"] > 0 and card["regime"]["called"] == "Risk-On"
    # One reflection for the whole call, shown the scorecard and the call together.
    assert len(reflections) == 1
    shown = reflections[0][1][1]
    assert "Regime called: Risk-On" in shown and "- Energy: Bullish (High)" in shown and "THE CALL AS MADE" in shown
    # The final decision-maker of the later run reads the scorecard and the lesson.
    assert "LESSON: energy leadership held" in state["past_context"]
    assert "Regime called: Risk-On" in state["past_context"]
    assert any("Chief Market Strategist" in p[:400] and "LESSON: energy leadership held" in p for p in log)
    # The run's own call stays pending until its window has traded.
    assert graph.scorecard().settled == 1 and graph.scorecard().pending == 1


def test_a_call_stays_pending_until_its_window_trades_or_when_settling_fails(monkeypatch, offline):
    import tradingagents.market.memory as memory
    from tests.test_market_scoring import _prices

    config, _ = offline
    graph = _graph(monkeypatch, config, FakeModel([]))
    _pending_call(graph)

    monkeypatch.setattr(memory, "fetch_prices", lambda date, days: None)   # the window cannot have traded
    done = graph.settle_all_pending()
    assert (done.settled, done.failed) == ([], []) and len(graph.memory_log.pending()) == 1

    def offline_prices(date, days):
        raise OSError("no network")
    monkeypatch.setattr(memory, "fetch_prices", offline_prices)
    done = graph.settle_all_pending()
    assert done.failed[0][:2] == ("MARKET", "2024-01-02") and len(graph.memory_log.pending()) == 1
    assert "could not be settled" in graph._memory_step({"trade_date": "2024-03-15"})["memory_note"]

    monkeypatch.setattr(memory, "fetch_prices", lambda date, days: _prices())

    def broken(self, messages):
        raise RuntimeError("provider down")
    graph.reflector.quick_thinking_llm = type("R", (), {"invoke": broken})()
    done = graph.settle_all_pending()
    assert "reflection failed" in done.failed[0][2] and len(graph.memory_log.pending()) == 1


def test_lessons_not_known_by_a_past_date_stay_out(monkeypatch, offline):
    import tradingagents.market.memory as memory
    from tests.test_market_scoring import _prices

    config, _ = offline
    graph = _graph(monkeypatch, config, FakeModel([]))
    _pending_call(graph, "2024-03-01")
    monkeypatch.setattr(memory, "fetch_prices", lambda date, days: _prices())
    graph.reflector.quick_thinking_llm = type("R", (), {"invoke": lambda self, m: AIMessage(content="LATER LESSON")})()
    graph.settle_all_pending()
    assert graph.memory_log.load()[0]["resolved"] == "2024-03-11"
    assert graph.memory_log.past_context(as_of="2024-03-08") == ""
    assert "LATER LESSON" in graph.memory_log.past_context(as_of="2024-03-11")
    assert "LATER LESSON" in graph.memory_log.past_context()


def test_future_dates_and_unknown_analysts_are_refused(monkeypatch, offline):
    config, _ = offline
    graph = _graph(monkeypatch, config, FakeModel([]))
    with pytest.raises(ValueError, match="future"):
        graph.propagate("2999-01-01")
    with pytest.raises(ValueError, match="unknown market analyst"):
        _graph(monkeypatch, config, FakeModel([]), selected_analysts=("crypto",))


def test_checkpoint_signature_keys_on_rounds_and_analysts(monkeypatch, offline):
    config, _ = offline
    a = _graph(monkeypatch, config, FakeModel([]))
    b = _graph(monkeypatch, {**config, "max_debate_rounds": 3}, FakeModel([]))
    c = _graph(monkeypatch, config, FakeModel([]), selected_analysts=("macro", "sector"))
    sigs = {g._run_signature("market") for g in (a, b, c)}
    assert len(sigs) == 3


def test_report_tree(monkeypatch, offline, tmp_path):
    config, _ = offline
    graph = _graph(monkeypatch, config, FakeModel([]))
    state, _ = graph.propagate("2024-03-15")
    out = tmp_path / "report"
    graph.save_reports(state, out)
    assert (out / "1_analysts" / "sector.md").exists()
    assert (out / "4_risk" / "neutral.md").exists()
    assert (out / "5_decision" / "decision.md").exists()
    assert (out / "complete_report.html").exists()
    saved_call = json.loads((out / "market_call.json").read_text())
    assert saved_call["sector_ratings"]["Energy"] == "Bullish" and saved_call["sector_convictions"]["Energy"] == "Medium"
    assert "Market regime: Rotation" in (out / "complete_report.md").read_text()
