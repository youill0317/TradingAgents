// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "Yahoo", routes.ts key `yahoo`: the composite every Yahoo-served capability is routed to, over the shared
 * yahoo-finance2 client (deps.ts). Every key is read through listings.ts first.
 *
 * - quotes.quote/many and priceHistory.daily/dailyPair: upstream's Yahoo provider
 *   (src/data/yahoo/provider.ts), unchanged, answers what it serves, US listings and its MIC:SYMBOL venues
 *   (answers name the canonical key);
 *   this composite answers the rest from Yahoo itself (sources/yahoo.ts): Korean listings (XKRX:, XKOS:, .KS,
 *   .KQ, a bare code, answered as XKRX:/XKOS: with venue KOSPI or KOSDAQ), futures roots' continuous front
 *   months (`future:XNYM:CL`, Yahoo `CL=F`, with instrument.continuous), currency pairs (`fx:EURUSD`, quotes
 *   only: a pair's daily history is the ECB's reference rates), crypto pairs (`crypto:BTC-USD`; BTC-USDT is
 *   read as BTC-USD, which the instrument's name says) and price series (`series:us.equity_index.sp500`,
 *   Yahoo `^GSPC`). A batch is one request for all of these. A Korean listing Yahoo does not answer fails as
 *   unsupported or unavailable, never no_data, so the router asks the next source (FSC); so does, with
 *   DATA_GO_KR_API_KEY (the FSC's daily bars), a Korean listing's daily window whose every session Yahoo's
 *   chart gives without a close or without an adjusted close, the reason saying which (without the key, and
 *   in a pair, the window is Yahoo's, those sessions listed missing); a value series fails as invalid,
 *   pointing to macro_series.
 * - priceHistory.intraday: a listed security's 15-minute or hourly bars, regular hours only.
 * - technicals.latest: the 22 indicators (compute/technicals.ts) from about 400 daily bars (TECHNICALS_DAYS).
 * - profiles.profile/analyst/calendar: quoteSummary's modules, asked per use.
 * - corporateActions.list: the splits and dividends of Yahoo's chart.
 * - ownership.holders: the top institutional holders Yahoo lists (insider transactions are the filers').
 */
import { addDays, dayOf, errorText } from "../../../contracts/index.js";
import type { Call, DataProvider, Instrument, Quote, QuoteBatch } from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import { type YahooClient, yahooProvider } from "../../../data/yahoo/provider.js";
import { technicalsOf } from "../compute/technicals.js";
import type { ForkDeps } from "../deps.js";
import {
  analystOf,
  calendarOf,
  holdersOf,
  koreanCandidates,
  koreanMarketOf,
  koreanTarget,
  type LeftOut,
  MODULES,
  noQuote,
  type Plan,
  planOf,
  profileOf,
  quoteOf,
  type Raw,
  readActions,
  readDaily,
  readIntraday,
  readQuotes,
  readSummary,
  rememberKorean,
  SOURCE,
  targetOf,
} from "../sources/yahoo.js";

/**
 * Calendar days of daily bars the indicators are computed from: about 410 sessions on a weekday calendar,
 * enough for SMA 200 with the smoothed indicators' seeds long behind the latest session.
 */
export const TECHNICALS_DAYS = 600;

/**
 * The canonical key of a listing upstream's Yahoo provider serves the quotes and daily bars of (US listings
 * and its venues), or undefined for one this composite answers itself.
 */
function upstreamKey(plan: Plan): string | undefined {
  return plan.kind === "target" && (plan.listing === "us" || plan.listing === "venue")
    ? plan.target.key
    : undefined;
}

/** An upstream answer naming the canonical key (upstream names Yahoo's symbol, such as VOD.L). */
function named<T extends { instrument?: Instrument | null }>(answer: T, key: string): T {
  return answer.instrument ? { ...answer, instrument: { ...answer.instrument, key } } : answer;
}

/**
 * What Yahoo's chart gives none of for `left`, every session of a window it answers no bar of (each without a
 * close, or without an adjusted close), as the reason the window is passed on says it: "no close for its 5
 * sessions from 2026-11-19 to 2026-11-25", "no adjusted close for its session of 2026-11-25", "no close for 2
 * and no adjusted close for 3 of its 5 sessions from 2026-11-19 to 2026-11-25".
 */
function lackedIn(left: readonly LeftOut[]): string {
  const first = left[0]?.date;
  const last = left.at(-1)?.date;
  const sessions =
    left.length === 1 ? `session of ${first}` : `${left.length} sessions from ${first} to ${last}`;
  const counts = new Map<LeftOut["lacks"], number>();
  for (const { lacks } of left) counts.set(lacks, (counts.get(lacks) ?? 0) + 1);
  if (counts.size === 1) return `no ${left[0]?.lacks} for its ${sessions}`;
  const each = [...counts].map(([lacks, count]) => `no ${lacks} for ${count}`);
  return `${each.join(" and ")} of its ${sessions}`;
}

export function yahooComposite(deps: ForkDeps): DataProvider {
  const upstream = yahooProvider({ client: deps.yahoo as unknown as YahooClient, now: deps.clock });
  const theirs = upstream.capabilities;

  /** The quote of one planned key, Yahoo's quotes of the symbols it needs read as `rows` (one batch). */
  const answer = async (key: string, plan: Plan, rows: () => Promise<Map<string, Raw>>, call?: Call) => {
    if (plan.kind === "refused") throw plan.error;
    const canonical = upstreamKey(plan);
    if (canonical) return named(await theirs.quotes.quote(key, call), canonical);
    const found = await rows();
    if (plan.kind === "korean") {
      const market = koreanMarketOf(plan.code, found);
      await rememberKorean(deps, plan.code, market);
      const target = koreanTarget(plan.code, market);
      return quoteOf(found.get(target.symbol) as Raw, target);
    }
    const row = found.get(plan.target.symbol.toUpperCase());
    if (!row) throw noQuote(plan.target);
    return quoteOf(row, plan.target);
  };

  /** The Yahoo symbols this composite reads itself for these plans (both spellings of a bare Korean code). */
  const symbolsOf = (plans: readonly Plan[]) => [
    ...new Set(
      plans.flatMap((plan) => {
        if (plan.kind === "korean") return koreanCandidates(plan.code).map((one) => one.symbol);
        if (plan.kind === "target" && !upstreamKey(plan)) return [plan.target.symbol];
        return [];
      }),
    ),
  ];

  const quote = async (key: string, call?: Call): Promise<Quote> => {
    const plan = planOf(key);
    return answer(key, plan, () => readQuotes(deps, symbolsOf([plan]), call), call);
  };

  const many = async (keys: readonly string[], call?: Call): Promise<QuoteBatch> => {
    const plans = keys.map((key) => planOf(key));
    const symbols = symbolsOf(plans);
    // One request for every symbol this composite reads; upstream asks for its own one by one.
    const batch = symbols.length ? readQuotes(deps, symbols, call) : Promise.resolve(new Map<string, Raw>());
    batch.catch(() => {});
    const answers = await Promise.allSettled(
      keys.map((key, i) => answer(key, plans[i] as Plan, () => batch, call)),
    );
    const failures = answers.flatMap((one) => (one.status === "rejected" ? [one.reason as unknown] : []));
    // Nothing answered for one reason (the batch's request failed): the call's failure, as for one quote.
    if (failures.length === answers.length && failures.every((reason) => reason === failures[0])) {
      throw failures[0];
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
                message: errorText(one.reason),
                ...(one.reason instanceof DataError ? { kind: one.reason.kind } : {}),
              },
            ]
          : [],
      ),
    };
  };

  /** Whether the FSC answers a Korean listing's daily bars after Yahoo (it declares them with this key). */
  const fscAnswers = Boolean(deps.config.dataGoKrKey);

  /**
   * A listing's daily bars. With `passOn`, a Korean listing whose every session in the window Yahoo gives
   * without a close or without an adjusted close fails as unsupported, saying which (`lackedIn`), so the FSC
   * is asked; otherwise those sessions are listed missing.
   */
  const daily = async (key: string, window: { from: string; to: string }, call?: Call, passOn = false) => {
    const plan = planOf(key);
    const canonical = upstreamKey(plan);
    if (canonical) return named(await theirs.priceHistory.daily(key, window, call), canonical);
    const target = await targetOf(deps, plan, call);
    if (target.kind === "fx") {
      throw new DataError(
        "unsupported",
        `daily bars of a currency pair are not Yahoo's here: a pair's history is its reference rates (${target.key})`,
        { source: SOURCE },
      );
    }
    const { bars, left } = await readDaily(deps, target, window, call);
    const korean = plan.kind === "korean" || (plan.kind === "target" && plan.listing === "kr");
    if (passOn && korean && !bars.bars.length && left.length) {
      throw new DataError("unsupported", `Yahoo's chart of ${target.key} gives ${lackedIn(left)}`, {
        source: SOURCE,
      });
    }
    return bars;
  };

  return {
    name: SOURCE,
    capabilities: {
      quotes: { quote, many },
      priceHistory: {
        daily: (key, window, call) => daily(key, window, call, fscAnswers),
        // Both listings from Yahoo, or neither (no later source answers a pair).
        dailyPair: async ([first, second], window, call) => {
          const [a, b] = await Promise.all([daily(first, window, call), daily(second, window, call)]);
          return [a, b];
        },
        intraday: async (key, query, call) =>
          readIntraday(deps, await targetOf(deps, planOf(key), call), query, call),
      },
      technicals: {
        latest: async (key, call) => {
          const target = await targetOf(deps, planOf(key), call);
          const to = dayOf(deps.clock());
          const from = addDays(to, -TECHNICALS_DAYS);
          const { bars, left } = await readDaily(deps, target, { from, to }, call);
          if (!bars.bars.length) {
            throw new DataError(target.notFound, `Yahoo has no daily bars of ${target.key} since ${from}`, {
              source: SOURCE,
            });
          }
          return {
            instrument: bars.instrument ?? null,
            ...technicalsOf(bars.bars, { missing: left, priceBasis: bars.price_basis }),
          };
        },
      },
      profiles: {
        profile: async (key, call) => {
          const target = await targetOf(deps, planOf(key), call);
          return profileOf(await readSummary(deps, target, MODULES.profile, call), target);
        },
        analyst: async (key, call) => {
          const target = await targetOf(deps, planOf(key), call);
          return analystOf(await readSummary(deps, target, MODULES.analyst, call), target);
        },
        calendar: async (key, call) => {
          const target = await targetOf(deps, planOf(key), call);
          return calendarOf(await readSummary(deps, target, MODULES.calendar, call), target, deps.clock());
        },
      },
      corporateActions: {
        list: async (key, call) => readActions(deps, await targetOf(deps, planOf(key), call), call),
      },
      ownership: {
        holders: async (key, query, call) => {
          const target = await targetOf(deps, planOf(key), call);
          return holdersOf(await readSummary(deps, target, MODULES.holders, call), target, query);
        },
      },
    },
  };
}
