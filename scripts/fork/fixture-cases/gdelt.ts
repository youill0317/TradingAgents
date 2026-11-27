// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of the news provider's sources for its tests (test/fork/data/news*.test.ts): GDELT's DOC API
 * article lists (gdelt/), each for the search the provider builds for a topic, the market's latest, words and
 * a tone (sources/gdelt.ts), and Yahoo's raw search answers with news (yahoo-news/), recorded through
 * yahoo-finance2 with its own User-Agent (the only one Yahoo answers) as the provider asks (quotesCount 0).
 * The tests' fixtures of these names are hand-made in the same forms until the owner records them: GDELT could
 * not be reached from the development session, and Yahoo answers no other User-Agent. GDELT's lists are
 * recorded at a few articles each (`maxrecords`), to keep them small; the tests match a search by its words,
 * whatever its count. Times follow the day of recording, so the tests' days and texts follow a new recording.
 */
import { artListUrl, gdeltQuery } from "../../../src/fork/data/sources/gdelt.js";
import type { FixtureCase, ReadTools } from "../record-fixtures.ts";

/** GDELT's article list for `query`, at most `records` articles (the provider asks for GDELT's maximum). */
function articles(name: string, query: string, records = 10): FixtureCase {
  const url = new URL(artListUrl({ query }));
  url.searchParams.set("maxrecords", String(records));
  return { source: "gdelt", name, url: url.href };
}

/** Yahoo's answer to the provider's news search for `symbol`. */
function yahooNews(name: string, symbol: string, newsCount: number): FixtureCase {
  return {
    source: "yahoo-news",
    name,
    read: (_http, { yahooAnswer }: ReadTools) =>
      yahooAnswer(
        (yahoo) => yahoo.search(symbol, { newsCount, quotesCount: 0 }, { validateResult: false }),
        /^https:\/\/query\d\.finance\.yahoo\.com\/v1\/finance\/search\?/,
      ),
  };
}

export const cases: FixtureCase[] = [
  // A topic (macro-outlook's "fed"), the market's latest (market-brief's), words, words with a tone.
  articles("artlist-fed", gdeltQuery({ topic: "fed" })),
  articles("artlist-market", gdeltQuery({})),
  articles("artlist-chip-export-controls", gdeltQuery({ words: "chip export controls" })),
  articles("artlist-tariffs-bearish", gdeltQuery({ words: "tariffs", tone: "bearish" })),
  // Words in Korean (the setup with Korea's keys, test/fork/data/korea-routes.test.ts).
  articles("artlist-samsung-semiconductor", gdeltQuery({ words: "삼성전자 반도체" })),
  // Nothing matching, and a search GDELT refuses in words (a keyword too short).
  articles("artlist-empty", gdeltQuery({ words: "zzqx vvkj" })),
  { ...articles("refusal-keyword", "an"), file: "refusal-keyword.txt" },
  // A US listing's news and a Korean listing's.
  yahooNews("search-aapl", "AAPL", 12),
  yahooNews("search-005930-ks", "005930.KS", 9),
];
