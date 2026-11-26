// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Yahoo's answers for the Yahoo composite (providers/yahoo.ts): every read goes through the shared
 * yahoo-finance2 client (deps.yahoo, with the library's own User-Agent) inside yahooCall, which maps its
 * failures (sources/yahoo-call.ts), and is turned here into the capabilities' shapes.
 *
 * - `planOf(key)`: the Yahoo symbol a key names (listings.ts reads every form) and how answers describe it:
 *   its canonical key, venue, currency, what it is, the exchanges a security's answer must come from (a bare
 *   ticker Yahoo resolves elsewhere, such as BTC-USD to a crypto pair, is not that listing), and what Yahoo
 *   having no such symbol means: no_data where only Yahoo serves it, unsupported for a Korean listing, so the
 *   router asks the next source. A bare six-character code is resolved by one batched quote of both Korean
 *   spellings (kept a day); a code listed on both markets is invalid, with both as candidates.
 * - quotes, several in one request (`readQuotes`, `quoteOf`); daily bars (`readDaily`): adjusted for splits
 *   and dividends where Yahoo adjusts them (its adjusted close scales the bar), the session under way left
 *   out, a session final once a later one has a bar; intraday bars of 15 minutes and an hour, regular hours
 *   only, within the depth Yahoo keeps (`readIntraday`); splits and dividends from the chart's events
 *   (`readActions`).
 * - quoteSummary's modules (`readSummary`), asked per use (a profile's, the analysts', the calendar's, the
 *   holders'), so one use's module cannot fail another's; yahoo-finance2 4.0.6 validates strictly, and an
 *   answer one field of which its schema refuses (a summaryDetail without `fulldayPrice`) is read anyway,
 *   deliberately: every value is read for what it is, and one that is not a number, a text or a date is
 *   treated as missing. Then `profileOf`, `analystOf`, `calendarOf` and `holdersOf`.
 *
 * What Yahoo is known to keep (its intraday depth, its exchange codes) is as widely reported; it was not seen
 * live from where this was written.
 */
import type { ChartResultArray } from "yahoo-finance2/modules/chart";
import { addDays, dayOf } from "../../../contracts/index.js";
import type {
  Call,
  CorporateActions,
  DailyBar,
  DailyBars,
  FieldStates,
  Instrument,
  Ownership,
  PriceHistory,
  Profiles,
  Quote,
} from "../../../data/capabilities.js";
import { PROFILE_FIELDS } from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import type { FutureRoot, PriceSeries } from "../catalog/instruments.js";
import { FUTURE_ROOTS } from "../catalog/instruments.js";
import type { ForkDeps } from "../deps.js";
import { KOREAN_MARKETS, type KoreanMarket, notPriced, parseListing } from "../listings.js";
import { yahooCall } from "./yahoo-call.js";

/** The source answers name. */
export const SOURCE = "Yahoo";

const DAY_MS = 86_400_000;

// What a key names at Yahoo ----------------------------------------------------------------------

/** What kind of instrument a target is, as the capabilities tell them apart. */
export type TargetKind = "security" | "future" | "fx" | "crypto" | "series";

/** What a key names at Yahoo: its symbol, and how answers about it describe it. */
export type YahooTarget = {
  /** Yahoo's symbol ("005930.KS", "CL=F", "^GSPC"). */
  symbol: string;
  /** The canonical key answers name in `instrument.key` ("XKRX:005930", "future:XNYM:CL"). */
  key: string;
  kind: TargetKind;
  /** Yahoo's codes of the exchanges a security's answer must come from; unchecked when undefined. */
  exchanges?: readonly string[];
  /** The venue answers name, when the key says it (KOSPI, KOSDAQ) rather than Yahoo. */
  venue?: string;
  /** The time zone the listing's sessions are dated in, when known before Yahoo answers. */
  zone?: string;
  /** What Yahoo having no such symbol means: no_data where only Yahoo serves it; unsupported for Korea. */
  notFound: "no_data" | "unsupported";
  /** How a key was read as another (crypto:BTC-USDT as BTC-USD), said in every answer about it. */
  note?: string;
  /** The futures root's catalog entry, the price series', the pair's currencies. */
  future?: FutureRoot;
  series?: PriceSeries;
  pair?: { base: string; quote: string };
};

/** How a key is answered: a target; a bare Korean code whose market is still to be found; or a refusal. */
export type Plan =
  | { kind: "target"; target: YahooTarget; listing: "us" | "venue" | "kr" | "other" }
  | { kind: "korean"; code: string }
  | { kind: "refused"; error: DataError };

/** Yahoo's codes for the exchanges of the US venues, as its answers give them. */
export const US_EXCHANGES: readonly string[] = ["NMS", "NGM", "NCM", "NAS", "NYQ", "PCX", "BTS", "ASE"];

/** Yahoo's codes for each venue's exchanges, by MIC. */
const EXCHANGES: Readonly<Record<string, readonly string[]>> = {
  XNAS: ["NMS", "NGM", "NCM", "NAS"],
  XNYS: ["NYQ"],
  ARCX: ["PCX"],
  BATS: ["BTS"],
  XASE: ["ASE"],
  XHKG: ["HKG"],
  XLON: ["LSE"],
  XTKS: ["JPX"],
  XTSE: ["TOR"],
  XNSE: ["NSI"],
  XBOM: ["BSE"],
  XETR: ["GER"],
  XPAR: ["PAR"],
  XASX: ["ASX"],
};

/** The time zone each venue's sessions are dated in, by MIC. */
const ZONES: Readonly<Record<string, string>> = {
  XNAS: "America/New_York",
  XNYS: "America/New_York",
  ARCX: "America/New_York",
  BATS: "America/New_York",
  XASE: "America/New_York",
  XHKG: "Asia/Hong_Kong",
  XLON: "Europe/London",
  XTKS: "Asia/Tokyo",
  XTSE: "America/Toronto",
  XNSE: "Asia/Kolkata",
  XBOM: "Asia/Kolkata",
  XETR: "Europe/Berlin",
  XPAR: "Europe/Paris",
  XASX: "Australia/Sydney",
  XKRX: "Asia/Seoul",
  XKOS: "Asia/Seoul",
};

function invalid(message: string, more: { candidates?: { symbol: string; name: string }[] } = {}): DataError {
  return new DataError("invalid", message, { source: SOURCE, retry: "change_request", ...more });
}

/** How `input` (any key the tools pass) is answered: see the top of this file. */
export function planOf(input: string): Plan {
  const listing = parseListing(input);
  switch (listing.kind) {
    case "invalid":
      return { kind: "refused", error: invalid(`${listing.input || input}: ${listing.reason}`) };
    case "value_series":
      return { kind: "refused", error: notPriced(listing, SOURCE) as DataError };
    case "us":
      return {
        kind: "target",
        listing: "us",
        target: {
          symbol: listing.yahoo,
          key: listing.key,
          kind: "security",
          exchanges: US_EXCHANGES,
          zone: "America/New_York",
          notFound: "no_data",
        },
      };
    case "venue": {
      if (!listing.yahoo) {
        return {
          kind: "refused",
          error: new DataError("unsupported", `Yahoo has no symbol for ${listing.key}`, { source: SOURCE }),
        };
      }
      return {
        kind: "target",
        listing: "venue",
        target: {
          symbol: listing.yahoo,
          key: listing.key,
          kind: "security",
          exchanges: EXCHANGES[listing.mic] ?? [],
          ...(ZONES[listing.mic] ? { zone: ZONES[listing.mic] as string } : {}),
          notFound: "no_data",
        },
      };
    }
    case "kr":
      if (!listing.market) return { kind: "korean", code: listing.code };
      return { kind: "target", listing: "kr", target: koreanTarget(listing.code, listing.market) };
    case "future": {
      const future = FUTURE_ROOTS[listing.root];
      return {
        kind: "target",
        listing: "other",
        target: {
          symbol: listing.yahoo,
          key: listing.key,
          kind: "future",
          zone: "America/New_York",
          notFound: "no_data",
          ...(future ? { future } : {}),
        },
      };
    }
    case "fx":
      return {
        kind: "target",
        listing: "other",
        target: {
          symbol: listing.yahoo,
          key: listing.key,
          kind: "fx",
          notFound: "no_data",
          pair: { base: listing.base, quote: listing.quote },
        },
      };
    case "crypto":
      return {
        kind: "target",
        listing: "other",
        target: {
          symbol: listing.yahoo,
          key: listing.key,
          kind: "crypto",
          notFound: "no_data",
          pair: { base: listing.base, quote: listing.quote },
          ...(listing.note ? { note: listing.note } : {}),
        },
      };
    case "price_series":
      if (!listing.series || !listing.yahoo) {
        return {
          kind: "refused",
          error: invalid(
            `${listing.key} is not a price series this source knows; find_instrument names them`,
          ),
        };
      }
      return {
        kind: "target",
        listing: "other",
        target: {
          symbol: listing.yahoo,
          key: listing.key,
          kind: "series",
          notFound: "no_data",
          series: listing.series,
        },
      };
  }
}

/** A Korean listing on its market. */
export function koreanTarget(code: string, market: KoreanMarket): YahooTarget {
  return {
    symbol: `${code}${KOREAN_MARKETS[market].yahooSuffix}`,
    key: `${market}:${code}`,
    kind: "security",
    venue: KOREAN_MARKETS[market].venue,
    zone: "Asia/Seoul",
    notFound: "unsupported",
  };
}

/** Both Yahoo spellings of a bare Korean code, KOSPI first. */
export function koreanCandidates(code: string): { market: KoreanMarket; symbol: string }[] {
  return (Object.keys(KOREAN_MARKETS) as KoreanMarket[]).map((market) => ({
    market,
    symbol: `${code}${KOREAN_MARKETS[market].yahooSuffix}`,
  }));
}

/**
 * The market of a bare Korean code, from which of its spellings Yahoo quotes: unsupported when neither (the
 * router may ask another source), invalid when both. `rows` are the quotes of both spellings, by symbol.
 */
export function koreanMarketOf(code: string, rows: ReadonlyMap<string, Raw>): KoreanMarket {
  const found = koreanCandidates(code).filter(({ symbol }) => rows.has(symbol));
  const [only] = found;
  if (found.length === 1 && only) return only.market;
  if (!found.length) {
    throw new DataError("unsupported", `Yahoo quotes no KOSPI or KOSDAQ listing with the code ${code}`, {
      source: SOURCE,
    });
  }
  throw invalid(`${code} names a listing on both KOSPI and KOSDAQ: name the market`, {
    candidates: found.map(({ market, symbol }) => ({
      symbol: `${market}:${code}`,
      name: `${text(rows.get(symbol)?.longName) ?? text(rows.get(symbol)?.shortName) ?? code} (${KOREAN_MARKETS[market].venue})`,
    })),
  });
}

/** The target a plan answers, a bare Korean code's market found by one batched quote (kept a day). */
export async function targetOf(deps: ForkDeps, plan: Plan, call?: Call): Promise<YahooTarget> {
  if (plan.kind === "refused") throw plan.error;
  if (plan.kind === "target") return plan.target;
  const market = await deps.cache.remember(
    `yahoo:korean-market:${plan.code}`,
    DAY_MS,
    async () => {
      const symbols = koreanCandidates(plan.code).map((one) => one.symbol);
      return koreanMarketOf(plan.code, await readQuotes(deps, symbols, call));
    },
    { signal: call?.signal },
  );
  return koreanTarget(plan.code, market);
}

/** Remembers a bare Korean code's market, found another way (a batched quote that asked for it). */
export async function rememberKorean(deps: ForkDeps, code: string, market: KoreanMarket): Promise<void> {
  await deps.cache.remember(`yahoo:korean-market:${code}`, DAY_MS, async () => market);
}

// Reading values ---------------------------------------------------------------------------------

/** One record of an answer, read field by field. */
export type Raw = Record<string, unknown>;

const NOTHING: Raw = Object.freeze({});

/** `value` as a record, or an empty one. */
export function record(value: unknown): Raw {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : NOTHING;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A finite number (Yahoo's `{raw, fmt}` read as its raw value), or null. */
export function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value !== null && typeof value === "object" && "raw" in value) return num((value as Raw).raw);
  return null;
}

/** A non-empty text, trimmed, or null. */
export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** An instant: a date the library made, epoch seconds as Yahoo sends them, or an ISO text; else null. */
export function instant(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000);
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  if (value !== null && typeof value === "object" && "raw" in value) return instant((value as Raw).raw);
  return null;
}

/** A UTC time as answers write it, to the second ("2026-11-25T14:30:00Z"). */
export function isoTime(time: Date): string {
  return time.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** The calendar date of `time` where the listing trades (UTC when its zone is unknown or not one). */
export function dayAt(time: Date, zone: string | null | undefined): string {
  const name = zone || "UTC";
  let format = DAY_FORMATS.get(name);
  if (!format) {
    const options = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
    try {
      format = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: name });
    } catch {
      format = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" });
    }
    DAY_FORMATS.set(name, format);
  }
  return format.format(time);
}

/**
 * The date Yahoo means by a time in a company's data: a date alone is sent as its midnight in UTC (an
 * ex-dividend date, a report date), read as that date; any other time is an instant, dated where the listing
 * trades (an earnings release after the close).
 */
export function dateMeant(time: Date, zone: string | null | undefined): string {
  return time.getTime() % DAY_MS === 0 ? dayOf(time) : dayAt(time, zone);
}

/** Currencies Yahoo quotes in a minor unit, with the major unit and its scale. */
const MINOR: Readonly<Record<string, { currency: string; scale: number }>> = {
  GBp: { currency: "GBP", scale: 0.01 },
  GBX: { currency: "GBP", scale: 0.01 },
  ZAc: { currency: "ZAR", scale: 0.01 },
  ILA: { currency: "ILS", scale: 0.01 },
  // US cents, as Yahoo quotes CBOT's grain futures.
  USX: { currency: "USD", scale: 0.01 },
};

/** A currency as answers name it, and the scale of a price quoted in it (1 for a major unit). */
export function currencyOf(code: string | null): { currency: string | null; scale: number } {
  if (!code) return { currency: null, scale: 1 };
  const minor = MINOR[code];
  return minor ? { currency: minor.currency, scale: minor.scale } : { currency: code, scale: 1 };
}

// Describing an instrument -------------------------------------------------------------------------

/** How a continuous futures series is made: Yahoo's front month, rolls not marked (price_history says so). */
export const CONTINUOUS = { method: "Yahoo's continuous front month", rolls_marked: false } as const;

/** What a Yahoo instrument type is, as answers classify it. */
const TYPES: Readonly<Record<string, string>> = {
  EQUITY: "stock",
  ETF: "etf",
  MUTUALFUND: "fund",
  INDEX: "index",
  FUTURE: "future",
  CURRENCY: "currency_pair",
  CRYPTOCURRENCY: "crypto",
};

/** What Yahoo said about an instrument: its names, exchange, currency and type. */
export type Described = {
  longName?: unknown;
  shortName?: unknown;
  fullExchangeName?: unknown;
  currency?: unknown;
  type?: unknown;
};

/** The instrument a target is, as answers describe it, from what Yahoo said of it. */
export function instrumentOf(target: YahooTarget, said: Described): Instrument {
  const { currency, scale } = currencyOf(text(said.currency));
  const yahooName = text(said.longName) ?? text(said.shortName);
  let name: string;
  let venue: string | null;
  let money = currency;
  switch (target.kind) {
    case "future":
      name = `${target.future?.name ?? target.symbol} futures, continuous front month${text(said.shortName) ? ` (${text(said.shortName)})` : ""}`;
      venue = text(said.fullExchangeName) ?? target.future?.mic ?? null;
      break;
    case "fx":
      name = target.pair ? `${target.pair.base}/${target.pair.quote}` : (yahooName ?? target.symbol);
      venue = null;
      money = currency ?? target.pair?.quote ?? null;
      break;
    case "crypto":
      name = yahooName ?? target.symbol;
      venue = null;
      break;
    case "series":
      name = target.series?.name ?? yahooName ?? target.symbol;
      venue = null;
      money = target.series ? target.series.currency : currency;
      break;
    default:
      name = yahooName ?? target.symbol;
      venue = target.venue ?? text(said.fullExchangeName);
  }
  const type =
    target.kind === "series" ? "index" : (TYPES[text(said.type) ?? ""] ?? defaultType(target.kind));
  return {
    key: target.key,
    name: target.note ? `${name}; ${target.note}` : name,
    venue,
    currency: money,
    price_scale: scale === 1 || target.kind === "series" ? null : scale,
    listing: target.kind === "security" ? { state: "listed", delisted_at: null } : null,
    classification: { instrument_type: type },
    continuous: target.kind === "future" ? CONTINUOUS : null,
  };
}

function defaultType(kind: TargetKind): string | null {
  return { security: null, future: "future", fx: "currency_pair", crypto: "crypto", series: "index" }[kind];
}

/** A security answered from another venue than its key names: not that listing. */
function onItsVenue(target: YahooTarget, code: string | null, name: string | null): void {
  if (target.exchanges && !target.exchanges.includes(code ?? "")) {
    throw new DataError(
      "unsupported",
      `Yahoo's ${target.symbol} is a listing on ${name ?? code ?? "another venue"}, not ${target.key}`,
      { source: SOURCE },
    );
  }
}

function fetchOptions(call: Call | undefined): { fetchOptions: RequestInit } {
  return { fetchOptions: call?.signal ? { signal: call.signal } : {} };
}

// Quotes -----------------------------------------------------------------------------------------

/**
 * Yahoo's quotes of `symbols`, in one request, by symbol (upper case): a symbol Yahoo does not quote is
 * left out, as Yahoo leaves it out of its answer. (A 404 from the quote endpoint is the endpoint failing,
 * not a symbol missing: unavailable.)
 */
export async function readQuotes(
  deps: ForkDeps,
  symbols: readonly string[],
  call: Call | undefined,
): Promise<Map<string, Raw>> {
  const rows = await yahooCall(() => deps.yahoo.quote([...symbols], {}, fetchOptions(call)), {
    signal: call?.signal,
    notFound: "unavailable",
  });
  const found = new Map<string, Raw>();
  for (const row of list(rows)) {
    const symbol = text(record(row).symbol);
    if (symbol) found.set(symbol.toUpperCase(), record(row));
  }
  return found;
}

/**
 * A quote of `target` from Yahoo's row: the last price during the regular session, otherwise the last
 * close; dated by the session (a futures session by its trade date, which starts at 18:00 New York time),
 * except a currency or crypto pair, which trades around the clock without sessions.
 */
export function quoteOf(row: Raw, target: YahooTarget): Quote {
  const time = instant(row.regularMarketTime);
  const zone = text(row.exchangeTimezoneName) ?? target.zone;
  const state = text(row.marketState);
  const sessions = target.kind !== "fx" && target.kind !== "crypto";
  const traded = time && target.kind === "future" ? new Date(time.getTime() + 6 * 3_600_000) : time;
  return {
    instrument: instrumentOf(target, {
      longName: row.longName,
      shortName: row.shortName,
      fullExchangeName: row.fullExchangeName,
      currency: row.currency,
      type: row.quoteType,
    }),
    quote_kind: state === "REGULAR" ? "last" : "last_close",
    price: num(row.regularMarketPrice),
    price_basis: target.kind === "series" ? "as published" : "as traded",
    price_time: time ? isoTime(time) : null,
    stale: null,
    session_date: sessions && traded ? dayAt(traded, zone) : null,
    market_state: state ? state.toLowerCase() : null,
    previous_close: num(row.regularMarketPreviousClose),
    change: num(row.regularMarketChange),
    change_percent: num(row.regularMarketChangePercent),
    change_basis: "previous_close",
    day: {
      open: num(row.regularMarketOpen),
      high: num(row.regularMarketDayHigh),
      low: num(row.regularMarketDayLow),
      volume: num(row.regularMarketVolume),
    },
    range_52w: { low: num(row.fiftyTwoWeekLow), high: num(row.fiftyTwoWeekHigh) },
    market_cap: num(row.marketCap),
    field_states: null,
  };
}

/** The failure for a target Yahoo quotes nothing for. */
export function noQuote(target: YahooTarget): DataError {
  return new DataError(target.notFound, `Yahoo has no quote for ${target.key} (${target.symbol})`, {
    source: SOURCE,
  });
}

// Charts: daily and intraday bars, events ----------------------------------------------------------

type Chart = ChartResultArray;

/** Yahoo's chart of `target`, checked to be of the listing its key names. */
async function readChart(
  deps: ForkDeps,
  target: YahooTarget,
  options: {
    period1: string | number;
    period2: string | number;
    interval: "1d" | "15m" | "1h";
    includePrePost?: boolean;
    events?: string;
  },
  call: Call | undefined,
): Promise<Chart> {
  const chart = await yahooCall(
    () => deps.yahoo.chart(target.symbol, { ...options, return: "array" }, fetchOptions(call)),
    {
      signal: call?.signal,
      notFound: target.notFound,
      notFoundMessage: `Yahoo has no chart for ${target.key} (${target.symbol})`,
      // A range past what Yahoo keeps at an interval.
      statuses: { 422: "unsupported" },
    },
  );
  onItsVenue(target, chart.meta.exchangeName ?? null, chart.meta.fullExchangeName ?? null);
  return chart;
}

function describedBy(meta: Chart["meta"]): Described {
  return {
    longName: meta.longName,
    shortName: meta.shortName,
    fullExchangeName: meta.fullExchangeName,
    currency: meta.currency,
    type: meta.instrumentType,
  };
}

/** A session a reading left out, and why. */
export type LeftOut = { date: string; reason: string };

/** Daily bars as answered, and the sessions in the window left out for want of a price. */
export type Daily = { bars: DailyBars; left: LeftOut[] };

/** How each kind of instrument's daily bars are adjusted, as answers state it. */
function basisOf(kind: TargetKind): string {
  if (kind === "security") return "split_dividend_adjusted";
  if (kind === "series") return "as published";
  return "as traded";
}

/**
 * The completed sessions of `chart`, one per date (the latest row of a date kept), each with its date where
 * the listing trades; the session under way is left out until its regular hours have ended.
 */
function sessionsOf(chart: Chart, zone: string | undefined, now: Date) {
  const end = chart.meta.currentTradingPeriod?.regular?.end;
  const today = dayAt(now, zone);
  const byDate = new Map<string, Chart["quotes"][number]>();
  for (const row of chart.quotes) {
    const date = dayAt(row.date, zone);
    if (date === today && !(end instanceof Date && now >= end)) continue;
    byDate.set(date, row);
  }
  return [...byDate.entries()].map(([date, row]) => ({ date, row }));
}

/** The daily bars of `chart` from `from` to `to`: see the top of this file. */
export function dailyOf(
  chart: Chart,
  target: YahooTarget,
  { from, to }: { from: string; to: string },
  now: Date,
): Daily {
  const zone = chart.meta.exchangeTimezoneName || target.zone;
  const all = sessionsOf(chart, zone, now);
  const latest = all.at(-1)?.date;
  const adjusted = target.kind === "security";
  const bars: DailyBar[] = [];
  const left: LeftOut[] = [];
  for (const { date, row } of all) {
    if (date < from || date > to) continue;
    const close = row.close;
    if (typeof close !== "number" || !Number.isFinite(close) || close === 0) {
      left.push({ date, reason: "the source gives no close" });
      continue;
    }
    let factor = 1;
    if (adjusted) {
      const adjclose = row.adjclose;
      if (typeof adjclose !== "number" || !Number.isFinite(adjclose)) {
        left.push({ date, reason: "the source gives no adjusted close" });
        continue;
      }
      factor = adjclose / close;
    }
    const scaled = (value: number | null | undefined) =>
      typeof value === "number" && Number.isFinite(value) ? value * factor : null;
    bars.push({
      date,
      open: scaled(row.open),
      high: scaled(row.high),
      low: scaled(row.low),
      close: close * factor,
      volume: typeof row.volume === "number" && Number.isFinite(row.volume) ? row.volume : null,
      // Yahoo does not say when a bar is final: one with a later session after it is taken as final.
      revision: latest !== undefined && date < latest ? "final" : "provisional",
      field_states: null,
    });
  }
  const first = chart.meta.firstTradeDate ? dayAt(chart.meta.firstTradeDate, zone) : null;
  const late = first !== null && first > from;
  return {
    bars: {
      instrument: instrumentOf(target, describedBy(chart.meta)),
      price_basis: basisOf(target.kind),
      bars,
      coverage: {
        from: bars[0]?.date ?? null,
        through: bars.at(-1)?.date ?? null,
        // Yahoo does not say whether every session is there, unless the listing's history starts later.
        complete: late ? false : null,
        complete_reason: late ? "insufficient_history" : null,
        history_from: first,
        missing_sessions: left.length,
      },
      earlier_end: first !== null && first < from ? addDays(from, -1) : null,
    },
    left,
  };
}

/** Daily bars of `target` from `from` to `to`, with a week past `to` read to tell whether `to` is final. */
export async function readDaily(
  deps: ForkDeps,
  target: YahooTarget,
  window: { from: string; to: string },
  call: Call | undefined,
): Promise<Daily> {
  const chart = await readChart(
    deps,
    target,
    // From the day before, so a session dated `from` where it trades is not cut by UTC midnight.
    { period1: addDays(window.from, -1), period2: addDays(window.to, 8), interval: "1d" },
    call,
  );
  return dailyOf(chart, target, window, deps.clock());
}

/** How far back Yahoo keeps intraday bars, in days: about 60 for 15 minutes, 730 for an hour. */
export const INTRADAY_DAYS = { "15m": 60, "1h": 730 } as const;

type IntradayQuery = Parameters<PriceHistory["intraday"]>[1];
type IntradayBars = Awaited<ReturnType<PriceHistory["intraday"]>>["data"];

/** The first date Yahoo keeps `interval` bars for, a day inside its depth, as of `now`. */
export function intradayFrom(interval: "15m" | "1h", now: Date): string {
  return addDays(dayOf(now), -(INTRADAY_DAYS[interval] - 1));
}

/**
 * A security's intraday bars from `query.start` (a date) to `query.end` (a date, or a UTC time when paging
 * back), the newest `query.limit` of them, oldest first, regular hours only; `earlier_end` pages back (a
 * second before the oldest bar) while Yahoo has bars before them.
 */
export async function readIntraday(
  deps: ForkDeps,
  target: YahooTarget,
  query: IntradayQuery,
  call: Call | undefined,
): Promise<IntradayBars> {
  if (target.kind !== "security") {
    throw new DataError("unsupported", `intraday bars are served for listed securities, not ${target.key}`, {
      source: SOURCE,
    });
  }
  const now = deps.clock();
  const kept = intradayFrom(query.interval, now);
  const timed = query.end !== undefined && query.end.length > 10;
  const endMs =
    query.end === undefined ? undefined : Date.parse(timed ? query.end : `${query.end}T00:00:00Z`);
  if (endMs !== undefined && !Number.isFinite(endMs)) {
    throw invalid(`${query.end} is not a date or a UTC time`);
  }
  const before = addDays(query.start, -1);
  const period1 = Date.parse(`${[before, kept].sort()[1]}T00:00:00Z`);
  const period2 = endMs === undefined ? now.getTime() + 60_000 : timed ? endMs + 1_000 : endMs + DAY_MS;
  if (period2 <= period1) {
    throw new DataError(
      "unsupported",
      `Yahoo keeps ${query.interval} bars for about the last ${INTRADAY_DAYS[query.interval]} days (from ${kept}), not before`,
      { source: SOURCE },
    );
  }
  const chart = await readChart(
    deps,
    target,
    {
      period1: Math.floor(period1 / 1000),
      period2: Math.floor(period2 / 1000),
      interval: query.interval,
      includePrePost: false,
    },
    call,
  );
  const zone = chart.meta.exchangeTimezoneName || target.zone;
  const today = dayAt(now, zone);
  const end = chart.meta.currentTradingPeriod?.regular?.end;
  const running = !(end instanceof Date && now >= end);
  const first = chart.meta.firstTradeDate ? dayAt(chart.meta.firstTradeDate, zone) : null;
  const historyFrom = first !== null && first > kept ? first : kept;
  const short = new Set<string>();
  const all = chart.quotes.flatMap((row) => {
    const date = dayAt(row.date, zone);
    if (date < query.start) return [];
    if (query.end !== undefined && (timed ? row.date.getTime() > (endMs as number) : date > query.end))
      return [];
    if (typeof row.close !== "number" || !Number.isFinite(row.close)) {
      short.add(date);
      return [];
    }
    const value = (field: number | null) =>
      typeof field === "number" && Number.isFinite(field) ? field : null;
    return [
      {
        start: isoTime(row.date),
        date,
        open: value(row.open),
        high: value(row.high),
        low: value(row.low),
        close: row.close,
        volume: value(row.volume),
        // A bar of the session under way may still change; a finished session's bars do not.
        revision: date === today && running ? ("provisional" as const) : ("final" as const),
        field_states: null,
      },
    ];
  });
  const bars = all.slice(Math.max(0, all.length - query.limit));
  // Older bars: those this page leaves out, or Yahoo's before the window's start; the next page ends a
  // second before the oldest bar shown (or before the window, when it showed none).
  const oldest = bars[0]?.start ?? `${query.start}T00:00:00Z`;
  const more = all.length > bars.length || query.start > historyFrom;
  return {
    instrument: instrumentOf(target, describedBy(chart.meta)),
    price_basis: "split_adjusted",
    bars,
    missing_sessions: short.size,
    incomplete_because: null,
    history_from: historyFrom,
    earlier_end: more ? isoTime(new Date(Date.parse(oldest) - 1_000)) : null,
  };
}

type ActionList = Awaited<ReturnType<CorporateActions["list"]>>["data"];

/**
 * A security's splits and dividends as Yahoo reports them on its chart, its whole history read: a split's
 * value is the shares after for each one before, a dividend's the amount per share in the listing's currency
 * (its major unit), split adjusted as Yahoo states it; `through` is the newest completed session.
 */
export async function readActions(
  deps: ForkDeps,
  target: YahooTarget,
  call: Call | undefined,
): Promise<ActionList> {
  if (target.kind !== "security") {
    throw new DataError(
      "unsupported",
      `splits and dividends are served for listed securities, not ${target.key}`,
      {
        source: SOURCE,
      },
    );
  }
  const now = deps.clock();
  const chart = await readChart(
    deps,
    target,
    {
      // Yahoo answers a listing's whole daily history from a start before it.
      period1: `${now.getUTCFullYear() - 99}-01-01`,
      period2: addDays(dayOf(now), 1),
      interval: "1d",
      events: "div|split",
    },
    call,
  );
  const zone = chart.meta.exchangeTimezoneName || target.zone;
  const { currency, scale } = currencyOf(text(chart.meta.currency));
  const dividends = (chart.events?.dividends ?? []).flatMap((event) => {
    const amount = num(event.amount);
    const date = instant(event.date);
    if (!date) return [];
    return [
      {
        ex_date: dayAt(date, zone),
        action_type: "dividend",
        value: amount === null ? null : amount * scale,
        unit: currency,
        cash_basis: "split_adjusted",
        revised: false,
        field_states: null,
      },
    ];
  });
  const splits = (chart.events?.splits ?? []).flatMap((event) => {
    const date = instant(event.date);
    const numerator = num(event.numerator);
    const denominator = num(event.denominator);
    if (!date) return [];
    return [
      {
        ex_date: dayAt(date, zone),
        action_type: "split",
        value: numerator !== null && denominator ? numerator / denominator : null,
        unit: "ratio",
        cash_basis: null,
        revised: false,
        field_states: null,
      },
    ];
  });
  return {
    instrument: instrumentOf(target, describedBy(chart.meta)),
    actions: [...splits, ...dividends].sort((a, b) => a.ex_date.localeCompare(b.ex_date)),
    through: sessionsOf(chart, zone, now).at(-1)?.date ?? null,
    // Yahoo does not say whether an update of its record is overdue.
    stale: null,
  };
}

// quoteSummary: profiles, analysts, the calendar, holders ---------------------------------------------

/** The modules each use reads, `price` among them for the instrument and its venue. */
export const MODULES = {
  profile: ["price", "assetProfile", "summaryDetail", "defaultKeyStatistics", "financialData"],
  analyst: ["price", "financialData", "recommendationTrend", "earningsTrend"],
  calendar: ["price", "calendarEvents", "defaultKeyStatistics", "summaryDetail"],
  holders: ["price", "institutionOwnership", "majorHoldersBreakdown"],
} as const;

/** One use's modules of quoteSummary, by name, for a listed security. */
export type Summary = Raw;

/** Whether `error` is yahoo-finance2 refusing an answer its schema does not fit, the answer in it. */
function refusedAnswer(error: unknown): error is { result: unknown } {
  const failed = error as { name?: unknown; result?: unknown } | null;
  return failed?.name === "FailedYahooValidationError" && record(failed.result) !== NOTHING;
}

/**
 * Yahoo's quoteSummary modules of `target` for one use, read deliberately when the library's schema refuses
 * a field of them (see the top of this file), and checked to be of the listing its key names.
 */
export async function readSummary(
  deps: ForkDeps,
  target: YahooTarget,
  modules: readonly (typeof MODULES)[keyof typeof MODULES][number][],
  call: Call | undefined,
): Promise<Summary> {
  if (target.kind !== "security") {
    throw new DataError("unsupported", `company data is served for listed securities, not ${target.key}`, {
      source: SOURCE,
    });
  }
  const answer = await yahooCall(
    async (): Promise<unknown> => {
      try {
        return await deps.yahoo.quoteSummary(target.symbol, { modules: [...modules] }, fetchOptions(call));
      } catch (error) {
        if (refusedAnswer(error)) return error.result;
        throw error;
      }
    },
    {
      signal: call?.signal,
      notFound: target.notFound,
      notFoundMessage: `Yahoo has no company data for ${target.key} (${target.symbol})`,
    },
  );
  const summary = record(answer);
  if (summary === NOTHING || !modules.some((name) => record(summary[name]) !== NOTHING)) {
    throw new DataError(target.notFound, `Yahoo has no company data for ${target.key} (${target.symbol})`, {
      source: SOURCE,
    });
  }
  const price = record(summary.price);
  if (price !== NOTHING) onItsVenue(target, text(price.exchange), text(price.exchangeName));
  return summary;
}

/** The instrument a summary describes. */
function summaryInstrument(summary: Summary, target: YahooTarget): Instrument {
  const price = record(summary.price);
  return instrumentOf(target, {
    longName: price.longName,
    shortName: price.shortName,
    fullExchangeName: price.exchangeName,
    currency: price.currency ?? record(summary.summaryDetail).currency,
    type: price.quoteType,
  });
}

type ProfileAnswer = Awaited<ReturnType<Profiles["profile"]>>["data"];
type ProfileField = (typeof PROFILE_FIELDS)[number];

/** Fields that describe a fund, not a company. */
const FUND_FIELDS: ReadonlySet<ProfileField> = new Set([
  "fund_yield",
  "nav_price",
  "five_year_avg_return",
  "beta_3y",
]);
/** Fields that describe a company, not a fund. */
const COMPANY_FIELDS: ReadonlySet<ProfileField> = new Set([
  "sector",
  "industry_group",
  "industry",
  "sub_industry",
  "financial_currency",
  "market_cap_basis",
  "enterprise_value",
  "pe_ratio",
  "forward_pe",
  "peg_ratio",
  "price_to_book",
  "price_to_sales",
  "profit_margin",
  "operating_margin",
  "return_on_assets",
  "return_on_equity",
  "revenue_growth",
  "earnings_growth",
  "total_cash",
  "total_debt",
  "debt_to_equity",
  "current_ratio",
  "quick_ratio",
  "payout_ratio",
  "shares_outstanding",
  "float_shares",
  "employees",
  "shares_short",
  "days_to_cover",
  "short_interest_of_float",
  "institutional_ownership",
  "insider_ownership",
]);

/** How far apart the shares behind Yahoo's market cap and the listing's own may be and still be one count. */
const SHARE_CLASS_GAP = 0.05;

/**
 * The dividend yield as a fraction: Yahoo has sent it as a percent in some answers, so where the dividend
 * rate and price are given the unit closer to their ratio is taken; otherwise a yield above 1 is a percent.
 */
function dividendYield(stated: number | null, rate: number | null, price: number | null): number | null {
  if (stated === null) return null;
  if (rate !== null && price) {
    const ratio = rate / price;
    return Math.abs(stated - ratio) <= Math.abs(stated / 100 - ratio) ? stated : stated / 100;
  }
  return stated > 1 ? stated / 100 : stated;
}

/**
 * A company's (or fund's) profile from its summary: every profile field present, null where Yahoo gives no
 * value (with the reason when the field applies to it); fractions stay fractions; debt to equity, a percent
 * at Yahoo, is a ratio here; Yahoo classifies by its own sectors and industries, not GICS, so the GICS
 * industry group and sub-industry are not given.
 */
export function profileOf(summary: Summary, target: YahooTarget): ProfileAnswer {
  const asset = record(summary.assetProfile);
  const detail = record(summary.summaryDetail);
  const stats = record(summary.defaultKeyStatistics);
  const financial = record(summary.financialData);
  const price = record(summary.price);
  const quoteType = text(price.quoteType);
  const fund = quoteType === "ETF" || quoteType === "MUTUALFUND";
  const lastPrice = num(price.regularMarketPrice) ?? num(financial.currentPrice);
  const priced = instant(price.regularMarketTime);
  const outstanding = num(stats.sharesOutstanding);
  const implied = num(stats.impliedSharesOutstanding);
  const debtToEquity = num(financial.debtToEquity);
  const facts: Record<ProfileField, string | number | null> = {
    sector: text(asset.sector),
    industry_group: null,
    industry: text(asset.industry),
    sub_industry: null,
    country: text(asset.country),
    financial_currency: text(financial.financialCurrency),
    market_cap: num(price.marketCap) ?? num(detail.marketCap),
    market_cap_basis:
      outstanding && implied
        ? Math.abs(implied - outstanding) / outstanding > SHARE_CLASS_GAP
          ? "stated"
          : "price_times_shares"
        : null,
    market_cap_price_date: priced ? dayAt(priced, target.zone) : null,
    enterprise_value: num(stats.enterpriseValue),
    pe_ratio: num(detail.trailingPE),
    forward_pe: num(detail.forwardPE) ?? num(stats.forwardPE),
    peg_ratio: num(stats.pegRatio),
    price_to_book: num(stats.priceToBook),
    price_to_sales: num(detail.priceToSalesTrailing12Months),
    profit_margin: num(financial.profitMargins) ?? num(stats.profitMargins),
    operating_margin: num(financial.operatingMargins),
    return_on_assets: num(financial.returnOnAssets),
    return_on_equity: num(financial.returnOnEquity),
    revenue_growth: num(financial.revenueGrowth),
    earnings_growth: num(financial.earningsGrowth),
    total_cash: num(financial.totalCash),
    total_debt: num(financial.totalDebt),
    debt_to_equity: debtToEquity === null ? null : debtToEquity / 100,
    current_ratio: num(financial.currentRatio),
    quick_ratio: num(financial.quickRatio),
    dividend_rate: num(detail.dividendRate),
    dividend_yield: dividendYield(num(detail.dividendYield), num(detail.dividendRate), lastPrice),
    payout_ratio: num(detail.payoutRatio),
    beta: num(detail.beta) ?? num(stats.beta),
    shares_outstanding: outstanding,
    float_shares: num(stats.floatShares),
    employees: num(asset.fullTimeEmployees),
    website: text(asset.website),
    description: text(asset.longBusinessSummary),
    shares_short: num(stats.sharesShort),
    days_to_cover: num(stats.shortRatio),
    short_interest_of_float: num(stats.shortPercentOfFloat),
    institutional_ownership: num(stats.heldPercentInstitutions),
    insider_ownership: num(stats.heldPercentInsiders),
    fund_yield: num(detail.yield),
    nav_price: num(detail.navPrice),
    five_year_avg_return: num(stats.fiveYearAverageReturn),
    beta_3y: num(stats.beta3Year),
  };
  const states: NonNullable<FieldStates> = {};
  for (const field of PROFILE_FIELDS) {
    if (facts[field] !== null) continue;
    // A field of the other kind of issuer does not apply: null without a reason.
    if (fund ? COMPANY_FIELDS.has(field) : FUND_FIELDS.has(field)) continue;
    states[field] =
      field === "industry_group" || field === "sub_industry"
        ? { reason: "Yahoo classifies by its own sectors and industries, not by GICS", retry: "never" }
        : field === "market_cap_basis"
          ? { reason: "Yahoo does not give the shares behind its market cap", retry: "later" }
          : { reason: "not given by Yahoo", retry: "later" };
  }
  return {
    instrument: summaryInstrument(summary, target),
    ...facts,
    field_states: Object.keys(states).length ? states : null,
    // Yahoo restates these figures in place and does not say when.
    dataset_status: { refreshed_at: null },
  };
}

/** What Yahoo's estimate periods are, in words. */
const PERIODS: Readonly<Record<string, string>> = {
  "0q": "current_quarter",
  "+1q": "next_quarter",
  "0y": "current_fiscal_year",
  "+1y": "next_fiscal_year",
};

/**
 * Analysts' consensus from the summary: the rating (Yahoo's key, such as "buy"), its mean (1 strong buy to 5
 * sell) and how many analysts; the price targets in the listing's currency (its major unit); the ratings'
 * distribution this month and the three before; and the EPS and revenue estimates of the current and next
 * quarter and fiscal year, the EPS ones with their trend over 90 days and recent revisions. Yahoo does not
 * say when it refreshed them. No rating, target or estimate at all is the source having none.
 */
export function analystOf(summary: Summary, target: YahooTarget): Record<string, unknown> {
  const financial = record(summary.financialData);
  const price = record(summary.price);
  const { currency, scale } = currencyOf(text(price.currency));
  const scaled = (value: unknown) => {
    const read = num(value);
    return read === null ? null : read * scale;
  };
  const key = text(financial.recommendationKey);
  const ratings = list(record(summary.recommendationTrend).trend).flatMap((row) => {
    const one = record(row);
    const months = /^(-?\d+)m$/.exec(text(one.period) ?? "");
    if (!months) return [];
    return [
      {
        months_ago: Math.abs(Number(months[1])),
        strong_buy: num(one.strongBuy),
        buy: num(one.buy),
        hold: num(one.hold),
        sell: num(one.sell),
        strong_sell: num(one.strongSell),
      },
    ];
  });
  const periods = list(record(summary.earningsTrend).trend)
    .map(record)
    .filter((row) => PERIODS[text(row.period) ?? ""]);
  const ended = (row: Raw) => {
    const end = instant(row.endDate);
    return end ? dayOf(end) : null;
  };
  const eps = periods.flatMap((row) => {
    const estimate = record(row.earningsEstimate);
    const trend = record(row.epsTrend);
    const revisions = record(row.epsRevisions);
    if (num(estimate.avg) === null) return [];
    return [
      {
        period: PERIODS[text(row.period) as string],
        period_end: ended(row),
        average: num(estimate.avg),
        low: num(estimate.low),
        high: num(estimate.high),
        analysts: num(estimate.numberOfAnalysts),
        year_ago: num(estimate.yearAgoEps),
        growth: num(estimate.growth),
        currency: text(estimate.earningsCurrency),
        trend: {
          "7_days_ago": num(trend["7daysAgo"]),
          "30_days_ago": num(trend["30daysAgo"]),
          "60_days_ago": num(trend["60daysAgo"]),
          "90_days_ago": num(trend["90daysAgo"]),
        },
        revisions: {
          up_7_days: num(revisions.upLast7days),
          up_30_days: num(revisions.upLast30days),
          down_7_days: num(revisions.downLast7Days),
          down_30_days: num(revisions.downLast30days),
        },
      },
    ];
  });
  const revenue = periods.flatMap((row) => {
    const estimate = record(row.revenueEstimate);
    if (num(estimate.avg) === null) return [];
    return [
      {
        period: PERIODS[text(row.period) as string],
        period_end: ended(row),
        average: num(estimate.avg),
        low: num(estimate.low),
        high: num(estimate.high),
        analysts: num(estimate.numberOfAnalysts),
        year_ago: num(estimate.yearAgoRevenue),
        growth: num(estimate.growth),
        currency: text(estimate.revenueCurrency),
      },
    ];
  });
  const answer = {
    recommendation: key && key !== "none" ? key : null,
    recommendation_mean: num(financial.recommendationMean),
    analysts: num(financial.numberOfAnalystOpinions),
    target_mean_price: scaled(financial.targetMeanPrice),
    target_median_price: scaled(financial.targetMedianPrice),
    target_low_price: scaled(financial.targetLowPrice),
    target_high_price: scaled(financial.targetHighPrice),
    target_currency: currency,
    ratings,
    eps_estimates: eps,
    revenue_estimates: revenue,
    refreshed_at: null,
  };
  const covered =
    answer.recommendation !== null ||
    answer.target_mean_price !== null ||
    ratings.some((row) => [row.strong_buy, row.buy, row.hold, row.sell, row.strong_sell].some(Boolean)) ||
    eps.length > 0 ||
    revenue.length > 0;
  if (!covered) {
    throw new DataError(target.notFound, `Yahoo has no analysts' estimates for ${target.key}`, {
      source: SOURCE,
    });
  }
  return answer;
}

/**
 * The calendar from the summary: the next stated earnings date (or, once it has passed, the latest), with
 * its EPS and revenue estimates and whether the date is Yahoo's estimate, or that no date is announced yet;
 * and the latest dividend (its ex-date, payment date and amount per share), with the next ex-date when one
 * is announced, or null when Yahoo states none.
 */
export function calendarOf(summary: Summary, target: YahooTarget, now: Date): Record<string, unknown> {
  const events = record(summary.calendarEvents);
  const earned = record(events.earnings);
  const stats = record(summary.defaultKeyStatistics);
  const detail = record(summary.summaryDetail);
  const { currency, scale } = currencyOf(text(record(summary.price).currency) ?? text(detail.currency));
  const zone = target.zone;
  const today = dayAt(now, zone);
  const dates = list(earned.earningsDate)
    .map(instant)
    .filter((date): date is Date => date !== null)
    .map((date) => dateMeant(date, zone))
    .sort();
  const [first] = dates;
  const last = dates.at(-1);
  const earnings = first
    ? {
        earnings_date: first,
        ...(last && last !== first ? { earnings_date_end: last } : {}),
        status: (last ?? first) < today ? "past" : "upcoming",
        is_estimate:
          typeof earned.isEarningsDateEstimate === "boolean" ? earned.isEarningsDateEstimate : null,
        eps_estimate: num(earned.earningsAverage),
        eps_low: num(earned.earningsLow),
        eps_high: num(earned.earningsHigh),
        revenue_estimate: num(earned.revenueAverage),
        revenue_low: num(earned.revenueLow),
        revenue_high: num(earned.revenueHigh),
      }
    : "no next date announced yet";
  const day = (value: unknown) => {
    const date = instant(value);
    return date ? dateMeant(date, zone) : null;
  };
  const exDate = day(events.exDividendDate) ?? day(detail.exDividendDate);
  const payDate = day(events.dividendDate);
  const lastValue = num(stats.lastDividendValue);
  const lastDate = day(stats.lastDividendDate);
  const rate = num(detail.dividendRate);
  let dividend: Record<string, unknown> | null = null;
  if (lastValue !== null) {
    const same = !exDate || exDate === lastDate;
    dividend = {
      ex_date: lastDate ?? exDate,
      pay_date: same ? payDate : null,
      amount: lastValue * scale,
      currency,
      annual_rate: rate === null ? null : rate * scale,
      ...(exDate && lastDate && exDate > lastDate ? { next_ex_date: exDate, next_pay_date: payDate } : {}),
    };
  } else if (exDate) {
    dividend = {
      ex_date: exDate,
      pay_date: payDate,
      amount: null,
      currency,
      annual_rate: rate === null ? null : rate * scale,
    };
  }
  return { earnings, dividend, refreshed_at: null };
}

type HoldersAnswer = Awaited<ReturnType<Ownership["holders"]>>["data"];
type HoldersQuery = Parameters<Ownership["holders"]>[1];

/** A fraction as a percent, to one decimal. */
const percent = (fraction: number) => `${Number((fraction * 100).toFixed(1))}%`;

/**
 * The top institutional holders Yahoo lists (at most ten), largest first: Yahoo's aggregation of managers'
 * 13F reports, not the filings, so there is no accession number or filing date, the list is never complete,
 * and `quarter` is Yahoo's report date. Paged by `after` (the count already shown) within those rows.
 */
export function holdersOf(summary: Summary, target: YahooTarget, query: HoldersQuery): HoldersAnswer {
  const price = record(summary.price);
  const { currency, scale } = currencyOf(text(price.currency));
  const rows = list(record(summary.institutionOwnership).ownershipList)
    .map(record)
    .filter((row) => text(row.organization) !== null)
    .map((row) => ({
      manager: text(row.organization) as string,
      reported: instant(row.reportDate),
      shares: num(row.position),
      value: num(row.value),
    }))
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  if (!rows.length) {
    throw new DataError(target.notFound, `Yahoo lists no institutional holders of ${target.key}`, {
      source: SOURCE,
    });
  }
  const reported = [
    ...new Set(rows.flatMap((row) => (row.reported ? [dateMeant(row.reported, target.zone)] : []))),
  ].sort();
  const quarter = reported.at(-1) ?? null;
  if (query.quarter && query.quarter !== quarter) {
    throw new DataError(
      "unsupported",
      `Yahoo lists institutional holders as of its latest report date only (${quarter ?? "not stated"}), not ${query.quarter}`,
      { source: SOURCE },
    );
  }
  const offset = query.after === undefined ? 0 : Number(query.after);
  if (!Number.isInteger(offset) || offset < 0 || offset >= rows.length) {
    throw invalid(`${query.after} is not a cursor of this list: ask again without after`);
  }
  const page = rows.slice(offset, offset + query.limit);
  const breakdown = record(summary.majorHoldersBreakdown);
  const institutions = num(breakdown.institutionsPercentHeld);
  const insiders = num(breakdown.insidersPercentHeld);
  const count = num(breakdown.institutionsCount);
  const caveats = [
    "Yahoo's list of the largest institutional holders, at most ten, as Yahoo aggregates them from managers' 13F reports: not the 13F filings themselves, so no accession numbers or filing dates, and more holders report than these",
    ...(reported.length > 1 ? [`the holders' report dates differ: ${reported.join(", ")}`] : []),
    ...(institutions !== null || insiders !== null
      ? [
          `Yahoo also states that institutions hold ${institutions === null ? "an unstated share" : percent(institutions)} of the shares${count === null ? "" : ` (${count} institutions)`} and insiders ${insiders === null ? "an unstated share" : percent(insiders)}`,
        ]
      : []),
  ];
  return {
    instrument: summaryInstrument(summary, target),
    quarter,
    complete: false,
    quarters: quarter ? [quarter] : [],
    caveats,
    holders: page.map((row) => ({
      manager: row.manager,
      filed: null,
      form: null,
      value: row.value === null ? null : row.value * scale,
      value_unit: currency === "USD" ? "dollars" : currency,
      shares: row.shares,
      shares_type: "SH",
      put_call: null,
      discretion: null,
      accession: "",
    })),
    next_cursor: offset + page.length < rows.length ? String(offset + page.length) : null,
  };
}
