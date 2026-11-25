// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * What a key the tools pass names, read into a typed listing with its canonical key and the Yahoo symbol
 * that serves it where there is one. The forms (src/data/instrument-key.ts reads the kind):
 *
 * - a US ticker, bare: "AAPL", "BRK.B" or "BRK-B" (canonical with a dash, as SEC and Yahoo spell it);
 * - MIC:SYMBOL, as upstream's Yahoo provider takes it: "XNAS:AAPL", "XLON:VOD";
 * - a Korean listing: "XKRX:005930" (KOSPI) and "XKOS:035900" (KOSDAQ) are canonical; "005930.KS",
 *   "035900.KQ" name the same; a bare 6-character code ("005930") names a listing whose market is not
 *   known yet (both Yahoo spellings are candidates);
 * - a future: "future:XNYM:CL", "future:CL" (the catalog supplies the exchange), "/continuous" allowed;
 *   Yahoo's continuous front month `CL=F`;
 * - a currency pair: "fx:EURUSD" (Yahoo `EURUSD=X`);
 * - a crypto pair: "crypto:BTC-USD"; "crypto:BTC-USDT" and "crypto:BTC-USDC" read as Yahoo's USD pair,
 *   which the listing's `note` says (Yahoo lists crypto against USD, not against stablecoins);
 * - a price series: "series:us.equity_index.sp500" (Yahoo `^GSPC`; catalog/instruments.ts);
 * - a value series: any other "series:" key ("series:us.fred.cpiaucsl"), an economic statistic that
 *   macro_series reads: price tools answer it with `notPriced`.
 *
 * Any key may carry "security:" before a listing ("security:AAPL", "security:XNAS:AAPL"), and the
 * symbol-schema tools upper-case typed keys ("FX:EURUSD", "SERIES:US.FRED.CPIAUCSL"): both read the same.
 */
import { DataError } from "../../data/errors.js";
import { isInstrumentKey, parseInstrument } from "../../data/instrument-key.js";
import {
  FUTURE_ROOTS,
  PRICE_SERIES,
  PRICE_SERIES_FAMILIES,
  type PriceSeries,
} from "./catalog/instruments.js";

/** The Korean markets: the KRX's KOSPI and KOSDAQ, by MIC. */
export const KOREAN_MARKETS = {
  XKRX: { venue: "KOSPI", yahooSuffix: ".KS" },
  XKOS: { venue: "KOSDAQ", yahooSuffix: ".KQ" },
} as const;
export type KoreanMarket = keyof typeof KOREAN_MARKETS;

export type Listing =
  | { kind: "us"; key: string; ticker: string; yahoo: string }
  | { kind: "venue"; key: string; mic: string; symbol: string; yahoo: string | null }
  | {
      kind: "kr";
      /** XKRX:<code> or XKOS:<code>; null while the market is not known (a bare code). */
      key: string | null;
      code: string;
      market: KoreanMarket | null;
      /** The Yahoo symbols that may serve it: one when the market is known, both otherwise. */
      yahoo: string[];
    }
  | { kind: "future"; key: string; mic: string | null; root: string; yahoo: string; known: boolean }
  | { kind: "fx"; key: string; base: string; quote: string; yahoo: string }
  | {
      kind: "crypto";
      key: string;
      base: string;
      quote: string;
      yahoo: string;
      /** What reading it as another pair means, when the key asked for one Yahoo does not list. */
      note?: string;
    }
  | { kind: "price_series"; key: string; series: PriceSeries | null; yahoo: string | null }
  | { kind: "value_series"; key: string }
  | { kind: "invalid"; input: string; reason: string };

/** Yahoo's suffix for listings on a venue outside the US (US venues need none), and how it spells symbols. */
const VENUE_SPELLING: Readonly<Record<string, { suffix: string; dots?: "dash"; digits?: number }>> = {
  XHKG: { suffix: ".HK", digits: 4 },
  XLON: { suffix: ".L", dots: "dash" },
  XTKS: { suffix: ".T" },
  XTSE: { suffix: ".TO", dots: "dash" },
  XNSE: { suffix: ".NS" },
  XBOM: { suffix: ".BO" },
  XETR: { suffix: ".DE" },
  XPAR: { suffix: ".PA" },
  XASX: { suffix: ".AX" },
};
/** US venues, by MIC: their listings are spelled as bare US tickers. */
const US_VENUES = new Set(["XNAS", "XNYS", "ARCX", "BATS", "XASE"]);

/** A Korean listing's code: six characters, a digit first ("005930", "0088M0"). */
const KOREAN_CODE = /^[0-9][0-9A-Z]{5}$/;

/** Crypto quotes Yahoo does not list a pair in, read as its USD pair. */
const STABLECOINS = new Set(["USDT", "USDC"]);

/** What `input` names; never throws (a key it cannot read is a listing of kind "invalid"). */
export function parseListing(input: string): Listing {
  const trimmed = input.trim();
  const unprefixed = trimmed.replace(/^security:/i, "");
  if (!unprefixed || !isInstrumentKey(unprefixed)) {
    return { kind: "invalid", input: trimmed, reason: "not a ticker, MIC:SYMBOL or instrument key" };
  }
  const { kind, id } = parseInstrument(unprefixed);
  switch (kind) {
    case "security":
      return security(id);
    case "future":
      return future(id, trimmed);
    case "fx": {
      const base = id.slice(0, 3);
      const quote = id.slice(3);
      if (base === quote)
        return { kind: "invalid", input: trimmed, reason: "a pair of one currency with itself" };
      return { kind: "fx", key: `fx:${id}`, base, quote, yahoo: `${id}=X` };
    }
    case "crypto": {
      const [base, quote] = id.split("-") as [string, string];
      if (STABLECOINS.has(quote)) {
        return {
          kind: "crypto",
          key: `crypto:${base}-USD`,
          base,
          quote: "USD",
          yahoo: `${base}-USD`,
          note: `crypto:${base}-${quote} is read as ${base}-USD: Yahoo lists crypto pairs against USD, not against ${quote}`,
        };
      }
      return { kind: "crypto", key: `crypto:${id}`, base, quote, yahoo: id };
    }
    case "series": {
      const series = PRICE_SERIES[id];
      if (series) return { kind: "price_series", key: `series:${id}`, series, yahoo: series.yahoo };
      const family = id.split(".")[1] ?? "";
      if (PRICE_SERIES_FAMILIES.has(family))
        return { kind: "price_series", key: `series:${id}`, series: null, yahoo: null };
      return { kind: "value_series", key: `series:${id}` };
    }
  }
}

function security(symbol: string): Listing {
  const colon = symbol.indexOf(":");
  if (colon < 0) {
    const korean = /^([0-9][0-9A-Z]{5})\.(KS|KQ)$/.exec(symbol);
    if (korean) return koreanListing(korean[1] as string, korean[2] === "KS" ? "XKRX" : "XKOS");
    if (KOREAN_CODE.test(symbol)) return koreanListing(symbol, null);
    const ticker = symbol.replaceAll(".", "-");
    return { kind: "us", key: ticker, ticker, yahoo: ticker };
  }
  const mic = symbol.slice(0, colon);
  const code = symbol.slice(colon + 1);
  if (mic === "XKRX" || mic === "XKOS") {
    if (!KOREAN_CODE.test(code)) {
      return {
        kind: "invalid",
        input: symbol,
        reason: `a ${KOREAN_MARKETS[mic].venue} code is six characters, such as 005930`,
      };
    }
    return koreanListing(code, mic);
  }
  return { kind: "venue", key: `${mic}:${code}`, mic, symbol: code, yahoo: venueSpelling(mic, code) };
}

function koreanListing(code: string, market: KoreanMarket | null): Listing {
  return {
    kind: "kr",
    key: market ? `${market}:${code}` : null,
    code,
    market,
    yahoo: market
      ? [`${code}${KOREAN_MARKETS[market].yahooSuffix}`]
      : [`${code}${KOREAN_MARKETS.XKRX.yahooSuffix}`, `${code}${KOREAN_MARKETS.XKOS.yahooSuffix}`],
  };
}

/** How Yahoo spells `code` on `mic`, if it lists that venue. */
function venueSpelling(mic: string, code: string): string | null {
  if (US_VENUES.has(mic)) return code.replaceAll(".", "-");
  const venue = VENUE_SPELLING[mic];
  if (!venue) return null;
  let spelled = venue.dots === "dash" ? code.replaceAll(".", "-") : code;
  if (venue.digits && /^\d+$/.test(spelled)) spelled = spelled.padStart(venue.digits, "0");
  return `${spelled}${venue.suffix}`;
}

function future(id: string, input: string): Listing {
  const [first, second] = id.split(":") as [string, string | undefined];
  const root = second ?? first;
  const given = second === undefined ? null : first;
  const known = FUTURE_ROOTS[root];
  if (known && given && given !== known.mic) {
    return {
      kind: "invalid",
      input,
      reason: `${root} (${known.name}) trades on ${known.mic}: future:${known.mic}:${root}`,
    };
  }
  const mic = given ?? known?.mic ?? null;
  return {
    kind: "future",
    key: mic ? `future:${mic}:${root}` : `future:${root}`,
    mic,
    root,
    yahoo: `${root}=F`,
    known: known !== undefined,
  };
}

/** The canonical key of what `input` names; undefined when it is not one, or a Korean code's market is not known. */
export function canonicalKey(input: string): string | undefined {
  const listing = parseListing(input);
  return listing.kind === "invalid" ? undefined : (listing.key ?? undefined);
}

/**
 * The failure a price tool (quote, price_history, technicals) answers for a value series: `invalid`, saying
 * macro_series reads it; undefined for anything else.
 */
export function notPriced(listing: Listing, source: string): DataError | undefined {
  if (listing.kind !== "value_series") return undefined;
  return new DataError(
    "invalid",
    `${listing.key} is an economic series, not a price: read it with macro_series`,
    { source, retry: "change_request" },
  );
}
