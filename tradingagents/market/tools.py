"""Tools the market analysts call, alongside the ticker analysts' macro, news and prediction tools.

Like ``tradingagents.agents.tools``, every tool serves the run's date at the
latest: a model asking for a later date, or for none, is served as of the run's
``trade_date``, so a past-dated analysis never reads what came after it.
"""

from datetime import datetime, timedelta
from typing import Annotated

from langchain_core.tools import tool
from langgraph.prebuilt import InjectedState

from tradingagents.dataflows.date_window import as_of
from tradingagents.dataflows.errors import NoMarketDataError, VendorUnavailableError
from tradingagents.dataflows.global_market import get_global_asset_report, get_regional_macro_report
from tradingagents.dataflows.market_diagnostics import collect_market_diagnostics
from tradingagents.dataflows.market_events import collect_market_events
from tradingagents.dataflows.market_scan import get_sector_performance as _sector_performance
from tradingagents.dataflows.router import no_data_available, vendor_unavailable
from tradingagents.dataflows.vendors.reddit import fetch_reddit_posts
from tradingagents.dataflows.vendors.stocktwits import fetch_stocktwits_messages

# Community searches for the market as a whole: (search terms, subreddits).
COMMUNITY_SEARCHES = (
    ("inflation OR recession OR rates", ("Economics", "investing", "stocks")),
    ("war OR tariffs OR sanctions", ("geopolitics", "worldnews")),
)


def _serve(method: str, func, *args) -> str:
    """A vendor failure becomes the same explicit sentinel the ticker tools return."""
    try:
        return func(*args)
    except NoMarketDataError as e:
        return no_data_available(e)
    except VendorUnavailableError as e:
        return vendor_unavailable(method, e)
    except Exception as e:  # provider exceptions can carry credential-bearing URLs
        return f"DATA_UNAVAILABLE: {method} failed ({type(e).__name__}). Report the data as unavailable."


@tool
def get_global_asset_returns(
    curr_date: Annotated[str, "Current date in yyyy-mm-dd format"],
    trade_date: Annotated[str, InjectedState("trade_date")] = "",
) -> str:
    """
    Retrieve 1-week, 1-month and 3-month returns for regional equity ETFs (US,
    eurozone, UK, China, Japan, Korea, India, emerging markets), major FX pairs,
    government and EM bond ETFs, and gold, oil and copper futures.
    Args:
        curr_date (str): Current date in yyyy-mm-dd format
    Returns:
        str: A formatted report of cross-asset returns with observation dates.
    """
    return _serve("get_global_asset_returns", get_global_asset_report, as_of(curr_date, trade_date))


@tool
def get_regional_macro(
    curr_date: Annotated[str, "Current date in yyyy-mm-dd format"],
    trade_date: Annotated[str, InjectedState("trade_date")] = "",
) -> str:
    """
    Retrieve real GDP, consumer prices, unemployment, policy rates and reserves
    for the US, eurozone, UK, China, Japan, Korea and India from FRED, as the
    data stood on the date. Needs FRED_API_KEY.
    Args:
        curr_date (str): Current date in yyyy-mm-dd format
    Returns:
        str: A formatted report of the latest observations per economy.
    """
    return _serve("get_regional_macro", get_regional_macro_report, as_of(curr_date, trade_date))


@tool
def get_sector_performance(
    curr_date: Annotated[str, "Current date in yyyy-mm-dd format; the end of the window"],
    look_back_days: Annotated[int, "Trailing window length in days (e.g. 5 for a week, 30 for a month)"] = 30,
    trade_date: Annotated[str, InjectedState("trade_date")] = "",
) -> str:
    """
    Rank the eleven US sectors (SPDR sector ETFs) by trailing return alongside
    the S&P 500, Nasdaq 100 and Russell 2000, with each sector's spread versus SPY.
    Args:
        curr_date (str): Current date in yyyy-mm-dd format
        look_back_days (int): Trailing window length in days
    Returns:
        str: A formatted report of sector and broad-market returns.
    """
    return _serve("get_sector_performance", _sector_performance, as_of(curr_date, trade_date), look_back_days)


@tool
def get_market_participation(
    curr_date: Annotated[str, "Current date in yyyy-mm-dd format"],
    trade_date: Annotated[str, InjectedState("trade_date")] = "",
) -> str:
    """
    Retrieve market internals: how many sectors are rising or above their 50/200
    session averages, each sector's 1w/1mo/3mo return and spread versus SPY,
    rank changes, leadership reversals, equal-weight vs cap-weight, small vs
    large caps, high-yield vs investment-grade credit, and SPY drawdown and
    volatility.
    Args:
        curr_date (str): Current date in yyyy-mm-dd format
    Returns:
        str: A formatted report of participation and rotation measures.
    """
    return _serve("get_market_participation",
                  lambda date: collect_market_diagnostics(date)["report"], as_of(curr_date, trade_date))


@tool
def get_economic_calendar(
    curr_date: Annotated[str, "Current date in yyyy-mm-dd format"],
    trade_date: Annotated[str, InjectedState("trade_date")] = "",
) -> str:
    """
    Retrieve economic releases from a week before to two weeks after the date:
    upcoming events with consensus where available, and recent figures with
    their surprise versus consensus. Figures released after the date are withheld.
    Args:
        curr_date (str): Current date in yyyy-mm-dd format
    Returns:
        str: A formatted calendar of upcoming and recent releases.
    """
    return _serve("get_economic_calendar",
                  lambda date: collect_market_events(date)["report"], as_of(curr_date, trade_date))


def _community(end_date: str) -> str:
    start_date = (datetime.strptime(end_date, "%Y-%m-%d") - timedelta(days=7)).strftime("%Y-%m-%d")
    blocks = [f"## Market community posts, {start_date} to {end_date}",
              "Unverified opinions, not representative polling; do not profile authors."]
    for terms, subreddits in COMMUNITY_SEARCHES:
        blocks.append(f"### Reddit: {terms}\n" + fetch_reddit_posts(
            terms, subreddits, start_date=start_date, end_date=end_date))
    blocks.append("### StockTwits: SPY\n" + fetch_stocktwits_messages(
        "SPY", limit=20, start_date=start_date, end_date=end_date))
    return "\n\n".join(blocks)


@tool
def get_market_community_posts(
    curr_date: Annotated[str, "Current date in yyyy-mm-dd format"],
    trade_date: Annotated[str, InjectedState("trade_date")] = "",
) -> str:
    """
    Retrieve the past week's Reddit posts on the economy and geopolitics and
    StockTwits messages on SPY. Public feeds serve recent posts only, so a past
    window they cannot reach is reported as unavailable.
    Args:
        curr_date (str): Current date in yyyy-mm-dd format
    Returns:
        str: Formatted community posts, grouped by source.
    """
    return _serve("get_market_community_posts", _community, as_of(curr_date, trade_date))
