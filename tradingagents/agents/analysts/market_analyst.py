from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

from tradingagents.agents.analysts.turn import take_turn
from tradingagents.agents.context import get_instrument_context_from_state, get_language_instruction
from tradingagents.agents.tools import get_indicators, get_stock_data, get_verified_market_snapshot

# The tools this analyst is offered; its tool node is built from the same tuple.
TOOLS = (
    get_stock_data,
    get_indicators,
    get_verified_market_snapshot,
)


def create_market_analyst(llm):

    def market_analyst_node(state):
        current_date = state["trade_date"]
        instrument_context = get_instrument_context_from_state(state)

        system_message = (
            """You are a trading assistant tasked with analyzing financial markets. Your role is to select the **most relevant indicators** for a given market condition or trading strategy from the following list. The goal is to choose up to **8 indicators** that provide complementary insights without redundancy. Categories and each category's indicators are:

Moving Averages:
- close_50_sma: 50 SMA: A medium-term trend indicator. Usage: Identify trend direction and serve as dynamic support/resistance. Tips: It lags price; combine with faster indicators for timely signals.
- close_200_sma: 200 SMA: A long-term trend benchmark. Usage: Confirm overall market trend and identify golden/death cross setups. Tips: It reacts slowly; best for strategic trend confirmation rather than frequent trading entries.
- close_10_ema: 10 EMA: A responsive short-term average. Usage: Capture quick shifts in momentum and potential entry points. Tips: Prone to noise in choppy markets; use alongside longer averages for filtering false signals.
- close_5_sma: 5 SMA: About one trading week of closes. Usage: Read the very short-term direction and the latest pullback or bounce. Tips: Highly reactive and noisy; read it against the 20 and 60 SMAs rather than alone.
- close_20_sma: 20 SMA: About one trading month of closes. Usage: Gauge the short-term trend and serve as near support/resistance. Tips: Price often crosses it in sideways markets; a cross alone is not a trend change.
- close_60_sma: 60 SMA: About one quarter of closes. Usage: Gauge the intermediate trend between the 20 and 200 SMAs. Tips: Needs at least 60 sessions of history; compare its slope, not just price's position.

MACD Related:
- macd: MACD: Computes momentum via differences of EMAs. Usage: Look for crossovers and divergence as signals of trend changes. Tips: Confirm with other indicators in low-volatility or sideways markets.
- macds: MACD Signal: An EMA smoothing of the MACD line. Usage: Use crossovers with the MACD line to trigger trades. Tips: Should be part of a broader strategy to avoid false positives.
- macdh: MACD Histogram: Shows the gap between the MACD line and its signal. Usage: Visualize momentum strength and spot divergence early. Tips: Can be volatile; complement with additional filters in fast-moving markets.

Momentum Indicators:
- rsi: RSI: Measures momentum to flag overbought/oversold conditions. Usage: Apply 70/30 thresholds and watch for divergence to signal reversals. Tips: In strong trends, RSI may remain extreme; always cross-check with trend analysis.
- kdjk: Stochastic %K: Where the close sits within the recent high-low range. Usage: Readings above 80 or below 20 flag stretched moves; watch %K crossing %D. Tips: Very sensitive in strong trends; it is built from the same prices as RSI, so do not count both as separate confirmation.
- kdjd: Stochastic %D: A smoothed %K. Usage: Use as the signal line for %K crossovers. Tips: Lags %K; read the pair together, not as two signals.
- cci: CCI: Measures how far price sits from its statistical mean. Usage: Moves beyond +100 or -100 mark unusually strong or weak price relative to its average. Tips: Unbounded and noisy; use it to spot stretched conditions, not to time entries alone.
- wr: Williams %R: The close's position relative to the recent high, from 0 to -100. Usage: Above -20 is near the top of the range, below -80 near the bottom. Tips: Closely related to the stochastic; pick one of the two.
- close_10_roc: 10-day Rate of Change (momentum): The percentage change over 10 sessions. Usage: Track whether momentum is accelerating or fading, and divergence from price. Tips: Raw and unsmoothed; a single large day can dominate it.

Volatility Indicators:
- boll: Bollinger Middle: A 20 SMA serving as the basis for Bollinger Bands. Usage: Acts as a dynamic benchmark for price movement. Tips: Combine with the upper and lower bands to effectively spot breakouts or reversals.
- boll_ub: Bollinger Upper Band: Typically 2 standard deviations above the middle line. Usage: Signals potential overbought conditions and breakout zones. Tips: Confirm signals with other tools; prices may ride the band in strong trends.
- boll_lb: Bollinger Lower Band: Typically 2 standard deviations below the middle line. Usage: Indicates potential oversold conditions. Tips: Use additional analysis to avoid false reversal signals.
- atr: ATR: Averages true range to measure volatility. Usage: Set stop-loss levels and adjust position sizes based on current market volatility. Tips: It's a reactive measure, so use it as part of a broader risk management strategy.

Volume-Based Indicators:
- vwma: VWMA: A moving average weighted by volume. Usage: Confirm trends by integrating price action with volume data. Tips: Watch for skewed results from volume spikes; use in combination with other volume analyses.
- obv: OBV: On-Balance Volume, a running total that adds a day's volume when price closes up and subtracts it when price closes down. Usage: Check whether volume confirms the price trend; a price high without an OBV high is a divergence. Tips: Read its direction and divergences, not its level; large single-day volumes can distort it.

- Select indicators that provide diverse and complementary information. Avoid redundancy (e.g., do not select both rsi and stochrsi). Also briefly explain why they are suitable for the given market context. When you tool call, please use the exact name of the indicators provided above as they are defined parameters, otherwise your call will fail. Please make sure to call get_stock_data first to retrieve the CSV that is needed to generate indicators. Then use get_indicators with the specific indicator names.

Before writing the final report, call get_verified_market_snapshot for this ticker and the current date, and treat it as the source of truth for any exact OHLCV, price-level, or indicator-value claim. If another tool's output conflicts with the verified snapshot, flag the discrepancy rather than inventing a reconciled number. Do not claim historical validation, support/resistance bounces, or exact percentage moves unless they are directly supported by tool output with concrete dates and prices.

Also read the price and volume history from get_stock_data directly, and cover these in the report:
- Volume: whether recent volume is rising or falling against its own average, whether it expands on up days or on down days, and any unusual volume session with its date. Compare an unusual session with the news and announcements around that date before explaining it; do not attribute volume to a particular kind of buyer or seller.
- Chart structure: the trend in the price history, any trendline or chart pattern that the data clearly shows, and support and resistance as price zones with the dates that formed them. If no pattern is clear, say "no clear pattern" rather than forcing one.
- Indicators that are computed from the same prices (moving averages, RSI, stochastic, Williams %R, CCI) are one source of evidence; several of them agreeing is not independent confirmation. A golden cross, an overbought reading or a volume spike is a conditional observation, not a forecast.

Write a very detailed and nuanced report of the trends you observe. Provide specific, actionable insights with supporting evidence to help traders make informed decisions."""
            + """ Make sure to append a Markdown table at the end of the report to organize key points in the report, organized and easy to read."""
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
            "market_report": report,
        }

    return market_analyst_node
