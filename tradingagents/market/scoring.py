"""What a market call claims, and how its outcome is measured against the claim.

The ticker workflow scores a rating by the instrument's alpha against its
benchmark over ``holding_period_days``. A market call makes two kinds of claim
over the same kind of window, and each is scored against what it claims:

- A sector verdict claims the sector ETF's performance RELATIVE TO SPY.
  Bullish is a hit when its alpha is positive and Bearish when negative, as
  Buy and Sell are; Neutral claims no direction and is not scored as a hit,
  as Hold is not.
- The regime claims something observable about the market over the window.
  The prompts give the model these same definitions, so it is scored on what
  it was told it was claiming.

The three thresholds a regime needs are taken from the year of sessions before
the call, so "an ordinary move" means ordinary for that market, not a fixed
percentage.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

from tradingagents.agents.rating import RATING_REVIEW
from tradingagents.dataflows.config import get_config
from tradingagents.dataflows.market_scan import SECTOR_ETFS

HISTORY_SESSIONS = 252
MIN_HISTORY = 60
# Half the width of the "ordinary move" band, in standard deviations of the past
# year's same-length SPY returns: +/-0.43 sd holds the middle third of a
# zero-centred normal distribution.
FLAT_BAND_SIGMAS = 0.43
# A drawdown is "unusually deep" when it is among the deepest tenth of the past
# year's same-length windows.
STRESS_QUANTILE = 0.90

_DIRECTION = {"Bullish": 1, "Neutral": 0, "Bearish": -1}


def market_horizon_days(config: dict | None = None) -> int:
    """Trading days a market call looks ahead and is scored over.

    ``market_holding_period_days``, else the ticker workflow's ``holding_period_days``.
    """
    cfg = config if config is not None else get_config()
    return int(cfg.get("market_holding_period_days") or cfg.get("holding_period_days", 5))


def regime_definitions(days: int) -> str:
    """What each regime claims about the next ``days`` trading days, for the prompts."""
    return (
        f"Each regime is a claim about the next {days} trading days, and is checked against it:\n"
        "- Risk-On: SPY rises by more than an ordinary move.\n"
        "- Risk-Off: SPY falls by more than an ordinary move.\n"
        "- Stressed: SPY suffers an unusually deep drawdown from its starting level at some point in the window.\n"
        "- Rotation: the sectors' returns diverge more than usual, whatever the index does.\n"
        "- Range-Bound: SPY stays within an ordinary move and the sectors move together.\n"
        f"An ordinary move is the middle third of the past year's {days}-day SPY moves; usual divergence is the "
        "past year's median spread across sector returns; an unusually deep drawdown is among the deepest tenth. "
        "More than one can come true; choose the one you are most confident will."
    )


def verdict_definition(days: int) -> str:
    """What a sector verdict claims, for the prompts."""
    return (
        f"A sector verdict is the sector ETF's expected performance RELATIVE TO SPY over the next {days} trading "
        "days: Bullish means it outperforms SPY, Bearish means it underperforms, Neutral means roughly in line or "
        "evidence too thin to call. It is not a call on whether the sector's price rises: in a falling market, a "
        "sector that falls less than SPY is Bullish. The market's own direction is the regime's claim. The sectors "
        "make up the market, so they cannot all outperform it: a call with every sector Bullish, or every sector "
        "Bearish, contradicts itself."
    )


# --- Measuring the window -------------------------------------------------------


def _window_return(prices: pd.Series, days: int) -> pd.Series:
    return prices / prices.shift(days) - 1


def _max_drawdown(path: pd.Series) -> float:
    """Deepest fall from the path's starting level or any later high, as a positive fraction."""
    return float((1 - path / path.cummax()).max())


def measure_outcome(prices: pd.DataFrame, trade_date: str, days: int) -> dict | None:
    """What the market did over the ``days`` sessions after ``trade_date``.

    ``prices`` holds final daily closes by day, a ``SPY`` column and one per
    sector ETF. As in the ticker workflow's settlement, the window opens at the
    first close after the call's date and closes ``days`` sessions later;
    ``None`` until that last session has closed.
    """
    if "SPY" not in prices or prices["SPY"].dropna().empty:
        return None
    prices = prices.sort_index()
    spy = prices["SPY"].dropna()
    after = spy.index[spy.index > pd.Timestamp(trade_date)]
    if len(after) <= days:
        return None
    entry, exit_ = after[0], after[days]
    window = spy.loc[entry:exit_]
    spy_return = float(window.iloc[-1] / window.iloc[0] - 1)

    sectors = {}
    for name, etf in SECTOR_ETFS.items():
        series = prices[etf] if etf in prices else pd.Series(dtype=float)
        start, end = series.get(entry), series.get(exit_)
        if pd.isna(start) or pd.isna(end) or start <= 0:
            sectors[name] = None   # no price at either end: this sector cannot be scored
            continue
        raw = float(end / start - 1)
        sectors[name] = {"raw": raw, "alpha": raw - spy_return}
    returns = [s["raw"] for s in sectors.values() if s]
    dispersion = float(pd.Series(returns).std(ddof=0)) if len(returns) >= 2 else None

    return {
        "entry": entry.strftime("%Y-%m-%d"),
        "exit": exit_.strftime("%Y-%m-%d"),
        "days": days,
        "spy_return": spy_return,
        "max_drawdown": _max_drawdown(window),
        "dispersion": dispersion,
        "sectors": sectors,
        "thresholds": _thresholds(prices, trade_date, days),
    }


def _thresholds(prices: pd.DataFrame, trade_date: str, days: int) -> dict | None:
    """Ordinary move, usual divergence and deep drawdown, from the year up to the call's date."""
    history = prices[prices.index <= pd.Timestamp(trade_date)].tail(HISTORY_SESSIONS + days)
    spy = history["SPY"].dropna()
    moves = _window_return(spy, days).dropna()
    if len(moves) < MIN_HISTORY:
        return None
    etfs = [etf for etf in SECTOR_ETFS.values() if etf in history]
    divergence = _window_return(history[etfs], days).std(axis=1, ddof=0).dropna() if len(etfs) >= 2 else pd.Series()
    drawdowns = spy.rolling(days + 1).apply(_max_drawdown, raw=False).dropna()
    return {
        "ordinary_move": float(FLAT_BAND_SIGMAS * moves.std(ddof=0)),
        "usual_dispersion": float(divergence.median()) if len(divergence) >= MIN_HISTORY else None,
        "deep_drawdown": float(drawdowns.quantile(STRESS_QUANTILE)) if len(drawdowns) >= MIN_HISTORY else None,
    }


def regimes_held(outcome: dict) -> dict[str, bool | None]:
    """Whether each regime's claim came true; ``None`` where the past year could not set its threshold."""
    t = outcome.get("thresholds") or {}
    move, usual, deep = t.get("ordinary_move"), t.get("usual_dispersion"), t.get("deep_drawdown")
    spy, spread, fall = outcome["spy_return"], outcome.get("dispersion"), outcome["max_drawdown"]
    diverged = None if usual is None or spread is None else spread > usual
    return {
        "Risk-On": None if move is None else spy > move,
        "Risk-Off": None if move is None else spy < -move,
        "Stressed": None if deep is None else (deep > 0 and fall >= deep),
        "Rotation": diverged,
        "Range-Bound": None if move is None or diverged is None else (abs(spy) <= move and not diverged),
    }


# --- Scoring a call against the window -------------------------------------------


def score_call(regime: str, sectors: dict[str, dict], outcome: dict) -> dict:
    """The call's scorecard: the regime's hit, each sector's hit, and the run-level sector figures.

    ``spread`` is the mean alpha of the Bullish sectors less that of the Bearish
    ones: what the call's sector ranking was worth. ``neutral_miss`` is the mean
    absolute alpha of the Neutral sectors: how far the sectors left uncalled
    actually moved against the market.
    """
    held = regimes_held(outcome)
    rows, by_outlook = {}, {"Bullish": [], "Neutral": [], "Bearish": []}
    for name in SECTOR_ETFS:
        call = sectors.get(name) or {}
        outlook, measured = call.get("outlook", RATING_REVIEW), outcome["sectors"].get(name)
        direction = _DIRECTION.get(outlook)
        alpha = measured["alpha"] if measured else None
        rows[name] = {
            "outlook": outlook,
            "conviction": call.get("conviction", ""),
            "raw": measured["raw"] if measured else None,
            "alpha": alpha,
            "hit": (alpha * direction > 0) if direction and alpha is not None else None,
        }
        if alpha is not None and outlook in by_outlook:
            by_outlook[outlook].append(alpha)

    def mean(values):
        return sum(values) / len(values) if values else None

    bullish, bearish = mean(by_outlook["Bullish"]), mean(by_outlook["Bearish"])
    return {
        "regime": {"called": regime, "hit": held.get(regime), "held": [r for r, ok in held.items() if ok]},
        "sectors": rows,
        "bullish_alpha": bullish,
        "bearish_alpha": bearish,
        "spread": bullish - bearish if bullish is not None and bearish is not None else None,
        "neutral_miss": mean([abs(a) for a in by_outlook["Neutral"]]),
    }


def _pct(value, signed=True) -> str:
    if value is None:
        return "n/a"
    return f"{value:+.1%}" if signed else f"{value:.1%}"


def _verdict(hit) -> str:
    return "not scored" if hit is None else "HIT" if hit else "MISS"


def render_scorecard(scorecard: dict, outcome: dict) -> str:
    """The scorecard as text, for the reflection and for later runs' past context."""
    t = outcome.get("thresholds") or {}
    regime = scorecard["regime"]
    lines = [
        f"Window: {outcome['entry']} to {outcome['exit']} ({outcome['days']} trading days after the call).",
        f"SPY {_pct(outcome['spy_return'])} (ordinary move ±{_pct(t.get('ordinary_move'), False)}); "
        f"deepest drawdown {_pct(outcome['max_drawdown'], False)} (unusually deep from "
        f"{_pct(t.get('deep_drawdown'), False)}); sector divergence {_pct(outcome.get('dispersion'), False)} "
        f"(usual {_pct(t.get('usual_dispersion'), False)}).",
        f"Regime called: {regime['called']} -> {_verdict(regime['hit'])}. "
        f"Claims that came true: {', '.join(regime['held']) or 'none'}.",
        "Sector verdicts against SPY:",
    ]
    for name, row in scorecard["sectors"].items():
        conviction = f" ({row['conviction']})" if row["conviction"] else ""
        lines.append(f"- {name}: {row['outlook']}{conviction} -> alpha {_pct(row['alpha'])}, "
                     f"return {_pct(row['raw'])}: {_verdict(row['hit'])}")
    lines.append(
        f"Bullish sectors' mean alpha {_pct(scorecard['bullish_alpha'])}, Bearish {_pct(scorecard['bearish_alpha'])}, "
        f"spread {_pct(scorecard['spread'])}; Neutral sectors moved {_pct(scorecard['neutral_miss'], False)} "
        "against SPY on average.")
    return "\n".join(lines)


# --- Aggregating settled calls ------------------------------------------------------


@dataclass
class Tally:
    count: int = 0
    hits: int = 0
    scored: int = 0
    alphas: list[float] = field(default_factory=list)

    def add(self, hit, alpha=None):
        self.count += 1
        if hit is not None:
            self.scored += 1
            self.hits += bool(hit)
        if alpha is not None:
            self.alphas.append(alpha)

    @property
    def hit_rate(self) -> float | None:
        return self.hits / self.scored if self.scored else None

    @property
    def mean_alpha(self) -> float | None:
        return sum(self.alphas) / len(self.alphas) if self.alphas else None


@dataclass
class MarketSummary:
    """Settled market calls scored: regimes, sector verdicts by outlook, conviction and sector."""

    settled: int
    pending: int
    regime: Tally
    by_regime: dict[str, Tally]
    by_outlook: dict[str, Tally]
    by_conviction: dict[str, Tally]
    by_sector: dict[str, Tally]
    spreads: list[float]
    neutral_misses: list[float]
    horizons: set[int]

    def render(self) -> str:
        if not self.settled:
            return f"No settled market calls yet ({self.pending} pending)."

        def rate(t: Tally) -> str:
            return "n/a" if t.hit_rate is None else f"{t.hit_rate:.0%} ({t.hits}/{t.scored})"

        def table(title, first, tallies, alpha=True):
            rows = [f"\n{title}", f"| {first} | Calls | Hit rate |" + (" Mean alpha |" if alpha else ""),
                    "| --- | --- | --- |" + (" --- |" if alpha else "")]
            for name, t in tallies.items():
                rows.append(f"| {name} | {t.count} | {rate(t)} |" + (f" {_pct(t.mean_alpha)} |" if alpha else ""))
            return rows

        windows = ", ".join(f"{d} trading days" for d in sorted(self.horizons))
        lines = [f"Market calls: {self.settled} settled, {self.pending} pending; scored over {windows}.",
                 f"Regime hit rate: {rate(self.regime)}"]
        lines += table("By regime called", "Regime", self.by_regime, alpha=False)
        lines += table("Sector verdicts by outlook (alpha vs SPY)", "Outlook", self.by_outlook)
        lines += table("Directional verdicts by conviction", "Conviction", self.by_conviction)
        lines += table("Directional verdicts by sector (mean alpha in the called direction)", "Sector", self.by_sector)
        if self.spreads:
            lines.append(f"\nMean Bullish-minus-Bearish spread: {_pct(sum(self.spreads) / len(self.spreads))} "
                         f"over {len(self.spreads)} call(s) with both sides.")
        if self.neutral_misses:
            lines.append("Neutral sectors moved "
                         f"{_pct(sum(self.neutral_misses) / len(self.neutral_misses), False)} against SPY on average.")
        lines.append("Neutral is not scored as a hit or a miss. Calls made on nearby dates share most of their "
                     "window, so they are not independent samples.")
        return "\n".join(lines)


def summarize_market(records: list[dict]) -> MarketSummary:
    """Score every settled record of a market memory log."""
    settled = [r for r in records if r.get("scorecard")]
    summary = MarketSummary(
        settled=len(settled), pending=len(records) - len(settled), regime=Tally(), by_regime={},
        by_outlook={name: Tally() for name in _DIRECTION}, by_conviction={}, by_sector={},
        spreads=[], neutral_misses=[], horizons=set())
    for record in settled:
        card = record["scorecard"]
        summary.horizons.add(int(record["outcome"]["days"]))
        regime = card["regime"]
        summary.regime.add(regime["hit"])
        summary.by_regime.setdefault(regime["called"], Tally()).add(regime["hit"])
        for name, row in card["sectors"].items():
            outlook, direction = row["outlook"], _DIRECTION.get(row["outlook"])
            if outlook in summary.by_outlook:
                summary.by_outlook[outlook].add(row["hit"], row["alpha"])
            if direction and row["alpha"] is not None:
                signed = row["alpha"] * direction
                summary.by_conviction.setdefault(row["conviction"] or "unstated", Tally()).add(row["hit"], signed)
                summary.by_sector.setdefault(name, Tally()).add(row["hit"], signed)
        if card.get("spread") is not None:
            summary.spreads.append(card["spread"])
        if card.get("neutral_miss") is not None:
            summary.neutral_misses.append(card["neutral_miss"])
    return summary
