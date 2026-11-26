// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of the U.S. Treasury's daily yield curves (no key), for the statistics provider's tests
 * (test/fork/data/treasury.test.ts): the par and real curves' 2026 files, the par curve's 2025 file (paging back a
 * year), and its 2003 and 2020 files, whose columns differ from today's.
 *
 * The fixtures in the repository are the Treasury's own answers saved earlier (2003 and 2020 cut to their header
 * and a few rows); recording replaces them with the whole current files, so the golden texts in those tests then
 * need bringing up to date (the current year's file grows each business day).
 */
import type { FixtureCase } from "../record-fixtures.ts";

const RATES =
  "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv";

/** A curve's file for a year, every maturity, unpaginated. */
const year = (name: string, type: string, of: number): FixtureCase => ({
  source: "treasury",
  name,
  url: `${RATES}/${of}/all?type=${type}&field_tdr_date_value=${of}&page&_format=csv`,
  file: `${name}.csv`,
});

export const cases: FixtureCase[] = [
  year("par-2026", "daily_treasury_yield_curve", 2026),
  year("real-2026", "daily_treasury_real_yield_curve", 2026),
  year("par-2025", "daily_treasury_yield_curve", 2025),
  year("par-2020", "daily_treasury_yield_curve", 2020),
  year("par-2003", "daily_treasury_yield_curve", 2003),
];
