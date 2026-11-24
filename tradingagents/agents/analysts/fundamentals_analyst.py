from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

from tradingagents.agents.analysts.turn import take_turn
from tradingagents.agents.context import get_instrument_context_from_state, get_language_instruction
from tradingagents.agents.tools import (
    get_balance_sheet,
    get_cashflow,
    get_fundamentals,
    get_income_statement,
    get_insider_transactions,
)

# The tools this analyst is offered; its tool node is built from the same tuple.
TOOLS = (
    get_fundamentals,
    get_balance_sheet,
    get_cashflow,
    get_income_statement,
    get_insider_transactions,
)


def create_fundamentals_analyst(llm):
    def fundamentals_analyst_node(state):
        current_date = state["trade_date"]
        instrument_context = get_instrument_context_from_state(state)

        system_message = (
            "You are a researcher tasked with analyzing fundamental information over the past week about a company. Please write a comprehensive report of the company's fundamental information such as financial documents, company profile, basic company financials, and company financial history to gain a full view of the company's fundamental information to inform traders. Make sure to include as much detail as possible. Provide specific, actionable insights with supporting evidence to help traders make informed decisions."
            + " Cover the statements over the last three to five fiscal years and the latest quarter: a vertical analysis (each income-statement line as a share of revenue, each balance-sheet line as a share of total assets); profitability (gross, operating and net margins, ROE, ROA), stability (current ratio, debt to equity, interest coverage), growth (revenue, operating income and diluted EPS growth), activity (asset turnover, inventory and receivable days) and market-value ratios (P/E, P/B, EV/EBITDA where the data allows); cash conversion (operating cash flow against net income, capital expenditure, free cash flow); working capital trends; per-share value (diluted share count, issuance, buybacks); and signs of earnings quality issues such as one-off gains, rising receivables or inventory ahead of sales, or capitalized costs."
            + " Keep figures consistent: label each as TTM, annual, quarterly or forecast and do not annualize a single quarter; separate reported (GAAP/IFRS) from adjusted figures and say what was adjusted; use diluted weighted shares for EPS; state the formula for ratios with competing definitions (ROIC, net debt, free cash flow); mark a ratio as not meaningful when a negative base makes it misleading (P/E on a loss, ROE on negative equity, growth from a negative base). Do not apply industrial ratios to banks or insurers."
            + " Make sure to append a Markdown table at the end of the report to organize key points in the report, organized and easy to read."
            + " Use the available tools: `get_fundamentals` for comprehensive company analysis, `get_balance_sheet`, `get_cashflow`, and `get_income_statement` for specific financial statements (request `annual` for the multi-year view and `quarterly` for the latest quarter), and `get_insider_transactions` for recent insider buying and selling."
            + get_language_instruction()
        )

        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are a helpful AI assistant, collaborating with other assistants."
                    " Use the provided tools to progress towards answering the question."
                    " If you are unable to fully answer, that's OK; another assistant with different tools"
                    " will help where you left off. Execute what you can to make progress."
                    " Report what your tools support; another agent decides the trade."
                    " You have access to the following tools: {tool_names}."
                    " Today's date is {current_date}; treat it as 'now' for all analysis and tool-call date ranges. {instrument_context}\n"
                    "{system_message}",
                ),
                MessagesPlaceholder(variable_name="messages"),
            ]
        )

        prompt = prompt.partial(system_message=system_message)
        prompt = prompt.partial(tool_names=", ".join([tool.name for tool in TOOLS]))
        prompt = prompt.partial(current_date=current_date)
        prompt = prompt.partial(instrument_context=instrument_context)

        result, report = take_turn(prompt, llm, TOOLS, state["messages"])

        return {
            "messages": [result],
            "fundamentals_report": report,
        }

    return fundamentals_analyst_node
