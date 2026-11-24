"""The market workflow's memory log: each call recorded, settled against the market and reflected on.

The same cycle as the ticker workflow's ``tradingagents.memory``: a run records
its decision as pending; once the window it looked ahead over has traded, a
later run measures the outcome, asks the model for one short reflection and
stores both; the final decision-maker of later runs reads the recent ones.

A market call is one decision, a regime and eleven sector verdicts, so it is
one record with one scorecard and one reflection. The log is JSON Lines, since
a scorecard is structured; ``tradingagents.market.scoring`` defines the scoring.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
from datetime import timedelta
from pathlib import Path
from typing import Any

import pandas as pd

from tradingagents.agents.rating import RATING_REVIEW
from tradingagents.dataflows.files import locked
from tradingagents.dataflows.market_scan import SECTOR_ETFS
from tradingagents.dataflows.vendors.yahoo.market import get_closes
from tradingagents.market.scoring import (
    HISTORY_SESSIONS,
    measure_outcome,
    render_scorecard,
    score_call,
)
from tradingagents.memory.settlement import Settlement, _by_day, _now

logger = logging.getLogger(__name__)

SUBJECT = "MARKET"


def market_memory_log_path(config: dict) -> str | None:
    """``market_memory_log_path``, else ``market_memory.jsonl`` beside the ticker memory log."""
    if config.get("market_memory_log_path"):
        return config["market_memory_log_path"]
    ticker_log = config.get("memory_log_path")
    return os.path.join(os.path.dirname(ticker_log), "market_memory.jsonl") if ticker_log else None


class MarketMemoryLog:
    """Append-only log of market calls; a settled call gains its outcome, scorecard and reflection."""

    def __init__(self, config: dict | None = None):
        path = market_memory_log_path(config or {})
        self._log_path = Path(path).expanduser() if path else None
        if self._log_path:
            self._log_path.parent.mkdir(parents=True, exist_ok=True)

    # --- Write: a run records its call ---

    def store_call(self, trade_date: str, regime: str, sectors: dict[str, dict], decision: str, days: int) -> bool:
        """Append a pending call. One call per date: a re-run of the date changes nothing."""
        if not self._log_path:
            return False
        with locked(self._log_path):
            if any(r["date"] == trade_date for r in self.load()):
                return False
            record = {"date": trade_date, "regime": regime, "sectors": sectors, "decision": decision,
                      "days": int(days), "pending": True}
            with open(self._log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
            return True

    def settling(self, wait: bool = True):
        """Hold the log for one settlement pass at a time, as the ticker memory log does."""
        if not self._log_path:
            return contextlib.nullcontext(True)
        return locked(f"{self._log_path}.settle", wait=wait)

    def settle(self, trade_date: str, outcome: dict, scorecard: dict, reflection: str) -> bool:
        """Record a pending call's outcome; ``False`` when another pass settled it first."""
        if not self._log_path or not self._log_path.exists():
            return False
        with locked(self._log_path):
            records, updated = self.load(), False
            for record in records:
                if record["date"] == trade_date and record.get("pending"):
                    record.update(pending=False, outcome=outcome, scorecard=scorecard, reflection=reflection,
                                  resolved=outcome["exit"])
                    updated = True
            if updated:
                tmp = self._log_path.with_suffix(".tmp")
                tmp.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records), encoding="utf-8")
                tmp.replace(self._log_path)
            return updated

    # --- Read ---

    def load(self) -> list[dict]:
        if not self._log_path or not self._log_path.exists():
            return []
        records = []
        for line in self._log_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                records.append(json.loads(line))
        return records

    def pending(self) -> list[dict]:
        return [r for r in self.load() if r.get("pending")]

    def past_context(self, as_of: str | None = None, n: int = 3) -> str:
        """The latest settled calls with their scorecards and lessons, most recent first.

        With ``as_of``, only calls whose outcome was known by that date: a
        past-dated run must not learn from what had not happened yet.
        """
        settled = [r for r in self.load() if not r.get("pending")]
        if as_of is not None:
            settled = [r for r in settled if r.get("resolved") and r["resolved"] <= as_of]
        settled.sort(key=lambda r: r["date"], reverse=True)
        if not settled:
            return ""
        parts = ["Past market calls and how they turned out (most recent first):"]
        for record in settled[:n]:
            parts.append(f"[{record['date']} | regime {record['regime']}]\n"
                         f"{render_scorecard(record['scorecard'], record['outcome'])}\n"
                         f"REFLECTION:\n{record['reflection']}")
        return "\n\n".join(parts)


# --- What a finished run records -----------------------------------------------------


def call_record(final_state: dict) -> tuple[str, dict[str, dict]]:
    """The final call's regime and, per sector, its outlook, conviction and evidence leans by source."""
    ratings = final_state.get("final_sector_ratings") or {}
    convictions = final_state.get("final_sector_convictions") or {}
    evidence = final_state.get("final_sector_evidence") or {}
    sectors = {name: {"outlook": ratings.get(name, RATING_REVIEW), "conviction": convictions.get(name, ""),
                      "evidence": evidence.get(name, {})}
               for name in SECTOR_ETFS}
    return final_state.get("final_regime") or RATING_REVIEW, sectors


# --- Settle: measure the window, reflect, record --------------------------------------


def fetch_prices(trade_date: str, days: int) -> pd.DataFrame | None:
    """Final daily closes of SPY and the sector ETFs, from a year before the call through its window.

    ``None`` while the window cannot have traded yet, so no prices are asked for.
    Cleaned as the ticker workflow's settlement cleans its closes: today's bar,
    still trading, is dropped.
    """
    start = pd.Timestamp(trade_date)
    today = _now().tz_localize(None).normalize()
    if (today - start).days < days + 1:
        return None
    first = (start - timedelta(days=round((HISTORY_SESSIONS + 2 * days) * 7 / 5) + 14)).strftime("%Y-%m-%d")
    until = (today + timedelta(days=1)).strftime("%Y-%m-%d")
    columns = {symbol: _by_day(get_closes(symbol, first, until)) for symbol in ("SPY", *SECTOR_ETFS.values())}
    return pd.DataFrame(columns)


class MarketReflector:
    """One short reflection on a settled market call, as the ticker workflow's Reflector writes."""

    def __init__(self, quick_thinking_llm: Any):
        self.quick_thinking_llm = quick_thinking_llm

    def _system_prompt(self, days: int) -> str:
        return (
            "You are a market strategist reviewing your own past market call now that the outcome is known.\n"
            f"The call claimed a market regime and each US sector's performance relative to SPY over the {days} "
            "trading days after it. The scorecard measures exactly those claims; one window is a single "
            "observation, not proof.\n"
            "Write exactly 3-5 sentences of plain prose (no bullets, no headers, no markdown).\n\n"
            "Cover in order:\n"
            "1. Whether the regime call held, citing SPY's move, drawdown or sector divergence.\n"
            "2. What the sector verdicts were worth: the Bullish-minus-Bearish spread, the clearest hit and the "
            "clearest miss, and any Neutral sector that moved a lot against SPY.\n"
            "3. Which part of the call's reasoning the window supports or undercuts, and say so plainly if the "
            "outcome is too close to the thresholds to judge.\n"
            "4. One concrete lesson for the next market call.\n\n"
            "Be specific and terse. Your output is stored verbatim and re-read by future analyses."
        )

    def reflect_on_market_call(self, decision: str, scorecard_text: str, days: int) -> str:
        messages = [
            ("system", self._system_prompt(days)),
            ("human", f"Scorecard:\n{scorecard_text}\n\nThe call as it was made:\n{decision}"),
        ]
        return self.quick_thinking_llm.invoke(messages).content


def settle_pending_calls(memory_log: MarketMemoryLog, reflector: MarketReflector, wait: bool = True,
                         fetch=None) -> Settlement:
    """Settle the pending calls whose window has traded, one pass at a time per log.

    A call whose window has not traded stays pending; one whose prices or
    reflection could not be had stays pending and is reported as failed.
    """
    fetch = fetch or fetch_prices
    result = Settlement()
    with memory_log.settling(wait=wait) as held:
        if not held:
            return result
        for record in memory_log.pending():
            date, days = record["date"], int(record["days"])
            try:
                prices = fetch(date, days)
                outcome = measure_outcome(prices, date, days) if prices is not None else None
            except Exception as exc:
                logger.warning("Prices for settling the market call of %s were unavailable: %s", date, exc)
                result.failed.append((SUBJECT, date, f"prices unavailable: {exc}"))
                continue
            if outcome is None:
                continue   # the window has not traded yet: try again next run
            scorecard = score_call(record["regime"], record["sectors"], outcome)
            try:
                reflection = reflector.reflect_on_market_call(
                    record.get("decision", ""), render_scorecard(scorecard, outcome), days)
            except Exception as exc:
                logger.warning("Reflection failed for the market call of %s: %s", date, exc)
                result.failed.append((SUBJECT, date, f"reflection failed: {exc}"))
                continue
            if memory_log.settle(date, outcome, scorecard, reflection):
                result.settled.append((SUBJECT, date))
    return result
