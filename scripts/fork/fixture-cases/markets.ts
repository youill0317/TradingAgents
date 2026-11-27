// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of the market views' sources (providers/markets.ts), for their tests (test/fork/data/markets*.test.ts),
 * written to test/fork/fixtures/markets/:
 *
 * - Yahoo, through yahoo-finance2 with its own User-Agent (the only one Yahoo answers), its crumb removed: one
 *   quote request for every symbol the views quote; the first page of the predefined screens day_gainers,
 *   day_losers and most_actives as the provider asks for it (250 rows, unvalidated: a screen longer than that
 *   is read on from row 251, a page the tests then need too, as screener-day-gainers-start5.json is for the
 *   hand-made screen of seven); the daily charts of the 11 SPDR
 *   sector funds and SPY over the rotation's window (3 months and the days before, counted from the day of
 *   recording).
 * - The ECB's main refinancing and marginal lending rates since 2024, beside test/fork/fixtures/ecb's deposit
 *   facility rate.
 * - FRED's keyless download of the views' series that test/fork/fixtures/fred does not hold.
 * - The Bank of Korea's base rate on ECOS (722Y001, item 0101000, daily) since 2024, for central_banks with
 *   ECOS_API_KEY (taken from the settings: it travels in the path and is removed from what is written; without it
 *   the case has no address and fails, unsent). ECOS answers a failure with HTTP 200 and a RESULT: read what was
 *   written. The fixture of this name is hand-made in ECOS's documented JSON until the owner records it.
 *
 * The views also read the Treasury's curves, the New York Fed's rates, the ECB's deposit facility rate and
 * FRED's headline series from the fixtures of their own sources (treasury.ts, nyfed.ts, ecb.ts, fred.ts here).
 * The tests' fixtures of these names are hand-made in the same forms until the owner records them (Yahoo
 * answers no other User-Agent; FRED's website did not answer the session that built them) but for the ECB's,
 * which are excerpts of its answer saved earlier; recording replaces them, so the golden texts then need
 * bringing up to date.
 */
import {
  BENCHMARK,
  COMMODITY_BENCHMARKS,
  CROSS_ASSET,
  CRYPTO,
  FRED_BANK_RATES,
  FUTURES,
  FX,
  INDICES,
  MOVE_INDEX,
  SCREENS,
  SECTOR_FUNDS,
  SUMMARY_INDICES,
  VIX_TERMS,
} from "../../../src/fork/data/catalog/markets.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import { parseListing } from "../../../src/fork/data/listings.js";
import { SCREEN_ROWS } from "../../../src/fork/data/providers/markets.js";
import type { FixtureCase, ReadTools } from "../record-fixtures.ts";

/** A date `days` from the day of recording (back when negative). */
function day(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** The answer of Yahoo's request whose path is `path`. */
function answerOf(path: string): RegExp {
  return new RegExp(
    `^https://query\\d\\.finance\\.yahoo\\.com${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?`,
  );
}

/** The Yahoo symbol of a key the views list. */
function yahooSymbol(key: string): string {
  const listing = parseListing(key);
  switch (listing.kind) {
    case "us":
    case "fx":
    case "crypto":
    case "future":
      return listing.yahoo;
    case "price_series":
      if (listing.yahoo) return listing.yahoo;
      break;
  }
  throw new Error(`fixture-cases/markets.ts: no Yahoo symbol for ${key}`);
}

/** Every symbol a view quotes, once. */
const SYMBOLS = [
  ...new Set(
    [
      ...SUMMARY_INDICES,
      ...INDICES,
      ...SECTOR_FUNDS,
      ...VIX_TERMS,
      MOVE_INDEX,
      ...COMMODITY_BENCHMARKS,
      ...Object.values(FUTURES).flat(),
      ...FX,
      ...CRYPTO,
      ...CROSS_ASSET.flatMap((spec) => ("key" in spec ? [spec] : [])),
    ].map((spec) => yahooSymbol(spec.key)),
  ),
];

function screen(id: string): FixtureCase {
  return {
    source: "markets",
    name: `screener-${id.replaceAll("_", "-")}`,
    read: (_http, { yahooAnswer }: ReadTools) =>
      yahooAnswer(
        (yahoo) =>
          yahoo.screener(
            {
              scrIds: id as (typeof SCREENS)[keyof typeof SCREENS],
              count: SCREEN_ROWS,
              region: "US",
              lang: "en-US",
            },
            undefined,
            { validateResult: false },
          ),
        answerOf("/v1/finance/screener/predefined/saved"),
      ),
  };
}

function chart(symbol: string): FixtureCase {
  return {
    source: "markets",
    name: `chart-${symbol.toLowerCase()}-1d`,
    read: (_http, { yahooAnswer }: ReadTools) =>
      yahooAnswer(
        (yahoo) => yahoo.chart(symbol, { period1: day(-104), period2: day(8), interval: "1d" }),
        answerOf(`/v8/finance/chart/${symbol}`),
      ),
  };
}

const FM = "https://data-api.ecb.europa.eu/service/data/FM";
const GRAPH = "https://fred.stlouisfed.org/graph/fredgraph.csv";

/** FRED's keyless download of `code` over a window. */
const graph = (code: string, start: string, end: string): FixtureCase => ({
  source: "markets",
  name: `fred-graph-${code.toLowerCase()}`,
  url: `${GRAPH}?id=${code}&cosd=${start}&coed=${end}`,
  file: `fred-graph-${code.toLowerCase()}.csv`,
});

export const cases: FixtureCase[] = [
  {
    source: "markets",
    name: "quotes",
    read: (_http, { yahooAnswer }: ReadTools) =>
      yahooAnswer((yahoo) => yahoo.quote(SYMBOLS), answerOf("/v7/finance/quote")),
  },
  ...Object.values(SCREENS).map(screen),
  ...[...SECTOR_FUNDS, BENCHMARK].map((fund) => chart(fund.key)),
  ...["MRR_FR", "MLFR"].map((rate) => ({
    source: "markets",
    name: `ecb-fm-${rate.toLowerCase().replace("_", "-")}-since2024`,
    url: `${FM}/D.U2.EUR.4F.KR.${rate}.LEV?format=csvdata&detail=dataonly&startPeriod=2024-01-01`,
  })),
  graph("PCEPI", "2025-05-01", "2026-11-25"),
  graph("PCEPILFE", "2025-05-01", "2026-11-25"),
  graph("ICSA", "2025-10-04", "2026-11-25"),
  graph("A191RL1Q225SBEA", "2023-01-01", "2026-11-25"),
  graph("BAMLH0A0HYM2", "2026-10-25", "2026-11-25"),
  graph("BAMLC0A0CM", "2026-10-25", "2026-11-25"),
  graph("BAA10Y", "2026-10-25", "2026-11-25"),
  ...FRED_BANK_RATES.map((bank) => graph(bank.id, "2025-05-01", "2026-11-25")),
  {
    // The Bank of Korea's base rate since 2024, as central_banks reads it with ECOS_API_KEY.
    source: "markets",
    name: "ecos-722y001-d-since2024",
    url: (config: PublicDataConfig) =>
      config.ecosKey
        ? `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(config.ecosKey)}/json/kr/1/1000/722Y001/D/20240101/20261125/0101000`
        : "ECOS_API_KEY is not set",
    file: "ecos-722y001-d-since2024.json",
  },
];
