// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of the New York Fed's reference rates (no key), for the statistics provider's tests
 * (test/fork/data/nyfed.test.ts): the latest days of EFFR, SOFR, OBFR and TGCR, windows of EFFR (October 2026;
 * December 2008, with a revised rate and the target's change from one rate to a range) and of SOFR (2026; a
 * weekend, which has none).
 *
 * The fixtures in the repository are the New York Fed's own answers saved earlier (SOFR's 2026 cut to its rows
 * from September; TGCR's made from the all-rates answer's TGCR row); recording replaces them with its current
 * answers, so the golden texts in those tests then need bringing up to date.
 */
import type { FixtureCase } from "../record-fixtures.ts";

const RATES = "https://markets.newyorkfed.org/api/rates";

export const cases: FixtureCase[] = [
  { source: "nyfed", name: "effr-last5", url: `${RATES}/unsecured/effr/last/5.json` },
  { source: "nyfed", name: "sofr-last5", url: `${RATES}/secured/sofr/last/5.json` },
  { source: "nyfed", name: "obfr-last5", url: `${RATES}/unsecured/obfr/last/5.json` },
  { source: "nyfed", name: "tgcr-last1", url: `${RATES}/secured/tgcr/last/1.json` },
  {
    source: "nyfed",
    name: "effr-search-2026-10",
    url: `${RATES}/unsecured/effr/search.json?startDate=2026-10-01&endDate=2026-10-31`,
  },
  {
    source: "nyfed",
    name: "effr-search-2008-12",
    url: `${RATES}/unsecured/effr/search.json?startDate=2008-12-12&endDate=2008-12-19`,
  },
  {
    source: "nyfed",
    name: "sofr-search-2026",
    url: `${RATES}/secured/sofr/search.json?startDate=2026-01-01&endDate=2026-11-25`,
  },
  {
    source: "nyfed",
    name: "sofr-search-weekend",
    url: `${RATES}/secured/sofr/search.json?startDate=2026-11-21&endDate=2026-11-22`,
  },
];
