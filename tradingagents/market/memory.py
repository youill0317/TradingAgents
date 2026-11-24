"""The market workflow's memory log: each sector verdict recorded, settled and reflected on.

It is the ticker workflow's ``TradingMemoryLog`` on a log of its own. Every
sector verdict is an entry under its sector ETF, so the ticker workflow's
settlement scores it the same way: the ETF's return over the holding period,
and its alpha against the benchmark (SPY by default).
"""

import os

from tradingagents.agents.rating import RATING_REVIEW
from tradingagents.dataflows.market_scan import SECTOR_ETFS
from tradingagents.memory import TradingMemoryLog
from tradingagents.memory.reflection import Reflector


def market_memory_log_path(config: dict) -> str | None:
    """``market_memory_log_path``, else ``market_memory.md`` beside the ticker memory log."""
    if config.get("market_memory_log_path"):
        return config["market_memory_log_path"]
    ticker_log = config.get("memory_log_path")
    return os.path.join(os.path.dirname(ticker_log), "market_memory.md") if ticker_log else None


def market_memory_log(config: dict) -> TradingMemoryLog:
    return TradingMemoryLog({**config, "memory_log_path": market_memory_log_path(config)})


class MarketReflector(Reflector):
    """The ticker workflow's reflection, worded for a sector verdict."""

    def _system_prompt(self, holding_days: int) -> str:
        return (
            "You are a market strategist reviewing your own past sector verdict now that the outcome is known.\n"
            f"The outcome covers {holding_days} trading days of the sector ETF from the first close after the "
            "analysis date, which may be shorter than the 1–4 week horizon of the verdict.\n"
            "A Bullish or Bearish verdict called the ETF's direction (the raw return); the alpha shows how it "
            "did against the market. Neutral called no clear direction.\n"
            "Write exactly 2-4 sentences of plain prose (no bullets, no headers, no markdown).\n\n"
            "Cover in order:\n"
            f"1. What the {holding_days}-day raw return and alpha show about the verdict (cite the figures), "
            "and say so plainly if the window is too short to judge it.\n"
            "2. Which part of the market or sector reasoning this window supports or undercuts.\n"
            "3. One concrete lesson for the next market analysis.\n\n"
            "Be specific and terse. Your output is stored verbatim and re-read by future analyses."
        )


def canonical_line(line: str, sector: str, etf: str) -> bool:
    """Whether the line is the sector's own verdict line: a table row or list item opening with it."""
    lowered = line.strip().lstrip("|-*• ").casefold()
    return lowered.startswith((sector.casefold(), etf.casefold()))


def verdict_entries(final_state: dict) -> list[tuple[str, str, str]]:
    """``(etf, rating, decision text)`` for every sector the final call rated."""
    regime = final_state.get("final_regime", RATING_REVIEW)
    decision = final_state.get("final_market_decision", "")
    entries = []
    for sector, rating in (final_state.get("final_sector_ratings") or {}).items():
        etf = SECTOR_ETFS.get(sector)
        if etf is None or rating == RATING_REVIEW:
            continue
        # The call's own line for this sector carries its rationale; the whole
        # call would be re-read for every sector by every later run.
        line = next((ln.strip() for ln in decision.splitlines()
                     if canonical_line(ln, sector, etf)), "")
        text = f"Market regime: {regime}\nSector: {sector} ({etf})\nVerdict: {rating}\n{line}".rstrip()
        entries.append((etf, rating, text))
    return entries


def past_market_context(memory_log: TradingMemoryLog, as_of: str | None, per_sector: int = 2) -> str:
    """The latest settled verdicts and lessons for each sector, known by ``as_of``."""
    parts = []
    for sector, etf in SECTOR_ETFS.items():
        context = memory_log.get_past_context(etf, n_same=per_sector, n_cross=0, as_of=as_of)
        if context:
            parts.append(f"### {sector} ({etf})\n{context}")
    return "\n\n".join(parts)
