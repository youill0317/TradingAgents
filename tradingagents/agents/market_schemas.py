"""Pydantic schemas for the market-wide scan (Market Strategist and risk review).

Kept apart from ``tradingagents.agents.schemas``, which holds the per-ticker
agents' schemas; the two workflows share no output shapes.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from tradingagents.dataflows.market_scan import SECTOR_ETFS


class MarketRegime(StrEnum):
    """Coarse read on what the market is doing, used by the Market Strategist.

    Deliberately coarse: the nuance lives in ``regime_evidence``.
    """

    RISK_ON = "Risk-On"
    RISK_OFF = "Risk-Off"
    ROTATION = "Rotation"
    RANGE_BOUND = "Range-Bound"
    STRESSED = "Stressed"


class Conviction(StrEnum):
    """How strongly a sector verdict is held."""

    HIGH = "High"
    MEDIUM = "Medium"
    LOW = "Low"


class SectorOutlook(StrEnum):
    """Expected direction of a sector over the next 1–4 weeks."""

    BULLISH = "Bullish"
    NEUTRAL = "Neutral"
    BEARISH = "Bearish"


class ScanMode(StrEnum):
    """Point-in-time contract for a market scan."""

    LIVE = "live"
    HISTORICAL = "historical"


class ScanStatus(StrEnum):
    """Whether the final verdicts passed their required validation gates."""

    COMPLETE = "COMPLETE"
    DEGRADED = "DEGRADED"
    INCOMPLETE = "INCOMPLETE"


class SectorVerdict(BaseModel):
    """The verdict on one US sector, read through its SPDR sector ETF."""

    sector: str = Field(
        description=(
            "Exactly one of: Technology, Financial Services, Energy, Healthcare, "
            "Consumer Cyclical, Consumer Defensive, Industrials, Basic Materials, "
            "Real Estate, Utilities, Communication Services."
        ),
    )
    outlook: SectorOutlook = Field(
        description=(
            "Bullish or Bearish only when the evidence points one way for the next "
            "1–4 weeks; Neutral when it is mixed, flat or too thin to call."
        ),
    )
    conviction: Conviction = Field(
        description=(
            "High only when the macro regime, relative performance across windows "
            "and catalysts agree; Low when the verdict rests on a single signal."
        ),
    )
    rationale: str = Field(
        description=(
            "One to three sentences citing the sector ETF's returns and spread "
            "versus SPY across windows, and the macro or catalyst link."
        ),
    )
    invalidation: str = Field(
        description="The observable condition that would overturn this verdict.",
    )

    @field_validator("sector", mode="before")
    @classmethod
    def _strip_sector(cls, v):
        """Strip only; the sector name is matched in the Market Strategist node.

        A raising validator would fail the whole structured call and lose every
        other verdict with it (#1058); an unknown name costs one verdict there.
        """
        return v.strip() if isinstance(v, str) else v


class MarketRiskReview(BaseModel):
    summary: str = Field(description="What was audited, including unavailable evidence.")
    findings: list[str] = Field(description="Material findings only. Each states the claim, source/date, severity, required correction and monitoring condition. Empty if none.")


class MarketRiskResolution(BaseModel):
    finding_id: str
    decision: Literal["accepted", "rejected"]
    rationale: str = Field(description="Evidence/date and correction made, or evidence supporting rejection.")


class MarketScanReport(BaseModel):
    """Structured output produced by the Market Strategist.

    Two results: the market regime and a verdict on every US sector. Neither is
    a position call.
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
    sector_verdicts: list[SectorVerdict] = Field(
        description=(
            "Exactly one verdict for each of the eleven US sectors, no more and no "
            "fewer. Use Neutral rather than forcing a direction the evidence does "
            "not support."
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
    parts.extend(["## Sector Verdicts", ""])

    if not report.sector_verdicts:
        parts.append(
            "_Sector verdicts were not completed; see warnings._"
            if report.status is ScanStatus.INCOMPLETE else
            "_No sector verdict was produced._"
        )
        return "\n".join(parts)

    def cell(text):
        # Pipes or newlines inside a cell would break the table.
        return text.replace("|", "\\|").replace("\n", " ")

    parts.extend([
        "| Sector | ETF | Outlook | Conviction | Rationale | Invalidated if |",
        "| --- | --- | --- | --- | --- | --- |",
    ])
    for v in report.sector_verdicts:
        parts.append(
            f"| {v.sector} | {SECTOR_ETFS.get(v.sector, '?')} | {v.outlook.value} | "
            f"{v.conviction.value} | {cell(v.rationale)} | {cell(v.invalidation)} |"
        )

    parts.extend([
        "",
        "_Sector verdicts read the sector ETFs over the next 1–4 weeks. They are "
        "not position calls._",
    ])
    return "\n".join(parts)
