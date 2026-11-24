"""Tools the market analysts call, alongside the ticker analysts' macro, news and prediction tools.

Like ``tradingagents.agents.tools``, every tool serves the run's date at the
latest: a model asking for a later date, or for none, is served as of the run's
``trade_date``, so a past-dated analysis never reads what came after it.
"""

from datetime import datetime, timedelta
from typing import Annotated

import pandas as pd
from langchain_core.tools import tool
from langgraph.prebuilt import InjectedState

from tradingagents.dataflows.date_window import as_of
from tradingagents.dataflows.errors import NoMarketDataError, VendorUnavailableError
from tradingagents.dataflows.global_market import get_global_asset_report, get_regional_macro_report
from tradingagents.dataflows.market_diagnostics import collect_market_diagnostics
from tradingagents.dataflows.market_events import collect_market_events
from tradingagents.dataflows.market_scan import (
    SECTOR_ETFS,
    get_sector_performance as _sector_performance,
)
from tradingagents.dataflows.router import no_data_available, vendor_unavailable
from tradingagents.dataflows.vendors.reddit import fetch_reddit_posts
from tradingagents.dataflows.vendors.stocktwits import fetch_stocktwits_messages
from tradingagents.dataflows.vendors.yahoo.ohlcv import load_ohlcv

# Community searches for the market as a whole: (search terms, subreddits).
# Read by the Sentiment Analyst, which, like the ticker workflow's, takes its
# sources up front rather than through tools.
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
def get_market_internals(
    curr_date: Annotated[str, "Current date in yyyy-mm-dd format"],
    trade_date: Annotated[str, InjectedState("trade_date")] = "",
) -> str:
    """
    Retrieve US market internals: how many sectors are rising or above their
    50/200 session averages, equal-weight vs cap-weight, small vs large caps,
    Nasdaq vs S&P 500, high-yield vs investment-grade credit, and SPY, QQQ and
    IWM trend, drawdown and realized volatility.
    Args:
        curr_date (str): Current date in yyyy-mm-dd format
    Returns:
        str: A formatted report of market-wide participation and risk measures.
    """
    return _serve("get_market_internals",
                  lambda date: collect_market_diagnostics(date)["internals_report"], as_of(curr_date, trade_date))


@tool
def get_sector_rotation(
    curr_date: Annotated[str, "Current date in yyyy-mm-dd format"],
    trade_date: Annotated[str, InjectedState("trade_date")] = "",
) -> str:
    """
    Retrieve each US sector's 1w/1mo/3mo return and spread versus SPY over the
    same sessions, the week-on-week change in that spread, the change in its
    1-month rank, and whether its leadership is persistent, reversing or fading.
    Args:
        curr_date (str): Current date in yyyy-mm-dd format
    Returns:
        str: A formatted sector rotation table.
    """
    return _serve("get_sector_rotation",
                  lambda date: collect_market_diagnostics(date)["rotation_report"], as_of(curr_date, trade_date))


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


def _vix(end_date: str) -> str:
    """The VIX's latest close, its 20-session range and its 1-month change, as of ``end_date``."""
    data = load_ohlcv("^VIX", end_date)
    closes = pd.to_numeric(data["Close"], errors="coerce").dropna()
    if closes.empty:
        return "VIX: no observations"
    dates = pd.to_datetime(data.loc[closes.index, "Date"])
    latest, last_date = float(closes.iloc[-1]), dates.iloc[-1].date().isoformat()
    window = closes.iloc[-20:]
    month = closes[dates <= dates.iloc[-1] - pd.DateOffset(months=1)]
    change = f"{latest - float(month.iloc[-1]):+.2f} pts over 1 month" if not month.empty else "1-month change unavailable"
    return (f"VIX {latest:.2f} on {last_date}; 20-session range {window.min():.2f}–{window.max():.2f}; {change}. "
            "Above about 30 is stress, below about 15 complacency; it measures expected S&P 500 volatility.")


def collect_market_sentiment(end_date: str) -> dict[str, str]:
    """The Sentiment Analyst's sources for the week to ``end_date``, each a text block.

    Every fetcher returns a placeholder instead of raising, as the ticker
    workflow's sentiment sources do, so the analyst always sees what is missing.
    """
    start_date = (datetime.strptime(end_date, "%Y-%m-%d") - timedelta(days=7)).strftime("%Y-%m-%d")
    reddit = "\n\n".join(
        f"### {terms}\n" + fetch_reddit_posts(terms, subreddits, start_date=start_date, end_date=end_date)
        for terms, subreddits in COMMUNITY_SEARCHES)
    stocktwits = "\n\n".join(
        f"### ${symbol}\n" + fetch_stocktwits_messages(symbol, limit=limit, start_date=start_date, end_date=end_date)
        for symbol, limit in (("SPY", 30), *((etf, 10) for etf in SECTOR_ETFS.values())))
    return {
        "start_date": start_date,
        "end_date": end_date,
        "vix": _serve("vix", _vix, end_date),
        "stocktwits": stocktwits,
        "reddit": reddit,
    }
