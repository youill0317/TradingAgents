from typing import Annotated

from langchain_core.tools import tool
from langgraph.prebuilt import InjectedState

from tradingagents.dataflows.interface import route_to_vendor


@tool
def get_prediction_markets(
    topic: Annotated[
        str,
        "Event topic/keyword, e.g. 'Fed rate cut', 'recession 2026', "
        "'US election', or a sector/company event.",
    ],
    limit: Annotated[int | None, "Max markets to return; omit for a default of 6"] = None,
    offset: Annotated[int, "Discovery offset returned by a previous response; 0 for first page"] = 0,
    state: Annotated[dict, InjectedState] = None,
) -> str:
    """
    Retrieve live, market-implied probabilities for forward-looking events from
    prediction markets (Kalshi or Polymarket): Fed decisions, recession, elections,
    geopolitics, crypto. Returns the most-traded open markets matching the
    topic, with provider-specific prices, volume, and dates. Kalshi uses related
    series keyword matching; verify each contract matches the intended event.
    Uses the configured prediction_markets vendor. Follow a returned offset to
    inspect more series; if no series match, retry with a returned provider category.
    This is bounded discovery, never proof that an event has no market.

    Args:
        topic (str): Event keyword(s) to search
        limit (int): Max markets to return; omit for a default of 6

    Returns:
        str: A formatted markdown report of matching prediction markets
    """
    return route_to_vendor("get_prediction_markets", topic, limit, offset=offset,
                           curr_date=(state or {}).get("trade_date"))
