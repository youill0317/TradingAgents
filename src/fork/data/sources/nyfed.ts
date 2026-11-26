// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The New York Fed's reference rates (no key): the effective federal funds rate (EFFR) with the FOMC's
 * target range, the overnight bank funding rate (OBFR), and the secured rates SOFR, TGCR and BGCR, each a
 * business day's volume-weighted median in percent (EFFR's a volume-weighted mean of brokered trades before
 * March 2016), published the next business morning.
 *
 * `/api/rates/<market>/<rate>/last/<n>.json` answers the latest n; `search.json?startDate&endDate` a window.
 * Both answer `{"refRates": [...]}` newest first, read here oldest first. Older rows lack fields newer ones
 * have (EFFR's rows of 2000 and 2008 carry no percentiles or volume; its target is a single rate,
 * `targetRateFrom`, before 2008-12-16). `revisionIndicator` is "r" for a revised rate. A window without a
 * business day answers no rows; a malformed request, HTTP 400 with an empty body.
 */
import type { Call } from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import type { ForkDeps } from "../deps.js";
import { unreadable } from "../http.js";

export const NYFED_SOURCE = "New York Fed";

const NYFED_API = "https://markets.newyorkfed.org/api/rates";

/** The rates, each with its market (the address's segment), its type in answers and its first day. */
export const NYFED_RATES = {
  effr: { market: "unsecured", type: "EFFR", since: "2000-07-03" },
  obfr: { market: "unsecured", type: "OBFR", since: "2016-03-01" },
  sofr: { market: "secured", type: "SOFR", since: "2018-04-02" },
  tgcr: { market: "secured", type: "TGCR", since: "2018-04-02" },
  bgcr: { market: "secured", type: "BGCR", since: "2018-04-02" },
} as const;
export type NyFedRate = keyof typeof NYFED_RATES;

/** One business day's rate; EFFR's days carry the FOMC's target (a range from 2008-12-16). */
export type RateDay = {
  date: string;
  value: number | null;
  revised: boolean;
  target?: { from: number | null; to: number | null };
};

export function latestUrl(rate: NyFedRate, count: number): string {
  const { market } = NYFED_RATES[rate];
  return `${NYFED_API}/${market}/${rate}/last/${count}.json`;
}

export function windowUrl(rate: NyFedRate, window: { from: string; to: string }): string {
  const { market } = NYFED_RATES[rate];
  return `${NYFED_API}/${market}/${rate}/search.json?startDate=${window.from}&endDate=${window.to}`;
}

/** The latest `count` days of `rate`, oldest first; kept an hour. */
export async function latestRates(
  deps: ForkDeps,
  rate: NyFedRate,
  count: number,
  call?: Call,
): Promise<RateDay[]> {
  return read(deps, rate, `nyfed:${rate}:last:${count}`, latestUrl(rate, count), 3_600_000, call);
}

/** The days of `rate` from `from` to `to`, both inclusive, oldest first; kept a day. */
export async function ratesBetween(
  deps: ForkDeps,
  rate: NyFedRate,
  window: { from: string; to: string },
  call?: Call,
): Promise<RateDay[]> {
  const days = await read(
    deps,
    rate,
    `nyfed:${rate}:${window.from}:${window.to}`,
    windowUrl(rate, window),
    86_400_000,
    call,
  );
  return days.filter((day) => day.date >= window.from && day.date <= window.to);
}

async function read(
  deps: ForkDeps,
  rate: NyFedRate,
  key: string,
  url: string,
  ttlMs: number,
  call?: Call,
): Promise<RateDay[]> {
  const signal = call?.signal;
  return deps.cache.remember(
    key,
    ttlMs,
    async () => {
      let answer: unknown;
      try {
        answer = await deps.http.json(url, {
          source: NYFED_SOURCE,
          signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        // A rate missing from its address is the source's failure, not a day without a rate.
        if (error instanceof DataError && error.kind === "no_data") {
          throw new DataError(
            "unavailable",
            `The New York Fed's ${NYFED_RATES[rate].type} is not at its address (HTTP ${error.details.status ?? 404}).`,
            { ...error.details, source: NYFED_SOURCE },
          );
        }
        throw error;
      }
      return parseRates(answer, rate);
    },
    { signal },
  );
}

/** An answer's days of `rate`, oldest first. */
export function parseRates(answer: unknown, rate: NyFedRate): RateDay[] {
  const list = (answer as { refRates?: unknown } | null)?.refRates;
  if (!Array.isArray(list)) throw unreadable(NYFED_SOURCE, "its rates");
  const { type } = NYFED_RATES[rate];
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const days: RateDay[] = [];
  for (const item of list) {
    const row = item as Record<string, unknown> | null;
    if (!row || typeof row !== "object") continue;
    const date = typeof row.effectiveDate === "string" ? row.effectiveDate : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (row.type !== undefined && row.type !== type)) continue;
    const from = number(row.targetRateFrom);
    const to = number(row.targetRateTo);
    days.push({
      date,
      value: number(row.percentRate),
      revised: typeof row.revisionIndicator === "string" && row.revisionIndicator.toLowerCase() === "r",
      ...(from !== null || to !== null ? { target: { from, to } } : {}),
    });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}
