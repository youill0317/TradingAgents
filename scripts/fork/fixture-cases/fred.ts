// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of FRED, for the statistics provider's tests (test/fork/data/fred.test.ts): its keyless download of
 * the catalog's headline series (CPI, core CPI, the unemployment rate, payrolls, real GDP), and its API with
 * FRED_API_KEY (taken from the settings, never from here): CPI's description and every vintage, a search for a
 * code outside the catalog and that series' description and vintages, and FRED's 400 answers without a key and
 * for a code it does not know.
 *
 * Every fixture in the repository but error-no-key.json is hand-made in FRED's documented formats: FRED's website
 * did not answer the session that built them, and no key was used. Recording replaces them with FRED's own
 * answers, so the golden texts in those tests then need bringing up to date. A case needing the key fails
 * (writing nothing) when FRED_API_KEY is not set.
 */
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import type { FixtureCase } from "../record-fixtures.ts";

const API = "https://api.stlouisfed.org/fred";
const GRAPH = "https://fred.stlouisfed.org/graph/fredgraph.csv";

/** An API address with the configured key (empty when none is set, which FRED refuses). */
const keyed = (path: string, query: string) => (config: PublicDataConfig) =>
  `${API}/${path}?${query}&api_key=${encodeURIComponent(config.fredKey ?? "")}&file_type=json`;

/** The keyless download of a series over a window. */
const graph = (code: string, start: string, end: string): FixtureCase => ({
  source: "fred",
  name: `graph-${code.toLowerCase()}`,
  url: `${GRAPH}?id=${code}&cosd=${start}&coed=${end}`,
  file: `graph-${code.toLowerCase()}.csv`,
});

/** Every vintage of a series' dates from `start` to `end`. */
const vintages = (code: string, start: string, end: string): FixtureCase => ({
  source: "fred",
  name: `observations-${code.toLowerCase()}`,
  url: keyed(
    "series/observations",
    `series_id=${code}&realtime_start=1776-07-04&realtime_end=9999-12-31&observation_start=${start}&observation_end=${end}`,
  ),
  file: `observations-${code.toLowerCase()}.json`,
});

export const cases: FixtureCase[] = [
  graph("CPIAUCSL", "2025-05-01", "2026-11-25"),
  graph("CPILFESL", "2025-05-01", "2026-11-25"),
  graph("UNRATE", "2025-05-01", "2026-11-25"),
  graph("PAYEMS", "2025-05-01", "2026-11-25"),
  graph("GDPC1", "2023-01-01", "2026-11-25"),
  {
    source: "fred",
    name: "series-cpiaucsl",
    url: keyed("series", "series_id=CPIAUCSL"),
    file: "series-cpiaucsl.json",
  },
  vintages("CPIAUCSL", "2025-05-01", "2026-11-25"),
  {
    source: "fred",
    name: "series-dexjpus",
    url: keyed("series", "series_id=DEXJPUS"),
    file: "series-dexjpus.json",
  },
  {
    source: "fred",
    name: "search-dexjpus",
    url: keyed("series/search", "search_text=DEXJPUS&limit=5&order_by=search_rank&sort_order=desc"),
    file: "search-dexjpus.json",
  },
  vintages("DEXJPUS", "2026-10-28", "2026-11-25"),
  {
    // FRED's 400 for a request without a key, kept deliberately (no key is sent).
    source: "fred",
    name: "error-no-key",
    url: `${API}/series?series_id=CPIAUCSL&file_type=json`,
    accept: [400],
    file: "error-no-key.json",
  },
  {
    source: "fred",
    name: "error-no-series",
    url: keyed("series", "series_id=NOSUCHCODE"),
    accept: [400],
    file: "error-no-series.json",
  },
];
