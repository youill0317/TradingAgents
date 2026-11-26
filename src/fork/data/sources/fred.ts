// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * FRED, the St. Louis Fed's economic data, two ways:
 *
 * - With FRED_API_KEY, its API (api.stlouisfed.org, about 120 requests a minute, paced by the HTTP client):
 *   a series' description (`/fred/series`), a search across every series (`/fred/series/search`), and its
 *   observations with every vintage (ALFRED's real-time periods, `realtime_start=1776-07-04` to
 *   `realtime_end=9999-12-31`): each date's current value is the row whose real-time period runs to
 *   9999-12-31, known from the start of the first vintage that held that value (a later vintage repeating
 *   it changes nothing); its first release is the row that starts first.
 * - Without a key, its website's download (`fredgraph.csv?id=...&cosd=...&coed=...`): a series' latest
 *   values only, with no vintage dates; the first column is the date (`observation_date`, formerly `DATE`),
 *   the others one per code, a missing value "." or empty. It is an undocumented endpoint that has stopped
 *   answering some networks for long stretches, so nothing depends on it alone.
 *
 * FRED answers a request it refuses with HTTP 400 and `{"error_code": 400, "error_message": "..."}`: a
 * key it does not know is rejected (FRED_API_KEY is named), a code it does not know invalid. The key travels
 * in the query; the HTTP client keeps it out of every message, and nothing here keeps a URL.
 */
import { NOTICE } from "../../../contracts/index.js";
import type { Call } from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import type { PeriodKind, SeriesUnit } from "../catalog/series.js";
import type { ForkDeps } from "../deps.js";
import { unreadable } from "../http.js";
import { csvTable, numberOf } from "../util/csv.js";

export const FRED_SOURCE = "FRED";
export const FRED_API = "https://api.stlouisfed.org/fred";
export const FRED_GRAPH = "https://fred.stlouisfed.org/graph/fredgraph.csv";
/** Where a FRED API key is had, free. */
export const FRED_KEY_PAGE = "https://fred.stlouisfed.org/docs/api/api_key.html";

/** ALFRED's bounds for every vintage. */
const ALL_VINTAGES = { realtime_start: "1776-07-04", realtime_end: "9999-12-31" } as const;

/** FRED's description of a series, as FRED words it. */
export type FredSeries = {
  id: string;
  title: string;
  /** "Monthly", "Weekly, Ending Saturday", "Daily, Close". */
  frequency: string;
  /** "D", "W", "BW", "M", "Q", "SA", "A". */
  frequencyShort: string;
  units: string;
  seasonalAdjustment: string;
  observationStart: string | null;
  observationEnd: string | null;
};

/** One date of a series: its current value and when that became known, and its first release. */
export type FredPoint = {
  date: string;
  value: number | null;
  knownFrom: string | null;
  first: { date: string; value: number | null } | null;
};

/** A date and its latest value, as the keyless download gives them. */
export type FredValue = { date: string; value: number | null };

/** The failure for a request that needs FRED_API_KEY when it is not set; its message is shown as it is. */
export function fredKeyNeeded(what: string): DataError {
  return new DataError(
    "not_configured",
    `${what} needs FRED_API_KEY (a free key from ${FRED_KEY_PAGE}), set in the environment or under "data" in credentials.json.`,
    { source: FRED_SOURCE, code: NOTICE.capabilityUnavailable, retry: "never" },
  );
}

/** FRED's refusal of a request, by what its 400 says. */
function refusal(deps: ForkDeps, answer: unknown, id?: string): DataError {
  const said = (answer as { error_message?: unknown } | null)?.error_message;
  const text = deps.http
    .redact(typeof said === "string" ? said.replace(/\s+/g, " ").trim() : "")
    .slice(0, 200)
    .replace(/[.\s]+$/, "");
  if (/api_key/i.test(text)) {
    return new DataError(
      "rejected",
      `FRED refused FRED_API_KEY (${text}). A free key comes from ${FRED_KEY_PAGE}.`,
      { source: FRED_SOURCE, status: 400, code: NOTICE.capabilityUnavailable },
    );
  }
  if (/does not exist/i.test(text)) {
    return new DataError("invalid", `FRED has no series ${id ?? ""}`.trim(), {
      source: FRED_SOURCE,
      status: 400,
      code: "no_such_series",
      retry: "change_request",
    });
  }
  return new DataError("unavailable", `FRED did not take the request (${text || "HTTP 400"}).`, {
    source: FRED_SOURCE,
    status: 400,
  });
}

/** A FRED API answer for `path` with `params`, the key added; its 400s read as refusals. */
async function api(
  deps: ForkDeps,
  path: string,
  params: Record<string, string>,
  call?: Call,
  id?: string,
): Promise<Record<string, unknown>> {
  const key = deps.config.fredKey;
  if (!key) throw fredKeyNeeded("FRED's API");
  const query = new URLSearchParams({ ...params, api_key: key, file_type: "json" });
  const answer = await deps.http.get(`${FRED_API}/${path}?${query}`, {
    source: FRED_SOURCE,
    signal: call?.signal,
    headers: { Accept: "application/json" },
    accept: [400],
  });
  const body = await answer.json();
  if (answer.status === 400) throw refusal(deps, body, id);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw unreadable(FRED_SOURCE, "its API");
  return body as Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** A series as FRED's `seriess` lists it; undefined for an item without a code. */
function seriesOf(item: unknown): FredSeries | undefined {
  const row = item as Record<string, unknown> | null;
  const id = text(row?.id);
  if (!row || !id) return undefined;
  return {
    id,
    title: text(row.title) || id,
    frequency: text(row.frequency),
    frequencyShort: text(row.frequency_short),
    units: text(row.units),
    seasonalAdjustment: text(row.seasonal_adjustment),
    observationStart: text(row.observation_start) || null,
    observationEnd: text(row.observation_end) || null,
  };
}

/** FRED's description of series `id` (needs the key); kept a day. A code FRED does not know is invalid. */
export async function fredSeries(deps: ForkDeps, id: string, call?: Call): Promise<FredSeries> {
  const signal = call?.signal;
  return deps.cache.remember(
    `fred:series:${id}`,
    86_400_000,
    async () => {
      const answer = await api(deps, "series", { series_id: id }, call, id);
      const found = Array.isArray(answer.seriess) ? seriesOf(answer.seriess[0]) : undefined;
      if (!found) throw unreadable(FRED_SOURCE, `series ${id}`);
      return found;
    },
    { disk: "json", signal },
  );
}

/** FRED's search for `query`, its best `limit` matches first (needs the key); kept a day. */
export async function fredSearch(
  deps: ForkDeps,
  query: string,
  limit: number,
  call?: Call,
): Promise<FredSeries[]> {
  const signal = call?.signal;
  return deps.cache.remember(
    `fred:search:${limit}:${query.toLowerCase()}`,
    86_400_000,
    async () => {
      const answer = await api(
        deps,
        "series/search",
        { search_text: query, limit: String(limit), order_by: "search_rank", sort_order: "desc" },
        call,
      );
      if (!Array.isArray(answer.seriess)) throw unreadable(FRED_SOURCE, "a search");
      return answer.seriess.flatMap((item) => seriesOf(item) ?? []);
    },
    { signal },
  );
}

/**
 * Series `id`'s dates from `start` to `end` with every vintage (needs the key), oldest first: each date's
 * current value, the day it became known, and its first release. Kept an hour.
 */
export async function fredVintages(
  deps: ForkDeps,
  id: string,
  window: { start: string; end: string },
  call?: Call,
): Promise<FredPoint[]> {
  const signal = call?.signal;
  return deps.cache.remember(
    `fred:vintages:${id}:${window.start}:${window.end}`,
    3_600_000,
    async () =>
      parseVintages(
        await api(
          deps,
          "series/observations",
          { series_id: id, ...ALL_VINTAGES, observation_start: window.start, observation_end: window.end },
          call,
          id,
        ),
      ),
    { disk: "json", signal },
  );
}

/** An observations answer with every vintage, as each date's current value and first release. */
export function parseVintages(answer: Record<string, unknown>): FredPoint[] {
  if (!Array.isArray(answer.observations)) throw unreadable(FRED_SOURCE, "observations");
  const byDate = new Map<string, { start: string; end: string; value: number | null }[]>();
  for (const item of answer.observations) {
    const row = item as Record<string, unknown> | null;
    const date = text(row?.date);
    const start = text(row?.realtime_start);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(start)) continue;
    const vintages = byDate.get(date) ?? [];
    vintages.push({ start, end: text(row?.realtime_end), value: numberOf(text(row?.value)) });
    byDate.set(date, vintages);
  }
  const points: FredPoint[] = [];
  for (const [date, vintages] of byDate) {
    vintages.sort((a, b) => a.start.localeCompare(b.start));
    // The value of today's vintage, which runs to the end of time; a date no longer in it is left out.
    const index = vintages.findLastIndex((vintage) => vintage.end === ALL_VINTAGES.realtime_end);
    const current = vintages[index];
    if (!current) continue;
    // Known since the first of the vintages before it that already held this value.
    let since = index;
    while (since > 0 && vintages[since - 1]?.value === current.value) since--;
    const first = vintages[0] as (typeof vintages)[number];
    points.push({
      date,
      value: current.value,
      knownFrom: (vintages[since] as (typeof vintages)[number]).start,
      first: { date: first.start, value: first.value },
    });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

/** The address of the keyless download of `id` from `start` to `end`. */
export function graphUrl(id: string, window: { start: string; end: string }): string {
  return `${FRED_GRAPH}?id=${encodeURIComponent(id)}&cosd=${window.start}&coed=${window.end}`;
}

/** Series `id`'s latest values from `start` to `end`, from the keyless download, oldest first; kept an hour. */
export async function fredGraph(
  deps: ForkDeps,
  id: string,
  window: { start: string; end: string },
  call?: Call,
): Promise<FredValue[]> {
  const signal = call?.signal;
  return deps.cache.remember(
    `fred:graph:${id}:${window.start}:${window.end}`,
    3_600_000,
    async () =>
      parseGraph(
        await deps.http.text(graphUrl(id, window), {
          source: FRED_SOURCE,
          signal,
          headers: { Accept: "text/csv" },
          notFoundMessage: `FRED's download has no series ${id}`,
        }),
        id,
      ).filter((point) => point.date >= window.start && point.date <= window.end),
    { disk: "json", signal },
  );
}

/** The keyless download's dates and values of `id`, oldest first; an empty body has none. */
export function parseGraph(body: string, id: string): FredValue[] {
  if (!body.trim()) return [];
  const { header, rows } = csvTable(body);
  const dates = header[0];
  if (!dates || !/^(observation_date|date)$/i.test(dates)) throw unreadable(FRED_SOURCE, "its download");
  const column = header.find((name) => name.toUpperCase() === id.toUpperCase()) ?? header[1];
  if (!column) throw unreadable(FRED_SOURCE, "its download");
  return rows
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row[dates] ?? ""))
    .map((row) => ({ date: row[dates] ?? "", value: numberOf(row[column]) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** The period of a FRED observation, by FRED's short frequency ("M", "Q", "W", ...). */
export function periodKindOf(frequencyShort: string): PeriodKind {
  const short = frequencyShort.toUpperCase();
  if (short.startsWith("M")) return "month";
  if (short.startsWith("Q")) return "quarter";
  if (short === "SA") return "half_year";
  if (short.startsWith("A")) return "year";
  if (short.startsWith("W") || short.startsWith("BW")) return "week";
  return "calendar_day";
}

/** The unit of a FRED series, read from its units as FRED words them ("Billions of Dollars", "Percent"). */
export function unitOf(units: string): SeriesUnit {
  const words = units.toLowerCase();
  const multiplier = /\btrillions?\b/.test(words)
    ? 1e12
    : /\bbillions?\b/.test(words)
      ? 1e9
      : /\bmillions?\b/.test(words)
        ? 1e6
        : /\bthousands?\b/.test(words)
          ? 1e3
          : 1;
  const per = /\bper (hour|week|month|year|share)\b/.exec(words)?.[1] ?? null;
  if (/^basis points?\b/.test(words))
    return { kind: "percentage_points", multiplier: 0.01, currency: null, per };
  if (/^percentage points?\b/.test(words))
    return { kind: "percentage_points", multiplier: 1, currency: null, per };
  if (/^percent\b/.test(words)) return { kind: "percent", multiplier: 1, currency: null, per };
  if (/^index\b/.test(words)) return { kind: "index", multiplier: 1, currency: null, per };
  if (/\bto one\b|\bper u\.s\. dollar\b|\bper euro\b|\bratio\b/.test(words))
    return { kind: "ratio", multiplier: 1, currency: null, per: null };
  if (/\bdollars?\b/.test(words)) return { kind: "currency", multiplier, currency: "USD", per };
  if (/\b(persons|people|units|number|claims|jobs|employees|level)\b/.test(words))
    return { kind: "count", multiplier, currency: null, per };
  return { kind: "quantity", multiplier, currency: null, per };
}
