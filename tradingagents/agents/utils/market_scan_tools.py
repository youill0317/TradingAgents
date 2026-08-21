from typing import Annotated

from langchain_core.tools import tool

from tradingagents.dataflows.interface import route_to_vendor


@tool
def get_sector_performance(
    curr_date: Annotated[str, "Current date in yyyy-mm-dd format; the end of the window"],
    look_back_days: Annotated[
        int, "Trailing window length in days (e.g. 5 for a week, 30 for a month)"
    ] = 30,
) -> str:
    """
    Rank the eleven US equity sectors by trailing return, alongside the broad
    market (S&P 500, Nasdaq 100, Russell 2000). Each sector also shows its
    spread versus SPY, which separates genuine leadership from a sector merely
    riding the index. Use this to identify which part of the market money is
    rotating into before picking individual names.

    Args:
        curr_date (str): Current date in yyyy-mm-dd format
        look_back_days (int): Trailing window length in days

    Returns:
        str: A formatted markdown report of sector and broad-market returns
    """
    return route_to_vendor("get_sector_performance", curr_date, look_back_days)


@tool
def screen_equities(
    sector: Annotated[
        str | None,
        "Sector to screen, exactly one of: Technology, Financial Services, "
        "Energy, Healthcare, Consumer Cyclical, Consumer Defensive, "
        "Industrials, Basic Materials, Real Estate, Utilities, "
        "Communication Services. Omit for a market-wide sweep.",
    ] = None,
    min_market_cap: Annotated[
        float, "Minimum market capitalisation in USD (e.g. 1e10 for $10B)"
    ] = 1e10,
    min_volume: Annotated[float, "Minimum daily share volume"] = 1e6,
    sort_field: Annotated[
        str,
        "Screener field to rank by: 'percentchange' for today's movers, "
        "'intradaymarketcap' for the largest names, 'dayvolume' for the "
        "most active.",
    ] = "percentchange",
    limit: Annotated[int, "Maximum number of matches to return"] = 25,
    curr_date: Annotated[str | None, "Current date in yyyy-mm-dd format"] = None,
) -> str:
    """
    Screen US-listed equities (NASDAQ/NYSE) by sector, size, liquidity, and
    momentum, returning the matches with price, change, market cap, volume, and
    P/E. This is how candidate names are discovered — call it once per sector
    you care about, since the screener cannot attribute a result to a sector on
    its own.

    Note: the screener reflects the market as it stands today; it has no
    historical mode. Results for a past date carry survivorship bias and are
    labelled as such.

    Args:
        sector (str): Sector name, or omit for a market-wide sweep
        min_market_cap (float): Minimum market capitalisation in USD
        min_volume (float): Minimum daily share volume
        sort_field (str): Screener field to rank by
        limit (int): Maximum number of matches
        curr_date (str): Current date in yyyy-mm-dd format

    Returns:
        str: A formatted markdown table of matching equities
    """
    # Keyword arguments on purpose: min_price is not exposed on the tool (an
    # LLM has no business lowering the penny-stock floor), so it is passed
    # positionally nowhere — a reorder of the vendor signature would otherwise
    # slide it silently onto another parameter.
    return route_to_vendor(
        "screen_equities",
        sector=sector,
        min_market_cap=min_market_cap,
        min_volume=min_volume,
        min_price=5.0,
        sort_field=sort_field,
        limit=limit,
        curr_date=curr_date,
    )
