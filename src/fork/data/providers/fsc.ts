// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "FSC", routes.ts key `fsc`: KRX's official end-of-day prices as the Financial Services Commission publishes
 * them on data.go.kr (sources/fsc.ts), asked after Yahoo for quotes and daily price history. With
 * DATA_GO_KR_API_KEY it declares quotes.quote, quotes.many and priceHistory.daily; without it, nothing.
 *
 * - Korean listings only, in every form listings.ts reads (XKRX:005930, XKOS:035900, 005930.KS, 035900.KQ, a
 *   bare six-character code, whose market the FSC's rows say). Any other key is unsupported, so the router
 *   moves on; so is a code the FSC's stock prices hold no row of at all (a fund such as KODEX 200, which
 *   getStockPriceInfo does not list: its shares are KOSPI's, KOSDAQ's and KONEX's), the router then saying
 *   every source's reason; a share the FSC holds without a session in the window asked is no_data; a listing
 *   the FSC places on the other market is invalid, naming the one it is on; a KONEX listing (no XKRX:/XKOS:
 *   key names one) is unsupported.
 * - quotes: the last official close (quote_kind last_close, price_basis as traded), its session (basDt), the
 *   previous close and the change from vs and fltRt (against the exchange's base price: the previous close,
 *   adjusted on a corporate action's day, which field_states then says), the session's open, high, low and
 *   volume (none of the prices on a session the share did not trade), and the market capitalization
 *   (mrktTotAmt). The latest row of the last 31 days in Seoul; a share without one there is answered from its
 *   last row, said in field_states. The FSC gives no 52-week range.
 * - priceHistory.daily: one bar a session from `from` to `to`, unadjusted, as KRX closed them (price_basis says
 *   so), final once published; `earlier_end` when the FSC holds earlier sessions of the share, and, when it
 *   holds none and the first falls after `from`, the history marked incomplete from where it starts.
 */
import { addDays } from "../../../contracts/index.js";
import type {
  Call,
  DailyBar,
  DailyBars,
  DataProvider,
  FieldStates,
  Instrument,
  Quote,
  QuoteBatch,
} from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import type { ForkDeps } from "../deps.js";
import { KOREAN_MARKETS, type KoreanMarket, parseListing } from "../listings.js";
import { FSC_SOURCE, type FscRow, fscSource, seoulDay } from "../sources/fsc.js";

/** How a daily bar's prices are stated. */
export const FSC_DAILY_BASIS = "unadjusted: KRX's official end-of-day prices as traded";

/** Days back from today in Seoul the latest close is looked for (the FSC publishes the next business day). */
export const QUOTE_DAYS = 31;

/** A key the FSC answers: a Korean listing's code, and its market when the key says it. */
type Target = { key: string; code: string; market: KoreanMarket | null };

export function fscProvider(deps: ForkDeps): DataProvider {
  if (!deps.config.dataGoKrKey) return { name: FSC_SOURCE, capabilities: {} };
  const source = fscSource(deps);

  const quote = async (key: string, call?: Call): Promise<Quote> => {
    const target = targetOf(key);
    const today = seoulDay(deps.clock());
    let rows = await source.rows(target.code, { from: addDays(today, -QUOTE_DAYS) }, call);
    const recent = rows.length > 0;
    if (!recent) rows = await source.rows(target.code, {}, call);
    const latest = rows.at(-1);
    if (!latest) throw notHeld(target);
    return quoteOf(marketOf(target, latest), latest, rows.at(-2), recent);
  };

  const many = async (keys: readonly string[], call?: Call): Promise<QuoteBatch> => {
    const answers = await Promise.allSettled(keys.map((key) => quote(key, call)));
    const failures = answers.flatMap((one) => (one.status === "rejected" ? [one.reason as unknown] : []));
    // Nothing answered, for one reason (the key refused, the quota spent): the call's failure, as for one quote.
    const [first] = failures;
    if (
      failures.length === answers.length &&
      first instanceof DataError &&
      failures.every(
        (one) => one instanceof DataError && one.kind === first.kind && one.message === first.message,
      )
    ) {
      throw first;
    }
    return {
      quotes: answers.flatMap((one, i) =>
        one.status === "fulfilled" ? [{ instrument: keys[i] as string, quote: one.value }] : [],
      ),
      errors: answers.flatMap((one, i) =>
        one.status === "rejected"
          ? [
              {
                instrument: keys[i] as string,
                message: one.reason instanceof Error ? one.reason.message : String(one.reason),
                ...(one.reason instanceof DataError ? { kind: one.reason.kind } : {}),
              },
            ]
          : [],
      ),
    };
  };

  const daily = async (
    key: string,
    window: { from: string; to: string },
    call?: Call,
  ): Promise<DailyBars> => {
    const target = targetOf(key);
    const rows = await source.rows(target.code, { from: window.from, until: addDays(window.to, 1) }, call);
    const latest = rows.at(-1);
    if (!latest) {
      // A share the FSC holds, without a session in the window, is an answer about the window; a code it holds
      // no row of at all is not one its stock prices cover.
      if ((await source.count(target.code, {}, call)) === 0) throw notHeld(target);
      throw new DataError(
        "no_data",
        `its stock prices hold no session of ${labelOf(target)} from ${window.from} to ${window.to}`,
        { source: FSC_SOURCE },
      );
    }
    const market = marketOf(target, latest);
    // Whether the FSC holds earlier sessions of the share: one row asked for, to count them.
    const earlier = await source.count(target.code, { until: window.from }, call);
    const bars = rows.flatMap((row) => barOf(row));
    const first = bars[0]?.date ?? null;
    const late = earlier === 0 && first !== null && first > window.from;
    return {
      instrument: instrumentOf(market, latest, null),
      price_basis: FSC_DAILY_BASIS,
      bars,
      coverage: {
        from: first,
        through: bars.at(-1)?.date ?? null,
        // The FSC does not say whether every session is there, unless the share's history starts later.
        complete: late ? false : null,
        complete_reason: late ? "insufficient_history" : null,
        history_from: earlier === 0 ? first : null,
        missing_sessions: rows.length - bars.length,
      },
      earlier_end: earlier > 0 ? addDays(window.from, -1) : null,
    };
  };

  return {
    name: FSC_SOURCE,
    capabilities: {
      quotes: { quote, many },
      priceHistory: { daily },
    },
  };
}

/** The Korean listing `key` names, or unsupported (the router moves on) for any other key. */
function targetOf(key: string): Target {
  const listing = parseListing(key);
  if (listing.kind !== "kr") {
    throw new DataError(
      "unsupported",
      `its stock prices are KRX's, for KOSPI and KOSDAQ listings (XKRX:, XKOS:, .KS, .KQ or a six-character code); ${key} is not one`,
      { source: FSC_SOURCE },
    );
  }
  return { key, code: listing.code, market: listing.market };
}

/** How a message names the listing asked for. */
function labelOf(target: Target): string {
  return target.market ? `${target.market}:${target.code}` : target.code;
}

/**
 * The failure for a code the FSC's stock prices hold no row of at all: unsupported, a listing they do not cover
 * (a fund, which getStockPriceInfo does not list), so the router says every source's reason.
 */
function notHeld(target: Target): DataError {
  return new DataError(
    "unsupported",
    `its stock prices list KOSPI, KOSDAQ and KONEX shares and hold no row of the code ${target.code}${target.market ? ` (${labelOf(target)})` : ""}`,
    { source: FSC_SOURCE },
  );
}

/**
 * The market of the listing the FSC's latest row places the share on: the key's, when it names one; invalid
 * when the FSC places it on the other one; unsupported on KONEX (no listing key names one).
 */
function marketOf(target: Target, row: FscRow): KoreanMarket {
  const said = (row.market ?? "").toUpperCase();
  const market: KoreanMarket | undefined = said.startsWith("KOSPI")
    ? "XKRX"
    : said.startsWith("KOSDAQ")
      ? "XKOS"
      : undefined;
  const name = row.name ?? target.code;
  if (!market) {
    throw new DataError(
      "unsupported",
      `it lists ${target.code} (${name}) on ${row.market ?? "a market it does not name"}; XKRX: and XKOS: keys name KOSPI and KOSDAQ listings`,
      { source: FSC_SOURCE },
    );
  }
  if (target.market && target.market !== market) {
    const venue = KOREAN_MARKETS[market].venue;
    throw new DataError(
      "invalid",
      `${target.code} is listed on ${venue} (${market}:${target.code}), not ${KOREAN_MARKETS[target.market].venue}`,
      {
        source: FSC_SOURCE,
        retry: "change_request",
        candidates: [{ symbol: `${market}:${target.code}`, name: `${name} (${venue})` }],
      },
    );
  }
  return market;
}

/** The listing a row is of, as answers describe it; `listed` when the FSC lists it among its latest sessions. */
function instrumentOf(market: KoreanMarket, row: FscRow, listed: boolean | null): Instrument {
  return {
    key: `${market}:${row.code}`,
    name: row.name ?? `${market}:${row.code}`,
    venue: KOREAN_MARKETS[market].venue,
    currency: "KRW",
    price_scale: null,
    listing: listed ? { state: "listed", delisted_at: null } : null,
    classification: { instrument_type: "stock" },
    continuous: null,
  };
}

/** A price as a session's: the FSC writes 0 for a price of a session without trades. */
function traded(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

/** Whether a row is of a session the share did not trade (halted): no open and no volume. */
function untraded(row: FscRow): boolean {
  return traded(row.open) === null && (row.volume ?? 0) === 0;
}

/** The quote of the latest row, against the one before it when there is one. */
function quoteOf(market: KoreanMarket, latest: FscRow, previous: FscRow | undefined, recent: boolean): Quote {
  const states: NonNullable<FieldStates> = {};
  // vs is against the exchange's base price: the previous close, adjusted on a corporate action's day.
  const base = latest.close !== null && latest.change !== null ? latest.close - latest.change : null;
  let changeBasis = "previous_close";
  if (previous && base !== null && previous.close !== null && previous.close !== base) {
    changeBasis = "base_price";
    states.previous_close = {
      reason: `the exchange's base price for ${latest.date}: the ${previous.date} close of ${previous.close} adjusted for a corporate action`,
    };
  }
  if (untraded(latest)) {
    states.day = {
      reason: "no trades this session (trading halted): the close is the previous close carried over",
    };
  }
  if (!recent) {
    states.session_date = {
      reason: `the FSC's latest row of ${latest.code} is of ${latest.date}; it lists no session of it since`,
    };
  }
  states.range_52w = { reason: "the FSC publishes each session's prices, not a 52-week range" };
  return {
    instrument: instrumentOf(market, latest, recent),
    quote_kind: "last_close",
    price: latest.close,
    price_basis: "as traded",
    price_time: null,
    stale: null,
    session_date: latest.date,
    market_state: null,
    previous_close: base === null ? null : previous ? { value: base, date: previous.date } : base,
    change: latest.change,
    change_percent: latest.changePercent,
    change_basis: changeBasis,
    day: {
      open: traded(latest.open),
      high: traded(latest.high),
      low: traded(latest.low),
      volume: latest.volume,
    },
    range_52w: null,
    market_cap: latest.marketCap,
    field_states: states,
  };
}

/** A row as a daily bar (none for a row without a close); a session without trades says so. */
function barOf(row: FscRow): DailyBar[] {
  if (row.close === null) return [];
  return [
    {
      date: row.date,
      open: traded(row.open),
      high: traded(row.high),
      low: traded(row.low),
      close: row.close,
      volume: row.volume,
      // The FSC publishes a session's official prices once, after it has ended.
      revision: "final",
      field_states: untraded(row)
        ? {
            close: {
              reason:
                "no trades this session (trading halted): the previous close carried over, no open, high or low",
            },
          }
        : null,
    },
  ];
}
