// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of the instrument search for its tests (test/fork/data/instruments*.test.ts): Yahoo's raw answers
 * to its search (instruments/), recorded through yahoo-finance2 with its own User-Agent (the only one Yahoo
 * answers) as the provider first asks (YAHOO_SEARCH: listings only, no news), one for each search the tests
 * make; an answer holding all the matches asked for is asked again for ten times as many, a request the tests
 * then need recorded too. SEC's ticker list, which the tests read too, is recorded with SEC's other fixtures
 * (sec.ts). The tests'
 * fixtures of these names are hand-made in the same form until the owner records them; Yahoo's matches and
 * their order follow the day of recording, so the golden texts of those tests follow a new recording.
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

export const cases: FixtureCase[] = [
  // A US ticker, a company's name, a company with two share classes.
  yahooSearch("yahoo-search-aapl", "AAPL"),
  yahooSearch("yahoo-search-apple", "Apple"),
  yahooSearch("yahoo-search-berkshire-hathaway", "Berkshire Hathaway"),
  // A Korean company's name in English, its code alone and Yahoo's symbol for it (asked for XKRX:005930 too).
  yahooSearch("yahoo-search-samsung-electronics", "Samsung Electronics"),
  yahooSearch("yahoo-search-005930", "005930"),
  yahooSearch("yahoo-search-005930-ks", "005930.KS"),
  // The tool's own examples and an economic series by name: what Yahoo adds to the catalogs' matches.
  yahooSearch("yahoo-search-gold", "gold"),
  yahooSearch("yahoo-search-crude-oil", "crude oil"),
  yahooSearch("yahoo-search-s-and-p-500", "S&P 500"),
  yahooSearch("yahoo-search-euro-dollar", "euro dollar"),
  yahooSearch("yahoo-search-bitcoin", "bitcoin"),
  yahooSearch("yahoo-search-cpi", "CPI"),
  yahooSearch("yahoo-search-10-year-treasury-yield", "10-year Treasury yield"),
];
