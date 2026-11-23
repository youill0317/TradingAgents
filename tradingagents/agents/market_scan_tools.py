"""LLM tools for the market-wide scan.

Kept apart from ``tradingagents.agents.tools``: the scan has no instrument under
analysis, so its tools take the symbol or sector explicitly, and its screener
and sector vendors are called directly rather than through the data router.
"""

from typing import Annotated

from langchain_core.tools import tool
from langgraph.prebuilt import InjectedState

from tradingagents.dataflows.date_window import as_of_window
from tradingagents.dataflows.errors import NoMarketDataError, VendorUnavailableError
from tradingagents.dataflows.market_scan import (
    get_sector_performance as _sector_performance,
    screen_equities as _screen_equities,
)
from tradingagents.dataflows.router import no_data_available, route_to_vendor, vendor_unavailable


def _call(method: str, func, *args, **kwargs) -> str:
    try:
        return func(*args, **kwargs)
    except NoMarketDataError as e:
        return no_data_available(e)
    except VendorUnavailableError as e:
        return vendor_unavailable(method, e)


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
    return _call("get_sector_performance", _sector_performance, curr_date, look_back_days)


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
        "Screener field to rank by: 'intradaymarketcap' for the largest names, "
        "'dayvolume' for the most active, or 'percentchange' for today's movers. "
        "Prefer market cap unless the thesis specifically requires momentum.",
    ] = "intradaymarketcap",
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
    historical mode. A past date is rejected instead of mixing current rows
    into a historical report.

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
    return _call(
        "screen_equities",
        _screen_equities,
        sector=sector,
        min_market_cap=min_market_cap,
        min_volume=min_volume,
        min_price=5.0,
        sort_field=sort_field,
        limit=limit,
        curr_date=curr_date,
    )


@tool
def get_stock_data(
    symbol: Annotated[str, "Ticker symbol to look up, e.g. NVDA"],
    start_date: Annotated[str, "Start date in yyyy-mm-dd format"],
    end_date: Annotated[str, "End date in yyyy-mm-dd format"],
    trade_date: Annotated[str, InjectedState("trade_date")] = "",
) -> str:
    """
    Retrieve stock price data (OHLCV) for any ticker, e.g. a screened candidate.
    Uses the configured core_stock_apis vendor.
    Args:
        symbol (str): Ticker symbol
        start_date (str): Start date in yyyy-mm-dd format
        end_date (str): End date in yyyy-mm-dd format
    Returns:
        str: A formatted dataframe containing the price data over the date range.
    """
    try:
        start_date, end_date = as_of_window(start_date, end_date, trade_date)
    except ValueError as e:
        return str(e)
    return route_to_vendor("get_stock_data", symbol, start_date, end_date)
