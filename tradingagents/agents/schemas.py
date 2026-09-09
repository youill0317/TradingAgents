"""Pydantic schemas used by agents that produce structured output.

The framework's primary artifact is still prose: each agent's natural-language
reasoning is what users read in the saved markdown reports and what the
downstream agents read as context.  Structured output is layered onto the
three decision-making agents (Research Manager, Trader, Portfolio Manager)
so that:

- Their outputs follow consistent section headers across runs and providers
- Each provider's native structured-output mode is used (json_schema for
  OpenAI/xAI, response_schema for Gemini, tool-use for Anthropic)
- Schema field descriptions become the model's output instructions, freeing
  the prompt body to focus on context and the rating-scale guidance
- A render helper turns the parsed Pydantic instance back into the same
  markdown shape the rest of the system already consumes, so display,
  memory log, and saved reports keep working unchanged
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, field_validator

# LLMs sometimes write a placeholder string ("None", "N/A", ...) into an optional
# numeric field instead of omitting it. Coerce those to None so the structured
# call validates instead of erroring (#1058). Pydantic still parses real numeric
# strings ("189.5") to float.
_NULLISH_FLOAT = {"", "none", "n/a", "na", "null", "nil", "-", "tbd", "unknown"}


def _coerce_optional_float(value):
    if isinstance(value, str) and value.strip().lower() in _NULLISH_FLOAT:
        return None
    return value


# ---------------------------------------------------------------------------
# Shared rating types
# ---------------------------------------------------------------------------


class PortfolioRating(str, Enum):
    """5-tier rating used by the Research Manager and Portfolio Manager."""

    BUY = "Buy"
    OVERWEIGHT = "Overweight"
    HOLD = "Hold"
    UNDERWEIGHT = "Underweight"
    SELL = "Sell"


class TraderAction(str, Enum):
    """3-tier transaction direction used by the Trader.

    The Trader's job is to translate the Research Manager's investment plan
    into a concrete transaction proposal: should the desk execute a Buy, a
    Sell, or sit on Hold this round.  Position sizing and the nuanced
    Overweight / Underweight calls happen later at the Portfolio Manager.
    """

    BUY = "Buy"
    HOLD = "Hold"
    SELL = "Sell"


# ---------------------------------------------------------------------------
# Research Manager
# ---------------------------------------------------------------------------


class ResearchPlan(BaseModel):
    """Structured investment plan produced by the Research Manager.

    Hand-off to the Trader: the recommendation pins the directional view,
    the rationale captures which side of the bull/bear debate carried the
    argument, and the strategic actions translate that into concrete
    instructions the trader can execute against.
    """

    recommendation: PortfolioRating = Field(
        description=(
            "The investment recommendation. Exactly one of Buy / Overweight / "
            "Hold / Underweight / Sell. Reserve Hold for situations where the "
            "evidence on both sides is genuinely balanced; otherwise commit to "
            "the side with the stronger arguments."
        ),
    )
    rationale: str = Field(
        description=(
            "Conversational summary of the key points from both sides of the "
            "debate, ending with which arguments led to the recommendation. "
            "Speak naturally, as if to a teammate."
        ),
    )
    strategic_actions: str = Field(
        description=(
            "Concrete steps for the trader to implement the recommendation, "
            "including position sizing guidance consistent with the rating."
        ),
    )


def render_research_plan(plan: ResearchPlan) -> str:
    """Render a ResearchPlan to markdown for storage and the trader's prompt context."""
    return "\n".join([
        f"**Recommendation**: {plan.recommendation.value}",
        "",
        f"**Rationale**: {plan.rationale}",
        "",
        f"**Strategic Actions**: {plan.strategic_actions}",
    ])


# ---------------------------------------------------------------------------
# Trader
# ---------------------------------------------------------------------------


class TraderProposal(BaseModel):
    """Structured transaction proposal produced by the Trader.

    The trader reads the Research Manager's investment plan and the analyst
    reports, then turns them into a concrete transaction: what action to
    take, the reasoning that justifies it, and the practical levels for
    entry, stop-loss, and sizing.
    """

    action: TraderAction = Field(
        description="The transaction direction. Exactly one of Buy / Hold / Sell.",
    )
    reasoning: str = Field(
        description=(
            "The case for this action, anchored in the analysts' reports and "
            "the research plan. Two to four sentences."
        ),
    )
    entry_price: float | None = Field(
        default=None,
        description="Optional entry price target in the instrument's quote currency.",
    )
    stop_loss: float | None = Field(
        default=None,
        description="Optional stop-loss price in the instrument's quote currency.",
    )
    position_sizing: str | None = Field(
        default=None,
        description="Optional sizing guidance, e.g. '5% of portfolio'.",
    )

    @field_validator("entry_price", "stop_loss", mode="before")
    @classmethod
    def _nullish_float_to_none(cls, v):
        return _coerce_optional_float(v)


def render_trader_proposal(proposal: TraderProposal) -> str:
    """Render a TraderProposal to markdown.

    The trailing ``FINAL TRANSACTION PROPOSAL: **BUY/HOLD/SELL**`` line is
    preserved for backward compatibility with the analyst stop-signal text
    and any external code that greps for it.
    """
    parts = [
        f"**Action**: {proposal.action.value}",
        "",
        f"**Reasoning**: {proposal.reasoning}",
    ]
    if proposal.entry_price is not None:
        parts.extend(["", f"**Entry Price**: {proposal.entry_price}"])
    if proposal.stop_loss is not None:
        parts.extend(["", f"**Stop Loss**: {proposal.stop_loss}"])
    if proposal.position_sizing:
        parts.extend(["", f"**Position Sizing**: {proposal.position_sizing}"])
    parts.extend([
        "",
        f"FINAL TRANSACTION PROPOSAL: **{proposal.action.value.upper()}**",
    ])
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Portfolio Manager
# ---------------------------------------------------------------------------


class PortfolioDecision(BaseModel):
    """Structured output produced by the Portfolio Manager.

    The model fills every field as part of its primary LLM call; no separate
    extraction pass is required. Field descriptions double as the model's
    output instructions, so the prompt body only needs to convey context and
    the rating-scale guidance.
    """

    rating: PortfolioRating = Field(
        description=(
            "The final position rating. Exactly one of Buy / Overweight / Hold / "
            "Underweight / Sell, picked based on the analysts' debate."
        ),
    )
    executive_summary: str = Field(
        description=(
            "A concise action plan covering entry strategy, position sizing, "
            "key risk levels, and time horizon. Two to four sentences."
        ),
    )
    investment_thesis: str = Field(
        description=(
            "Detailed reasoning anchored in specific evidence from the analysts' "
            "debate. If prior lessons are referenced in the prompt context, "
            "incorporate them; otherwise rely solely on the current analysis."
        ),
    )
    price_target: float | None = Field(
        default=None,
        description="Optional target price in the instrument's quote currency.",
    )
    time_horizon: str | None = Field(
        default=None,
        description="Optional recommended holding period, e.g. '3-6 months'.",
    )

    @field_validator("price_target", mode="before")
    @classmethod
    def _nullish_float_to_none(cls, v):
        return _coerce_optional_float(v)


def render_pm_decision(decision: PortfolioDecision) -> str:
    """Render a PortfolioDecision back to the markdown shape the rest of the system expects.

    Memory log, CLI display, and saved report files all read this markdown,
    so the rendered output preserves the exact section headers (``**Rating**``,
    ``**Executive Summary**``, ``**Investment Thesis**``) that downstream
    parsers and the report writers already handle.
    """
    parts = [
        f"**Rating**: {decision.rating.value}",
        "",
        f"**Executive Summary**: {decision.executive_summary}",
        "",
        f"**Investment Thesis**: {decision.investment_thesis}",
    ]
    if decision.price_target is not None:
        parts.extend(["", f"**Price Target**: {decision.price_target}"])
    if decision.time_horizon:
        parts.extend(["", f"**Time Horizon**: {decision.time_horizon}"])
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Sentiment Analyst
# ---------------------------------------------------------------------------


class SentimentBand(str, Enum):
    """Discrete sentiment direction produced by the Sentiment Analyst.

    Six tiers keep the signal granular enough to be actionable while remaining
    small enough for every provider to map reliably from its JSON output.
    """

    BULLISH = "Bullish"
    MILDLY_BULLISH = "Mildly Bullish"
    NEUTRAL = "Neutral"
    MIXED = "Mixed"
    MILDLY_BEARISH = "Mildly Bearish"
    BEARISH = "Bearish"


class SentimentReport(BaseModel):
    """Structured sentiment report produced by the Sentiment Analyst.

    Replaces the previous free-form prose output so downstream consumers
    (dashboards, audit logs, PDF renderers, other agents) can read
    ``overall_band`` and ``overall_score`` without maintaining fragile regex
    fallbacks that drift with every model release. ``narrative`` preserves the
    rich source-by-source analysis; ``render_sentiment_report`` prepends a
    deterministic header so the saved report stays human-readable.
    """

    overall_band: SentimentBand = Field(
        description=(
            "Overall sentiment direction. Exactly one of: "
            "Bullish / Mildly Bullish / Neutral / Mixed / Mildly Bearish / Bearish. "
            "Use Mixed when sources point in clearly different directions. "
            "Use Neutral only when all sources are genuinely silent or non-committal."
        ),
    )
    overall_score: float = Field(
        ge=0.0,
        le=10.0,
        description=(
            "Numeric sentiment intensity on a 0–10 scale. "
            "0 = maximally bearish, 5 = neutral, 10 = maximally bullish. "
            "Guideline for consistency with overall_band: "
            "Bullish ~6.5–10, Mildly Bullish ~5.5–6.4, Neutral/Mixed ~4.5–5.5, "
            "Mildly Bearish ~3.5–4.4, Bearish ~0–3.4. "
            "Only the 0–10 bounds are enforced."
        ),
    )
    confidence: Literal["low", "medium", "high"] = Field(
        description=(
            "Confidence in the assessment based on data quality and sample size. "
            "Use 'low' when one or more sources returned a placeholder or fewer "
            "than 5 data points; 'medium' when data is present but sparse; "
            "'high' when all three sources returned substantive data."
        ),
    )
    narrative: str = Field(
        description=(
            "Full sentiment report covering, in order: "
            "(1) source-by-source breakdown with specific evidence (cite message "
            "counts, ratios, notable posts); "
            "(2) cross-source divergences and alignments; "
            "(3) dominant narrative themes; "
            "(4) catalysts and risks surfaced by the data; "
            "(5) a markdown table summarising key sentiment signals, their "
            "direction, source, and supporting evidence. "
            "Keep it informative and substantive: develop each section thoroughly "
            "with concrete evidence so every point adds new signal for the trader."
        ),
    )


def render_sentiment_report(report: SentimentReport) -> str:
    """Render a SentimentReport to the markdown shape the rest of the system expects.

    The structured header (band + score + confidence) is prepended to the
    narrative so the saved report is both human-readable and machine-parseable
    without regex.
    """
    return "\n".join([
        f"**Overall Sentiment:** **{report.overall_band.value}** "
        f"(Score: {report.overall_score:.1f}/10)",
        f"**Confidence:** {report.confidence.capitalize()}",
        "",
        report.narrative,
    ])


# ---------------------------------------------------------------------------
# Market Strategist
# ---------------------------------------------------------------------------


class MarketRegime(str, Enum):
    """Coarse read on what the market is doing, used by the Market Strategist.

    Deliberately coarse: the regime label is a routing hint for the candidate
    list, not a forecast.  The nuance lives in ``regime_evidence``.
    """

    RISK_ON = "Risk-On"
    RISK_OFF = "Risk-Off"
    ROTATION = "Rotation"
    RANGE_BOUND = "Range-Bound"
    STRESSED = "Stressed"


class Conviction(str, Enum):
    """How strongly a candidate is put forward."""

    HIGH = "High"
    MEDIUM = "Medium"
    LOW = "Low"


class ScanMode(str, Enum):
    """Point-in-time contract for a market scan."""

    LIVE = "live"
    HISTORICAL = "historical"


class ScanStatus(str, Enum):
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


class MarketScanReport(BaseModel):
    """Structured output produced by the Market Strategist.

    Unlike the per-ticker agents, this one answers "what should we look at?"
    rather than "should we buy this?".  It deliberately carries no rating: a
    shortlist entry is a prompt for further analysis, not a position call.
    """

    status: ScanStatus = Field(
        default=ScanStatus.COMPLETE,
        description="Completeness of the validated scan output.",
    )
    warnings: list[str] = Field(
        default_factory=list,
        description="Machine-readable reasons for degraded or incomplete output.",
    )
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
        "## Candidates",
        "",
    ]

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
