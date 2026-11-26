// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "Market overview", routes.ts key `markets`: markets.view, all 22 market views, declared in every setup
 * (no view needs a key; with FRED_API_KEY, FRED's series are read from its API instead of its keyless
 * download). Every row names its source; catalog/markets.ts lists each view's rows.
 *
 * - Yahoo (sources/yahoo.ts, one batched quote per view): equity_summary (the US indices and the 11 SPDR
 *   sector funds, with the funds' breadth on the session), sectors (the funds ranked by the session's
 *   move), indices (the US's, Korea's and the other major markets'), volatility (the VIX term structure,
 *   all in the summary, with its structure), energy, metals, agriculture and livestock (Yahoo's continuous
 *   front-month futures), fx (the major pairs and the dollar index), crypto (large assets ranked by market
 *   capitalization), cross_asset (with the Treasury's 2- and 10-year yields), commodity_benchmarks (oil and
 *   gold volatility, the broad commodity indices), and the MOVE index in rate_indicators.
 * - Yahoo's predefined screens (day_gainers, day_losers, most_actives) for gainers, losers and most_active:
 *   every row of the screen, read a page at a time (250 rows, the most Yahoo answers to one request) until its
 *   total is read; `more` when Yahoo stops short of its total. yahoo-finance2 4.0.6
 *   validates these answers strictly (one quote without `fulldayPrice` fails the whole answer), so they are
 *   read unvalidated, each value for what it is.
 * - sector_rotation: each sector fund's return and its return against SPY's over 1 week, 1 month and 3
 *   months, from Yahoo's daily closes adjusted for splits and dividends; the method is in the summary.
 * - The U.S. Treasury (sources/treasury.ts): yield_curve (the par curve) and tips_breakevens (par less real).
 * - The New York Fed (sources/nyfed.ts): rate_indicators (EFFR, SOFR, OBFR, the FOMC's target range) and the
 *   Federal Reserve's row of central_banks.
 * - The ECB (sources/ecb.ts): its three key interest rates in central_banks, each with the day it took effect.
 * - FRED (sources/fred.ts): credit_spreads, macro (headline statistics with their changes from the period
 *   before and from a year earlier) and the Bank of Japan's and the Reserve Bank of India's rates in
 *   central_banks.
 *
 * A source that fails leaves out only its own rows: each is listed in `missing` and counted in `coverage` by
 * the source's reason (said with each key when the reasons differ, once in the coverage when they are one).
 * `through` is the latest day the data reaches (a monthly or quarterly statistic's reaches its period's last
 * day); `stale` is true when the latest daily value is more than three business days old.
 */
import { addDays, dayOf } from "../../../contracts/index.js";
import type { Call, DataProvider, MarketView, MarketViewName, Quote } from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import {
  BENCHMARK,
  BREAKEVEN_MATURITIES,
  COMMODITY_BENCHMARKS,
  CREDIT_SPREADS,
  CROSS_ASSET,
  CRYPTO,
  ECB_RATES,
  FRED_BANK_RATES,
  FUTURES,
  FX,
  INDICES,
  MACRO_SERIES,
  MOVE_INDEX,
  NYFED_ROWS,
  PAR_MATURITIES,
  type QuotedSpec,
  SCREENS,
  SECTOR_FUNDS,
  type SectorFund,
  SUMMARY_INDICES,
  VIX_TERMS,
} from "../catalog/markets.js";
import { type CatalogSeries, catalogSeries, type PeriodKind, type UnitKind } from "../catalog/series.js";
import type { ForkDeps } from "../deps.js";
import { canonicalKey } from "../listings.js";
import { ECB_SOURCE, policyRateRuns } from "../sources/ecb.js";
import { FRED_KEY_PAGE, FRED_SOURCE, fredGraph, fredVintages } from "../sources/fred.js";
import { latestRates, NYFED_SOURCE } from "../sources/nyfed.js";
import { type CurveDay, curveYear, TREASURY_SOURCE } from "../sources/treasury.js";
import {
  noQuote,
  num,
  planOf,
  quoteOf,
  type Raw,
  readDaily,
  readQuotes,
  record,
  text,
  SOURCE as YAHOO,
  type YahooTarget,
} from "../sources/yahoo.js";
import { yahooCall } from "../sources/yahoo-call.js";

export const MARKETS_SOURCE = "Market overview";

export function marketsProvider(deps: ForkDeps): DataProvider {
  return {
    name: MARKETS_SOURCE,
    capabilities: { markets: { view: (name, call) => marketView(deps, name, call) } },
  };
}

/** One view of today's market: see the top of this file. */
export async function marketView(deps: ForkDeps, name: MarketViewName, call?: Call): Promise<MarketView> {
  switch (name) {
    case "equity_summary":
      return equitySummary(deps, call);
    case "sectors":
      return sectors(deps, call);
    case "gainers":
    case "losers":
    case "most_active":
      return movers(deps, SCREENS[name], call);
    case "volatility":
      return volatility(deps, call);
    case "yield_curve":
      return yieldCurve(deps, call);
    case "central_banks":
      return centralBanks(deps, call);
    case "credit_spreads":
      return statistics(deps, CREDIT_SPREADS, call);
    case "energy":
    case "metals":
    case "agriculture":
    case "livestock":
      return commodities(deps, FUTURES[name], call);
    case "fx":
      return fx(deps, call);
    case "cross_asset":
      return crossAsset(deps, call);
    case "crypto":
      return crypto(deps, call);
    case "macro":
      return statistics(
        deps,
        MACRO_SERIES.map((key) => ({ key })),
        call,
      );
    case "indices":
      return quotedView(deps, INDICES, {}, call);
    case "sector_rotation":
      return sectorRotation(deps, call);
    case "tips_breakevens":
      return breakevens(deps, call);
    case "rate_indicators":
      return rateIndicators(deps, call);
    case "commodity_benchmarks":
      return quotedView(deps, COMMODITY_BENCHMARKS, {}, call);
  }
}

// What a view gathers, and the view it makes -----------------------------------------------------------

type Row = Record<string, unknown>;
type Missing = { key: string; reason: string | null };

/** What a view gathered from its sources. */
class Gathered {
  rows: Row[] = [];
  /** What the view asked its sources for and could not include, with why: counted in its coverage. */
  gaps: Missing[] = [];
  /** What the view lists as left out without counting it (no source it reads has it, or it is a reference). */
  listed: Missing[] = [];
  /** The days of the daily values read, and the last days of longer periods (a month's, a quarter's). */
  days: string[] = [];
  periodEnds: string[] = [];

  constructor(readonly call: Call | undefined) {}

  /** Records why `key` is left out; the caller's cancellation, and a failure that is no DataError, go on. */
  gap(key: string, error: unknown, counted = true): void {
    (counted ? this.gaps : this.listed).push({ key, reason: reasonOf(error, this.call) });
  }

  /** Adds `row`, whose value is of `day` (a daily value) when given. */
  add(row: Row, day?: string | null): void {
    this.rows.push(row);
    if (day) this.days.push(day);
  }
}

/** What a failure says in a view's `missing`: its message; the caller's cancellation is the caller's. */
function reasonOf(error: unknown, call: Call | undefined): string {
  if (call?.signal?.aborted) throw call.signal.reason;
  if (typeof error === "string") return error;
  if (error instanceof DataError) return error.message;
  throw error;
}

/** The latest of some ISO dates. */
function latest(dates: readonly (string | null | undefined)[]): string | null {
  return (
    dates
      .filter((date): date is string => typeof date === "string")
      .sort()
      .at(-1) ?? null
  );
}

/** Weekdays after `from` up to and including `to` (none when `to` is not after `from`). */
export function weekdaysBetween(from: string, to: string): number {
  let count = 0;
  for (let day = addDays(from, 1); day <= to; day = addDays(day, 1)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

/** The business days past which a view's latest daily value is stale. */
export const STALE_AFTER_DAYS = 3;

/** The view `gathered` makes: coverage over `requested` rows (none for a screen), `through`, `stale`. */
function viewOf(
  deps: ForkDeps,
  gathered: Gathered,
  {
    summary = {},
    requested,
    more = false,
  }: { summary?: Record<string, unknown>; requested: number | null; more?: boolean },
): MarketView {
  const counts = new Map<string, number>();
  for (const gap of gathered.gaps) counts.set(gap.reason ?? "", (counts.get(gap.reason ?? "") ?? 0) + 1);
  const lastDay = latest(gathered.days);
  // One reason for every row left out is said once, with its count, in the coverage.
  const once = requested !== null && counts.size === 1;
  return {
    rows: gathered.rows,
    summary,
    missing: [
      ...(once ? gathered.gaps.map(({ key }) => ({ key, reason: null })) : gathered.gaps),
      ...gathered.listed,
    ],
    coverage:
      requested === null
        ? null
        : {
            requested,
            measured: Math.max(0, requested - gathered.gaps.length),
            byReason: [...counts].map(([reason, count]) => ({ reason: reason || null, count })),
          },
    through: latest([...gathered.days, ...gathered.periodEnds]),
    stale: lastDay ? weekdaysBetween(lastDay, dayOf(deps.clock())) > STALE_AFTER_DAYS : null,
    more,
  };
}

// Numbers ----------------------------------------------------------------------------------------------

const POINTS = { kind: "percentage_points" } as const;

/** The decimals a number is written with. */
function decimals(value: number): number {
  const written = String(value);
  const dot = written.indexOf(".");
  return dot < 0 || /e/i.test(written) ? 0 : written.length - dot - 1;
}

/** `a` less `b`, to the decimals they are written with (no float remainder). */
function minus(a: number, b: number): number {
  return Number((a - b).toFixed(Math.min(10, Math.max(decimals(a), decimals(b)))));
}

/** The percent change from `then` to `now`, to two decimals; null from zero. */
function percentChange(now: number, then: number): number | null {
  return then === 0 ? null : Number((((now - then) / Math.abs(then)) * 100).toFixed(2));
}

/** A change as rows give it: in the value's own unit, or in percentage points for a rate. */
function changeOf(now: number | null, then: number | null, points: boolean) {
  const known = now !== null && then !== null;
  return {
    absolute: known ? minus(now, then) : null,
    percent: known && !points ? percentChange(now, then) : null,
    absolute_unit: points ? POINTS : null,
  };
}

// Yahoo's quotes ---------------------------------------------------------------------------------------

/**
 * Yahoo's quotes of `keys`, in one request: each key's quote, or the failure that leaves it out (Yahoo
 * quoting nothing for it, or the request failing).
 */
async function quotesOf(
  deps: ForkDeps,
  keys: readonly string[],
  call: Call | undefined,
): Promise<Map<string, Quote | DataError>> {
  const targets = new Map<string, YahooTarget | DataError>();
  for (const key of keys) {
    const plan = planOf(key);
    targets.set(
      key,
      plan.kind === "target"
        ? plan.target
        : plan.kind === "refused"
          ? plan.error
          : new DataError("invalid", `${key}: name the market`, { source: YAHOO }),
    );
  }
  const symbols = [
    ...new Set(
      [...targets.values()].flatMap((target) => (target instanceof DataError ? [] : [target.symbol])),
    ),
  ];
  let rows: Map<string, Raw> | DataError = new Map();
  if (symbols.length) {
    try {
      rows = await readQuotes(deps, symbols, call);
    } catch (error) {
      if (call?.signal?.aborted || !(error instanceof DataError)) throw error;
      rows = error;
    }
  }
  const answers = new Map<string, Quote | DataError>();
  for (const [key, target] of targets) {
    if (target instanceof DataError) answers.set(key, target);
    else if (rows instanceof DataError) answers.set(key, rows);
    else {
      const row = rows.get(target.symbol.toUpperCase());
      answers.set(key, row ? quoteOf(row, target) : noQuote(target));
    }
  }
  return answers;
}

/** The day a quote is of: its session's, or for a pair quoted around the clock, its time's (UTC). */
function quoteDay(quote: Quote): string | null {
  return quote.session_date ?? quote.price_time?.slice(0, 10) ?? null;
}

/** A quote as a view's row (the QUOTED shape markets.ts previews), under the name and key `spec` gives. */
function quotedRow(spec: QuotedSpec, quote: Quote): Row {
  const scale = quote.instrument?.price_scale;
  return {
    instrument: spec.name,
    key: spec.key,
    ...spec.extra,
    ...priced(quote),
    currency: quote.instrument?.currency ?? null,
    ...(typeof scale === "number" && scale !== 1 ? { price_scale: scale } : {}),
    date: quoteDay(quote),
    time: quote.price_time ?? null,
    market_state: quote.market_state ?? null,
    source: YAHOO,
  };
}

/** A quote's price and its change on the session, in the instrument's money. */
function priced(quote: Quote) {
  return {
    price: quote.price ?? null,
    change: { absolute: quote.change ?? null, percent: quote.change_percent ?? null, absolute_unit: null },
  };
}

/** The rows of `specs`, quoted in one request, into `gathered` (each left out with Yahoo's reason). */
async function addQuoted(
  deps: ForkDeps,
  gathered: Gathered,
  specs: readonly QuotedSpec[],
  call: Call | undefined,
): Promise<Map<string, Quote>> {
  const answers = await quotesOf(
    deps,
    specs.map((spec) => spec.key),
    call,
  );
  const quoted = new Map<string, Quote>();
  for (const spec of specs) {
    const answer = answers.get(spec.key);
    if (answer && !(answer instanceof DataError)) {
      quoted.set(spec.key, answer);
      gathered.add(quotedRow(spec, answer), quoteDay(answer));
    } else gathered.gap(spec.key, answer ?? noQuoteFor(spec.key));
  }
  return quoted;
}

function noQuoteFor(key: string): DataError {
  return new DataError("no_data", `Yahoo has no quote for ${key}`, { source: YAHOO });
}

/** A view of quoted rows alone, in the catalog's order. */
async function quotedView(
  deps: ForkDeps,
  specs: readonly QuotedSpec[],
  summary: Record<string, unknown>,
  call: Call | undefined,
): Promise<MarketView> {
  const gathered = new Gathered(call);
  await addQuoted(deps, gathered, specs, call);
  return viewOf(deps, gathered, { summary, requested: specs.length });
}

/** Rows ranked by a number, highest first, those without one last (in their order); each given its rank. */
function ranked(rows: Row[], by: (row: Row) => number | null): Row[] {
  const order = rows
    .map((row, index) => ({ row, index, value: by(row) }))
    .sort((a, b) =>
      a.value === null
        ? b.value === null
          ? a.index - b.index
          : 1
        : b.value === null
          ? -1
          : b.value - a.value,
    );
  return order.map(({ row, value }, index) => ({ rank: value === null ? null : index + 1, ...row }));
}

/** A quoted row's percent change on the session. */
const sessionMove = (row: Row) => {
  const change = row.change as { percent?: number | null } | undefined;
  return typeof change?.percent === "number" ? change.percent : null;
};

// Equities ---------------------------------------------------------------------------------------------

/** The sector funds as quoted rows, each with its sector. */
const SECTOR_ROWS: readonly QuotedSpec[] = SECTOR_FUNDS.map((fund) => ({
  key: fund.key,
  name: fund.name,
  extra: { sector: fund.sector },
}));

async function equitySummary(deps: ForkDeps, call: Call | undefined): Promise<MarketView> {
  const gathered = new Gathered(call);
  const specs = [
    ...SUMMARY_INDICES.map((spec) => ({ ...spec, extra: { group: "index" } })),
    ...SECTOR_ROWS.map((spec) => ({ ...spec, extra: { group: "sector", ...spec.extra } })),
  ];
  await addQuoted(deps, gathered, specs, call);
  const indexRows = gathered.rows.filter((row) => row.group === "index");
  const sectorRows = ranked(
    gathered.rows.filter((row) => row.group === "sector"),
    sessionMove,
  );
  gathered.rows = [...indexRows, ...sectorRows];
  const moves = sectorRows.map(sessionMove).filter((move): move is number => move !== null);
  const up = moves.filter((move) => move > 0).length;
  gathered.listed.push({
    key: "market_breadth",
    reason: "advancing and declining issues, new highs and lows: no source this app reads publishes them",
  });
  return viewOf(deps, gathered, {
    requested: specs.length,
    summary: {
      breadth: {
        positive_sectors: up,
        negative_sectors: moves.filter((move) => move < 0).length,
        unchanged_sectors: moves.filter((move) => move === 0).length,
        measured_sectors: moves.length,
        total_sectors: SECTOR_FUNDS.length,
        breadth_percent: moves.length ? Number(((up / moves.length) * 100).toFixed(1)) : null,
        basis: "the SPDR sector funds that rose on the session, of those quoted",
      },
    },
  });
}

async function sectors(deps: ForkDeps, call: Call | undefined): Promise<MarketView> {
  const gathered = new Gathered(call);
  await addQuoted(deps, gathered, SECTOR_ROWS, call);
  gathered.rows = ranked(gathered.rows, sessionMove);
  return viewOf(deps, gathered, {
    requested: SECTOR_ROWS.length,
    summary: { ranked_by: "the session's percent change, highest first" },
  });
}

// Yahoo's screens -------------------------------------------------------------------------------------

/**
 * The most rows Yahoo answers to one request of a predefined screen (as widely reported): a screen is read a
 * page of this many at a time.
 */
export const SCREEN_ROWS = 250;

/**
 * Yahoo's answer to one request of predefined screen `id`, from row `start` (0, the first), read unvalidated
 * (see the top of this file).
 */
export async function readScreen(
  deps: ForkDeps,
  id: string,
  call: Call | undefined,
  start = 0,
): Promise<Raw> {
  const answer = await yahooCall(
    () =>
      deps.yahoo.screener(
        {
          scrIds: id as (typeof SCREENS)[keyof typeof SCREENS],
          count: SCREEN_ROWS,
          ...(start ? { start } : {}),
          region: "US",
          lang: "en-US",
        },
        undefined,
        { validateResult: false, fetchOptions: call?.signal ? { signal: call.signal } : {} },
      ),
    { signal: call?.signal, notFound: "unavailable", notFoundMessage: `Yahoo has no screen ${id}` },
  );
  const screen = record(answer);
  if (!Array.isArray(screen.quotes)) {
    throw new DataError("unavailable", `Yahoo answered the ${id} screen in a form this app does not read.`, {
      source: YAHOO,
    });
  }
  return screen;
}

/** A screen's listing as a row: the quote's fields, keyed as the tools take a listing. */
function screenRow(item: Raw, rank: number): Row | undefined {
  const symbol = text(item.symbol);
  if (!symbol) return undefined;
  const key = canonicalKey(symbol) ?? symbol;
  const plan = planOf(symbol);
  const target: YahooTarget =
    plan.kind === "target"
      ? plan.target
      : { symbol, key, kind: "security", zone: "America/New_York", notFound: "no_data" };
  const quote = quoteOf(item, target);
  return {
    rank,
    instrument: text(item.longName) ?? text(item.shortName) ?? symbol,
    key,
    ...priced(quote),
    volume: num(item.regularMarketVolume),
    average_volume_3m: num(item.averageDailyVolume3Month),
    market_cap: num(item.marketCap),
    currency: quote.instrument?.currency ?? null,
    exchange: text(item.fullExchangeName) ?? text(item.exchange),
    date: quoteDay(quote),
    time: quote.price_time ?? null,
    market_state: quote.market_state ?? null,
    source: YAHOO,
  };
}

/** A screen's sort order in words: Yahoo writes "DESC" or "ASC". */
function orderOf(sortType: string): string {
  if (/^desc/i.test(sortType)) return "descending";
  if (/^asc/i.test(sortType)) return "ascending";
  return sortType;
}

async function movers(deps: ForkDeps, id: string, call: Call | undefined): Promise<MarketView> {
  const gathered = new Gathered(call);
  let screen: Raw;
  try {
    screen = await readScreen(deps, id, call);
  } catch (error) {
    gathered.gap(id, error, false);
    return viewOf(deps, gathered, { requested: null, summary: { screen: id } });
  }
  const total = num(screen.total);
  const pages = [screen];
  let read = (num(screen.start) ?? 0) + (screen.quotes as unknown[]).length;
  // The rest of the screen, a page at a time, until its total is read. A page that does not go on from the
  // rows read (none, or not from the row asked for) ends it; a page that fails is listed with its ranks.
  while (total !== null && read < total) {
    let page: Raw;
    try {
      page = await readScreen(deps, id, call, read);
    } catch (error) {
      gathered.gap(`ranks ${read + 1} to ${total}`, error, false);
      break;
    }
    const quotes = page.quotes as unknown[];
    if (!quotes.length || (num(page.start) ?? read) !== read) break;
    pages.push(page);
    read += quotes.length;
  }
  for (const page of pages) {
    const start = num(page.start) ?? 0;
    (page.quotes as unknown[]).forEach((item, index) => {
      const row = screenRow(record(item), start + index + 1);
      if (row) gathered.add(row, row.date as string | null);
      else gathered.gap(`rank ${start + index + 1}`, "Yahoo's row names no symbol");
    });
  }
  const meta = record(screen.criteriaMeta);
  const sortField = text(meta.sortField);
  const sortType = text(meta.sortType);
  return viewOf(deps, gathered, {
    requested: null,
    more: total !== null && total > read,
    summary: {
      screen: id,
      title: text(screen.title),
      criteria: text(screen.description),
      ranked_by: sortField ? `${sortField}${sortType ? `, ${orderOf(sortType)}` : ""}` : null,
      total,
    },
  });
}

// Volatility ------------------------------------------------------------------------------------------

async function volatility(deps: ForkDeps, call: Call | undefined): Promise<MarketView> {
  const gathered = new Gathered(call);
  const answers = await quotesOf(
    deps,
    VIX_TERMS.map((term) => term.key),
    call,
  );
  const summary: Record<string, unknown> = {};
  const prices = new Map<string, number | null>();
  for (const { field, key } of VIX_TERMS) {
    const answer = answers.get(key);
    if (!answer || answer instanceof DataError) {
      summary[field] = null;
      gathered.gap(key, answer ?? noQuoteFor(key));
      continue;
    }
    const day = quoteDay(answer);
    if (day) gathered.days.push(day);
    prices.set(field, answer.price ?? null);
    summary[field] = {
      key,
      price: answer.price ?? null,
      change: { absolute: answer.change ?? null, percent: answer.change_percent ?? null },
      date: day,
      time: answer.price_time ?? null,
      source: YAHOO,
    };
  }
  const spot = prices.get("spot") ?? null;
  const threeMonth = prices.get("vix_3m") ?? null;
  summary.structure =
    spot === null || threeMonth === null
      ? null
      : threeMonth > spot
        ? "contango"
        : threeMonth < spot
          ? "backwardation"
          : "flat";
  summary.vix_to_vix3m = spot !== null && threeMonth ? Number((spot / threeMonth).toFixed(3)) : null;
  summary.structure_basis =
    "the 3-month VIX against the spot VIX: contango when the 3-month is higher, backwardation when lower";
  return viewOf(deps, gathered, { requested: VIX_TERMS.length, summary });
}

// The Treasury's curves -------------------------------------------------------------------------------

/** "10y" as rows label a maturity: "10Y"; "1.5m": "1.5M". */
const maturityLabel = (maturity: string) => maturity.toUpperCase();

/** The key macro_series reads a curve point by: `series:us.treasury.par_10y`, `..._1_5m`. */
const curveKey = (kind: "par" | "real" | "breakeven", maturity: string) =>
  `series:us.treasury.${kind}_${maturity.replace(".", "_")}`;

/**
 * The latest days of `curve`, oldest first: the current year's file, and the year before's when the current
 * one holds fewer than two days (early January).
 */
async function curveDays(deps: ForkDeps, curve: "par" | "real", call: Call | undefined): Promise<CurveDay[]> {
  const today = dayOf(deps.clock());
  const year = Number(today.slice(0, 4));
  const days = await curveYear(deps, curve, year, today, call);
  if (days.length >= 2) return days;
  return [...(await curveYear(deps, curve, year - 1, today, call)), ...days];
}

/** A yield as a quoted row (the cross-asset view's, the rates'): its change in percentage points. */
function yieldRow(
  name: string,
  key: string,
  latestValue: { value: number; date: string },
  previous: { value: number; date: string } | undefined,
  source: string,
  extra: Row = {},
): Row {
  return {
    instrument: name,
    key,
    ...extra,
    price: latestValue.value,
    change: changeOf(latestValue.value, previous?.value ?? null, true),
    previous: previous ?? null,
    currency: null,
    date: latestValue.date,
    source,
  };
}

async function yieldCurve(deps: ForkDeps, call: Call | undefined): Promise<MarketView> {
  const gathered = new Gathered(call);
  let days: CurveDay[] = [];
  try {
    days = await curveDays(deps, "par", call);
  } catch (error) {
    for (const maturity of PAR_MATURITIES) gathered.gap(curveKey("par", maturity), error);
    return viewOf(deps, gathered, { requested: PAR_MATURITIES.length });
  }
  const last = days.at(-1);
  const before = days.at(-2);
  if (!last) {
    for (const maturity of PAR_MATURITIES)
      gathered.gap(curveKey("par", maturity), "the Treasury's files hold no day of its par curve");
    return viewOf(deps, gathered, { requested: PAR_MATURITIES.length });
  }
  for (const maturity of PAR_MATURITIES) {
    const value = last.yields[maturity];
    if (value === undefined) {
      gathered.gap(
        curveKey("par", maturity),
        `the Treasury's par curve of ${last.date} has no ${maturity} yield`,
      );
      continue;
    }
    const prior = before?.yields[maturity];
    gathered.add(
      {
        maturity: maturityLabel(maturity),
        key: curveKey("par", maturity),
        unit: { kind: "percent" },
        latest: { value, date: last.date },
        previous: before && prior !== undefined ? { value: prior, date: before.date } : null,
        change: changeOf(value, prior ?? null, true),
        source: TREASURY_SOURCE,
      },
      last.date,
    );
  }
  const spread = (long: string, short: string) => {
    const a = last.yields[long];
    const b = last.yields[short];
    return a === undefined || b === undefined ? null : minus(a, b);
  };
  return viewOf(deps, gathered, {
    requested: PAR_MATURITIES.length,
    summary: {
      date: last.date,
      previous_date: before?.date ?? null,
      basis: "the Treasury's daily par yield curve: yields in percent, on a bond-equivalent basis",
      spreads: {
        "10y_minus_2y": spread("10y", "2y"),
        "10y_minus_3m": spread("10y", "3m"),
        unit: "percentage points",
      },
    },
  });
}

async function breakevens(deps: ForkDeps, call: Call | undefined): Promise<MarketView> {
  const gathered = new Gathered(call);
  let par: CurveDay[];
  let real: CurveDay[];
  try {
    [par, real] = await Promise.all([curveDays(deps, "par", call), curveDays(deps, "real", call)]);
  } catch (error) {
    for (const maturity of BREAKEVEN_MATURITIES) gathered.gap(curveKey("breakeven", maturity), error);
    return viewOf(deps, gathered, { requested: BREAKEVEN_MATURITIES.length });
  }
  // The days both curves were published, latest last.
  const parByDate = new Map(par.map((day) => [day.date, day]));
  const both = real.filter((day) => parByDate.has(day.date));
  const last = both.at(-1);
  const before = both.at(-2);
  const breakeven = (day: CurveDay | undefined, maturity: string) => {
    const nominal = day ? parByDate.get(day.date)?.yields[maturity] : undefined;
    const inflationProtected = day?.yields[maturity];
    return nominal === undefined || inflationProtected === undefined
      ? undefined
      : { value: minus(nominal, inflationProtected), nominal, real: inflationProtected };
  };
  for (const maturity of BREAKEVEN_MATURITIES) {
    const now = breakeven(last, maturity);
    if (!last || !now) {
      gathered.gap(
        curveKey("breakeven", maturity),
        last
          ? `the Treasury's curves of ${last.date} have no ${maturity} par and real yield`
          : "the Treasury's files hold no day with both its par and real curves",
      );
      continue;
    }
    const then = breakeven(before, maturity);
    gathered.add(
      {
        maturity: maturityLabel(maturity),
        key: curveKey("breakeven", maturity),
        unit: { kind: "percent" },
        latest: { value: now.value, date: last.date },
        nominal: now.nominal,
        real: now.real,
        previous: before && then ? { value: then.value, date: before.date } : null,
        change: changeOf(now.value, then?.value ?? null, true),
        source: TREASURY_SOURCE,
      },
      last.date,
    );
  }
  return viewOf(deps, gathered, {
    requested: BREAKEVEN_MATURITIES.length,
    summary: {
      date: last?.date ?? null,
      method:
        "the Treasury's par (nominal) yield less its real (TIPS) par yield at each maturity, in percent, as FRED derives T5YIE and T10YIE",
    },
  });
}

// Rates: the New York Fed, the ECB, FRED --------------------------------------------------------------

async function rateIndicators(deps: ForkDeps, call: Call | undefined): Promise<MarketView> {
  const gathered = new Gathered(call);
  const summary: Record<string, unknown> = { fed_funds_target: null };
  const [rates, quoted] = await Promise.all([
    Promise.allSettled(NYFED_ROWS.map(({ rate }) => latestRates(deps, rate, 5, call))),
    quotesOf(deps, [MOVE_INDEX.key], call),
  ]);
  NYFED_ROWS.forEach(({ rate, name }, index) => {
    const key = `series:us.nyfed.${rate}`;
    const read = rates[index] as PromiseSettledResult<Awaited<ReturnType<typeof latestRates>>>;
    if (read.status === "rejected") {
      gathered.gap(key, read.reason);
      return;
    }
    const days = read.value.filter((day) => day.value !== null);
    const last = days.at(-1);
    if (!last || last.value === null) {
      gathered.gap(key, `the New York Fed published no ${rate.toUpperCase()} in its latest days`);
      return;
    }
    const before = days.at(-2);
    gathered.add(
      yieldRow(
        name,
        key,
        { value: last.value, date: last.date },
        before && before.value !== null ? { value: before.value, date: before.date } : undefined,
        NYFED_SOURCE,
        last.revised ? { revised: true } : {},
      ),
      last.date,
    );
    if (rate === "effr" && last.target && last.target.from !== null) {
      summary.fed_funds_target = {
        from: last.target.from,
        to: last.target.to,
        date: last.date,
        source: NYFED_SOURCE,
      };
    }
  });
  const move = quoted.get(MOVE_INDEX.key);
  if (move && !(move instanceof DataError)) gathered.add(quotedRow(MOVE_INDEX, move), quoteDay(move));
  else gathered.gap(MOVE_INDEX.key, move ?? noQuoteFor(MOVE_INDEX.key));
  return viewOf(deps, gathered, { requested: NYFED_ROWS.length + 1, summary });
}

async function centralBanks(deps: ForkDeps, call: Call | undefined): Promise<MarketView> {
  const gathered = new Gathered(call);
  const today = dayOf(deps.clock());
  // The ECB's runs from the start of the year before last, as macro_series reads them (one cache entry).
  const from = `${Number(today.slice(0, 4)) - 2}-01-01`;
  const [effr, ecb, fred] = await Promise.all([
    latestRates(deps, "effr", 5, call).then(
      (days) => ({ days }),
      (error: unknown) => ({ error }),
    ),
    Promise.allSettled(ECB_RATES.map(({ rate }) => policyRateRuns(deps, rate, { from }, call))),
    Promise.allSettled(FRED_BANK_RATES.map((bank) => fredPoints(deps, bank.id, bank.period, call))),
  ]);
  // The Federal Reserve: the FOMC's target range, as the New York Fed states it beside EFFR.
  const fedKey = "series:us.nyfed.effr";
  if ("error" in effr) gathered.gap(fedKey, effr.error);
  else {
    const last = effr.days.filter((day) => day.target && day.target.from !== null).at(-1);
    if (!last?.target) gathered.gap(fedKey, "the New York Fed's latest days state no FOMC target");
    else {
      gathered.add(
        {
          bank: "Federal Reserve",
          rate: "federal funds rate",
          key: fedKey,
          unit: { kind: "percent" },
          target_range: { from: last.target.from, to: last.target.to, date: last.date },
          latest: { value: last.value, date: last.date, measure: "effective federal funds rate (EFFR)" },
          source: NYFED_SOURCE,
        },
        last.date,
      );
    }
  }
  // The ECB: each key interest rate in effect, the day it took effect, and the rate before it.
  ECB_RATES.forEach(({ rate, name }, index) => {
    const key = `series:ea.ecb.${rate.toLowerCase()}`;
    const read = ecb[index] as PromiseSettledResult<Awaited<ReturnType<typeof policyRateRuns>>>;
    if (read.status === "rejected") {
      gathered.gap(key, read.reason);
      return;
    }
    const runs = read.value;
    const now = runs.at(-1);
    if (!now) {
      gathered.gap(key, `the ECB published no ${name} since ${from}`);
      return;
    }
    // The run the rate in effect started with (a day missing from the file splits a run, not a decision).
    let first = runs.length - 1;
    while (first > 0 && runs[first - 1]?.value === now.value) first--;
    const start = runs[first] as (typeof runs)[number];
    // A run that starts on the first day read was in effect before it: when it took effect is not read.
    const since = start.date > from ? start.date : null;
    const before = since ? runs[first - 1] : undefined;
    gathered.add(
      {
        bank: "European Central Bank",
        rate: name,
        key,
        unit: { kind: "percent" },
        latest: {
          value: now.value,
          date: now.through,
          ...(since ? { in_effect_since: since } : { in_effect_since: null, unchanged_since_at_least: from }),
        },
        previous: before ? { value: before.value, until: before.through } : null,
        change: changeOf(now.value, before?.value ?? null, true),
        source: ECB_SOURCE,
      },
      now.through,
    );
  });
  // Other central banks FRED serves.
  FRED_BANK_RATES.forEach((bank, index) => {
    const key = `series:us.fred.${bank.id.toLowerCase()}`;
    const read = fred[index] as PromiseSettledResult<Point[]>;
    if (read.status === "rejected") {
      gathered.gap(key, fredReason(deps, read.reason, call));
      return;
    }
    const facts = factsOf(read.value, bank.period, false);
    if (!facts) {
      gathered.gap(key, `FRED has no value of ${bank.id} in the last periods`);
      return;
    }
    gathered.add({
      bank: bank.bank,
      rate: bank.rate,
      key,
      unit: { kind: "percent" },
      frequency: FREQUENCY[bank.period],
      latest: facts.latest,
      previous: facts.previous,
      change: changeOf(facts.latest.value, facts.previous?.value ?? null, true),
      source: FRED_SOURCE,
    });
    gathered.periodEnds.push(periodEnd(bank.period, facts.latest.date));
  });
  return viewOf(deps, gathered, { requested: 1 + ECB_RATES.length + FRED_BANK_RATES.length });
}

// FRED's series ---------------------------------------------------------------------------------------

/** A date of a FRED series, its value, and (from FRED's API) since when that value has been known. */
type Point = { date: string; value: number | null; knownFrom: string | null };

/** Days read back for each kind of period: enough for the latest value, the one before and a year earlier. */
const LOOKBACK_DAYS: Readonly<Record<PeriodKind, number>> = {
  calendar_day: 31,
  week: 400,
  month: 500,
  quarter: 760,
  half_year: 1_100,
  year: 1_500,
};

const FREQUENCY: Readonly<Record<PeriodKind, string>> = {
  calendar_day: "daily",
  week: "weekly",
  month: "monthly",
  quarter: "quarterly",
  half_year: "semiannual",
  year: "annual",
};

/** FRED's latest values of `id`: from its API with FRED_API_KEY (each with when it became known), else its keyless download. */
async function fredPoints(
  deps: ForkDeps,
  id: string,
  period: PeriodKind,
  call: Call | undefined,
): Promise<Point[]> {
  const today = dayOf(deps.clock());
  const window = { start: addDays(today, -LOOKBACK_DAYS[period]), end: today };
  if (deps.config.fredKey) {
    return (await fredVintages(deps, id, window, call)).map((point) => ({
      date: point.date,
      value: point.value,
      knownFrom: point.knownFrom,
    }));
  }
  return (await fredGraph(deps, id, window, call)).map((point) => ({ ...point, knownFrom: null }));
}

/** Why a FRED series is left out: FRED's reason, and without FRED_API_KEY what the key would change. */
function fredReason(deps: ForkDeps, error: unknown, call: Call | undefined): string {
  const said = reasonOf(error, call).replace(/[.\s]+$/, "");
  if (deps.config.fredKey || (error instanceof DataError && error.kind === "invalid")) return said;
  return `FRED's keyless download failed: ${said}; with FRED_API_KEY set (a free key from ${FRED_KEY_PAGE}), FRED's API serves it`;
}

/** The last day of the period of `kind` starting on `date` (a week's date is its last day, as FRED dates them). */
function periodEnd(kind: PeriodKind, date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const endOfMonth = (y: number, m: number) => dayOf(new Date(Date.UTC(y, m, 0)));
  switch (kind) {
    case "month":
      return endOfMonth(year, month);
    case "quarter":
      return endOfMonth(year, month + 2);
    case "half_year":
      return endOfMonth(year, month + 5);
    case "year":
      return `${year}-12-31`;
    default:
      return date;
  }
}

/** A period as rows label it: "2026-10", "2026-Q3", "week ending 2026-11-21", or the day. */
function periodLabel(kind: PeriodKind, date: string): string {
  const month = Number(date.slice(5, 7));
  switch (kind) {
    case "month":
      return date.slice(0, 7);
    case "quarter":
      return `${date.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`;
    case "half_year":
      return `${date.slice(0, 4)}-H${month <= 6 ? 1 : 2}`;
    case "year":
      return date.slice(0, 4);
    case "week":
      return `week ending ${date}`;
    default:
      return date;
  }
}

/** The date a year before `date` (a week's: 52 weeks before, as weekly dates fall). */
function yearBefore(kind: PeriodKind, date: string): string {
  return kind === "week" ? addDays(date, -364) : `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
}

type Observed = { value: number | null; date: string; period?: string; known_from?: string | null };

/**
 * A series' latest value, the value of the period before it and, for longer periods, of the same period a
 * year earlier: null when FRED has the period without a value (a release that did not come out). A day
 * without a value is no period of a daily series (a holiday): the day before is the last one with a value.
 */
function factsOf(
  points: readonly Point[],
  kind: PeriodKind,
  withYear: boolean,
): { latest: Observed & { value: number }; previous: Observed | null; yearAgo: Observed | null } | undefined {
  const valued = points.filter((point): point is Point & { value: number } => point.value !== null);
  const last = valued.at(-1);
  if (!last) return undefined;
  const daily = kind === "calendar_day";
  const observed = (point: Point, known_from?: true): Observed => ({
    ...(daily ? {} : { period: periodLabel(kind, point.date) }),
    date: point.date,
    value: point.value,
    ...(known_from ? { known_from: point.knownFrom } : {}),
  });
  const before = daily ? valued.at(-2) : points[points.indexOf(last) - 1];
  const yearAgo = withYear ? points.find((point) => point.date === yearBefore(kind, last.date)) : undefined;
  return {
    latest: { ...observed(last, true), value: last.value },
    previous: before ? observed(before) : null,
    yearAgo: yearAgo ? observed(yearAgo) : null,
  };
}

/** Whether changes of a unit read as differences in percentage points (a rate, a spread). */
const inPoints = (kind: UnitKind) => kind === "percent" || kind === "percentage_points";

/**
 * Rows of catalogued FRED series (credit_spreads, macro): each series' latest value, its change from the
 * value before and, for monthly, weekly and quarterly statistics, from a year earlier.
 */
async function statistics(
  deps: ForkDeps,
  wanted: readonly { key: string; title?: string }[],
  call: Call | undefined,
): Promise<MarketView> {
  const gathered = new Gathered(call);
  const entries = wanted.map(({ key, title }) => {
    const entry = catalogSeries(key);
    if (entry?.origin.publisher !== "fred") throw new Error(`catalog/markets.ts: ${key} is no FRED series`);
    return { key, title, entry, id: entry.origin.id };
  });
  const reads = await Promise.allSettled(
    entries.map(({ entry, id }) => fredPoints(deps, id, entry.period, call)),
  );
  entries.forEach(({ key, title, entry }, index) => {
    const read = reads[index] as PromiseSettledResult<Point[]>;
    if (read.status === "rejected") {
      gathered.gap(`series:${key}`, fredReason(deps, read.reason, call));
      return;
    }
    const row = seriesRow(entry, read.value, title);
    if (!row) {
      gathered.gap(`series:${key}`, `FRED has no ${entry.name} value in the last periods`);
      return;
    }
    if (entry.period === "calendar_day") gathered.add(row.row, row.date);
    else {
      gathered.add(row.row);
      gathered.periodEnds.push(periodEnd(entry.period, row.date));
    }
  });
  return viewOf(deps, gathered, {
    requested: wanted.length,
    summary: {
      read_from: deps.config.fredKey
        ? "FRED's API: each latest value with the day it became known (known_from)"
        : "FRED's keyless download: the latest vintage of each value, without the day it became known",
    },
  });
}

/** A catalogued FRED series as a row, from its latest points; undefined when it has no value. */
function seriesRow(
  entry: CatalogSeries,
  points: readonly Point[],
  title: string | undefined,
): { row: Row; date: string } | undefined {
  const withYear = entry.period !== "calendar_day";
  const facts = factsOf(points, entry.period, withYear);
  if (!facts) return undefined;
  const points_ = inPoints(entry.unit.kind);
  const latestValue = facts.latest.value;
  return {
    date: facts.latest.date,
    row: {
      name: entry.name,
      ...(title ? { title } : {}),
      key: `series:${entry.key}`,
      unit: { kind: entry.unit.kind },
      as_published: entry.as_published.unit,
      frequency: entry.frequency,
      ...(entry.seasonal_adjustment ? { seasonal_adjustment: entry.seasonal_adjustment } : {}),
      latest: facts.latest,
      previous: facts.previous,
      change: changeOf(latestValue, facts.previous?.value ?? null, points_),
      ...(withYear
        ? { year_ago: facts.yearAgo, change_1y: changeOf(latestValue, facts.yearAgo?.value ?? null, points_) }
        : {}),
      source: FRED_SOURCE,
    },
  };
}

// Commodities, currencies, crypto, cross-asset --------------------------------------------------------

function commodities(
  deps: ForkDeps,
  specs: readonly QuotedSpec[],
  call: Call | undefined,
): Promise<MarketView> {
  return quotedView(
    deps,
    specs,
    {
      contracts:
        "Yahoo's continuous front-month futures (the nearest contract); a roll to the next contract is not marked",
    },
    call,
  );
}

function fx(deps: ForkDeps, call: Call | undefined): Promise<MarketView> {
  return quotedView(
    deps,
    FX,
    {
      convention:
        "a pair's price is units of its second currency per unit of its first (EUR/USD: dollars per euro)",
    },
    call,
  );
}

async function crypto(deps: ForkDeps, call: Call | undefined): Promise<MarketView> {
  const gathered = new Gathered(call);
  const quoted = await addQuoted(deps, gathered, CRYPTO, call);
  const capOf = (row: Row) => quoted.get(row.key as string)?.market_cap ?? null;
  gathered.rows = ranked(
    gathered.rows.map(({ source, ...row }) => ({ ...row, market_cap: capOf(row), source })),
    (row) => (typeof row.market_cap === "number" ? row.market_cap : null),
  );
  const caps = gathered.rows
    .map((row) => row.market_cap)
    .filter((cap): cap is number => typeof cap === "number");
  return viewOf(deps, gathered, {
    requested: CRYPTO.length,
    summary: {
      ranked_by: "market capitalization in US dollars, as Yahoo states it",
      universe: `${CRYPTO.length} large crypto assets, each as Yahoo's USD pair`,
      listed_market_cap: caps.length ? caps.reduce((sum, cap) => sum + cap, 0) : null,
    },
  });
}

async function crossAsset(deps: ForkDeps, call: Call | undefined): Promise<MarketView> {
  const gathered = new Gathered(call);
  const quotedSpecs = CROSS_ASSET.filter((spec): spec is QuotedSpec & { group: string } => "key" in spec);
  const [days, quoted] = await Promise.all([
    curveDays(deps, "par", call).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ),
    quotesOf(
      deps,
      quotedSpecs.map((spec) => spec.key),
      call,
    ),
  ]);
  for (const spec of CROSS_ASSET) {
    if ("treasury" in spec) {
      const key = curveKey("par", spec.treasury);
      if ("error" in days) {
        gathered.gap(key, days.error);
        continue;
      }
      const last = days.value.at(-1);
      const before = days.value.at(-2);
      const value = last?.yields[spec.treasury];
      if (!last || value === undefined) {
        gathered.gap(key, `the Treasury's latest par curve has no ${spec.treasury} yield`);
        continue;
      }
      const prior = before?.yields[spec.treasury];
      gathered.add(
        yieldRow(
          spec.name,
          key,
          { value, date: last.date },
          before && prior !== undefined ? { value: prior, date: before.date } : undefined,
          TREASURY_SOURCE,
          { group: spec.group },
        ),
        last.date,
      );
      continue;
    }
    const answer = quoted.get(spec.key);
    if (answer && !(answer instanceof DataError)) {
      gathered.add(quotedRow({ ...spec, extra: { group: spec.group } }, answer), quoteDay(answer));
    } else gathered.gap(spec.key, answer ?? noQuoteFor(spec.key));
  }
  return viewOf(deps, gathered, { requested: CROSS_ASSET.length });
}

// Sector rotation -------------------------------------------------------------------------------------

/** `date` moved by `months` calendar months, its day kept or, past the month's end, the month's last day. */
export function addMonths(date: string, months: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1 + months;
  const day = Number(date.slice(8, 10));
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return dayOf(new Date(Date.UTC(year, month, Math.min(day, last))));
}

/** The rotation's windows: each one's name and its start, counted back from the latest close. */
const WINDOWS: readonly { name: "1w" | "1m" | "3m"; start: (through: string) => string }[] = [
  { name: "1w", start: (through) => addDays(through, -7) },
  { name: "1m", start: (through) => addMonths(through, -1) },
  { name: "3m", start: (through) => addMonths(through, -3) },
];

/** The cyclical sectors' average score less the defensive sectors', in percentage points, past which a reading is risk-on or risk-off. */
export const ROTATION_BAND = 0.5;

const ROTATION_METHOD =
  "each sector fund's return over 1 week, 1 month and 3 months (Yahoo's daily closes adjusted for splits and " +
  "dividends: the latest close against the last close on or before the window's start) less SPY's over the " +
  "same window, in percentage points; score: the average of the three; sectors ranked by score; " +
  "rotation_signal: risk-on when the cyclical sectors' average score (energy, materials, industrials, consumer " +
  "discretionary, financials, information technology, communication services) exceeds the defensive sectors' " +
  `(consumer staples, health care, utilities, real estate) by more than ${ROTATION_BAND} percentage points, ` +
  "risk-off when it trails them by more than that, neutral otherwise";

/** Adjusted closes by date, oldest first. */
type Closes = { date: string; close: number }[];

/** The close on `date`, or on the last day before it with one. */
function closeOnOrBefore(closes: Closes, date: string): { date: string; close: number } | undefined {
  let found: { date: string; close: number } | undefined;
  for (const bar of closes) {
    if (bar.date > date) break;
    found = bar;
  }
  return found;
}

/** A return in percent from `then` to `now`, to two decimals. */
const returnOf = (now: number, then: number) => Number((((now - then) / then) * 100).toFixed(2));

async function sectorRotation(deps: ForkDeps, call: Call | undefined): Promise<MarketView> {
  const gathered = new Gathered(call);
  const today = dayOf(deps.clock());
  const window = { from: addDays(addMonths(today, -3), -10), to: today };
  const funds = [...SECTOR_FUNDS, { ...BENCHMARK, sector: "", group: "benchmark" as const }];
  const charts = await Promise.allSettled(
    funds.map(async (fund) => {
      const plan = planOf(fund.key);
      if (plan.kind !== "target") throw plan.kind === "refused" ? plan.error : noQuoteFor(fund.key);
      const { bars } = await readDaily(deps, plan.target, window, call);
      return bars.bars.map((bar) => ({ date: bar.date, close: bar.close }));
    }),
  );
  const closesOf = new Map<string, Closes>();
  funds.forEach((fund, index) => {
    const chart = charts[index] as PromiseSettledResult<Closes>;
    if (chart.status === "rejected") {
      if (fund.key === BENCHMARK.key) gathered.gap(fund.key, chart.reason, false);
      else gathered.gap(fund.key, chart.reason);
    } else closesOf.set(fund.key, chart.value);
  });
  const benchmark = closesOf.get(BENCHMARK.key);
  const through =
    benchmark?.at(-1)?.date ?? latest([...closesOf.values()].map((closes) => closes.at(-1)?.date));
  const returnsOf = (closes: Closes | undefined) => {
    const end = through && closes ? closeOnOrBefore(closes, through) : undefined;
    if (!end || end.date !== through) return undefined;
    return Object.fromEntries(
      WINDOWS.map(({ name, start }) => {
        const from = closeOnOrBefore(closes as Closes, start(through));
        return [name, from ? returnOf(end.close, from.close) : null];
      }),
    ) as Record<"1w" | "1m" | "3m", number | null>;
  };
  const market = returnsOf(benchmark);
  const scored: { fund: SectorFund; row: Row; score: number | null }[] = [];
  for (const fund of SECTOR_FUNDS) {
    const closes = closesOf.get(fund.key);
    if (!closes) continue;
    const own = returnsOf(closes);
    if (!own || !through) {
      gathered.gap(
        fund.key,
        `Yahoo's daily bars of ${fund.key} have no close for ${through ?? "the latest session"}`,
      );
      continue;
    }
    const relative = Object.fromEntries(
      WINDOWS.map(({ name }) => {
        const mine = own[name];
        const theirs = market?.[name] ?? null;
        return [name, mine === null || theirs === null ? null : minus(mine, theirs)];
      }),
    ) as Record<"1w" | "1m" | "3m", number | null>;
    const known = Object.values(relative).filter((value): value is number => value !== null);
    const score = known.length
      ? Number((known.reduce((sum, value) => sum + value, 0) / known.length).toFixed(2))
      : null;
    scored.push({
      fund,
      score,
      row: {
        sector: fund.sector,
        fund: fund.name,
        key: fund.key,
        group: fund.group,
        return_1w: own["1w"],
        return_1m: own["1m"],
        return_3m: own["3m"],
        relative_1w: relative["1w"],
        relative_1m: relative["1m"],
        relative_3m: relative["3m"],
        score,
        source: YAHOO,
      },
    });
  }
  if (through) gathered.days.push(through);
  gathered.rows = ranked(
    scored.map((one) => one.row),
    (row) => (typeof row.score === "number" ? row.score : null),
  );
  const rankedFunds = gathered.rows.filter((row) => typeof row.score === "number");
  const average = (group: SectorFund["group"]) => {
    const scores = scored
      .filter((one) => one.fund.group === group && one.score !== null)
      .map((one) => one.score as number);
    return scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
  };
  const cyclical = average("cyclical");
  const defensive = average("defensive");
  const lead = cyclical === null || defensive === null ? null : Number((cyclical - defensive).toFixed(2));
  return viewOf(deps, gathered, {
    requested: SECTOR_FUNDS.length,
    summary: {
      benchmark: BENCHMARK.key,
      through,
      windows: through
        ? Object.fromEntries(WINDOWS.map(({ name, start }) => [name, { from: start(through), to: through }]))
        : null,
      benchmark_returns: market ?? null,
      leading_sectors: rankedFunds.slice(0, 3).map((row) => row.sector),
      lagging_sectors: rankedFunds
        .slice(-3)
        .reverse()
        .map((row) => row.sector),
      cyclical_minus_defensive: lead,
      rotation_signal:
        lead === null
          ? null
          : lead > ROTATION_BAND
            ? "risk-on"
            : lead < -ROTATION_BAND
              ? "risk-off"
              : "neutral",
      method: ROTATION_METHOD,
    },
  });
}
