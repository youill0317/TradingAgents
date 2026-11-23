"""Pydantic schemas for the market-wide scan (Market Strategist and risk review).

Kept apart from ``tradingagents.agents.schemas``, which holds the per-ticker
agents' schemas; the two workflows share no output shapes.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class MarketRegime(StrEnum):
    """Coarse read on what the market is doing, used by the Market Strategist.

    Deliberately coarse: the regime label is a routing hint for the candidate
    list, not a forecast.  The nuance lives in ``regime_evidence``.
    """

    RISK_ON = "Risk-On"
    RISK_OFF = "Risk-Off"
    ROTATION = "Rotation"
    RANGE_BOUND = "Range-Bound"
    STRESSED = "Stressed"


class Conviction(StrEnum):
    """How strongly a candidate is put forward."""

    HIGH = "High"
    MEDIUM = "Medium"
    LOW = "Low"


class ScanMode(StrEnum):
    """Point-in-time contract for a market scan."""

    LIVE = "live"
    HISTORICAL = "historical"


class ScanStatus(StrEnum):
    """Whether the final shortlist passed its required validation gates."""

    COMPLETE = "COMPLETE"
    DEGRADED = "DEGRADED"
    INCOMPLETE = "INCOMPLETE"


class MarketCandidate(BaseModel):
    """One name on the shortlist, with the reason it is there."""

    ticker: str = Field(
        description=(
            "The exchange ticker symbol exactly as it appeared in the screen "
            "results (e.g. 'NVDA'). Never invent a symbol that was not returned "
            "by a tool."
        ),
    )
    sector: str = Field(
        description=(
            "The sector this name was screened under, copied verbatim from the "
            "screen results."
        ),
    )
    thesis: str = Field(
        description=(
            "Two to three sentences on why this name fits the current market "
            "regime and its sector's position, citing specific figures from the "
            "macro and sector reports."
        ),
    )
    conviction: Conviction = Field(
        description=(
            "High only when the macro regime and the sector evidence point the "
            "same way for this name; Low when the case rests on a single signal."
        ),
    )

    @field_validator("ticker", mode="before")
    @classmethod
    def _normalize_ticker(cls, v):
        """Strip and upper-case the symbol so it can be matched against a report.

        Normalise rather than validate, for the same reason
        ``_coerce_optional_float`` coerces instead of erroring (#1058): a
        raising validator fails the whole structured call and drops the report
        to the free-text fallback, losing every other field with it. Whether the
        symbol is *real* is checked in the Market Strategist node, where a bad
        one costs one candidate instead of the report.
        """
        return v.strip().upper() if isinstance(v, str) else v


class MarketRiskReview(BaseModel):
    summary: str = Field(description="What was audited, including unavailable evidence.")
    findings: list[str] = Field(description="Material findings only. Each states the claim, source/date, severity, required correction and monitoring condition. Empty if none.")


class MarketRiskResolution(BaseModel):
    finding_id: str
    decision: Literal["accepted", "rejected"]
    rationale: str = Field(description="Evidence/date and correction made, or evidence supporting rejection.")


class MarketScanReport(BaseModel):
    """Structured output produced by the Market Strategist.

    Describes market conditions, participation, rotation and conditional
    scenarios independently of the optional ticker shortlist. A shortlist
    entry is a prompt for further analysis, not a position call.
    """

    status: ScanStatus = Field(
        default=ScanStatus.COMPLETE,
        description="Completeness of the validated scan output.",
    )
    warnings: list[str] = Field(
        default_factory=list,
        description="Machine-readable reasons for degraded or incomplete output.",
    )
    review_resolution: str = Field(default="", description="Final response to material independent risk findings: accepted/rejected, evidence, corrections and unresolved uncertainty.")
    risk_resolutions: list[MarketRiskResolution] = Field(default_factory=list, description="Exactly one response per supplied risk finding ID; no invented IDs.")
    market_outlook: str = Field(default="", description="Independent 1–4 week market outlook: regime, contradictions, risk appetite and conditions for reassessment.")
    participation_assessment: str = Field(default="", description="Breadth of sector/ETF participation, equal-weight vs cap-weight and small vs large caps; cite dates and coverage, not invented stock breadth.")
    rotation_assessment: str = Field(default="", description="Multi-horizon sector leadership, reversals and like-for-like rank or weekly relative changes, grounded in the diagnostics.")
    catalyst_assessment: str = Field(default="", description="Dated upcoming events, available consensus and recent numeric surprises; identify missing coverage and separate data surprises from market direction.")
    scenarios: list[str] = Field(default_factory=list, description="Base, upside and downside scenarios for the next 1–4 weeks; each states observable confirmation/invalidation conditions and affected sectors, without invented probabilities.")

    regime: MarketRegime = Field(
        description="The single regime label that best fits the current market.",
    )
    regime_evidence: str = Field(
        description=(
            "Why that regime, anchored in available global economic and asset "
            "evidence, including its transmission to US markets. Distinguish "
            "reported geopolitical facts from expectations and scenarios. "
            "Three to five sentences. Name the figures, not just their direction."
        ),
    )
    sector_view: str = Field(
        description=(
            "Which sectors are leading and lagging, citing the trailing returns "
            "and the spread versus SPY, and what that rotation implies about "
            "where the market thinks it is heading. Three to five sentences."
        ),
    )
    candidates: list[MarketCandidate] = Field(
        description=(
            "The shortlist, strongest first. Only names that actually appeared "
            "in the screen results. Prefer a short, well-argued list over a long "
            "one; return an empty list if the evidence supports no candidate."
        ),
    )


def render_market_scan_report(report: MarketScanReport) -> str:
    """Render a MarketScanReport to the markdown shape the CLI and report tree expect."""
    parts = [
        f"**Status:** **{report.status.value}**",
        *(["", "## Warnings", "", *[f"- {w}" for w in report.warnings]] if report.warnings else []),
        "",
        f"**Market Regime:** **{report.regime.value}**",
        "",
        "## Regime Evidence",
        "",
        report.regime_evidence,
        "",
        "## Sector View",
        "",
        report.sector_view,
        "",
    ]

    # Market assessment remains useful even when no stock candidates qualify.
    for title, text in (
        ("Market Outlook (1–4 weeks)", report.market_outlook),
        ("Risk Review Resolution", report.review_resolution),
        ("Participation and Concentration", report.participation_assessment),
        ("Rotation and Transitions", report.rotation_assessment),
        ("Catalysts and Expectations", report.catalyst_assessment),
    ):
        if text:
            parts.extend([f"## {title}", "", text, ""])
    if report.scenarios:
        parts.extend(["## Conditional Scenarios", "", *[f"- {s}" for s in report.scenarios], ""])
    if report.risk_resolutions:
        parts.extend(["## Risk Findings Addressed", "", *[
            f"- {r.finding_id} — {r.decision}: {r.rationale}" for r in report.risk_resolutions
        ], ""])
    parts.extend(["## Candidates", ""])

    if not report.candidates:
        parts.append(
            "_Candidate selection was not completed; see warnings._"
            if report.status is ScanStatus.INCOMPLETE else
            "_No candidate met the bar this scan._"
        )
        return "\n".join(parts)

    parts.extend([
        "| # | Ticker | Sector | Conviction | Thesis |",
        "| --- | --- | --- | --- | --- |",
    ])
    for i, c in enumerate(report.candidates, start=1):
        # Pipes inside the thesis would break the table; escape them.
        thesis = c.thesis.replace("|", "\\|").replace("\n", " ")
        parts.append(
            f"| {i} | {c.ticker} | {c.sector} | {c.conviction.value} | {thesis} |"
        )

    parts.extend([
        "",
        "_A shortlist entry is a prompt for further analysis, not a position "
        "call. Run `tradingagents analyze` on a name before acting on it._",
    ])
    return "\n".join(parts)
