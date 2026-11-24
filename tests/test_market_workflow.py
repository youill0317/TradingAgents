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
import tradingagents.market.tools as market_tools
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.market import MarketAnalysisGraph
from tradingagents.market.schemas import SECTORS, MarketCall

FIRST_TOOL = ("get_regional_macro", "get_global_asset_returns", "get_sector_performance", "get_economic_calendar")


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
            return _call()
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
    monkeypatch.setattr(market_tools, "get_global_asset_report", record("global", "ASSET DATA"))
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
    assert {name for name, _ in dates} == {"macro", "global", "events", "sector"}
    assert {date for _, date in dates} == {"2024-03-15"}
    for key in ("macro_report", "global_report", "news_report", "sector_report"):
        assert state[key].startswith("REPORT")

    assert state["investment_debate_state"]["count"] == 2 * debate
    assert state["risk_debate_state"]["count"] == 3 * risk
    speakers = [line.split(":")[0] for line in state["risk_debate_state"]["history"].strip().splitlines()]
    assert speakers == ["Aggressive Analyst", "Conservative Analyst", "Neutral Analyst"] * risk

    assert call["regime"] == "Rotation"
    assert call["sector_ratings"]["Energy"] == "Bullish"
    assert set(call["sector_ratings"]) == set(SECTORS)
    assert "**Market Regime**: Rotation" in state["final_market_decision"]

    entries = graph.memory_log.load_entries()
    assert len(entries) == len(SECTORS)
    energy = next(e for e in entries if e["ticker"] == "XLE")
    assert energy["rating"] == "Bullish" and energy["pending"] and energy["date"] == "2024-03-15"
    assert "Energy figures" in energy["decision"]
    saved = json.loads((Path(config["results_dir"]) / "MARKET" / "MarketAnalysis_logs"
                        / "full_states_log_2024-03-15.json").read_text())
    assert saved["regime"] == "Rotation"


def test_without_structured_output_the_call_is_read_from_text(monkeypatch, offline):
    config, _ = offline
    text = "**Market Regime**: Risk-Off\n" + "\n".join(
        f"{s}: {'Bearish' if s == 'Technology' else 'Neutral'} (Low conviction) — reason" for s in SECTORS[:-1])
    graph = _graph(monkeypatch, config, FakeModel([], structured=False, final_text=text))
    state, call = graph.propagate("2024-03-15")
    assert call["regime"] == "Risk-Off"
    assert call["sector_ratings"]["Technology"] == "Bearish"
    assert call["sector_ratings"][SECTORS[-1]] == "REVIEW", "a sector the text never rated is not guessed"
    assert len(graph.memory_log.load_entries()) == len(SECTORS) - 1


def test_settled_verdicts_are_reflected_on_and_reach_the_final_call(monkeypatch, offline):
    import tradingagents.memory.settlement as settlement

    config, _ = offline
    log = []
    graph = _graph(monkeypatch, config, FakeModel(log))
    graph.memory_log.store_decision("XLE", "2024-01-02", "Verdict: Bullish", rating="Bullish")
    monkeypatch.setattr(settlement, "fetch_returns", lambda *a, **k: (0.05, 0.02, 5, "2024-01-10"))
    graph.reflector.quick_thinking_llm = type("R", (), {"invoke": lambda self, m: AIMessage(content="LESSON: oil held")})()

    state, _ = graph.propagate("2024-03-15")

    settled = next(e for e in graph.memory_log.load_entries() if e["date"] == "2024-01-02")
    assert not settled["pending"] and settled["reflection"] == "LESSON: oil held"
    assert "LESSON: oil held" in state["past_context"]
    assert any("Chief Market Strategist" in p and "LESSON: oil held" in p for p in log)


def test_lessons_not_known_by_a_past_date_stay_out(monkeypatch, offline):
    config, _ = offline
    graph = _graph(monkeypatch, config, FakeModel([]))
    graph.memory_log.store_decision("XLE", "2024-01-02", "Verdict: Bullish", rating="Bullish")
    graph.memory_log.update_with_outcome("XLE", "2024-01-02", 0.05, 0.02, 5, "LATER LESSON",
                                         resolution_date="2024-06-01")
    assert graph._memory_step({"trade_date": "2024-03-15"})["past_context"] == ""
    assert "LATER LESSON" in graph._memory_step({"trade_date": "2024-07-01"})["past_context"]


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
    assert json.loads((out / "market_call.json").read_text())["sector_ratings"]["Energy"] == "Bullish"
    assert "Market regime: Rotation" in (out / "complete_report.md").read_text()
