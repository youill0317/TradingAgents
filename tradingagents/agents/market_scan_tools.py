"""LLM tools for the market-wide scan.

Kept apart from ``tradingagents.agents.tools``: the scan has no instrument under
analysis, and its sector vendor is called directly rather than through the data
router.
"""

from typing import Annotated

from langchain_core.tools import tool

from tradingagents.dataflows.errors import NoMarketDataError, VendorUnavailableError
from tradingagents.dataflows.market_scan import get_sector_performance as _sector_performance
from tradingagents.dataflows.router import no_data_available, vendor_unavailable


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
    rotating into and out of.

    Args:
        curr_date (str): Current date in yyyy-mm-dd format
        look_back_days (int): Trailing window length in days

    Returns:
        str: A formatted markdown report of sector and broad-market returns
    """
    return _call("get_sector_performance", _sector_performance, curr_date, look_back_days)

