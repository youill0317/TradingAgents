"""The market analysis state, shaped like the ticker analysis's ``AgentState``.

The research and risk debates reuse the ticker workflow's debate states, so the
same ``ConditionalLogic`` drives how many rounds each debate runs.
"""

from typing import Annotated

from langgraph.graph import MessagesState

from tradingagents.agents.state import InvestDebateState, RiskDebateState


class MarketAgentState(MessagesState):
    trade_date: Annotated[str, "The analysis date; data is served as of it"]

    # analyst step
    macro_report: Annotated[str, "Report from the Macro Analyst"]
    market_report: Annotated[str, "Report from the Market Analyst"]
    news_report: Annotated[str, "Report from the Market News Analyst"]
    sentiment_report: Annotated[str, "Report from the Market Sentiment Analyst"]
    sector_report: Annotated[str, "Report from the Sector Analyst"]

    # research debate step
    investment_debate_state: Annotated[InvestDebateState, "The bull/bear debate on the market"]
    market_plan: Annotated[str, "Market outlook from the Market Research Manager"]

    sector_proposal: Annotated[str, "Sector positioning proposal from the Sector Strategist"]

    # risk debate step
    risk_debate_state: Annotated[RiskDebateState, "The risk analysts' debate on the proposal"]
    final_market_decision: Annotated[str, "Final call from the Chief Market Strategist"]
    final_regime: Annotated[str, "The final market regime, or REVIEW when it has none"]
    final_sector_ratings: Annotated[dict, "Sector -> Bullish / Neutral / Bearish, or REVIEW when it has none"]
    past_context: Annotated[str, "Lessons from settled past market calls, written by the Memory Log step"]
    memory_note: Annotated[str, "What the Memory Log step could not settle or read this run; empty when all went well"]
