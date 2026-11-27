// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of the instrument search for its tests (test/fork/data/instruments*.test.ts): Yahoo's raw answers
 * to its search (instruments/), recorded through yahoo-finance2 with its own User-Agent (the only one Yahoo
 * answers) as the provider first asks (YAHOO_SEARCH: listings only, no news), one for each search the tests
 * make; an answer holding all the matches asked for is asked again for ten times as many, a request the tests
 * then need recorded too. With DART_API_KEY the search places OpenDART's Korean companies on their markets by
 * one batched quote of their KOSPI and KOSDAQ spellings: Yahoo's quote of the listings those tests place
 * (KOREAN_LISTINGS) is recorded as one answer, whose rows the tests serve to each batch. SEC's ticker list and
 * OpenDART's company list, which the tests read too, are recorded with SEC's and OpenDART's other fixtures
 * (sec.ts, dart.ts). The tests' fixtures of these names are hand-made in the same form until the owner records
 * them; Yahoo's matches and their order follow the day of recording, so the golden texts of those tests follow
 * a new recording.
 */
import { YAHOO_SEARCH } from "../../../src/fork/data/providers/instruments.js";
import type { FixtureCase, ReadTools } from "../record-fixtures.ts";

/** Yahoo's answer to the instrument search's request for `words`. */
function yahooSearch(name: string, words: string): FixtureCase {
  return {
    source: "instruments",
    name,
    read: (_http, { yahooAnswer }: ReadTools) =>
      yahooAnswer(
        (yahoo) => yahoo.search(words, { ...YAHOO_SEARCH }, { validateResult: false }),
        /^https:\/\/query\d\.finance\.yahoo\.com\/v1\/finance\/search\?/,
      ),
  };
}

/** The Korean listings the instrument search's tests place OpenDART's companies by (their rows of one quote). */
export const KOREAN_LISTINGS = [
  "005930.KS",
  "005935.KS",
  "006400.KS",
  "009150.KS",
  "028260.KS",
  "000660.KS",
  "035720.KS",
  "035900.KQ",
] as const;

export const cases: FixtureCase[] = [
  // A US ticker, a company's name, a company with two share classes.
  yahooSearch("yahoo-search-aapl", "AAPL"),
  yahooSearch("yahoo-search-apple", "Apple"),
  yahooSearch("yahoo-search-berkshire-hathaway", "Berkshire Hathaway"),
  // A Korean company's name in English, its code alone and Yahoo's symbol for it (asked for XKRX:005930 too).
  yahooSearch("yahoo-search-samsung-electronics", "Samsung Electronics"),
  yahooSearch("yahoo-search-005930", "005930"),
  yahooSearch("yahoo-search-005930-ks", "005930.KS"),
  // A Korean fund's code (KODEX 200), which OpenDART's company list does not hold.
  yahooSearch("yahoo-search-069500", "069500"),
  // Yahoo's quote of the Korean listings OpenDART's matches are placed by, in one request.
  {
    source: "instruments",
    name: "yahoo-quote-kr-listings",
    read: (_http, { yahooAnswer }: ReadTools) =>
      yahooAnswer(
        (yahoo) => yahoo.quote([...KOREAN_LISTINGS], {}, { validateResult: false }),
        /^https:\/\/query\d\.finance\.yahoo\.com\/v7\/finance\/quote\?/,
      ),
  },
  // The tool's own examples and an economic series by name: what Yahoo adds to the catalogs' matches.
  yahooSearch("yahoo-search-gold", "gold"),
  yahooSearch("yahoo-search-crude-oil", "crude oil"),
  yahooSearch("yahoo-search-s-and-p-500", "S&P 500"),
  yahooSearch("yahoo-search-euro-dollar", "euro dollar"),
  yahooSearch("yahoo-search-bitcoin", "bitcoin"),
  yahooSearch("yahoo-search-cpi", "CPI"),
  yahooSearch("yahoo-search-10-year-treasury-yield", "10-year Treasury yield"),
];
