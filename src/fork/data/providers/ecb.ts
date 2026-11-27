// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "ECB", routes.ts key `ecb`: currency pairs' daily reference rates (priceHistory.referenceRates), which
 * price_history reads for an `fx:` key. Declared in every setup: the ECB's data API needs no key.
 *
 * From the ECB's euro reference rates (EXR, sources/ecb.ts), set once a TARGET business day: a pair against
 * the euro as published (EURUSD: USD per EUR) or inverted (USDEUR), any other pair as a cross through the
 * euro from one request (USDKRW: KRW per EUR divided by USD per EUR), the basis saying which. The ECB quotes
 * 29 currencies; a currency it stopped quoting is answered up to its last rate and said to be discontinued,
 * and one it never quoted is unsupported, naming those it does.
 */
import { addDays, dayOf, daysBetween } from "../../../contracts/index.js";
import type { Call, DataProvider, ReferenceRates } from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import type { ForkDeps } from "../deps.js";
import { parseListing } from "../listings.js";
import { ECB_CURRENCIES, ECB_ENDED, ECB_SOURCE, EURO_START, exchangeRates } from "../sources/ecb.js";

export function ecbProvider(deps: ForkDeps): DataProvider {
  return {
    name: ECB_SOURCE,
    capabilities: {
      priceHistory: {
        referenceRates: (pair, window, call) => referenceRates(deps, pair, window, call),
      },
    },
  };
}

/** How the rates are set, for every basis. */
const SET = "ECB euro reference rates (set daily at 14:15 CET)";

/** Units of `quote` per `base` from one day's rates (units of each currency per euro); null without both. */
function rateOf(base: string, quote: string, perEuro: ReadonlyMap<string, number>): number | null {
  const of = (currency: string) => (currency === "EUR" ? 1 : perEuro.get(currency));
  const baseRate = of(base);
  const quoteRate = of(quote);
  if (baseRate === undefined || quoteRate === undefined || baseRate === 0) return null;
  // A rate against the euro is the ECB's own number; an inverse or a cross is derived, to six digits.
  return base === "EUR" ? quoteRate : Number((quoteRate / baseRate).toPrecision(6));
}

/** What a pair's rates are, said in its basis. */
function basisOf(base: string, quote: string): string {
  if (base === "EUR") return `${SET}, ${quote} per EUR`;
  if (quote === "EUR")
    return `${SET}, EUR per ${base}: the inverse of the published ${base} per EUR, to 6 significant digits`;
  return `${SET}, ${quote} per ${base}; cross through EUR (derived): ${quote} per EUR divided by ${base} per EUR, to 6 significant digits`;
}

/**
 * The pair's reference rates from `from` to `to`, both inclusive, oldest first, one a publication day.
 * `earlier_end` pages back until the euro's first day (1999-01-04) or a currency's first rate.
 */
async function referenceRates(
  deps: ForkDeps,
  pair: string,
  window: { from: string; to: string },
  call?: Call,
): Promise<ReferenceRates> {
  const listing = parseListing(pair);
  if (listing.kind !== "fx") {
    throw new DataError(
      "invalid",
      listing.kind === "invalid"
        ? `${pair}: ${listing.reason}`
        : `${pair}: the ECB's reference rates are for currency pairs, such as fx:EURUSD`,
      { source: ECB_SOURCE, retry: "change_request" },
    );
  }
  const { base, quote, key } = listing;
  const legs = [base, quote].filter((currency) => currency !== "EUR");
  const unknown = legs.filter((currency) => !ECB_CURRENCIES.includes(currency) && !ECB_ENDED[currency]);
  if (unknown.length) {
    throw new DataError(
      "unsupported",
      `the ECB sets no euro reference rate for ${unknown.join(" or ")}; it sets one for ${ECB_CURRENCIES.join(", ")}`,
      { source: ECB_SOURCE },
    );
  }
  // A currency the ECB stopped quoting: its rates end on its last one.
  const ended = legs
    .flatMap((currency) => (ECB_ENDED[currency] ? [{ currency, last: ECB_ENDED[currency] as string }] : []))
    .sort((a, b) => a.last.localeCompare(b.last))[0];
  if (ended && window.from > ended.last) {
    throw new DataError(
      "no_data",
      `the ECB's last ${ended.currency} reference rate was on ${ended.last}; ask for dates on or before it`,
      { source: ECB_SOURCE },
    );
  }
  if (window.to < EURO_START) {
    throw new DataError("no_data", `the ECB's euro reference rates start on ${EURO_START}`, {
      source: ECB_SOURCE,
    });
  }
  const today = dayOf(deps.clock());
  const rows = await exchangeRates(deps, legs, window, today, call);
  const byDate = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (row.value === null) continue;
    const day = byDate.get(row.date) ?? new Map<string, number>();
    day.set(row.currency, row.value);
    byDate.set(row.date, day);
  }
  const rates = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([date, perEuro]) => {
      const value = rateOf(base, quote, perEuro);
      return value === null ? [] : [{ date, value }];
    });
  const first = rates[0];
  if (!first) {
    throw new DataError(
      "no_data",
      `the ECB set no ${base}/${quote} reference rate from ${window.from} to ${window.to}`,
      { source: ECB_SOURCE },
    );
  }
  // A first rate more than a week after the window opens: the series starts inside the window.
  const startsInside = daysBetween(window.from, first.date) > 7;
  return {
    instrument: {
      key,
      name: `${base}/${quote}`,
      venue: null,
      currency: quote,
      price_scale: null,
      listing: ended ? { state: "discontinued", delisted_at: ended.last } : null,
      classification: { instrument_type: "currency_pair" },
    },
    basis: basisOf(base, quote),
    rates,
    complete: !startsInside && !(ended && ended.last < window.to),
    earlier_end: window.from <= EURO_START || startsInside ? null : addDays(window.from, -1),
  };
}
