// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The European Central Bank's data API (SDMX, as CSV; no key).
 *
 * - Euro reference rates (EXR, `D.<currency>.EUR.SP00.A`): units of each currency per euro, set once a TARGET
 *   business day at 14:15 CET and published about 16:00 CET, from 1999-01-04 for the euro's first currencies.
 *   Several currencies come from one request (`D.KRW+USD.EUR.SP00.A`), each series' rows together, oldest
 *   first. 29 currencies are live; 15 ended (a country joined the euro, or the ECB stopped quoting it).
 * - Key interest rates (FM, `D.U2.EUR.4F.KR.<rate>.LEV`): the deposit facility (DFR), main refinancing (MRR_FR)
 *   and marginal lending facility (MLFR) rates, a row for every calendar day, weekends included, holding the
 *   rate in effect; `rateRuns` reads them as the runs between changes, each from the date it took effect.
 *
 * Answers are read by column name (`detail=dataonly` trims them to the key columns, but a full answer reads
 * the same): CRLF line ends, quoted fields with commas in them. A series with no row in the window answers
 * an empty body (no rows); a key the ECB does not know answers 404. The ECB is slow (1-7 s for one series,
 * 21 s for every currency's latest rate), so its requests take the HTTP client's slow-host deadline.
 */
import type { Call } from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import type { ForkDeps } from "../deps.js";
import { unreadable } from "../http.js";
import { csvTable, numberOf } from "../util/csv.js";

export const ECB_SOURCE = "ECB";
export const ECB_DATA = "https://data-api.ecb.europa.eu/service/data";

/** The first day of the euro's reference rates. */
export const EURO_START = "1999-01-04";

/** The currencies the ECB publishes a daily euro reference rate for. */
export const ECB_CURRENCIES: readonly string[] = [
  "AUD",
  "BRL",
  "CAD",
  "CHF",
  "CNY",
  "CZK",
  "DKK",
  "GBP",
  "HKD",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "ISK",
  "JPY",
  "KRW",
  "MXN",
  "MYR",
  "NOK",
  "NZD",
  "PHP",
  "PLN",
  "RON",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "USD",
  "ZAR",
];

/** Currencies whose euro reference rate the ECB no longer publishes, by the date of its last one. */
export const ECB_ENDED: Readonly<Record<string, string>> = {
  ARS: "2020-10-30",
  DZD: "2020-10-30",
  MAD: "2020-10-30",
  TWD: "2020-10-30",
  RUB: "2022-03-01",
  HRK: "2022-12-30",
  BGN: "2025-12-31",
  LTL: "2014-12-31",
  LVL: "2013-12-31",
  EEK: "2010-12-31",
  SKK: "2008-12-31",
  CYP: "2007-12-31",
  MTL: "2007-12-31",
  SIT: "2006-12-29",
  GRD: "2000-12-29",
};

// Reference rates --------------------------------------------------------------------------------

/** One reference rate: units of `currency` per euro on `date`. */
export type ExchangeRate = { currency: string; date: string; value: number | null };

/** How long a window's rates are kept: a window that ended days ago is settled. */
function keptFor(to: string, today: string): number {
  return to < today && Date.parse(`${today}T00:00:00Z`) - Date.parse(`${to}T00:00:00Z`) > 2 * 86_400_000
    ? 7 * 86_400_000
    : 3_600_000;
}

/** The address of the reference rates of `currencies` (none of them EUR) from `from` to `to`. */
export function exchangeRatesUrl(
  currencies: readonly string[],
  window: { from: string; to: string },
): string {
  return `${ECB_DATA}/EXR/D.${currencies.join("+")}.EUR.SP00.A?format=csvdata&detail=dataonly&startPeriod=${window.from}&endPeriod=${window.to}`;
}

/**
 * The euro reference rates of `currencies` (none of them EUR) from `from` to `to`, both inclusive, oldest
 * first within each currency; none when the ECB published none in the window. A currency the ECB does not
 * know is no_data (its 404).
 */
export async function exchangeRates(
  deps: ForkDeps,
  currencies: readonly string[],
  window: { from: string; to: string },
  today: string,
  call?: Call,
): Promise<ExchangeRate[]> {
  const list = [...new Set(currencies)].sort();
  const signal = call?.signal;
  return deps.cache.remember(
    `ecb:exr:${list.join("+")}:${window.from}:${window.to}`,
    keptFor(window.to, today),
    async () =>
      parseExchangeRates(
        await deps.http.text(exchangeRatesUrl(list, window), {
          source: ECB_SOURCE,
          signal,
          headers: { Accept: "text/csv" },
          notFound: "no_data",
          notFoundMessage: `the ECB has no ${list.join(" or ")} euro reference rate from ${window.from} to ${window.to}`,
        }),
      ).filter((rate) => rate.date >= window.from && rate.date <= window.to),
    { disk: "json", signal },
  );
}

/** The rows of an EXR answer, by column name; an empty body has none. */
export function parseExchangeRates(text: string): ExchangeRate[] {
  if (!text.trim()) return [];
  const { header, rows } = csvTable(text);
  for (const column of ["CURRENCY", "TIME_PERIOD", "OBS_VALUE"]) {
    if (!header.includes(column)) throw unreadable(ECB_SOURCE, "reference rates");
  }
  return rows
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.TIME_PERIOD ?? ""))
    .map((row) => ({
      currency: row.CURRENCY ?? "",
      date: row.TIME_PERIOD ?? "",
      value: numberOf(row.OBS_VALUE),
    }));
}

// Key interest rates -------------------------------------------------------------------------------

export type PolicyRate = "DFR" | "MRR_FR" | "MLFR";

/** The earliest day a key interest rate is asked from: the euro's first day. */
export const POLICY_START = "1999-01-01";

/** One day of a key interest rate: the rate in effect on `date`. */
export type PolicyDay = { date: string; value: number | null };

/** A run of days with one rate: from the day it took effect (`date`) to the last day of it read (`through`). */
export type RateRun = { date: string; through: string; value: number };

/** The address of one key interest rate's days from `from` (to `to`, or to the latest). */
export function policyRateUrl(rate: PolicyRate, window: { from: string; to?: string }): string {
  return `${ECB_DATA}/FM/D.U2.EUR.4F.KR.${rate}.LEV?format=csvdata&detail=dataonly&startPeriod=${window.from}${window.to ? `&endPeriod=${window.to}` : ""}`;
}

/**
 * The runs of one key interest rate from `from` (to `to`, or to the latest day published): a window
 * reaching today is kept an hour, an older one a week.
 */
export async function policyRateRuns(
  deps: ForkDeps,
  rate: PolicyRate,
  window: { from: string; to?: string },
  call?: Call,
): Promise<RateRun[]> {
  const signal = call?.signal;
  return deps.cache.remember(
    `ecb:fm:${rate}:${window.from}:${window.to ?? "latest"}`,
    window.to ? 7 * 86_400_000 : 3_600_000,
    async () => {
      let text: string;
      try {
        text = await deps.http.text(policyRateUrl(rate, window), {
          source: ECB_SOURCE,
          signal,
          headers: { Accept: "text/csv" },
        });
      } catch (error) {
        // "No Series was returned for the query": a window without a row, as an empty body is.
        if (error instanceof DataError && error.kind === "no_data") return [];
        throw error;
      }
      return rateRuns(parsePolicyDays(text, rate));
    },
    { disk: "json", signal },
  );
}

/** The days of an FM answer for `rate`, by column name, oldest first; an empty body has none. */
export function parsePolicyDays(text: string, rate: PolicyRate): PolicyDay[] {
  if (!text.trim()) return [];
  const { header, rows } = csvTable(text);
  for (const column of ["TIME_PERIOD", "OBS_VALUE"]) {
    if (!header.includes(column)) throw unreadable(ECB_SOURCE, "key interest rates");
  }
  const named = header.includes("PROVIDER_FM_ID");
  return rows
    .filter(
      (row) => (!named || row.PROVIDER_FM_ID === rate) && /^\d{4}-\d{2}-\d{2}$/.test(row.TIME_PERIOD ?? ""),
    )
    .map((row) => ({ date: row.TIME_PERIOD ?? "", value: numberOf(row.OBS_VALUE) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** The day after `date`. */
function nextDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/**
 * Days as runs of one rate: a run goes on while each next day holds the same rate; a different rate, or a
 * day missing or without a value (the main refinancing rate was not set as a fixed rate from mid-2000 to
 * late 2008), ends it.
 */
export function rateRuns(days: readonly PolicyDay[]): RateRun[] {
  const runs: RateRun[] = [];
  let open: RateRun | undefined;
  for (const day of days) {
    if (day.value === null) {
      open = undefined;
      continue;
    }
    if (open && open.value === day.value && nextDay(open.through) === day.date) {
      open.through = day.date;
      continue;
    }
    open = { date: day.date, through: day.date, value: day.value };
    runs.push(open);
  }
  return runs;
}

/**
 * Runs read from consecutive windows, oldest window first, as one list: a run cut by a window's edge is
 * joined to its continuation in the next.
 */
export function joinRuns(windows: readonly (readonly RateRun[])[]): RateRun[] {
  const joined: RateRun[] = [];
  for (const runs of windows) {
    for (const run of runs) {
      const last = joined.at(-1);
      if (last && last.value === run.value && nextDay(last.through) === run.date) {
        joined[joined.length - 1] = { ...last, through: run.through };
      } else joined.push({ ...run });
    }
  }
  return joined;
}
