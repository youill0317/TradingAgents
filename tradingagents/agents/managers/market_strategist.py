"""Market Strategist: turns the macro and sector reports into a shortlist.

The counterpart to the Portfolio Manager, but for the scan workflow. It makes
no position call — the output is a list of names worth analysing, each with the
reason it earned a place.
"""

from __future__ import annotations

import logging
import re

from tradingagents.agents.schemas import MarketScanReport, render_market_scan_report
from tradingagents.agents.utils.agent_utils import get_language_instruction
from tradingagents.agents.utils.structured import (
    NO_EXTERNAL_TOOLS,
    bind_structured,
    invoke_structured_or_freetext,
)

logger = logging.getLogger(__name__)

# A token in the Sector Analyst's report that could be a ticker (XOM, BRK.B).
# Deliberately permissive — it only has to catch a symbol that appears *nowhere*
# in the report, and a false drop costs a real candidate.
_TICKER_TOKEN = re.compile(r"\b[A-Z][A-Z0-9]{0,5}(?:[.\-][A-Z]{1,2})?\b")


def _ground_candidates(report: MarketScanReport, sector_report: str, limit: int):
    """Drop candidates the Sector Analyst never named, then apply ``limit``.

    Both rules are stated in the prompt, but a shortlist entry is the one field
    in this workflow that a user is told to feed straight into ``analyze``, so
    it is checked rather than trusted — the same reason the per-ticker schemas
    put their rating vocabularies in an Enum instead of the prompt body.

    Enforced here rather than in the schema on purpose: ``max_length`` on the
    list and a raising ticker validator would both fail the whole structured
    call and fall back to free text, losing the regime call and sector view to
    save one bad row.
    """
    named = set(_TICKER_TOKEN.findall(sector_report or ""))
    kept = []
    for c in report.candidates:
        if c.ticker in named:
            kept.append(c)
        else:
            # Never silent: a fabricated symbol is the failure mode this whole
            # workflow has to avoid, so it is visible when it happens.
            logger.warning(
                "Market Strategist: dropping candidate %r — it does not appear "
                "in the Sector Analyst's report.", c.ticker,
            )
    if len(kept) > limit:
        logger.info(
            "Market Strategist: trimming %d candidates to the %d requested.",
            len(kept), limit,
        )
    return report.model_copy(update={"candidates": kept[:limit]})


def create_market_strategist(llm):
    structured_llm = bind_structured(llm, MarketScanReport, "Market Strategist")

    def market_strategist_node(state) -> dict:
        macro_report = state.get("macro_report", "")
        sector_report = state.get("sector_report", "")
        limit = state.get("candidate_limit", 10)

        prompt = f"""As the Market Strategist, synthesise the macro and sector work below into a single regime call and a shortlist of names worth analysing in depth.

You are not deciding whether to buy anything. Your shortlist is the input to a separate, deeper per-ticker analysis, so the bar is "this deserves a closer look", not "this is a position".

**Rules that matter more than completeness:**
- Only include tickers that appear in the Sector Analyst's report. If a name is not there, it does not exist for your purposes. A fabricated ticker would be handed to the analysis pipeline as if it were real.
- Return at most {limit} candidates. A short, well-argued list is worth more than a padded one, and an empty list is the correct answer when the evidence supports no name.
- Every candidate's thesis must connect the name to both the regime and its sector's position. "It went up today" is not a thesis.
- Set conviction honestly: High only when macro and sector evidence point the same way. If the two reports contradict each other, say so in the regime evidence and let conviction reflect it rather than splitting the difference silently.

---

**Macro Analyst report:**
{macro_report}

---

**Sector Analyst report:**
{sector_report}

{NO_EXTERNAL_TOOLS}""" + get_language_instruction()

        report = invoke_structured_or_freetext(
            structured_llm,
            llm,
            prompt,
            lambda r: render_market_scan_report(
                _ground_candidates(r, sector_report, limit)
            ),
            "Market Strategist",
        )

        return {"market_scan_report": report}

    return market_strategist_node
