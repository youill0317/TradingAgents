"""Sector Analyst: finds where money is rotating, then names the candidates.

Runs after the Macro Analyst and reads its regime call from state, so the
screen it builds is shaped by the macro backdrop rather than run blind.
"""

from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

from tradingagents.agents.utils.agent_utils import (
    get_language_instruction,
    get_stock_data,
)
from tradingagents.agents.utils.market_scan_tools import (
    get_sector_performance,
    screen_equities,
)


def create_sector_analyst(llm):
    def sector_analyst_node(state):
        current_date = state["trade_date"]
        macro_report = state.get("macro_report", "")
        requested = state.get("requested_sectors") or []

        sector_instruction = (
            f"Restrict your screening to these sectors: {', '.join(requested)}."
            if requested
            else (
                "Screen the two or three sectors your rotation analysis singles "
                "out — leaders, or laggards if the regime favours mean reversion. "
                "Do not screen all eleven; a focused list beats a broad one."
            )
        )

        tools = [
            get_sector_performance,
            screen_equities,
            get_stock_data,
        ]

        system_message = (
            "You are a sector strategist. Your job is to determine where capital "
            "is rotating and to surface the specific names that sit in its path.\n\n"
            "Work in this order:\n"
            "1. Call get_sector_performance to see the rotation. Look at both the "
            "absolute return and the spread versus SPY — a sector up 3% while SPY "
            "is up 3.4% is lagging, not leading.\n"
            "2. Read that against the macro regime established below. Leadership "
            "that contradicts the macro read is the most important thing you can "
            "report; do not smooth it over.\n"
            f"3. {sector_instruction} Call screen_equities once per sector — it "
            "cannot attribute results to a sector unless you ask for one "
            "specifically.\n"
            "4. Optionally call get_stock_data on individual names to check how "
            "a candidate has actually traded.\n\n"
            "Then write a report covering: the rotation picture with figures; "
            "where it agrees and disagrees with the macro regime; and, for each "
            "sector you screened, the names that stood out and why.\n\n"
            "Only ever discuss tickers that a tool actually returned. If a screen "
            "comes back empty, report that plainly — an empty screen is a finding, "
            "and inventing names to fill the gap would poison every step "
            "downstream.\n\n"
            "--- MACRO REGIME (from the Macro Analyst) ---\n"
            f"{macro_report}"
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
            "sector_report": report,
        }

    return sector_analyst_node
