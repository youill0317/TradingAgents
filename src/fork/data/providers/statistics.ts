// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "Public statistics", routes.ts key `statistics`: economic series, macroSeries.search and
 * macroSeries.observations, from a curated catalog (catalog/series.ts) and its publishers. Declared in every
 * setup: the Treasury's, the New York Fed's and the ECB's series need no key, nor do FRED's catalogued
 * series while FRED's keyless download answers. Korea's need theirs: the Bank of Korea's ECOS
 * (ECOS_API_KEY) and Statistics Korea's KOSIS (KOSIS_API_KEY).
 *
 * - search: the catalog's series the text names exactly, under the very name asked (macro_series takes a
 *   series only on an exact name), then those it finds by their words, headline series first; price series
 *   (catalog/instruments.ts) as daily bars, which macro_series points to price_history; with FRED_API_KEY,
 *   FRED's own search after them (its best CALLS.seriesCandidates). Without a key a text the catalog does not
 *   find answers not_configured, naming FRED_API_KEY. Korea's catalogued series are offered only with their
 *   key: without it a text naming one answers not_configured, naming the variable. With ECOS_API_KEY or
 *   KOSIS_API_KEY, a text in Hangul or naming Korea is also searched in ECOS's table list (its tables whose
 *   names hold every word, Korean words read in Korean names and others in English ones) and with KOSIS's
 *   search, each answering its best CALLS.seriesCandidates series (a table's items, its other item groups or
 *   classifications at their first code), after the catalog's and before FRED's. A Korean key typed in
 *   another case is taken as named.
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
 *     FRED_API_KEY when that does not answer or for a series outside the catalog;
 *   - ECOS (`kr.ecos.<stat_code>.<item_code>...`): every row ECOS has for the periods the page needs (read to
 *     its total), in the series' cycle (the catalog's, else the shortest ECOS publishes its items in, from the
 *     table's item list): D, SM, M, Q, S and A as calendar_day, half_month, month, quarter, half_year and year;
 *   - KOSIS (`kr.kosis.<tbl_id>.<itm_id>.<obj_code>...`): the periods the page needs, split as KOSIS's cells
 *     per request require, in the series' period (the catalog's, else the first of M, Q, H, Y and D the table
 *     answers in, kept for the next read); a table outside the catalog is read once a KOSIS search has named
 *     its organization.
 *
 *   ECOS and KOSIS keep no vintages: a value is the one published now (known_from null, as the coverage
 *   says). A period the source answers without a value is listed with its reason, and one missing between two
 *   periods it answers is listed as missing; a day without a row is no period (a holiday). Period kinds are
 *   those macro_series compares by date (month, quarter, half_year, year) or by the period before
 *   (calendar_day, week, half_month); units are percent for rates and yields, percentage points for spreads,
 *   an index, a count or an amount otherwise, as FRED, ECOS and KOSIS word them (ECOS's 연% percent, 십억원
 *   billions of won, 2020=100 an index).
 */
import { addDays, dayOf, earlierDate, NOTICE } from "../../../contracts/index.js";
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
  type EcosCycle,
  exactName,
  type KosisPeriod,
  koreanKey,
  koreanSeriesKey,
  koreanUnitOf,
  normalizeName,
  type PeriodKind,
  SERIES,
  type SeriesOrigin,
  searchCatalog,
  searchWords,
  seriesKeysOf,
  servedWith,
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
  ECOS_CYCLES,
  ECOS_KEY_PAGE,
  ECOS_SOURCE,
  type EcosItem,
  type EcosTable,
  ecosItems,
  ecosKeyNeeded,
  ecosPeriod,
  ecosSeries,
  ecosTables,
} from "../sources/ecos.js";
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
import {
  KOSIS_KEY_PAGE,
  KOSIS_PERIODS,
  KOSIS_SOURCE,
  type KosisSeries,
  kosisKeepPeriod,
  kosisKeyNeeded,
  kosisKnownPeriod,
  kosisMeta,
  kosisOrg,
  kosisPeriod,
  kosisSearch,
  kosisSeries,
} from "../sources/kosis.js";
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
 * Without FRED_API_KEY a text the catalog does not find is not_configured, naming the key; a Korean series
 * named exactly, or found by words about Korea, without its source's key is not_configured, naming that key.
 */
async function search(deps: ForkDeps, query: string, call?: Call): Promise<SeriesMeta[]> {
  const asked = query.trim();
  const keys = seriesKeysOf(deps.config);
  const everything = searchCatalog(asked, "all");
  const catalog = everything.filter((match) => servedWith(match.entry, keys));
  const unserved = everything.filter((match) => !servedWith(match.entry, keys));
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
  // A Korean series of the catalog named without its source's key.
  const keyless = unserved.find((match) => match.exact);
  if (keyless) throw keyNeeded(keyless.entry, `${keyless.entry.name} (series:${keyless.entry.key})`);
  // A Korean key written in another case, or with a code macro_series' key pattern does not take.
  const typed = koreanKey(asked);
  if (typed) return [typedKey(deps, asked, typed)];
  const korea = aboutKorea(asked);
  const searches: (() => Promise<SeriesMeta[]>)[] = [
    ...(korea && keys.ecos ? [() => ecosSearch(deps, asked, call)] : []),
    ...(korea && keys.kosis ? [() => kosisCandidates(deps, asked, call)] : []),
  ];
  if (!searches.length && !deps.config.fredKey) {
    if (others.length) return others;
    // A Korean series the words find is named with its key only when the words ask about Korea; others are
    // FRED's to search.
    const words = korea ? unserved[0] : undefined;
    if (words)
      throw keyNeeded(
        words.entry,
        `${words.entry.name} (series:${words.entry.key}), which "${asked}" finds,`,
      );
    if (korea) throw koreaKeysNeeded(asked);
    throw fredKeyNeeded(
      `No series in this app's catalog matched "${asked}" (it holds the U.S. Treasury's yields, the New York Fed's reference rates, the ECB's key interest rates and FRED's headline series); a search of all of FRED's series`,
    );
  }
  const fredRun = deps.config.fredKey ? fredCandidates(deps, asked, call) : undefined;
  const [fredRead, ...koreanRead] = await Promise.allSettled([
    fredRun ?? Promise.resolve({ named: undefined, found: [] }),
    ...searches.map((run) => run()),
  ]);
  if (call?.signal?.aborted) throw call.signal.reason;
  const settled = [...(fredRun && fredRead ? [fredRead] : []), ...koreanRead];
  const failed = settled.flatMap((one) => (one.status === "rejected" ? [one.reason as unknown] : []));
  // The catalog's matches still answer when the searches do not.
  if (failed.length === settled.length && !others.length) throw failed[0];
  const listed = new Set(others.map((meta) => meta.key));
  const fresh = (found: readonly SeriesMeta[]) =>
    found.filter((meta) => {
      if (listed.has(meta.key)) return false;
      listed.add(meta.key);
      return true;
    });
  const named =
    fredRead?.status === "fulfilled" && fredRead.value.named && !listed.has(fredRead.value.named.key)
      ? fredRead.value.named
      : undefined;
  if (named) listed.add(named.key);
  const korean = koreanRead.flatMap((one) => (one.status === "fulfilled" ? fresh(one.value) : []));
  const fred = fredRead?.status === "fulfilled" ? fresh(fredRead.value.found) : [];
  const found = [...(named ? [named] : []), ...others, ...korean, ...fred];
  // Korea's statistics were not searched: without their keys, say what would search them.
  if (!found.length && korea && !keys.ecos && !keys.kosis) throw koreaKeysNeeded(asked);
  return found;
}

/** The failure for a search about Korea that nothing matched in a setup without ECOS's or KOSIS's key. */
function koreaKeysNeeded(asked: string): DataError {
  return new DataError(
    "not_configured",
    `No series in this app's catalog matched "${asked}"; a search of Korea's statistics needs ECOS_API_KEY (the Bank of Korea's ECOS, a free key from ${ECOS_KEY_PAGE}) or KOSIS_API_KEY (Statistics Korea's KOSIS, a free key from ${KOSIS_KEY_PAGE}), set in the environment or under "data" in credentials.json.`,
    { source: STATISTICS_SOURCE, code: NOTICE.capabilityUnavailable, retry: "never" },
  );
}

/** FRED's search for `asked`: the series a FRED code asked for exactly names (under the name asked), and the others. */
async function fredCandidates(
  deps: ForkDeps,
  asked: string,
  call?: Call,
): Promise<{ named: SeriesMeta | undefined; found: SeriesMeta[] }> {
  const found: FredSeries[] = await fredSearch(deps, asked, CALLS.seriesCandidates, call);
  const fred: SeriesMeta[] = [];
  let named: SeriesMeta | undefined;
  for (const series of found) {
    const entry = catalogByCode(series.id);
    const meta = entry ? metaOf(entry) : fredMeta(series);
    // A FRED code asked for exactly is named as asked, so macro_series takes it.
    if (series.id.toUpperCase() === asked.toUpperCase()) named = { ...meta, name: asked };
    else fred.push(meta);
  }
  return { named, found: fred };
}

// Korea's sources ----------------------------------------------------------------------------------------

/** The failure for a Korean series (`what`) in a setup without its source's key. */
function keyNeeded(entry: CatalogSeries, what: string): DataError {
  return entry.origin.publisher === "kosis" ? kosisKeyNeeded(what) : ecosKeyNeeded(what);
}

/** Words saying a text is about Korea (Hangul says so too). */
const KOREA_WORD = /\b(?:bank\s+of\s+korea|south\s+korea|korea|korean|bok|ecos|kosis|krw)\b/i;
/** Korean words saying it, written as words of their own. */
const KOREA_HANGUL = /(?:^|\s)(?:대한민국|한국은행|한국의|한국|한은|우리나라|국내)(?=\s|$)/g;
const HANGUL = /[가-힣]/;

/** Whether `text` asks about Korea: it holds Hangul, or words naming Korea. */
function aboutKorea(text: string): boolean {
  return HANGUL.test(text) || KOREA_WORD.test(text);
}

/** `text` without the words saying it is about Korea: what a Korean source is searched for. */
function withoutKorea(text: string): string {
  return text
    .replace(new RegExp(KOREA_WORD.source, "gi"), " ")
    .replace(KOREA_HANGUL, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** What answers call each ECOS cycle, and the period kind its periods are. */
const ECOS_CYCLE_WORDS: Readonly<Record<EcosCycle, { frequency: string; kind: string }>> = {
  D: { frequency: "daily", kind: "calendar_day" },
  SM: { frequency: "semimonthly", kind: "half_month" },
  M: { frequency: "monthly", kind: "month" },
  Q: { frequency: "quarterly", kind: "quarter" },
  S: { frequency: "semiannual", kind: "half_year" },
  A: { frequency: "annual", kind: "year" },
};

/** What answers call each KOSIS period, and the period kind its periods are. */
const KOSIS_PERIOD_WORDS: Readonly<Record<KosisPeriod, { frequency: string; kind: PeriodKind }>> = {
  D: { frequency: "daily", kind: "calendar_day" },
  M: { frequency: "monthly", kind: "month" },
  Q: { frequency: "quarterly", kind: "quarter" },
  H: { frequency: "semiannual", kind: "half_year" },
  Y: { frequency: "annual", kind: "year" },
};

/** A Korean key as typed (another case, a code the key pattern does not take), under the name asked. */
function typedKey(
  deps: ForkDeps,
  asked: string,
  typed: { publisher: "ecos" | "kosis"; codes: string[] },
): SeriesMeta {
  const key = koreanSeriesKey(typed.publisher, typed.codes);
  if (!seriesKeysOf(deps.config)[typed.publisher]) {
    throw typed.publisher === "ecos" ? ecosKeyNeeded(`series:${key}`) : kosisKeyNeeded(`series:${key}`);
  }
  return {
    key: `series:${key}`,
    name: asked,
    shape: "values",
    frequency: null,
    seasonal_adjustment: null,
    unit: null,
    as_published: null,
    field_states: null,
  };
}

/** A table's name without ECOS's numbering ("1.3.1. "). */
const tableName = (name: string) => name.replace(/^[\d.]+\s*/, "").trim();

/**
 * ECOS's tables whose names hold every word of `asked` (Korea's own words left out): Korean words in their
 * Korean names, the others in their English names; the series of the first of them, in ECOS's order, until
 * CALLS.seriesCandidates are found.
 */
async function ecosSearch(deps: ForkDeps, asked: string, call?: Call): Promise<SeriesMeta[]> {
  const words = [...new Set(searchWords(withoutKorea(asked)))];
  if (!words.length) return [];
  const hangul = words.filter((word) => HANGUL.test(word));
  const latin = words.filter((word) => !HANGUL.test(word));
  const korean = await ecosTables(deps, "kr", call);
  const english = latin.length
    ? new Map((await ecosTables(deps, "en", call)).map((table) => [table.code, table]))
    : undefined;
  const found = korean.filter((table) => {
    if (!table.values) return false;
    const name = normalizeName(table.name);
    if (!hangul.every((word) => name.includes(word))) return false;
    if (!english) return true;
    const own = new Set(searchWords(english.get(table.code)?.name ?? ""));
    return latin.every((word) => own.has(word));
  });
  const series: SeriesMeta[] = [];
  for (const table of found) {
    if (series.length >= CALLS.seriesCandidates) break;
    const items = await ecosItems(deps, table.code, call);
    series.push(...ecosTableSeries(table, english?.get(table.code), items));
  }
  return series.slice(0, CALLS.seriesCandidates);
}

/** A table's items by item group (Group1 first), each item once with every cycle it is published in. */
function itemGroups(items: readonly EcosItem[]) {
  const groups = new Map<string, Map<string, { item: EcosItem; cycles: Set<string> }>>();
  for (const item of items) {
    const group = groups.get(item.group) ?? new Map<string, { item: EcosItem; cycles: Set<string> }>();
    const known = group.get(item.code) ?? { item, cycles: new Set<string>() };
    known.cycles.add(item.cycle);
    group.set(item.code, known);
    groups.set(item.group, group);
  }
  const number = (group: string) => Number(/(\d+)$/.exec(group)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return [...groups].sort(([a], [b]) => number(a) - number(b)).map(([, group]) => [...group.values()]);
}

/** The shortest of `cycles` ECOS publishes in. */
const shortest = (cycles: ReadonlySet<string>) => ECOS_CYCLES.find((cycle) => cycles.has(cycle));

/** A table's series as candidates: each item of its first group, its other groups at their first item. */
function ecosTableSeries(
  table: EcosTable,
  english: EcosTable | undefined,
  items: readonly EcosItem[],
): SeriesMeta[] {
  const [first = [], ...rest] = itemGroups(items);
  const fixed = rest.map((group) => group[0]);
  if (fixed.some((one) => !one)) return [];
  const name = `${tableName(table.name)}${english ? ` (${tableName(english.name)})` : ""}`;
  return first.flatMap(({ item, cycles }) => {
    const cycle = shortest(cycles);
    if (!cycle) return [];
    const codes = [table.code, item.code, ...fixed.map((one) => one?.item.code as string)];
    const words = ECOS_CYCLE_WORDS[cycle];
    return [
      {
        key: `series:${koreanSeriesKey("ecos", codes)}`,
        name: `${name}: ${[item.name, ...fixed.map((one) => one?.item.name)].filter(Boolean).join(", ")}`,
        shape: "values",
        frequency: words.frequency,
        seasonal_adjustment: null,
        unit: item.unit ? koreanUnitOf(item.unit) : null,
        as_published: {
          unit: item.unit || null,
          frequency: `${words.frequency} (ECOS cycle ${cycle})`,
          seasonal_adjustment: null,
        },
        field_states: null,
      },
    ];
  });
}

/** A KOSIS series' name: its table's, its item's, and each classification's code ("성별 계"). */
function kosisName(table: string, item: string, codes: readonly { of: string; name: string }[]): string {
  const named = codes.map((code) => [code.of, code.name].filter(Boolean).join(" ")).filter(Boolean);
  return `${table}${item ? `: ${item}` : ""}${named.length ? ` (${named.join(", ")})` : ""}`;
}

/**
 * KOSIS's search for `asked` (Korea's own words left out): the items of its best tables, each with the
 * table's classifications at their first code, until CALLS.seriesCandidates are found.
 */
async function kosisCandidates(deps: ForkDeps, asked: string, call?: Call): Promise<SeriesMeta[]> {
  const words = withoutKorea(asked);
  if (!words) return [];
  const series: SeriesMeta[] = [];
  for (const table of await kosisSearch(deps, words, CALLS.seriesCandidates, call)) {
    if (series.length >= CALLS.seriesCandidates) break;
    const meta = await kosisMeta(deps, table.org, table.table, call);
    const fixed = meta.classifications.map((classification) => ({
      of: classification.name,
      ...classification.codes[0],
    }));
    if (fixed.some((one) => !one.code)) continue;
    const codes = fixed as { of: string; code: string; name: string }[];
    for (const item of meta.items) {
      series.push({
        key: `series:${koreanSeriesKey("kosis", [table.table, item.code, ...codes.map((code) => code.code)])}`,
        name: kosisName(table.name, item.name, codes),
        shape: "values",
        frequency: null,
        seasonal_adjustment: null,
        unit: item.unit ? koreanUnitOf(item.unit) : null,
        as_published: { unit: item.unit || null, frequency: null, seasonal_adjustment: null },
        field_states: null,
      });
    }
  }
  return series.slice(0, CALLS.seriesCandidates);
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
  const korean = koreanKey(bare);
  if (korean) return koreanObservations(deps, korean, page, call);
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
  const keys = seriesKeysOf(deps.config);
  const publishers = [
    "the U.S. Treasury's",
    "the New York Fed's",
    "the ECB's",
    "FRED's",
    ...(keys.ecos ? ["the Bank of Korea's (ECOS)"] : []),
    ...(keys.kosis ? ["Statistics Korea's (KOSIS)"] : []),
  ];
  const families = [
    "us.treasury.*",
    "us.nyfed.*",
    "ea.ecb.*",
    "us.fred.*",
    ...(keys.ecos ? ["kr.ecos.*"] : []),
    ...(keys.kosis ? ["kr.kosis.*"] : []),
  ];
  throw new DataError(
    "unsupported",
    `series:${bare}: this source serves ${publishers.slice(0, -1).join(", ")} and ${publishers.at(-1)} series (keys ${families.join(", ")})`,
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
    case "ecos":
      return ecos(deps, entry, origin, page, call);
    case "kosis":
      return kosis(deps, entry, origin, page, call);
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

// ECOS and KOSIS ---------------------------------------------------------------------------------------------

type EcosOrigin = Extract<SeriesOrigin, { publisher: "ecos" }>;
type KosisOrigin = Extract<SeriesOrigin, { publisher: "kosis" }>;

/** What a Korean source's answers say of when their values became known. */
const noVintages = (source: string) =>
  `${source} keeps no vintages: each value is the one it publishes now, without the day it became known`;

/** A period a Korean source answered, with its value (null when it answered the period without one). */
type KoreanPoint = { period: SeriesObservation["period"]; value: number | null };

/** The months between consecutive periods of each kind; a half month steps from the 1st to the 16th. */
const STEP_MONTHS: Readonly<Record<string, number>> = { month: 1, quarter: 3, half_year: 6, year: 12 };

/** The period of `kind` after the one starting on `start`, with its label; undefined for a day or a week. */
function nextPeriod(kind: string, start: string): SeriesObservation["period"] | undefined {
  if (kind === "half_month") {
    // The first half's next is its month's second (from the 16th); the second half's, the next month's first.
    const next = start.endsWith("-01") ? `${start.slice(0, 8)}16` : monthStart(start, 1);
    return {
      kind,
      start: next,
      label: `${next.slice(0, 7)} ${next.endsWith("-01") ? "first" : "second"} half`,
    };
  }
  const months = STEP_MONTHS[kind];
  if (!months) return undefined;
  return periodOf(kind as PeriodKind, monthStart(start, months));
}

/**
 * The answer of a Korean series: the latest `limit` periods `points` hold (oldest first), each period missing
 * between two of them listed in the coverage, and the coverage saying the source keeps no vintages.
 */
function koreanAnswer(
  source: string,
  meta: SeriesMeta,
  points: readonly KoreanPoint[],
  limit: number,
): SeriesObservations {
  const shown = points.slice(-limit);
  const first = shown[0] as KoreanPoint;
  const missing: { period: { label: string }; reason: string }[] = [];
  shown.forEach((point, index) => {
    const next = shown[index + 1];
    if (!next) return;
    for (
      let expected = nextPeriod(point.period.kind, point.period.start);
      expected && expected.start < next.period.start;
      expected = nextPeriod(expected.kind, expected.start)
    ) {
      missing.push({ period: { label: expected.label }, reason: `${source} has no row for this period` });
    }
  });
  return {
    series: meta,
    coverage: {
      missing,
      continue_end: shown.length === limit ? addDays(first.period.start, -1) : null,
      complete_reason: noVintages(source),
    },
    observations: shown.map(({ period, value }) =>
      observation(
        period,
        value,
        value === null
          ? {
              field_states: {
                value: { reason: `${source} published this period without a value`, retry: null },
              },
            }
          : {},
      ),
    ),
  };
}

/** The days a page of a half-monthly series needs: its periods and a few more, back from `last`. */
function halfMonthWindow(limit: number, last: string): { start: string; end: string } {
  return { start: addDays(last, -16 * (limit + 6)), end: last };
}

/** An ECOS series outside the catalog, as its answer describes it. */
function ecosMeta(
  origin: EcosOrigin,
  series: { statName: string; items: { name: string }[]; unit: string } | undefined,
): SeriesMeta {
  const words = ECOS_CYCLE_WORDS[origin.cycle];
  const unit = series?.unit ?? "";
  const items = series?.items.map((item) => item.name).filter(Boolean) ?? [];
  return {
    key: `series:${koreanSeriesKey("ecos", [origin.stat, ...origin.items])}`,
    name: series
      ? `${tableName(series.statName)}${items.length ? `: ${items.join(", ")}` : ""}`
      : `ECOS table ${origin.stat}, items ${origin.items.join(", ")}`,
    shape: "values",
    frequency: words.frequency,
    seasonal_adjustment: null,
    unit: unit ? koreanUnitOf(unit) : null,
    as_published: {
      unit: unit || null,
      frequency: `${words.frequency} (ECOS cycle ${origin.cycle})`,
      seasonal_adjustment: null,
    },
    field_states: null,
  };
}

/**
 * An ECOS series (`entry` when the catalog holds it): every row ECOS has for the periods the page needs, read
 * to its total, its latest `limit` periods starting on or before `last`. A day without a value is no period.
 */
async function ecos(
  deps: ForkDeps,
  entry: CatalogSeries | undefined,
  origin: EcosOrigin,
  { limit, last, today }: Page,
  call?: Call,
): Promise<SeriesObservations> {
  const key = koreanSeriesKey("ecos", [origin.stat, ...origin.items]);
  const what = entry ? `${entry.name} (series:${entry.key})` : `series:${key}`;
  if (!deps.config.ecosKey) throw ecosKeyNeeded(what);
  const words = ECOS_CYCLE_WORDS[origin.cycle];
  const window =
    origin.cycle === "SM"
      ? halfMonthWindow(limit, last)
      : observationWindow(words.kind as PeriodKind, limit, last, today);
  const series = await ecosSeries(
    deps,
    { stat: origin.stat, cycle: origin.cycle, items: origin.items, start: window.start, end: window.end },
    call,
  );
  const points = (series?.values ?? []).flatMap((one): KoreanPoint[] => {
    const period = ecosPeriod(origin.cycle, one.time);
    if (!period || period.start > last) return [];
    return one.value === null && origin.cycle === "D" ? [] : [{ period, value: one.value }];
  });
  const meta = entry ? metaOf(entry) : ecosMeta(origin, series);
  if (!points.length) {
    throw new DataError(
      "no_data",
      `${ECOS_SOURCE} has no ${entry?.name ?? meta.name} value for a period starting on or before ${last}.`,
      { source: ECOS_SOURCE },
    );
  }
  return koreanAnswer(ECOS_SOURCE, meta, points, limit);
}

/** A KOSIS series outside the catalog, as its answer describes it. */
function kosisMetaOf(
  origin: Omit<KosisOrigin, "period">,
  period: KosisPeriod,
  series: KosisSeries | undefined,
): SeriesMeta {
  const words = KOSIS_PERIOD_WORDS[period];
  const unit = series?.unit ?? "";
  return {
    key: `series:${koreanSeriesKey("kosis", [origin.table, origin.item, ...origin.objects])}`,
    name: series?.tableName
      ? kosisName(series.tableName, series.item.name, series.objects)
      : `KOSIS table ${origin.table}, item ${origin.item}`,
    shape: "values",
    frequency: words.frequency,
    seasonal_adjustment: null,
    unit: unit ? koreanUnitOf(unit) : null,
    as_published: {
      unit: unit || null,
      frequency: `${words.frequency} (KOSIS period ${period})`,
      seasonal_adjustment: null,
    },
    field_states: null,
  };
}

/**
 * A KOSIS series (`entry` when the catalog holds it) in its period: the catalog's, else the one the table
 * last answered in (kept), else the first of KOSIS_PERIODS it answers in (then kept). Its latest `limit`
 * periods starting on or before `last`; a day without a value is no period.
 */
async function kosis(
  deps: ForkDeps,
  entry: CatalogSeries | undefined,
  origin: Omit<KosisOrigin, "period"> & { period?: KosisPeriod },
  { limit, last, today }: Page,
  call?: Call,
): Promise<SeriesObservations> {
  const key = koreanSeriesKey("kosis", [origin.table, origin.item, ...origin.objects]);
  const what = entry ? `${entry.name} (series:${entry.key})` : `series:${key}`;
  if (!deps.config.kosisKey) throw kosisKeyNeeded(what);
  const read = (period: KosisPeriod) => {
    const window = observationWindow(KOSIS_PERIOD_WORDS[period].kind, limit, last, today);
    return kosisSeries(
      deps,
      {
        org: origin.org,
        table: origin.table,
        item: origin.item,
        objects: origin.objects,
        period,
        start: window.start,
        end: window.end,
      },
      call,
    );
  };
  let period = origin.period ?? (await kosisKnownPeriod(deps, origin.org, origin.table, call));
  let series = period ? await read(period) : undefined;
  if (!period) {
    // A table outside the catalog: the first period it answers in.
    let refused: DataError | undefined;
    for (const one of KOSIS_PERIODS) {
      let found: Awaited<ReturnType<typeof read>>;
      try {
        found = await read(one);
      } catch (error) {
        if (call?.signal?.aborted || !(error instanceof DataError) || error.kind !== "invalid") throw error;
        refused ??= error;
        continue;
      }
      if (!found?.values.length) continue;
      period = one;
      series = found;
      await kosisKeepPeriod(deps, origin.org, origin.table, one, call);
      break;
    }
    if (!period && refused) throw refused;
  }
  const points = period
    ? (series?.values ?? []).flatMap((one): KoreanPoint[] => {
        const of = kosisPeriod(period as KosisPeriod, one.time);
        if (!of || of.start > last) return [];
        return one.value === null && period === "D" ? [] : [{ period: of, value: one.value }];
      })
    : [];
  const name = entry?.name ?? (period ? kosisMetaOf(origin, period, series).name : what);
  if (!period || !points.length) {
    throw new DataError(
      "no_data",
      `${KOSIS_SOURCE} has no ${name} value for a period starting on or before ${last}.`,
      { source: KOSIS_SOURCE },
    );
  }
  return koreanAnswer(
    KOSIS_SOURCE,
    entry ? metaOf(entry) : kosisMetaOf(origin, period, series),
    points,
    limit,
  );
}

/** The cycle of an ECOS series outside the catalog: the shortest its items share, from the table's item list. */
async function ecosCycleOf(
  deps: ForkDeps,
  key: string,
  stat: string,
  items: readonly string[],
  call?: Call,
): Promise<EcosCycle> {
  const invalid = (detail: string) =>
    new DataError("invalid", `series:${key}: ${detail}`, { source: ECOS_SOURCE, retry: "change_request" });
  const groups = itemGroups(await ecosItems(deps, stat, call));
  if (!groups.length) throw invalid(`ECOS has no items of a table ${stat}`);
  if (groups.length !== items.length) {
    throw invalid(
      `ECOS table ${stat} has ${groups.length} item group${groups.length === 1 ? "" : "s"}, and its key names an item of each, in order`,
    );
  }
  let shared: Set<string> | undefined;
  items.forEach((code, index) => {
    const found = groups[index]?.find((one) => one.item.code === code);
    if (!found) throw invalid(`ECOS table ${stat} has no item ${code} in its item group ${index + 1}`);
    shared = shared ? new Set([...shared].filter((cycle) => found.cycles.has(cycle))) : new Set(found.cycles);
  });
  const cycle = shortest(shared ?? new Set());
  if (!cycle)
    throw invalid(`ECOS publishes items ${items.join(", ")} of table ${stat} in no cycle they share`);
  return cycle;
}

/** A Korean series outside the catalog, by its key. */
async function koreanObservations(
  deps: ForkDeps,
  { publisher, codes }: { publisher: "ecos" | "kosis"; codes: string[] },
  page: Page,
  call?: Call,
): Promise<SeriesObservations> {
  const key = koreanSeriesKey(publisher, codes);
  if (publisher === "ecos") {
    if (!deps.config.ecosKey) throw ecosKeyNeeded(`series:${key}`);
    const [stat, ...items] = codes;
    if (!stat || !items.length || codes.some((code) => !code)) {
      throw new DataError(
        "invalid",
        `series:${key} names no series: an ECOS key is kr.ecos.<stat_code>.<item_code>..., an item code for each of the table's item groups`,
        { source: ECOS_SOURCE, retry: "change_request" },
      );
    }
    const cycle = await ecosCycleOf(deps, key, stat, items, call);
    return ecos(deps, undefined, { publisher: "ecos", stat, items, cycle }, page, call);
  }
  if (!deps.config.kosisKey) throw kosisKeyNeeded(`series:${key}`);
  const [table, item, ...objects] = codes;
  if (!table || !item || codes.some((code) => !code)) {
    throw new DataError(
      "invalid",
      `series:${key} names no series: a KOSIS key is kr.kosis.<tbl_id>.<itm_id>.<obj_code>..., a code for each of the table's classifications`,
      { source: KOSIS_SOURCE, retry: "change_request" },
    );
  }
  // A table of the catalog's is read with any item or classification; another, once a search named its organization.
  const org = catalogKosisOrg(table) ?? (await kosisOrg(deps, table, call));
  if (!org) {
    throw new DataError(
      "invalid",
      `series:${key}: KOSIS table ${table} is not in this app's catalog, and no KOSIS search has named the organization that publishes it; search macro_series for the series by name, which names its key`,
      { source: KOSIS_SOURCE, retry: "change_request" },
    );
  }
  return kosis(deps, undefined, { publisher: "kosis", org, table, item, objects }, page, call);
}

/** The organization (orgId) publishing KOSIS table `table`, when the catalog holds a series of it. */
function catalogKosisOrg(table: string): string | undefined {
  for (const entry of SERIES) {
    const origin = entry.origin;
    if (origin.publisher === "kosis" && origin.table.toUpperCase() === table.toUpperCase()) return origin.org;
  }
  return undefined;
}
