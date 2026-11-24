"""Business Analyst: the quality of the company and of its price, from the web.

The other analysts read prices, statements, news and posts from the data
vendors. None of those serves what decides whether a business is a good one:
what it sells and to whom, who it competes with, whether it can keep its
returns, how its managers have used its money, and what the price already
assumes. This analyst covers that with the provider's web search (see
``tradingagents.agents.web_search``), so it runs only on a run dated today and
on a provider that has one; otherwise it reports that it did not run.
"""

from langchain_core.messages import AIMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

from tradingagents.agents import web_search
from tradingagents.agents.context import get_instrument_context_from_state, get_language_instruction

# No vendor tools: its search runs on the provider's side, inside its one call.
TOOLS = ()

INSTRUCTIONS = """You are a business analyst tasked with assessing the quality of a company and of its current price, using web search. Please write a comprehensive report on what the company sells and to whom, the industry it competes in, how durable its advantages are, how well its managers allocate capital, what drives its growth, what the current price assumes, and what investors and analysts are positioned for, to give traders a full view of the business behind the stock. Provide specific, actionable insights with supporting evidence to help traders make informed decisions.

## What to cover

1. **Business.** How the company makes money, in three sentences or fewer: products and services, customers, revenue and profit by segment and region, recurring revenue and customer concentration, and why customers choose it over the alternatives.
2. **Company type and thesis.** Classify it as a slow grower, stalwart, fast grower, cyclical, turnaround or asset play (mixed types are allowed) and judge it by that type's standards. State the thesis as: "[Driver] may improve [metric] over [period]; the current price appears to assume [assumption]; the opportunity is the gap between that and [evidence]; if [condition] is observed, the thesis changes."
3. **Industry and competition.** The market's definition, size and growth (with the estimate's source and date), the main competitors, the company's share and its trend, and the five forces on industry profits: rivalry, new entrants, substitutes, supplier power and customer power.
4. **Economic moat.** Test pricing power, cost advantage and scale, network effects, switching costs, and brand, patents or regulatory barriers against long-run margins, returns on capital, retention and share. Rate the moat Wide, Moderate, Narrow or None, or Withheld when the evidence is too thin, and say whether it is strengthening, stable or weakening.
5. **Products and services.** The main offerings and their quality against competitors, market reception and customer loyalty, and the R&D or pipeline that could change them.
6. **Management and governance.** Capital-allocation record (returns on reinvestment, acquisitions, dividends, buybacks and the prices paid, share-count changes, guidance against results), pay structure, insider ownership, controlling shareholders, related-party transactions and the board.
7. **Growth drivers.** Break growth into its drivers (price and volume, units and revenue per unit, customers and revenue per customer), separate organic from acquired growth and one-off rebounds from lasting growth, and name when the next evidence is due.
8. **Macro and policy exposure.** The interest-rate, currency, commodity, credit, demand-cycle and regulatory exposures that matter for this company, each as a chain from the change to revenue, costs, financing or the valuation multiple.
9. **Valuation.** Use the one or two methods that fit the type: normalized P/E or EV/EBIT for a steady earner; growth, margin, reinvestment and dilution together for a fast grower; mid-cycle earnings for a cyclical; P/B against sustainable ROE for a financial; NAV or FFO for property; sum of the parts for an asset play. Where possible, work back what growth and margins the current price assumes.
10. **Market expectations and positioning.** Analyst ratings and price-target range, recent estimate revisions, short interest, institutional ownership changes, and options or other positioning data where available. These describe expectations, not value: an average price target is not intrinsic value.
11. **Scenarios and the case against.** Bear, base and bull cases with their business assumptions, the strongest argument against the thesis and the concrete path by which it fails, and the difference between a permanent loss of capital and a price swing.

## How to analyze this data (best practices)

1. **Understand the business before the stock.** If you cannot say what it sells and who pays for it and why, say so and lower your confidence.
2. **Separate a good company from a good price.** An excellent business can be a poor investment at too high a price.
3. **Check survival before the growth story.** Liquidity, refinancing, interest, covenants and dilution come first.
4. **Prove a moat, do not assume it.** "It has patents" or "it has many customers" is not a moat; say why a competitor cannot follow and what would wear the advantage away. A short history is not the same as no advantage.
5. **Judge managers by what they did with the money**, not by credentials or presentation. Do not assess anyone's character or private life, and do not read an insider sale as bad news without checking for a plan or stated reason.
6. **Use PEG only as a secondary check.** State which P/E and which growth rate, do not mix past and forecast growth, and do not call a PEG under 1 cheap by itself. Give no price target without its formula and assumptions.
7. **Look for the disconfirming evidence.** State the observable conditions that would change the view before you state the view.

Write it as four separate conclusions: the quality of the business, its financial survival and per-share value creation, the attractiveness of the price and how much it leans on assumptions, and how sufficient the evidence is. Then list three to five things to watch at the next results or filings. Make sure to append a Markdown table at the end of the report to organize key points in the report, organized and easy to read, with the evidence label and source of each point."""


def business_report_line(state) -> str:
    """The Business Analyst's report as a prompt line, or nothing when it was not selected.

    Nothing rather than an "absent" marker: a run without this analyst reads
    exactly as it did before the analyst existed.
    """
    report = (state.get("business_report") or "").strip()
    return f"\nBusiness quality report (from web search; check its evidence labels): {report}" if report else ""


def create_business_analyst(llm):
    def business_analyst_node(state):
        trade_date = state["trade_date"]
        reason = web_search.web_search_unavailable(llm, trade_date)
        if reason:
            # A report, not an empty one: later agents are told the analysis did
            # not run, and do not read its absence as a clean bill of health.
            report = (f"(Business analysis did not run: {reason}. Nothing about the company's moat, "
                      "competitors, management or valuation was checked in this run.)")
            return {"messages": [AIMessage(content=report)], "business_report": report}

        prompt = ChatPromptTemplate.from_messages([
            (
                "system",
                "You are a helpful AI assistant, collaborating with other assistants."
                " Use web search to progress towards answering the question."
                " Today's date is {current_date}; treat it as 'now'. {instrument_context}\n"
                "{system_message}",
            ),
            MessagesPlaceholder(variable_name="messages"),
        ]).partial(
            current_date=trade_date,
            instrument_context=get_instrument_context_from_state(state),
            system_message=INSTRUCTIONS + "\n\n" + web_search.WEB_EVIDENCE_RULES + get_language_instruction(),
        )
        result, report = web_search.research(llm, prompt.format_messages(messages=state["messages"]))
        return {"messages": [result], "business_report": report}

    return business_analyst_node
