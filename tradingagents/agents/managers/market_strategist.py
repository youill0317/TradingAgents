"""Market Strategist: turns the macro and sector reports into a shortlist.

The counterpart to the Portfolio Manager, but for the scan workflow. It makes
no position call — the output is a list of names worth analysing, each with the
reason it earned a place.
"""

from __future__ import annotations

import logging

from tradingagents.agents.schemas import (
    Conviction,
    MarketScanReport,
    ScanMode,
    ScanStatus,
    render_market_scan_report,
)
from tradingagents.agents.utils.agent_utils import get_language_instruction
from tradingagents.agents.utils.structured import (
    NO_EXTERNAL_TOOLS,
    StructuredOutputError,
    bind_structured,
    invoke_structured_required,
)

logger = logging.getLogger(__name__)

def _screen_rows(sector_report: str) -> dict[str, str]:
    """Extract only rows from the equity-screen table, keyed by ticker.

    Upper-case prose tokens such as GDP, VIX and ETF are intentionally ignored.
    The sector is taken from the nearest ``###`` heading and becomes part of
    the grounding key, so a real ticker with a fabricated sector is rejected.
    """
    rows: dict[str, str] = {}
    sector = ""
    in_screen = False
    for raw in (sector_report or "").splitlines():
        line = raw.strip()
        if line.startswith("## Equity screen"):
            in_screen = True
            continue
        if not in_screen:
            continue
        if line.startswith("## ") and not line.startswith("### "):
            in_screen = False
            continue
        if line.startswith("### "):
            sector = line[4:].split(" (", 1)[0].strip()
            continue
        if not line.startswith("|") or line.startswith("| ---"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) < 2 or cells[0].lower() == "symbol" or not sector:
            continue
        ticker = cells[0].upper()
        if ticker and ticker != "?":
            rows[ticker] = sector
    return rows


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
    named = _screen_rows(sector_report)
    kept = []
    for c in report.candidates:
        if c.ticker in named and c.sector.casefold() == named[c.ticker].casefold():
            kept.append(c)
        else:
            # Never silent: a fabricated symbol is the failure mode this whole
            # workflow has to avoid, so it is visible when it happens.
            logger.warning(
                "Market Strategist: dropping candidate %r — it does not appear "
                "in the validated screen rows with sector %r.", c.ticker, c.sector,
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
        screen_evidence = (
            state.get("screen_evidence", "")
            if "screen_evidence" in state
            else sector_report
        )
        limit = state.get("candidate_limit", 10)
        scan_mode = ScanMode(state.get("scan_mode", ScanMode.LIVE.value))
        data_warnings = list(state.get("data_warnings", []))

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

---

**Validated raw equity-screen evidence:**
{screen_evidence or "No successful equity screen was captured."}

{NO_EXTERNAL_TOOLS}""" + get_language_instruction()

        if scan_mode is ScanMode.HISTORICAL:
            report = MarketScanReport(
                status=ScanStatus.INCOMPLETE,
                warnings=["UNSUPPORTED_HISTORICAL_UNIVERSE", *data_warnings],
                regime="Range-Bound",
                regime_evidence=(
                    "Historical macro and sector context may be reviewed, but a "
                    "point-in-time equity universe is unavailable."
                ),
                sector_view="No historical candidate universe was evaluated.",
                candidates=[],
            )
        else:
            try:
                report = invoke_structured_required(
                    structured_llm, prompt, MarketScanReport, "Market Strategist"
                )
                report = _ground_candidates(report, screen_evidence, limit)
                if "SCREEN_EVIDENCE_MISSING" in data_warnings:
                    report = report.model_copy(update={
                        "status": ScanStatus.INCOMPLETE,
                        "warnings": [*report.warnings, *data_warnings],
                        "candidates": [],
                    })
                elif data_warnings:
                    report = report.model_copy(update={
                        "status": ScanStatus.DEGRADED,
                        "warnings": [*report.warnings, *data_warnings],
                        "candidates": [
                            c.model_copy(update={"conviction": Conviction.LOW})
                            for c in report.candidates
                        ],
                    })
            except StructuredOutputError as exc:
                logger.error("%s", exc)
                report = MarketScanReport(
                    status=ScanStatus.INCOMPLETE,
                    warnings=["STRUCTURED_OUTPUT_INVALID"],
                    regime="Range-Bound",
                    regime_evidence="Validated structured output was unavailable.",
                    sector_view="No candidate selection was accepted.",
                    candidates=[],
                )

        return {
            "market_scan_report": render_market_scan_report(report),
            "scan_status": report.status.value,
            "scan_warnings": report.warnings,
        }

    return market_strategist_node
