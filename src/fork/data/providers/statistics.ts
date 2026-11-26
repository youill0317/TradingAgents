// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "Public statistics", routes.ts key `statistics`: economic series, macroSeries.search and
 * macroSeries.observations, from a curated catalog (catalog/series.ts) and its publishers. Declared in every
 * setup: the Treasury's, the New York Fed's and the ECB's series need no key, nor do FRED's catalogued
 * series while FRED's keyless download answers.
 *
 * - search: the catalog's series the text names exactly, under the very name asked (macro_series takes a
 *   series only on an exact name), then those it finds by their words, headline series first; price series
 *   (catalog/instruments.ts) as daily bars, which macro_series points to price_history; with FRED_API_KEY,
 *   FRED's own search after them (its best CALLS.seriesCandidates). Without a key a text the catalog does not
 *   find answers not_configured, naming FRED_API_KEY.
 * - observations, oldest first, the latest `limit` periods starting on or before `end`, and `continue_end`
 *   for the page before:
 *   - the U.S. Treasury's par and real yield curves (one file a year, read back a year at a time as the page
 *     needs), breakevens as par less real and spreads as one maturity less another, each row with its terms;
 *   - the New York Fed's EFFR (each day with the FOMC's target range), OBFR, SOFR, TGCR and BGCR;
 *   - the ECB's key interest rates, one observation per change (the date it took effect, and until when),
 *     never a run of identical daily values;
 *   - FRED: with FRED_API_KEY every vintage (each value known from the day it took its current value, its
 *     first release said when it was revised), FRED's description of the series; without a key, FRED's
 *     keyless download (the latest vintage, no vintage dates) for the catalogued series, and a failure naming
 *     FRED_API_KEY when that does not answer or for a series outside the catalog.
 *
 *   Period kinds are those macro_series compares by date (month, quarter, half_year, year) or by the period
 *   before (calendar_day, week); units are percent for rates and yields, percentage points for spreads, an
 *   index, a count or an amount otherwise, as FRED words them.
 */
import { addDays, dayOf, earlierDate } from "../../../contracts/index.js";
import { CALLS } from "../../../contracts/limits.js";
import type {
  Call,
  DataProvider,
  SeriesMeta,
  SeriesObservation,
  SeriesObservations,
} from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import { PRICE_SERIES, PRICE_SERIES_FAMILIES, type PriceSeries } from "../catalog/instruments.js";
import {
  type CatalogSeries,
  catalogByCode,
  catalogSeries,
  exactName,
  type PeriodKind,
  type SeriesOrigin,
  searchCatalog,
  searchWords,
} from "../catalog/series.js";
import type { ForkDeps } from "../deps.js";
import {
  ECB_SOURCE,
  joinRuns,
  POLICY_START,
  type PolicyRate,
  policyRateRuns,
  type RateRun,
} from "../sources/ecb.js";
import {
  FRED_KEY_PAGE,
  FRED_SOURCE,
  type FredPoint,
  type FredSeries,
  fredGraph,
  fredKeyNeeded,
  fredSearch,
  fredSeries,
  fredVintages,
  periodKindOf,
  unitOf,
} from "../sources/fred.js";
import { latestRates, NYFED_RATES, NYFED_SOURCE, type NyFedRate, ratesBetween } from "../sources/nyfed.js";
import { type CurveDay, curveYear, TREASURY_SOURCE } from "../sources/treasury.js";

export const STATISTICS_SOURCE = "Public statistics";

export function statisticsProvider(deps: ForkDeps): DataProvider {
  return {
    name: STATISTICS_SOURCE,
    capabilities: {
      macroSeries: {
        search: (query, call) => search(deps, query, call),
        observations: (key, query, call) => observations(deps, key, query, call),
      },
    },
  };
}

// Descriptions -----------------------------------------------------------------------------------

/** A catalog series as an answer describes it, under `name` when a search named it so. */
export function metaOf(entry: CatalogSeries, name: string = entry.name): SeriesMeta {
  return {
    key: `series:${entry.key}`,
    name,
    shape: "values",
    frequency: entry.frequency,
    seasonal_adjustment: entry.seasonal_adjustment,
    unit: { ...entry.unit },
    as_published: { ...entry.as_published },
    field_states: null,
  };
}

/** A FRED series outside the catalog, as FRED describes it, under `name` when a search named it so. */
function fredMeta(series: FredSeries, name: string = series.title): SeriesMeta {
  return {
    key: `series:us.fred.${series.id.toLowerCase()}`,
    name,
    shape: "values",
    frequency: series.frequency.toLowerCase() || null,
    seasonal_adjustment: series.seasonalAdjustment.toLowerCase() || null,
    unit: unitOf(series.units),
    as_published: {
      unit: series.units || null,
      frequency: series.frequency || null,
      seasonal_adjustment: series.seasonalAdjustment || null,
    },
    field_states: null,
  };
}

/** A price series (an index, a volatility index) as a search describes it: daily bars, for price_history. */
function priceMeta(key: string, series: PriceSeries, name: string = series.name): SeriesMeta {
  return {
    key: `series:${key}`,
    name,
    shape: "bars",
    frequency: "daily",
    seasonal_adjustment: null,
    unit: { kind: "index", multiplier: 1, currency: series.currency, per: null },
    as_published: null,
    field_states: null,
  };
}

// Search -----------------------------------------------------------------------------------------

/** The names a price series is named by exactly: its name, the short name in its parentheses, its symbol. */
function priceNames(series: PriceSeries): string[] {
  const short = /\(([^)]+)\)\s*$/.exec(series.name)?.[1];
  return [series.name, ...(short ? [short] : []), series.yahoo.replace(/^\^/, "")];
}

/** The price series `query` finds: by key or one of its names exactly, or by every word. */
function priceMatches(query: string): { meta: SeriesMeta; exact: boolean }[] {
  const asKey = query
    .trim()
    .replace(/^series:/i, "")
    .toLowerCase();
  const wanted = exactName(query);
  const words = [...new Set(searchWords(query))];
  const found: { meta: SeriesMeta; exact: boolean }[] = [];
  for (const [key, series] of Object.entries(PRICE_SERIES)) {
    if (key === asKey || priceNames(series).some((name) => exactName(name) === wanted)) {
      found.unshift({ meta: priceMeta(key, series, query.trim()), exact: true });
      continue;
    }
    const known = new Set(
      [...priceNames(series), key.split(".").at(-1) ?? "", key.split(".")[1] ?? ""].flatMap(searchWords),
    );
    if (words.length && words.every((word) => known.has(word)))
      found.push({ meta: priceMeta(key, series), exact: false });
  }
  return found;
}

/**
 * The series `query` may mean, best first; the one it names exactly first, under the name as asked.
 * Without FRED_API_KEY a text the catalog does not find is not_configured, naming the key.
 */
async function search(deps: ForkDeps, query: string, call?: Call): Promise<SeriesMeta[]> {
  const asked = query.trim();
  const catalog = searchCatalog(asked);
  const prices = priceMatches(asked);
  const exact = [
    ...catalog.filter((match) => match.exact).map((match) => metaOf(match.entry, asked)),
    ...prices.filter((match) => match.exact).map((match) => match.meta),
  ];
  const others = [
    ...catalog.filter((match) => !match.exact).map((match) => metaOf(match.entry)),
    ...prices.filter((match) => !match.exact).map((match) => match.meta),
  ];
  if (exact.length) return [...exact, ...others];
  if (!deps.config.fredKey) {
    if (others.length) return others;
    throw fredKeyNeeded(
      `No series in this app's catalog matched "${asked}" (it holds the U.S. Treasury's yields, the New York Fed's reference rates, the ECB's key interest rates and FRED's headline series); a search of all of FRED's series`,
    );
  }
  let found: FredSeries[];
  try {
    found = await fredSearch(deps, asked, CALLS.seriesCandidates, call);
  } catch (error) {
    // The catalog's matches still answer when FRED's search does not.
    if (call?.signal?.aborted || !others.length) throw error;
    return others;
  }
  const listed = new Set(others.map((meta) => meta.key));
  const fred: SeriesMeta[] = [];
  let named: SeriesMeta | undefined;
  for (const series of found) {
    const entry = catalogByCode(series.id);
    const meta = entry ? metaOf(entry) : fredMeta(series);
    if (listed.has(meta.key)) continue;
    listed.add(meta.key);
    // A FRED code asked for exactly is named as asked, so macro_series takes it.
    if (series.id.toUpperCase() === asked.toUpperCase()) named = { ...meta, name: asked };
    else fred.push(meta);
  }
  return [...(named ? [named] : []), ...others, ...fred];
}

// Observations -----------------------------------------------------------------------------------

/** What an observation needs besides its period and value; every field present, null where none. */
function observation(
  period: SeriesObservation["period"],
  value: number | null,
  more: Partial<Pick<SeriesObservation, "status" | "known_from" | "evidence" | "field_states">> = {},
): SeriesObservation {
  return {
    period,
    value,
    status: more.status ?? null,
    known_from: more.known_from ?? null,
    evidence: more.evidence ?? null,
    field_states: more.field_states ?? null,
  };
}

/** A period of `kind` starting on (or, for a week ending then, ending on) `date`. */
export function periodOf(kind: PeriodKind, date: string, weekEnding = false): SeriesObservation["period"] {
  const year = date.slice(0, 4);
  const month = Number(date.slice(5, 7));
  switch (kind) {
    case "month":
      return { kind, start: date, label: date.slice(0, 7) };
    case "quarter":
      return { kind, start: date, label: `${year}-Q${Math.floor((month - 1) / 3) + 1}` };
    case "half_year":
      return { kind, start: date, label: `${year}-H${month <= 6 ? 1 : 2}` };
    case "year":
      return { kind, start: date, label: year };
    case "week":
      return weekEnding
        ? { kind, start: addDays(date, -6), label: `week ending ${date}` }
        : { kind, start: date, label: `week of ${date}` };
    default:
      return { kind: "calendar_day", start: date, label: date };
  }
}

/** An answer: the series, its observations, and the page before when there is one. */
function answer(
  series: SeriesMeta,
  observations: SeriesObservation[],
  continueEnd: string | null,
): SeriesObservations {
  return {
    series,
    coverage: { missing: [], continue_end: continueEnd, complete_reason: null },
    observations,
  };
}

/** A two-decimal difference, without a float's remainder. */
const difference = (a: number, b: number) => Math.round((a - b) * 100) / 100;

/**
 * The latest `limit` observations of series `key` whose periods start on or before `end` (today when it is
 * later or not given), oldest first.
 */
async function observations(
  deps: ForkDeps,
  key: string,
  query: { limit: number; end?: string },
  call?: Call,
): Promise<SeriesObservations> {
  const bare = key
    .trim()
    .replace(/^series:/i, "")
    .toLowerCase();
  const today = dayOf(deps.clock());
  const page: Page = {
    limit: Math.max(1, Math.floor(query.limit)),
    last: query.end && query.end < today ? query.end : today,
    today,
  };
  const entry = catalogSeries(bare);
  if (entry) return fromOrigin(deps, entry, entry.origin, page, call);
  const [, publisher, ...rest] = bare.split(".");
  const price = PRICE_SERIES[bare];
  if (price || PRICE_SERIES_FAMILIES.has(publisher ?? "")) {
    throw new DataError(
      "invalid",
      `series:${bare}${price ? ` (${price.name})` : ""} is a price series with daily bars: read it with price_history`,
      { source: STATISTICS_SOURCE, retry: "change_request" },
    );
  }
  const code = rest.length === 1 ? (rest[0] as string) : "";
  if (publisher === "fred" && /^[a-z0-9_]+$/.test(code))
    return fred(deps, code.toUpperCase(), undefined, page, call);
  if (publisher === "treasury" || publisher === "nyfed" || publisher === "ecb" || publisher === "fred") {
    throw new DataError(
      "invalid",
      `series:${bare} is not a series this source serves: search macro_series by name for its key`,
      { source: STATISTICS_SOURCE, retry: "change_request" },
    );
  }
  throw new DataError(
    "unsupported",
    `series:${bare}: this source serves the U.S. Treasury's, the New York Fed's, the ECB's and FRED's series (keys us.treasury.*, us.nyfed.*, ea.ecb.*, us.fred.*)`,
    { source: STATISTICS_SOURCE },
  );
}

/** The page asked for: how many periods, the last day a period may start, and today. */
type Page = { limit: number; last: string; today: string };

function fromOrigin(
  deps: ForkDeps,
  entry: CatalogSeries,
  origin: SeriesOrigin,
  page: Page,
  call?: Call,
): Promise<SeriesObservations> {
  switch (origin.publisher) {
    case "treasury":
      return treasury(deps, entry, origin, page, call);
    case "nyfed":
      return nyfed(deps, entry, origin.rate, page, call);
    case "ecb":
      return ecb(deps, entry, origin.rate, page, call);
    case "fred":
      return fred(deps, origin.id, entry, page, call);
  }
}

// The Treasury's curves ----------------------------------------------------------------------------

/** A Treasury series: its curves' files read back a year at a time until the page is full. */
async function treasury(
  deps: ForkDeps,
  entry: CatalogSeries,
  origin: Extract<SeriesOrigin, { publisher: "treasury" }>,
  { limit, last, today }: Page,
  call?: Call,
): Promise<SeriesObservations> {
  const currentYear = Number(today.slice(0, 4));
  const { leg, less } = origin;
  const curves = [...new Set([leg.curve, ...(less ? [less.curve] : [])])];
  const points: { date: string; value: number; evidence: string | null }[] = [];
  let year = Number(last.slice(0, 4));
  for (; year >= origin.since && points.length < limit; year--) {
    const files = new Map<string, Map<string, CurveDay>>();
    for (const [index, days] of (
      await Promise.all(curves.map((curve) => curveYear(deps, curve, year, today, call)))
    ).entries()) {
      const curve = curves[index] as string;
      // A past year's file without a row is not a year without data: the source answered wrongly.
      if (!days.length && year < currentYear) {
        throw new DataError(
          "unavailable",
          `The Treasury's ${curve} yield curve file for ${year} came back without rows.`,
          { source: TREASURY_SOURCE },
        );
      }
      files.set(curve, new Map(days.map((day) => [day.date, day])));
    }
    const yearPoints: typeof points = [];
    for (const [date, day] of files.get(leg.curve) ?? []) {
      const value = day.yields[leg.maturity];
      if (value === undefined || date > last) continue;
      if (!less) {
        yearPoints.push({ date, value, evidence: null });
        continue;
      }
      const subtracted = files.get(less.curve)?.get(date)?.yields[less.maturity];
      if (subtracted !== undefined)
        yearPoints.push({
          date,
          value: difference(value, subtracted),
          evidence: `${value} less ${subtracted}`,
        });
    }
    points.unshift(...yearPoints);
  }
  const shown = points.slice(-limit);
  const first = shown[0];
  if (!first) {
    throw new DataError("no_data", `The Treasury's files hold no ${entry.name} on or before ${last}.`, {
      source: TREASURY_SOURCE,
    });
  }
  // Earlier rows: some read and not shown, or a year before the first one read.
  const more = points.length > shown.length || year >= origin.since;
  return answer(
    metaOf(entry),
    shown.map((point) =>
      observation(periodOf("calendar_day", point.date), point.value, { evidence: point.evidence }),
    ),
    more ? addDays(first.date, -1) : null,
  );
}

// The New York Fed's rates --------------------------------------------------------------------------

/** "3.75-4.00": a rate as the New York Fed quotes it, to two decimals. */
const quoted = (value: number) => value.toFixed(2);

async function nyfed(
  deps: ForkDeps,
  entry: CatalogSeries,
  rate: NyFedRate,
  { limit, last, today }: Page,
  call?: Call,
): Promise<SeriesObservations> {
  const { type, since } = NYFED_RATES[rate];
  // The latest page by count; an earlier one by a window wide enough for its business days.
  const days =
    last >= today
      ? await latestRates(deps, rate, limit, call)
      : await ratesBetween(
          deps,
          rate,
          { from: addDays(last, -(Math.ceil((limit * 7) / 5) + 10)), to: last },
          call,
        );
  const shown = days.filter((day) => day.date <= last && day.value !== null).slice(-limit);
  const first = shown[0];
  if (!first) {
    throw new DataError(
      "no_data",
      `The New York Fed published no ${type} on or before ${last}${last < since ? ` (its ${type} starts ${since})` : ""}.`,
      { source: NYFED_SOURCE },
    );
  }
  return answer(
    metaOf(entry),
    shown.map((day) => {
      // EFFR's days carry the FOMC's target: a range from 2008-12-16, a single rate before.
      const target = day.target;
      let evidence: string | null = null;
      if (target && target.from !== null) {
        evidence =
          target.to !== null
            ? `FOMC target range ${quoted(target.from)}-${quoted(target.to)}`
            : `FOMC target ${quoted(target.from)}`;
      }
      return observation(periodOf("calendar_day", day.date), day.value, {
        status: day.revised ? "revised" : null,
        evidence,
      });
    }),
    first.date > since ? addDays(first.date, -1) : null,
  );
}

// The ECB's key interest rates ---------------------------------------------------------------------

/**
 * The windows a key interest rate is read in, newest first: the last three years to the latest day, the
 * eight before, and the rest back to 1999. A window reaching today is kept an hour, the older ones a week.
 */
function policyWindows(today: string): { from: string; to?: string }[] {
  const year = Number(today.slice(0, 4));
  const later = (date: string) => (date > POLICY_START ? date : POLICY_START);
  const windows: { from: string; to?: string }[] = [{ from: later(`${year - 2}-01-01`) }];
  const middle = { from: later(`${year - 10}-01-01`), to: `${year - 3}-12-31` };
  if (middle.to >= middle.from) windows.push(middle);
  const oldest = { from: POLICY_START, to: `${year - 11}-12-31` };
  if (oldest.to >= oldest.from) windows.push(oldest);
  return windows;
}

/**
 * An ECB key interest rate as its changes: each run of one rate is an observation from the day it took
 * effect, said until when (or, for the rate in effect now, the latest day published). The first run read
 * started before the windows read, so it is no change of theirs, until the oldest window (from the euro's first
 * day) is read and holds rows: then it is the series' first level. The windows before are read when the page
 * needs more.
 */
async function ecb(
  deps: ForkDeps,
  entry: CatalogSeries,
  rate: PolicyRate,
  { limit, last, today }: Page,
  call?: Call,
): Promise<SeriesObservations> {
  const windows = policyWindows(today);
  const read: RateRun[][] = [];
  let runs: RateRun[] = [];
  let fromStart = false;
  for (const window of windows) {
    read.unshift(await policyRateRuns(deps, rate, window, call));
    runs = joinRuns(read);
    // The oldest window read, and with rows: its first run is the series' first level.
    fromStart = window.from === POLICY_START && Boolean(read[0]?.length);
    const changes = runs.filter((run, index) => (index > 0 || fromStart) && run.date <= last);
    if (changes.length >= limit) break;
  }
  const latest = runs.at(-1);
  const changes = runs.filter((run, index) => (index > 0 || fromStart) && run.date <= last);
  const shown = changes.slice(-limit);
  const first = shown[0];
  if (!first) {
    throw new DataError(
      "no_data",
      `The ECB's ${entry.name} has no change on or before ${last} in its series.`,
      {
        source: ECB_SOURCE,
      },
    );
  }
  const more = changes.length > shown.length || !fromStart;
  return answer(
    metaOf(entry),
    shown.map((run) =>
      observation(periodOf("calendar_day", run.date), run.value, {
        evidence:
          run === latest
            ? `in effect on ${run.through}, the latest day published`
            : `in effect to ${run.through}`,
      }),
    ),
    more ? addDays(first.date, -1) : null,
  );
}

// FRED ---------------------------------------------------------------------------------------------

/** Periods read beyond the page's, for values not out yet or missing. */
const SLACK: Record<PeriodKind, number> = {
  calendar_day: 10,
  week: 6,
  month: 6,
  quarter: 3,
  half_year: 2,
  year: 2,
};

/** The first day of the month `months` after (before, when negative) the month of `date`. */
function monthStart(date: string, months: number): string {
  const day = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + months, 1));
  return dayOf(day);
}

/** The dates to read for `count` periods of `kind` starting on or before `last`, with slack. */
export function observationWindow(
  kind: PeriodKind,
  count: number,
  last: string,
  today: string,
  weekEnding = false,
): { start: string; end: string } {
  const periods = count + SLACK[kind];
  const month = Number(last.slice(5, 7)) - 1;
  let start: string;
  switch (kind) {
    case "month":
      start = monthStart(last, -(periods - 1));
      break;
    case "quarter":
      start = monthStart(last, -(month % 3) - 3 * (periods - 1));
      break;
    case "half_year":
      start = monthStart(last, -(month % 6) - 6 * (periods - 1));
      break;
    case "year":
      start = `${Number(last.slice(0, 4)) - (periods - 1)}-01-01`;
      break;
    case "week":
      start = addDays(last, -7 * periods);
      break;
    default:
      start = addDays(last, -(Math.ceil((periods * 7) / 5) + 7));
  }
  // A week's date is its last day: one starting on or before `last` may end up to six days after it.
  const end = weekEnding ? (earlierDate(addDays(last, 6), today) as string) : last;
  return { start, end };
}

/** A FRED value as an observation: with every vintage when keyed, the latest vintage otherwise. */
function fredObservation(point: FredPoint, kind: PeriodKind, weekEnding: boolean, keyed: boolean) {
  const period = periodOf(kind, point.date, weekEnding);
  if (point.value === null) {
    return observation(period, null, {
      field_states: { value: { reason: "FRED has no value for this period", retry: null } },
    });
  }
  if (!keyed) return observation(period, point.value, { evidence: "latest vintage" });
  const first = point.first;
  const revised = first !== null && first.value !== point.value;
  return observation(period, point.value, {
    known_from: point.knownFrom,
    status: revised ? "revised" : null,
    evidence:
      revised && first ? `first released ${first.date} as ${first.value ?? "no value"}` : "first release",
  });
}

/** The failure of FRED's keyless download, said with what FRED_API_KEY would change. */
function keylessFailed(error: DataError): DataError {
  return new DataError(
    error.kind === "rate_limited" ? "rate_limited" : "unavailable",
    `FRED's keyless download failed: ${error.message.replace(/[.\s]+$/, "")}. With FRED_API_KEY set (a free key from ${FRED_KEY_PAGE}), FRED's API serves this series, with the day each value became known.`,
    { ...error.details, source: FRED_SOURCE },
  );
}

/** A FRED series: the catalog's (`entry`), or any FRED code with the key. */
async function fred(
  deps: ForkDeps,
  id: string,
  entry: CatalogSeries | undefined,
  { limit, last, today }: Page,
  call?: Call,
): Promise<SeriesObservations> {
  const keyed = Boolean(deps.config.fredKey);
  if (!entry && !keyed) throw fredKeyNeeded(`FRED series ${id}, outside this app's catalog,`);
  // A catalogued series is read at once; another's frequency comes from FRED's description first.
  const described = entry ? undefined : await fredSeries(deps, id, call);
  const kind = entry ? entry.period : periodKindOf(described?.frequencyShort ?? "");
  const weekEnding = entry
    ? entry.origin.publisher === "fred" && entry.origin.weekEnding === true
    : /ending/i.test(described?.frequency ?? "");
  const window = observationWindow(kind, limit, last, today, weekEnding);
  let points: FredPoint[];
  let latest: FredSeries | undefined = described;
  if (keyed) {
    const [description, vintages] = await Promise.all([
      // FRED's own words for the catalogued series' unit; the catalog's when FRED does not answer them.
      entry ? fredSeries(deps, id, call).catch(() => undefined) : Promise.resolve(described),
      fredVintages(deps, id, window, call),
    ]);
    latest = description;
    points = vintages;
  } else {
    try {
      points = (await fredGraph(deps, id, window, call)).map((value) => ({
        ...value,
        knownFrom: null,
        first: null,
      }));
    } catch (error) {
      if (call?.signal?.aborted || !(error instanceof DataError) || error.kind === "invalid") throw error;
      throw keylessFailed(error);
    }
  }
  const periods = points
    .map((point) => fredObservation(point, kind, weekEnding, keyed))
    .filter((one) => one.period.start <= last)
    // A day or a week without a value is no period of the series (a holiday), not a missing one.
    .filter((one) => one.value !== null || (kind !== "calendar_day" && kind !== "week"));
  const shown = periods.slice(-limit);
  const first = shown[0];
  const name = entry?.name ?? latest?.title ?? id;
  if (!first) {
    throw new DataError("no_data", `FRED has no ${name} value for a period starting on or before ${last}.`, {
      source: FRED_SOURCE,
    });
  }
  const meta = entry
    ? {
        ...metaOf(entry),
        ...(latest
          ? {
              as_published: {
                unit: latest.units || entry.as_published.unit,
                frequency: latest.frequency || entry.as_published.frequency,
                seasonal_adjustment: latest.seasonalAdjustment || entry.as_published.seasonal_adjustment,
              },
            }
          : {}),
      }
    : fredMeta(latest as FredSeries);
  const started = latest?.observationStart;
  const more = shown.length === limit && (!started || first.period.start > started);
  return answer(meta, shown, more ? addDays(first.period.start, -1) : null);
}
