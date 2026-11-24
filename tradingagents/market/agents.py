"""The market workflow's debaters and managers, one for each role in the ticker workflow.

| Ticker workflow       | Market workflow          |
| --------------------- | ------------------------ |
| Bull / Bear Researcher | Market Bull / Bear Researcher |
| Research Manager      | Market Research Manager  |
| Trader                | Sector Strategist        |
| Aggressive / Conservative / Neutral Analyst | the same three, on the sector proposal |
| Portfolio Manager     | Chief Market Strategist  |

Each manager answers with a ``MarketCall`` through the same structured-output
helpers as its ticker counterpart, and falls back to free text the same way.
"""

from __future__ import annotations

from tradingagents.agents.context import (
    get_language_instruction,
    opponent_argument_or_opening,
    report_or_absent,
)
from tradingagents.agents.structured import (
    NO_EXTERNAL_TOOLS,
    bind_structured,
    invoke_structured,
    invoke_structured_or_freetext,
)
from tradingagents.market.analysts import MARKET_CONTEXT
from tradingagents.market.schemas import (
    EVIDENCE_SOURCES,
    SECTORS,
    MarketCall,
    call_evidence,
    call_ratings,
    parse_call,
    render_call,
)
from tradingagents.market.scoring import market_horizon_days, regime_definitions, verdict_definition

REGIMES = "Risk-On / Risk-Off / Rotation / Range-Bound / Stressed"



def call_format() -> str:
    """What a market call claims and how to write it, for the horizon the run is scored over.

    The definitions are the ones ``tradingagents.market.scoring`` scores the
    call against, so every manager knows what its regime and verdicts claim.
    """
    days = market_horizon_days()
    return (
        "## What the call claims\n\n"
        f"{regime_definitions(days)}\n\n{verdict_definition(days)}\n\n"
        "## Output\n\n"
        f"Start with the regime on its own line, \"**Market Regime**: \" followed by exactly one of {REGIMES}. "
        "Then give one line per sector, \"<Sector>: <Bullish|Neutral|Bearish> (<High|Medium|Low> conviction) — "
        "rationale; invalidated if ...\", for each of: " + ", ".join(SECTORS) + ". Bullish or Bearish needs "
        "evidence that the sector will beat or trail SPY; mixed or thin evidence is Neutral, and conflict alone "
        "is not a reason for Neutral: weigh it.\n\n"
        "For every sector also record where each kind of evidence points against SPY (outperform, "
        "underperform, mixed, or none when that report says nothing about the sector or was not in this run): "
        + ", ".join(f"{src} ({report.replace('_', ' ')})" for src, report in EVIDENCE_SOURCES.items()) + ". "
        "Record what each report says, not what your verdict is; never fill a missing report with a reading. "
        "Evidence derived from the same prices (trend, moving averages, drawdown, relative performance) is one "
        "kind of evidence, not several. Then give base, bull and bear scenarios (assumptions, implied regime, "
        "favoured sectors, the observation that would confirm each; qualitative likelihoods only) and the "
        "strongest case against the call."
    )


def _language():
    """The configured language, keeping the call's labels and values readable by the program."""
    instruction = get_language_instruction()
    if not instruction:
        return ""
    return instruction + (
        " Also keep \"**Market Regime**:\", the regime label, the sector names and"
        " Bullish/Neutral/Bearish in English."
    )


def _reports(state) -> str:
    return (
        f"Macro report: {report_or_absent(state.get('macro_report'), 'macro')}\n\n"
        f"Market report: {report_or_absent(state.get('market_report'), 'market')}\n\n"
        f"Market news report: {report_or_absent(state.get('news_report'), 'market news')}\n\n"
        f"Market sentiment report: {report_or_absent(state.get('sentiment_report'), 'market sentiment')}\n\n"
        f"Sector report: {report_or_absent(state.get('sector_report'), 'sector')}"
        + (f"\n\nPolicy and industry report (from web search; check its evidence labels): {policy}"
           if (policy := (state.get("policy_report") or "").strip()) else "")
    )


# --- Research debate ---------------------------------------------------------

def _create_researcher(llm, side: str):
    bull = side == "bull"
    name = "Bull Analyst" if bull else "Bear Analyst"
    opponent = "bear analyst" if bull else "bull analyst"
    stance = (
        "the upside case for US equities and their sectors: improving growth or liquidity, broadening "
        "participation, sector leadership with evidence behind it, and catalysts that could lift prices"
        if bull else
        "the downside case for US equities and their sectors: slowing growth, tightening conditions, "
        "narrow or fading leadership, stretched positioning, and catalysts that could hit prices"
    )

    def node(state) -> dict:
        debate = state["investment_debate_state"]
        last = opponent_argument_or_opening(debate.get("current_response", ""), opponent)
        prompt = f"""You are the {name} in a debate about the market over the next {market_horizon_days()} trading days. Build {stance}. {MARKET_CONTEXT}

Ground every claim in the analysts' figures and dates. Say what you expect of the index, and name the sectors you expect to beat SPY and the ones you expect to trail it. Engage directly with the {opponent}'s last argument, conceding where the evidence is against you, and debate conversationally rather than listing data.

{_reports(state)}

Conversation history of the debate: {debate.get("history", "")}
Last {opponent} argument: {last}
""" + _language()
        argument = f"{name}: {llm.invoke(prompt).content}"
        mine, theirs = ("bull_history", "bear_history") if bull else ("bear_history", "bull_history")
        return {"investment_debate_state": {
            "history": debate.get("history", "") + "\n" + argument,
            mine: debate.get(mine, "") + "\n" + argument,
            theirs: debate.get(theirs, ""),
            "current_response": argument,
            "count": debate["count"] + 1,
        }}

    return node


def create_market_bull_researcher(llm):
    return _create_researcher(llm, "bull")


def create_market_bear_researcher(llm):
    return _create_researcher(llm, "bear")


def create_market_research_manager(llm):
    structured_llm = bind_structured(llm, MarketCall, "Market Research Manager")

    def node(state) -> dict:
        debate = state["investment_debate_state"]
        prompt = f"""As the Market Research Manager and debate facilitator, critically evaluate the bull/bear debate and deliver the research team's market outlook for the Sector Strategist. {MARKET_CONTEXT}

The debate always contains conflicting arguments; deciding which side is stronger, market-wide and sector by sector, is the job. Commit to the stronger case, sized by how decisively it wins. Weigh the cases on their merits, independent of which side spoke first or last.

**Debate History:**
{debate.get("history", "")}

{call_format()}
Then a **Rationale** section on which arguments decided it.

{NO_EXTERNAL_TOOLS}""" + _language()
        plan = invoke_structured_or_freetext(
            structured_llm, llm, prompt, lambda c: render_call(c, "Rationale"), "Market Research Manager")
        return {
            "investment_debate_state": {**debate, "current_response": plan},
            "market_plan": plan,
        }

    return node


def create_sector_strategist(llm):
    structured_llm = bind_structured(llm, MarketCall, "Sector Strategist")

    def node(state) -> dict:
        sector_report = report_or_absent(state.get("sector_report"), "sector")
        prompt = f"""You are the Sector Strategist. Turn the research team's market outlook into a concrete sector positioning proposal: which sectors to overweight, hold at market weight or underweight against SPY over the next {market_horizon_days()} trading days, how strongly, and what hedges or exits apply. {MARKET_CONTEXT}

Ground relative strength in the sector report's figures, and take direction and strategy from the research outlook. A Bullish verdict (the sector beats SPY) is an overweight, Bearish (it trails SPY) an underweight, sized by conviction.

Sector report:
{sector_report}

Research team's market outlook:
{state.get("market_plan", "")}

{call_format()}
Then a **Positioning** section: the tilts, their sizes, and the conditions for exiting them.

{NO_EXTERNAL_TOOLS}""" + _language()
        proposal = invoke_structured_or_freetext(
            structured_llm, llm, prompt, lambda c: render_call(c, "Positioning"), "Sector Strategist")
        return {"sector_proposal": proposal}

    return node


# --- Risk debate ---------------------------------------------------------------

_RISK_ROLES = {
    "aggressive": (
        "Aggressive Risk Analyst",
        "Champion the high-reward reading of the proposal: where its tilts are too timid, where leadership "
        "and catalysts justify more conviction, and what the cautious views would miss.",
    ),
    "conservative": (
        "Conservative Risk Analyst",
        "Protect against the downside: where the proposal overreaches, which tilts rest on thin or stale "
        "evidence, what concentration, drawdown and event risk it carries, and where Neutral is warranted.",
    ),
    "neutral": (
        "Neutral Risk Analyst",
        "Weigh both: where the aggressive view's upside and the conservative view's caution are each right, "
        "and the balanced adjustment the evidence supports.",
    ),
}


def _create_debator(llm, role: str):
    title, stance = _RISK_ROLES[role]
    speaker = role.capitalize()
    others = [r for r in _RISK_ROLES if r != role]

    def node(state) -> dict:
        debate = state["risk_debate_state"]
        replies = "\n".join(
            f"Last argument from the {other} analyst: "
            + opponent_argument_or_opening(debate.get(f"current_{other}_response", ""), f"{other} analyst")
            for other in others
        )
        prompt = f"""As the {title}, debate the Sector Strategist's proposal. {stance} {MARKET_CONTEXT}

Respond directly to each point the other analysts make, with data-driven rebuttals. If no one has spoken yet, present your own argument from the evidence.

Sector Strategist's proposal:
{state.get("sector_proposal", "")}

{_reports(state)}

Current conversation history: {debate.get("history", "")}
{replies}

Debate and persuade rather than only presenting data. Output conversationally, without special formatting.""" + _language()
        argument = f"{title.replace(' Risk', '')}: {llm.invoke(prompt).content}"
        updated = {key: debate.get(key, "") for key in (
            "aggressive_history", "conservative_history", "neutral_history",
            "current_aggressive_response", "current_conservative_response", "current_neutral_response")}
        updated.update({
            "history": debate.get("history", "") + "\n" + argument,
            f"{role}_history": debate.get(f"{role}_history", "") + "\n" + argument,
            f"current_{role}_response": argument,
            "latest_speaker": speaker,
            "count": debate["count"] + 1,
        })
        return {"risk_debate_state": updated}

    return node


def create_market_aggressive_debator(llm):
    return _create_debator(llm, "aggressive")


def create_market_conservative_debator(llm):
    return _create_debator(llm, "conservative")


def create_market_neutral_debator(llm):
    return _create_debator(llm, "neutral")


# --- Final call ------------------------------------------------------------------

def create_chief_market_strategist(llm):
    structured_llm = bind_structured(llm, MarketCall, "Chief Market Strategist")

    def node(state) -> dict:
        debate = state["risk_debate_state"]
        past_context = state.get("past_context", "")
        lessons = f"- Lessons from past market calls and outcomes:\n{past_context}\n" if past_context else ""
        prompt = f"""As the Chief Market Strategist, synthesize the risk analysts' debate and deliver the final market call. {MARKET_CONTEXT}

**Context:**
- Research team's market outlook: **{state.get("market_plan", "")}**
- Sector Strategist's proposal: **{state.get("sector_proposal", "")}**
{lessons}
**Risk Analysts Debate History:**
{debate.get("history", "")}

---

Ground every conclusion in specific evidence from the analysts. The risk debate always contains conflicting stances; deciding which is stronger is the job. Commit to the stronger case, sized by how decisively it wins, and do not force a direction to appear decisive. Weigh the analysts on their merits, independent of speaking order.

{call_format()}
Then an **Executive Summary**: the call and what would change it.

{NO_EXTERNAL_TOOLS}""" + _language()

        # The typed call is the decision; read back from text, a verdict quoted
        # in the reasoning could replace it.
        call = invoke_structured(structured_llm, prompt, "Chief Market Strategist")
        if call is not None:
            decision = render_call(call, "Executive Summary")
            regime, ratings, convictions = call_ratings(call)
            evidence = call_evidence(call)
        else:
            decision = llm.invoke(prompt).content
            regime, ratings, convictions = parse_call(decision)
            evidence = {}   # the per-source leans are read from the typed call only
        return {
            "risk_debate_state": {**debate, "latest_speaker": "Judge"},
            "final_market_decision": decision,
            "final_regime": regime,
            "final_sector_ratings": ratings,
            "final_sector_convictions": convictions,
            "final_sector_evidence": evidence,
        }

    return node
