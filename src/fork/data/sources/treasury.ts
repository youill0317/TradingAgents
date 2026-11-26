// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The U.S. Treasury's daily yield curves (no key): the par yield curve (constant-maturity yields on a
 * bond-equivalent basis, 1 month to 30 years, from 1990) and the real yield curve of TIPS (5 to 30 years,
 * from 2003), one CSV per year with every maturity.
 *
 * The files are read by column name, never by position: their maturities change by year (the 2003 file has
 * no "30 Yr" and no "2 Mo", the 2020 file no "4 Mo" or "1.5 Month", which starts in February 2025; the real
 * curve writes "YR" where the par curve writes "Yr"). Dates are MM/DD/YYYY, newest first; a blank cell is a
 * maturity not quoted that day; a year with no rows yet answers an empty body. Values are percents.
 */
import type { Call } from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import type { ForkDeps } from "../deps.js";
import { unreadable } from "../http.js";
import { csvTable, numberOf } from "../util/csv.js";

export const TREASURY_SOURCE = "U.S. Treasury";

const RATES_CSV =
  "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv";

/** The Treasury's two curves: the file each is in, and the first year of each. */
export const CURVES = {
  par: { type: "daily_treasury_yield_curve", since: 1990 },
  real: { type: "daily_treasury_real_yield_curve", since: 2003 },
} as const;
export type Curve = keyof typeof CURVES;

/** One day of a curve: each maturity quoted that day ("10y", "3m", "1.5m"), in percent. */
export type CurveDay = { date: string; yields: Record<string, number> };

/** The file of `curve`'s days in `year`, every maturity, unpaginated. */
export function curveUrl(curve: Curve, year: number): string {
  return `${RATES_CSV}/${year}/all?type=${CURVES[curve].type}&field_tdr_date_value=${year}&page&_format=csv`;
}

/**
 * A column's maturity as series keys write it: "10 Yr" and "10 YR" are "10y", "3 Mo" is "3m", "1.5 Month"
 * is "1.5m"; undefined for a column that is not a maturity.
 */
export function maturityOf(column: string): string | undefined {
  const found = /^(\d+(?:\.\d+)?)\s*(mo|mos|month|months|yr|yrs|year|years)$/i.exec(column.trim());
  if (!found) return undefined;
  return `${found[1]}${/^m/i.test(found[2] ?? "") ? "m" : "y"}`;
}

/** MM/DD/YYYY as an ISO date; undefined for anything else. */
function isoOf(date: string): string | undefined {
  const found = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date.trim());
  return found ? `${found[3]}-${found[1]}-${found[2]}` : undefined;
}

/** A curve file's days, oldest first; an empty body has none. */
export function parseCurve(text: string): CurveDay[] {
  if (!text.trim()) return [];
  const { header, rows } = csvTable(text);
  if (header[0]?.toLowerCase() !== "date") throw unreadable(TREASURY_SOURCE, "a yield curve");
  const maturities = header.map((column) => maturityOf(column));
  const days: CurveDay[] = [];
  for (const row of rows) {
    const date = isoOf(row[header[0] as string] ?? "");
    if (!date) continue;
    const yields: Record<string, number> = {};
    header.forEach((column, index) => {
      const maturity = maturities[index];
      const value = maturity ? numberOf(row[column]) : null;
      if (maturity && value !== null) yields[maturity] = value;
    });
    days.push({ date, yields });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * `curve`'s days in `year`, oldest first (none when the year has no rows yet). The file of a year still open,
 * or ended within the week (`today` is the engine's day), is kept an hour; an older one, which does not change,
 * a week.
 */
export async function curveYear(
  deps: ForkDeps,
  curve: Curve,
  year: number,
  today: string,
  call?: Call,
): Promise<CurveDay[]> {
  const signal = call?.signal;
  return deps.cache.remember(
    `treasury:${curve}:${year}`,
    today > `${year + 1}-01-07` ? 7 * 86_400_000 : 3_600_000,
    async () => {
      let text: string;
      try {
        text = await deps.http.text(curveUrl(curve, year), {
          source: TREASURY_SOURCE,
          signal,
          headers: { Accept: "text/csv" },
        });
      } catch (error) {
        // A year's file missing from its address is the source's failure, not a year without rates.
        if (error instanceof DataError && error.kind === "no_data") {
          throw new DataError(
            "unavailable",
            `The Treasury's ${curve} yield curve file for ${year} is not at its address (HTTP ${error.details.status ?? 404}).`,
            { ...error.details, source: TREASURY_SOURCE },
          );
        }
        throw error;
      }
      return parseCurve(text);
    },
    { disk: "json", signal },
  );
}
