"""The market analysts: each gathers its own data with tools, like the ticker analysts.

They run side by side, each on a private message history, and file one report.
"""

from dataclasses import dataclass

from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

from tradingagents.agents.analysts.turn import take_turn
from tradingagents.agents.context import get_language_instruction
from tradingagents.agents.tools import get_global_news, get_macro_indicators, get_prediction_markets
from tradingagents.dataflows.market_scan import SECTOR_ETFS
from tradingagents.market.tools import (
    get_economic_calendar,
    get_global_asset_returns,
    get_market_community_posts,
    get_market_participation,
    get_regional_macro,
    get_sector_performance,
)

MARKET_CONTEXT = (
    "This is a market-wide analysis: there is no single ticker. Your subject is the "
    "global economy, the US equity market and its eleven sectors."
)
_TABLE = " Append a Markdown table at the end of the report organising its key points."


@dataclass(frozen=True)
class MarketAnalystSpec:
    key: str
    agent_node: str
    report_key: str
    tools: tuple
    instructions: str


ANALYST_SPECS: dict[str, MarketAnalystSpec] = {
    spec.key: spec for spec in (
        MarketAnalystSpec(
            key="macro",
            agent_node="Macro Analyst",
            report_key="macro_report",
            tools=(get_macro_indicators, get_regional_macro, get_prediction_markets),
            instructions=(
                "You are a macro economist. Establish the macro regime as of the analysis date: growth, "
                "inflation, labour, policy rates and financial conditions in the US, and in the eurozone, UK, "
                "China, Japan, Korea and India. Use get_macro_indicators(indicator, curr_date, look_back_days) "
                "for US series from FRED (e.g. 'cpi', 'core_pce', 'unemployment', 'fed_funds_rate', "
                "'10y_treasury', 'yield_curve', 'VIXCLS'), get_regional_macro(curr_date) for the other "
                "economies, and get_prediction_markets(topic, limit) for market-implied odds of policy and "
                "recession events. Explain how conditions abroad transmit to US markets. Where indicators "
                "disagree, say so; a conflicted read is a finding. Cite figures with their dates."
            ),
        ),
        MarketAnalystSpec(
            key="global",
            agent_node="Global Markets Analyst",
            report_key="global_report",
            tools=(get_global_asset_returns, get_macro_indicators),
            instructions=(
                "You are a cross-asset strategist. Read risk appetite across regions and assets as of the "
                "analysis date. Use get_global_asset_returns(curr_date) for regional equity, FX, bond and "
                "commodity returns, and get_macro_indicators(indicator, curr_date, look_back_days) for US "
                "yields, the dollar index ('DTWEXBGS') and volatility ('VIXCLS'). Compare the same windows "
                "across assets. ETF returns are proxies, not measured capital flows; futures are contract "
                "prices, not spot. Say what the cross-asset picture implies for US equities and sectors."
            ),
        ),
        MarketAnalystSpec(
            key="news",
            agent_node="Market News Analyst",
            report_key="news_report",
            tools=(get_global_news, get_economic_calendar, get_market_community_posts),
            instructions=(
                "You are a market news researcher. Cover the past week's global news that matters for "
                "markets: central banks, growth, inflation, war, political conflict, trade and energy. Use "
                "get_global_news(curr_date, look_back_days, limit), get_economic_calendar(curr_date) for "
                "recent releases and their surprises and the releases due over the next two weeks, and "
                "get_market_community_posts(curr_date) for what investors are discussing. Separate reported "
                "facts from expectations and scenarios; headlines and summaries are not full articles, and "
                "community posts are unverified opinion. Name the sectors each development affects."
            ),
        ),
        MarketAnalystSpec(
            key="sector",
            agent_node="Sector Analyst",
            report_key="sector_report",
            tools=(get_sector_performance, get_market_participation, get_economic_calendar),
            instructions=(
                "You are a sector strategist. Assess each of the eleven US sectors, through their SPDR ETFs: "
                + ", ".join(f"{name} ({etf})" for name, etf in SECTOR_ETFS.items()) + ". Use "
                "get_sector_performance(curr_date, look_back_days) for trailing returns and spreads versus "
                "SPY over several windows, get_market_participation(curr_date) for breadth, leadership "
                "reversals, equal-weight vs cap-weight and credit, and get_economic_calendar(curr_date) for "
                "catalysts. A sector up 3% while SPY is up 3.4% is lagging, not leading. Distinguish "
                "persistent leadership, emerging reversals and fading leadership. For every sector, state its "
                "lean for the next 1–4 weeks (Bullish, Neutral or Bearish), the figures behind it and what "
                "would change it. Do not name individual stocks; a sector with missing data is uncertain."
            ),
        ),
    )
}


def create_market_analyst(spec: MarketAnalystSpec, llm):
    def analyst_node(state):
        prompt = ChatPromptTemplate.from_messages([
            (
                "system",
                "You are a helpful AI assistant, collaborating with other assistants."
                " Use the provided tools to progress towards answering the question."
                " If you are unable to fully answer, that's OK; another assistant with different tools"
                " will help where you left off. Execute what you can to make progress."
                " Report what your tools support; another agent makes the market call."
                " You have access to the following tools: {tool_names}."
                " Today's date is {current_date}; treat it as 'now' for all analysis and tool-call date"
                " ranges. {market_context}\n{system_message}",
            ),
            MessagesPlaceholder(variable_name="messages"),
        ])
        prompt = prompt.partial(
            system_message=spec.instructions + _TABLE + get_language_instruction(),
            tool_names=", ".join(tool.name for tool in spec.tools),
            current_date=state["trade_date"],
            market_context=MARKET_CONTEXT,
        )
        result, report = take_turn(prompt, llm, spec.tools, state["messages"])
        return {"messages": [result], spec.report_key: report}

    return analyst_node
