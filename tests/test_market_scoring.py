"""A market call is scored against what it claims: the regime's observable claim, and each
sector's performance relative to SPY, over the window the ticker settlement would use."""
import numpy as np
import pandas as pd
import pytest

import tradingagents.memory.settlement as settlement
from tradingagents.dataflows.market_scan import SECTOR_ETFS
from tradingagents.market import scoring
from tradingagents.market.scoring import measure_outcome, regimes_held, score_call, summarize_market

SECTORS = list(SECTOR_ETFS)
TRADE_DATE = "2024-03-15"   # a Friday


def _prices(drifts=None, spy_drift=0.0004, end="2024-04-30"):
    """Deterministic closes: SPY and each ETF on a steady drift plus a small wobble."""
    days = pd.bdate_range("2022-12-01", end)
    steps = np.arange(len(days))
    frame = {"SPY": 400 * np.exp(spy_drift * steps + 0.004 * np.sin(steps / 3))}
    for i, (name, etf) in enumerate(SECTOR_ETFS.items()):
        drift = (drifts or {}).get(name, spy_drift)
        frame[etf] = 50 * np.exp(drift * steps + 0.004 * np.sin(steps / 3 + i))
    return pd.DataFrame(frame, index=days)


def test_window_is_the_one_the_ticker_settlement_scores(monkeypatch):
    prices = _prices({"Energy": 0.002})
    outcome = measure_outcome(prices, TRADE_DATE, 5)
    assert outcome["entry"] == "2024-03-18", "the first close after the call's date"
    assert outcome["exit"] == "2024-03-25", "five sessions later"

    # The same closes through the ticker workflow's own settlement give the same figures.
    monkeypatch.setattr(settlement, "get_closes",
                        lambda symbol, start, end: prices[symbol][(prices.index >= start) & (prices.index < end)])
    monkeypatch.setattr(settlement, "_now", lambda: pd.Timestamp("2024-05-15", tz="UTC"))
    raw, alpha, days, resolved = settlement.fetch_returns("XLE", TRADE_DATE, 5, benchmark="SPY")
    assert outcome["sectors"]["Energy"]["raw"] == pytest.approx(raw)
    assert outcome["sectors"]["Energy"]["alpha"] == pytest.approx(alpha)
    assert (outcome["days"], outcome["exit"]) == (days, resolved)


def test_a_window_that_has_not_traded_is_not_scored():
    assert measure_outcome(_prices(end="2024-03-22"), TRADE_DATE, 5) is None
    assert measure_outcome(_prices(end="2024-03-25"), TRADE_DATE, 5) is not None


def test_thresholds_use_only_the_year_before_the_call():
    calm, wild = _prices(), _prices()
    wild.loc[wild.index > TRADE_DATE] *= np.linspace(1, 3, (wild.index > TRADE_DATE).sum())[:, None]
    before, after = measure_outcome(calm, TRADE_DATE, 5), measure_outcome(wild, TRADE_DATE, 5)
    assert before["thresholds"] == after["thresholds"], "what came after the call cannot move its thresholds"
    assert all(v > 0 for v in before["thresholds"].values())
    assert after["spy_return"] > before["spy_return"]


def test_too_little_history_leaves_the_regime_unscored():
    prices = _prices().loc["2024-02-15":]
    outcome = measure_outcome(prices, TRADE_DATE, 5)
    assert outcome["thresholds"] is None
    assert set(regimes_held(outcome).values()) == {None}
    card = score_call("Risk-On", {}, outcome)
    assert card["regime"]["hit"] is None


THRESHOLDS = {"ordinary_move": 0.01, "usual_dispersion": 0.02, "deep_drawdown": 0.04}


@pytest.mark.parametrize("spy,drawdown,dispersion,held", [
    (0.03, 0.00, 0.01, {"Risk-On"}),
    (-0.03, 0.03, 0.01, {"Risk-Off"}),
    (-0.06, 0.07, 0.01, {"Risk-Off", "Stressed"}),
    (0.03, 0.00, 0.05, {"Risk-On", "Rotation"}),          # the index can rise while leadership turns over
    (0.005, 0.01, 0.05, {"Rotation"}),
    (0.005, 0.01, 0.01, {"Range-Bound"}),
    (-0.01, 0.01, 0.02, {"Range-Bound"}),                 # the bounds themselves are ordinary
])
def test_each_regime_is_checked_against_its_own_claim(spy, drawdown, dispersion, held):
    outcome = {"spy_return": spy, "max_drawdown": drawdown, "dispersion": dispersion, "thresholds": THRESHOLDS}
    assert {r for r, ok in regimes_held(outcome).items() if ok} == held


def _outcome(alphas, spy=0.02):
    return {"entry": "2024-03-18", "exit": "2024-03-25", "days": 5, "spy_return": spy, "max_drawdown": 0.0,
            "dispersion": 0.01, "thresholds": THRESHOLDS,
            "sectors": {name: None if a is None else {"raw": spy + a, "alpha": a} for name, a in alphas.items()}}


def test_sector_verdicts_are_scored_against_spy_not_against_zero():
    calls = dict.fromkeys(SECTORS, {"outlook": "Neutral", "conviction": "Low"})
    calls |= {"Energy": {"outlook": "Bullish", "conviction": "High"},
              "Technology": {"outlook": "Bearish", "conviction": "Medium"},
              "Utilities": {"outlook": "Bullish", "conviction": "Low"},
              "Real Estate": {"outlook": "REVIEW", "conviction": ""}}
    alphas = dict.fromkeys(SECTORS, 0.01) | {"Energy": 0.03, "Technology": -0.02, "Utilities": -0.01,
                                              "Healthcare": None}
    # In a market down 5%, Energy fell 2%: it beat SPY, so Bullish is a hit.
    card = score_call("Risk-Off", calls, _outcome(alphas, spy=-0.05))
    rows = card["sectors"]
    assert rows["Energy"]["raw"] == pytest.approx(-0.02) and rows["Energy"]["hit"] is True
    assert rows["Technology"]["hit"] is True, "Bearish hits when the sector trails SPY"
    assert rows["Utilities"]["hit"] is False
    assert rows["Financial Services"]["hit"] is None, "Neutral claims no direction"
    assert rows["Real Estate"]["hit"] is None and rows["Healthcare"]["hit"] is None
    assert card["bullish_alpha"] == pytest.approx(0.01) and card["bearish_alpha"] == pytest.approx(-0.02)
    assert card["spread"] == pytest.approx(0.03)
    assert card["neutral_miss"] == pytest.approx(0.01), "what the uncalled sectors did against SPY"
    assert card["regime"] == {"called": "Risk-Off", "hit": True, "held": ["Risk-Off"]}
    text = scoring.render_scorecard(card, _outcome(alphas, spy=-0.05))
    assert "Regime called: Risk-Off -> HIT" in text
    assert "- Energy: Bullish (High) -> alpha +3.0%, return -2.0%: HIT" in text


def test_a_one_sided_call_has_no_spread():
    calls = dict.fromkeys(SECTORS, {"outlook": "Bullish", "conviction": "High"})
    card = score_call("Risk-On", calls, _outcome(dict.fromkeys(SECTORS, 0.0)))
    assert card["spread"] is None and card["bearish_alpha"] is None


def _record(date, regime, regime_hit, energy):
    outlook, alpha = energy
    calls = dict.fromkeys(SECTORS, {"outlook": "Neutral", "conviction": ""})
    calls |= {"Energy": {"outlook": outlook, "conviction": "High"},
              "Technology": {"outlook": "Bearish", "conviction": "Low"}}
    outcome = _outcome(dict.fromkeys(SECTORS, 0.0) | {"Energy": alpha, "Technology": -0.01},
                       spy=0.03 if regime_hit == (regime == "Risk-On") else -0.03)
    return {"date": date, "regime": regime, "pending": False, "outcome": outcome,
            "scorecard": score_call(regime, calls, outcome)}


def test_summary_scores_regimes_and_verdicts_and_leaves_neutral_unscored():
    records = [_record("2024-03-01", "Risk-On", True, ("Bullish", 0.02)),
               _record("2024-03-08", "Risk-On", False, ("Bullish", -0.01)),
               _record("2024-03-15", "Risk-Off", True, ("Bearish", -0.03)),
               {"date": "2024-03-22", "regime": "Rotation", "pending": True}]
    summary = summarize_market(records)
    assert (summary.settled, summary.pending) == (3, 1)
    assert summary.regime.hit_rate == pytest.approx(2 / 3)
    assert summary.by_regime["Risk-On"].hit_rate == 0.5
    assert summary.by_outlook["Bullish"].hit_rate == 0.5
    assert summary.by_outlook["Bearish"].hit_rate == 1.0 and summary.by_outlook["Bearish"].count == 4
    assert summary.by_outlook["Neutral"].hit_rate is None and summary.by_outlook["Neutral"].count == 27
    assert summary.by_conviction["High"].hits == 2 and summary.by_conviction["Low"].hit_rate == 1.0
    assert summary.by_sector["Energy"].mean_alpha == pytest.approx((0.02 - 0.01 + 0.03) / 3)
    assert len(summary.spreads) == 2, "only calls with both a Bullish and a Bearish side have a spread"
    text = summary.render()
    assert "Regime hit rate: 67% (2/3)" in text and "not independent samples" in text
    assert summarize_market([]).render().startswith("No settled market calls yet")


def test_horizon_is_ten_trading_days_unless_configured():
    assert scoring.market_horizon_days({"holding_period_days": 5}) == 10, "ten by default, whatever the ticker's is"
    assert scoring.market_horizon_days({"holding_period_days": 5, "market_holding_period_days": 20}) == 20
    assert "next 10 trading days" in scoring.regime_definitions(10)
    assert "RELATIVE TO SPY over the next 10 trading days" in scoring.verdict_definition(10)
