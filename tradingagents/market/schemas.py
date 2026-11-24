"""The market call: a regime and a verdict on every US sector, typed and read back from text.

The market workflow's managers answer with a ``MarketCall`` the way the ticker
workflow's answer with a rating. When a provider gives no structured output,
the call is read from the text the way ``tradingagents.agents.rating`` reads a
rating, and anything it cannot read is ``REVIEW``, never a guessed direction.
"""

from __future__ import annotations

import re
import unicodedata
from enum import StrEnum

from pydantic import BaseModel, Field

from tradingagents.agents.rating import RATING_REVIEW
from tradingagents.dataflows.market_scan import SECTOR_ETFS


class MarketRegime(StrEnum):
    RISK_ON = "Risk-On"
    RISK_OFF = "Risk-Off"
    ROTATION = "Rotation"
    RANGE_BOUND = "Range-Bound"
    STRESSED = "Stressed"


class SectorOutlook(StrEnum):
    BULLISH = "Bullish"
    NEUTRAL = "Neutral"
    BEARISH = "Bearish"


class Conviction(StrEnum):
    HIGH = "High"
    MEDIUM = "Medium"
    LOW = "Low"


class SectorVerdict(BaseModel):
    sector: str = Field(description="Exactly one of: " + ", ".join(SECTOR_ETFS) + ".")
    outlook: SectorOutlook = Field(
        description="The sector ETF's expected performance relative to SPY over the horizon the prompt states: "
                    "Bullish outperforms SPY, Bearish underperforms it, Neutral is roughly in line or too thin "
                    "to call. Not a call on whether the sector's price rises.")
    conviction: Conviction = Field(
        description="High only when macro, relative performance and catalysts agree; Low when the "
                    "verdict rests on a single signal.")
    rationale: str = Field(description="One to three sentences citing the figures and dates behind the verdict.")
    invalidation: str = Field(description="The observable condition that would overturn the verdict.")


class MarketCall(BaseModel):
    """A market regime and one verdict per US sector, with the reasoning around them."""

    regime: MarketRegime = Field(
        description="The one regime, as the prompt defines them, you are most confident will come true over the "
                    "horizon the prompt states.")
    regime_evidence: str = Field(
        description="Why that regime: the global and US evidence, its transmission to US markets, and "
                    "where the indicators disagree. Name the figures and their dates.")
    sector_verdicts: list[SectorVerdict] = Field(
        description="Exactly one verdict for each of the eleven US sectors.")
    summary: str = Field(description="The section this agent is asked for, in prose.")


SECTORS: tuple[str, ...] = tuple(SECTOR_ETFS)
_LOOKUP = {name.casefold(): name for name in SECTORS} | {etf.casefold(): name for name, etf in SECTOR_ETFS.items()}


def canonical_sector(name: str) -> str | None:
    """The sector a name or ETF symbol refers to, or ``None``."""
    return _LOOKUP.get(str(name).strip().casefold())


def normalize_call(call: MarketCall) -> MarketCall:
    """Canonical sector names in canonical order; an unknown or repeated sector is dropped."""
    kept = {}
    for verdict in call.sector_verdicts:
        name = canonical_sector(verdict.sector)
        if name and name not in kept:
            kept[name] = verdict.model_copy(update={"sector": name})
    return call.model_copy(update={"sector_verdicts": [kept[n] for n in SECTORS if n in kept]})


def call_ratings(call: MarketCall) -> tuple[str, dict[str, str], dict[str, str]]:
    """The regime, every sector's outlook and its conviction; a sector without a verdict is ``REVIEW``."""
    found = {v.sector: v for v in normalize_call(call).sector_verdicts}
    ratings = {name: found[name].outlook.value if name in found else RATING_REVIEW for name in SECTORS}
    convictions = {name: found[name].conviction.value if name in found else "" for name in SECTORS}
    return call.regime.value, ratings, convictions


def _cell(text: str) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def render_call(call: MarketCall, summary_heading: str) -> str:
    """The call as markdown, opening with the regime line its text parser reads."""
    call = normalize_call(call)
    lines = [
        f"**Market Regime**: {call.regime.value}",
        "",
        "**Regime Evidence**:",
        call.regime_evidence,
        "",
        "**Sector Verdicts**:",
        "",
        "| Sector | ETF | Outlook | Conviction | Rationale | Invalidated if |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    by_sector = {v.sector: v for v in call.sector_verdicts}
    for name in SECTORS:
        v = by_sector.get(name)
        if v is None:
            lines.append(f"| {name} | {SECTOR_ETFS[name]} | {RATING_REVIEW} | | No verdict given | |")
        else:
            lines.append(f"| {name} | {SECTOR_ETFS[name]} | {v.outlook.value} | {v.conviction.value} | "
                         f"{_cell(v.rationale)} | {_cell(v.invalidation)} |")
    lines += ["", f"**{summary_heading}**:", call.summary]
    return "\n".join(lines)


# --- Reading a call back from free text -------------------------------------

_REGIMES = {r.value.casefold().replace("-", ""): r.value for r in MarketRegime}
_REGIME_RE = re.compile(r"(?<![a-z])regime\b(?!\s*evidence)[^:\n\-\u2010-\u2015]*[:\-\u2010-\u2015][\s*_]*([a-z]+(?:[\s-][a-z]+)?)",
                        re.IGNORECASE)
_OUTLOOK_RE = re.compile(r"\b(bullish|neutral|bearish)\b", re.IGNORECASE)
_CONVICTION_RE = re.compile(r"\b(high|medium|low)\b(?=\W*conviction)|(?<=\|\s)(high|medium|low)(?=\s*\|)",
                            re.IGNORECASE)


def extract_regime(text: str) -> str | None:
    """The regime from its label ("Market Regime: Risk-On"), when every label agrees."""
    if not text:
        return None
    found = []
    for raw in _REGIME_RE.findall(unicodedata.normalize("NFKC", text)):
        key = raw.casefold().replace("-", "").replace(" ", "")
        for candidate, value in _REGIMES.items():
            if key.startswith(candidate):
                found.append(value)
                break
    return found[0] if found and len(set(found)) == 1 else None


def _sector_lines(text: str):
    """``(sector, line)`` for every line that names exactly one sector."""
    for line in unicodedata.normalize("NFKC", text or "").splitlines():
        lowered = line.casefold()
        named = [name for name in SECTORS
                 if re.search(rf"(?<![a-z]){re.escape(name.casefold())}(?![a-z])", lowered)
                 or re.search(rf"\b{SECTOR_ETFS[name].casefold()}\b", lowered)]
        if len(named) == 1:
            yield named[0], line


def extract_sector_convictions(text: str, ratings: dict[str, str]) -> dict[str, str]:
    """Each rated sector's conviction from its verdict line, empty where the line states none or several."""
    seen: dict[str, set[str]] = {name: set() for name in SECTORS}
    for name, line in _sector_lines(text):
        if _OUTLOOK_RE.search(line):
            seen[name] |= {next(g for g in m if g).capitalize() for m in _CONVICTION_RE.findall(line)}
    return {name: next(iter(v)) if len(v) == 1 and ratings.get(name) != RATING_REVIEW else ""
            for name, v in seen.items()}


def extract_sector_ratings(text: str) -> dict[str, str]:
    """Each sector's outlook from the lines naming that sector alone, when they agree.

    A line naming several sectors says nothing about which outlook is whose, and
    a sector whose lines disagree has no readable call: both are ``REVIEW``.
    """
    seen: dict[str, set[str]] = {name: set() for name in SECTORS}
    for line in unicodedata.normalize("NFKC", text or "").splitlines():
        lowered = line.casefold()
        named = {name for name in SECTORS
                 if re.search(rf"(?<![a-z]){re.escape(name.casefold())}(?![a-z])", lowered)
                 or re.search(rf"\b{SECTOR_ETFS[name].casefold()}\b", lowered)}
        outlooks = {m.capitalize() for m in _OUTLOOK_RE.findall(line)}
        if len(named) == 1 and len(outlooks) == 1:
            seen[named.pop()] |= outlooks
    return {name: next(iter(v)) if len(v) == 1 else RATING_REVIEW for name, v in seen.items()}


def parse_call(text: str) -> tuple[str, dict[str, str], dict[str, str]]:
    """The regime, sector ratings and convictions read from free text; what cannot be read is ``REVIEW``."""
    ratings = extract_sector_ratings(text)
    return extract_regime(text) or RATING_REVIEW, ratings, extract_sector_convictions(text, ratings)
