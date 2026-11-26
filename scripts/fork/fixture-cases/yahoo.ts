// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of Yahoo for the Yahoo composite's tests (test/fork/data/yahoo.test.ts), each Yahoo's raw answer
 * to the yahoo-finance2 call the composite makes, recorded through the library with its own User-Agent (the
 * only one Yahoo answers) and its crumb removed. The tests' fixtures of these names are hand-made in the same
 * shapes until the owner records them; windows are counted from the day of recording, so the tests' days and
 * values follow a new recording.
 */
import { MODULES } from "../../../src/fork/data/sources/yahoo.js";
import type { FixtureCase, ReadTools } from "../record-fixtures.ts";

/** A date `days` from the day of recording (back when negative). */
function day(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** The answer of Yahoo's request whose path is `path` (a quote, a chart, a summary). */
function answerOf(path: string): RegExp {
  return new RegExp(
    `^https://query\\d\\.finance\\.yahoo\\.com${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?`,
  );
}

function quote(name: string, symbol: string): FixtureCase {
  return {
    source: "yahoo",
    name,
    read: (_http, { yahooAnswer }: ReadTools) =>
      yahooAnswer((yahoo) => yahoo.quote([symbol]), answerOf("/v7/finance/quote")),
  };
}

function chart(
  name: string,
  symbol: string,
  options: {
    period1: string;
    period2?: string;
    interval: "1d" | "15m" | "1h";
    includePrePost?: boolean;
    events?: string;
  },
): FixtureCase {
  return {
    source: "yahoo",
    name,
    read: (_http, { yahooAnswer }: ReadTools) =>
      yahooAnswer((yahoo) => yahoo.chart(symbol, options), answerOf(`/v8/finance/chart/${symbol}`)),
  };
}

function summary(name: string, symbol: string, use: keyof typeof MODULES): FixtureCase {
  return {
    source: "yahoo",
    name,
    read: (_http, { yahooAnswer }: ReadTools) =>
      yahooAnswer(
        (yahoo) => yahoo.quoteSummary(symbol, { modules: [...MODULES[use]] }),
        answerOf(`/v10/finance/quoteSummary/${symbol}`),
      ),
  };
}

export const cases: FixtureCase[] = [
  // Upstream's provider: a US listing's quote and daily bars (the harness's YAHOO_AAPL).
  quote("quote-aapl", "AAPL"),
  chart("chart-aapl-1d", "AAPL", { period1: day(-9), period2: day(8), interval: "1d" }),
  // Listings and instruments the composite answers itself: Korea (KOSPI, KOSDAQ), a futures front month,
  // a currency pair, a crypto pair, an index.
  quote("quote-005930-ks", "005930.KS"),
  quote("quote-035900-kq", "035900.KQ"),
  quote("quote-cl-f", "CL=F"),
  quote("quote-eurusd-x", "EURUSD=X"),
  quote("quote-btc-usd", "BTC-USD"),
  quote("quote-gspc", "^GSPC"),
  chart("chart-005930-ks-1d", "005930.KS", { period1: day(-9), period2: day(8), interval: "1d" }),
  chart("chart-cl-f-1d", "CL=F", { period1: day(-9), period2: day(8), interval: "1d" }),
  chart("chart-gspc-1d", "^GSPC", { period1: day(-9), period2: day(8), interval: "1d" }),
  chart("chart-btc-usd-1d", "BTC-USD", { period1: day(-9), period2: day(8), interval: "1d" }),
  chart("chart-eurusd-x-1d", "EURUSD=X", { period1: day(-59), period2: day(8), interval: "1d" }),
  // The indicators' window (TECHNICALS_DAYS), intraday bars, a whole history's events.
  chart("chart-aapl-1d-600", "AAPL", { period1: day(-601), period2: day(8), interval: "1d" }),
  chart("chart-aapl-15m", "AAPL", { period1: day(-7), interval: "15m", includePrePost: false }),
  chart("chart-005930-ks-1h", "005930.KS", { period1: day(-3), interval: "1h", includePrePost: false }),
  chart("chart-aapl-events", "AAPL", {
    period1: `${new Date().getUTCFullYear() - 99}-01-01`,
    period2: day(1),
    interval: "1d",
    events: "div|split",
  }),
  // quoteSummary, by use: a profile (and the comps tool's peers), analysts' estimates, the calendar, holders.
  summary("quotesummary-aapl-profile", "AAPL", "profile"),
  summary("quotesummary-msft-profile", "MSFT", "profile"),
  summary("quotesummary-googl-profile", "GOOGL", "profile"),
  summary("quotesummary-meta-profile", "META", "profile"),
  summary("quotesummary-005930-ks-profile", "005930.KS", "profile"),
  summary("quotesummary-aapl-analyst", "AAPL", "analyst"),
  summary("quotesummary-aapl-calendar", "AAPL", "calendar"),
  summary("quotesummary-aapl-holders", "AAPL", "holders"),
];
