"""Macro Analyst: reads the market's regime, with no ticker in sight.

The per-ticker News Analyst already reaches for FRED, global news, and
prediction markets, but only as background colour for one name. This agent
uses the same three tools as its primary subject: what is the macro backdrop,
and what does it imply for risk appetite right now.
"""

from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

from tradingagents.agents.utils.agent_utils import (
    get_global_news,
    get_language_instruction,
    get_macro_indicators,
    get_prediction_markets,
)


def create_macro_analyst(llm):
    def macro_analyst_node(state):
        current_date = state["trade_date"]
        historical = state.get("scan_mode") == "historical"

        tools = [get_macro_indicators]
        if not historical:
            tools.extend([get_global_news, get_prediction_markets])

        system_message = (
            "You are a macro strategist establishing the market regime. You are "
            "not analysing any single company — your subject is the market "
            "itself.\n\n"
            "Ground every claim in retrieved numbers. Use get_macro_indicators "
            "(FRED) for the hard data; at minimum check the policy rate "
            "('fed_funds_rate'), the yield curve ('yield_curve'), inflation "
            "('core_pce' or 'cpi'), the labour market ('unemployment' or "
            "'initial_claims'), volatility ('vix'), and the dollar "
            "('dollar_index'). Use get_global_news for the macro narrative and "
            "get_prediction_markets for the market-implied odds of forward "
            "events (rate decisions, recession, geopolitics).\n\n"
            "Write a report covering, in order:\n"
            "1. Monetary policy and rates — level, direction, and what the curve implies\n"
            "2. Inflation and growth — trend, not just the latest print\n"
            "3. Risk appetite — volatility, the dollar, and credit conditions\n"
            "4. Forward catalysts — the dated events that could reprice the market\n"
            "5. Your regime call, and specifically what evidence would falsify it\n\n"
            "Cite the actual figures and their dates. A claim without a number "
            "behind it is worth less than no claim at all. Where the indicators "
            "disagree, say so — a conflicted read is a real finding, and "
            "pretending to a clean story hides the risk.\n\n"
            "Append a markdown table summarising each indicator, its latest "
            "value, its direction, and what it signals."
            + (
                " This is a historical review. Do not use current news or current "
                "prediction-market odds as evidence for the historical date."
                if historical else ""
            )
            + get_language_instruction()
        )

        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are a helpful AI assistant, collaborating with other assistants"
                    " on a market-wide scan. Use the provided tools to progress towards"
                    " answering the question. If you are unable to fully answer, that's"
                    " OK; another assistant with different tools will help where you"
                    " left off. Execute what you can to make progress."
                    " You have access to the following tools: {tool_names}."
                    " Today's date is {current_date}; treat it as 'now' for all analysis"
                    " and tool-call date ranges.\n{system_message}",
                ),
                MessagesPlaceholder(variable_name="messages"),
            ]
        )

        prompt = prompt.partial(system_message=system_message)
        prompt = prompt.partial(tool_names=", ".join([tool.name for tool in tools]))
        prompt = prompt.partial(current_date=current_date)

        chain = prompt | llm.bind_tools(tools)
        result = chain.invoke(state["messages"])

        report = ""
        if len(result.tool_calls) == 0:
            report = result.content

        return {
            "messages": [result],
            "macro_report": report,
            "macro_tool_rounds": state.get("macro_tool_rounds", 0) + 1,
        }

    return macro_analyst_node
