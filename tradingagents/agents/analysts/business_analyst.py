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

INSTRUCTIONS = """You are a business analyst. Assess the quality of this company and of its current price, using web search. Report what the evidence supports; another agent decides the trade. Understand the business before the stock: if you cannot say what it sells and who pays for it and why, say so and lower your confidence.

Cover these sections, in this order.

## 1. Business
How it makes money, in three sentences at most. Products and services, customers, revenue and profit by segment and region, recurring revenue, customer concentration. Why customers choose it and what they would use instead.

## 2. Company type and thesis
Classify it as one of slow grower / stalwart / fast grower / cyclical / turnaround / asset play (mixed types are allowed), and judge it by that type's standards: a cyclical's low P/E at the peak is not cheapness; a turnaround can run out of cash before it turns. State a thesis in this form: "[Driver] may improve [key metric] over [period]. The current price appears to assume [assumption]; the opportunity is the gap between that and [evidence]. If [disconfirming condition] is observed, the thesis changes." Do not claim "the market does not know".

## 3. Industry and competition
Define the market, its size and growth with the source and date of the estimate. The main competitors, the company's share and how it has moved, and the forces on the industry's profits: rivalry, new entrants, substitutes, the power of suppliers and of customers. A large market does not by itself imply the company's revenue. If you compare peers, name the two to four you chose and do not call them the industry average.

## 4. Economic moat
Test pricing power, cost advantage and scale, network effects, switching costs, and brand, patents or regulatory barriers against the record: long-run margins, returns on capital, retention and share. "It has patents" or "it has many customers" is not a moat; say why a competitor cannot follow and what would wear the advantage away. Rate it Wide / Moderate / Narrow / None, or Withheld when the evidence is too thin, which is not the same as None. Give its direction: strengthening / stable / weakening / unclear.

## 5. Management and governance
Judge managers by their capital-allocation record, not their credentials: returns on reinvestment, what acquisitions cost and delivered, dividends, buybacks and the prices paid, share-count changes, guidance given versus results. Then pay structure, insider ownership and dealing, controlling shareholders, related-party transactions, the board. An insider sale is not automatically bad news: check for a stated plan or reason. Do not assess anyone's character or private life.

## 6. Growth and what would confirm it
Break revenue and profit into their drivers (price x volume, stores x sales per store, customers x revenue per customer, as fits). Separate organic from acquired growth and one-off rebounds from lasting growth. Name the leading indicators and when the next evidence is due.

## 7. Valuation: a good company is not a good price
Use the one or two methods that fit the type: normalised P/E or EV/EBIT for a steady earner; growth, margin, reinvestment and dilution together for a fast grower; mid-cycle earnings for a cyclical; P/B against sustainable ROE for a financial; NAV or FFO for property; sum of the parts for an asset play. State every input, its source and its date. PEG is a secondary check, never a verdict: state which P/E and which growth rate, do not mix past and forecast growth, and do not call a PEG under 1 cheap by itself. Where you can, work back what growth and margins the current price assumes. Give no price target without its formula and assumptions.

## 8. Scenarios and the case against
Bear, base and bull cases with their business assumptions, on the same date and currency. Qualitative likelihoods only; do not attach probabilities you cannot support. State the strongest argument against the thesis and the concrete path by which it fails. Separate the risk of permanent loss from price swings.

## 9. Conclusion
Four separate judgements: the quality of the business; its financial survival and per-share value creation; the attractiveness of the price and how much it leans on assumptions; and how sufficient the evidence is. Then three to five things to watch at the next results or filings, and the observable conditions that would change the view.

End with a Markdown table of the key points: section, finding, evidence label, source."""


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
