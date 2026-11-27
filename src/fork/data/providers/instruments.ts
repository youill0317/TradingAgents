// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "Instrument search", routes.ts key `instruments`: instruments.search, which find_instrument reads. Declared
 * in every setup: the catalogs and Yahoo's search need no key; SEC's ticker list joins with SEC_USER_AGENT,
 * OpenDART's company list with DART_API_KEY.
 *
 * A search reads a name, a ticker, a code or a key and answers the keys the tools take (listings.ts), each
 * with what it is and the capabilities that serve it in this setup:
 *
 * - the catalogs, read here without a request: price series and futures roots (catalog/instruments.ts) by
 *   their names, the other names and codes below, and Yahoo's symbols for them (^GSPC, CL=F); currency
 *   pairs from the currencies a search names ("euro dollar", "EUR/USD", "yen", "원달러": the pair the way
 *   markets quote it, then the other way round when the search named it so); crypto pairs against the US
 *   dollar by the coin's name; the economic series macro_series reads (catalog/series.ts: "CPI", "10-year
 *   Treasury yield"; the Bank of Korea's and Statistics Korea's with ECOS_API_KEY and KOSIS_API_KEY), found as
 *   macro_series finds them;
 * - SEC's ticker list (sources/sec-tickers.ts), with SEC_USER_AGENT: a US ticker, and every company whose
 *   name holds each word searched;
 * - Yahoo's search, through deps.yahoo: listings on the US venues and on those listings.ts reads (MIC:SYMBOL,
 *   XKRX:, XKOS:), futures' front months, currency and crypto pairs, and the catalog's price series, in
 *   Yahoo's order. Yahoo is asked in the Latin script only (it refuses Hangul), with a Korean code as its
 *   code or its Yahoo symbol; a typed key the catalogs resolve is answered without it;
 * - OpenDART's company list (sources/dart.ts), with DART_API_KEY: the Korean companies whose names, Korean or
 *   English (spacing, case and legal forms aside), are the name searched, start with it or hold it, listed
 *   ones only (a company without a stock code has no listing a tool takes), and the company listed under a
 *   Korean code or key. The list does not say a listing's market: Yahoo's search, when asked, places the
 *   listings it finds, and the others are placed by one batched quote of their KOSPI and KOSDAQ spellings
 *   (005930.KS, 005930.KQ), the spelling Yahoo quotes naming the market (XKRX, XKOS), shared with the Yahoo
 *   composite's resolver of a bare code. A listing Yahoo quotes on neither market (delisted, or on KONEX,
 *   which no key names) is left out, as is every listing of a search whose quote failed. For the company a
 *   search names exactly, the same quote asks for its preferred shares, which KRX codes from its common
 *   share's (its first five characters and 5, 7 or 9, or K, L or M): one Yahoo quotes on the same market
 *   under the same company name is its preferred stock. Without DART_API_KEY a company's name in Hangul
 *   finds nothing: no other source here reads Korean names (Yahoo refuses Hangul), so a search in Hangul
 *   that finds nothing answers not_configured, naming DART_API_KEY; OpenDART's list adds them with the key.
 *
 * Korean codes resolve through the Korean listing forms (XKRX:005930, 005930.KS, a bare code), and the
 * catalogs hold Korean names of their own (코스피, 원/달러, 비트코인).
 *
 * Best first: a catalog's own name for the instrument; the listing whose key or ticker was searched; a
 * catalog's code for it; the company whose name was searched; the economic series a broader search finds;
 * other catalog entries holding every word; Yahoo's other matches; SEC's and OpenDART's other companies whose
 * names hold the words searched (OpenDART's: those starting with them first). Nothing found is left out for
 * being found less well. A source that fails leaves its matches out; when nothing is found and a source
 * failed, the search fails with that source's reason, so an outage is never answered as no match. A search
 * that finds nothing for want of a key answers not_configured, naming it: a Korean series of the catalog it
 * names exactly (ECOS_API_KEY or KOSIS_API_KEY, as macro_series says), or a name in Hangul (DART_API_KEY).
 * Any other search nothing matches answers no match, which find_instrument says.
 *
 * Names: a match's from the catalogs first, then OpenDART's (a Korean company's Korean name with its English
 * one), Yahoo's, SEC's.
 *
 * `serves` names the capabilities this setup serves the key with: a listing on a US venue the Yahoo
 * composite's (quotes, price history, technicals, profiles, institutional holders, corporate actions) and
 * news; with SEC_USER_AGENT, a company in SEC's ticker list statements (not a fund's), filings and insider
 * transactions too; a ticker SEC lists over the counter or on no exchange SEC's and news; another venue's
 * listing or a Korean one the composite's and news; with DART_API_KEY, a Korean listing OpenDART's list holds
 * under its code statements (not a fund's) and filings too, and, when the list could not be read, every Korean
 * listing (OpenDART is asked when a tool needs it); a futures front month, a crypto pair or a price series
 * quotes, daily price history, technicals and news; a currency pair quotes, technicals, news and, where the
 * ECB sets both currencies, price history (its reference rates); an economic series macro series.
 */
import { message } from "../../../contracts/index.js";
import type { Call, Capability, DataProvider, InstrumentMatch } from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import { INSTRUMENT_KINDS } from "../../../data/instrument-key.js";
import { FUTURE_ROOTS, type FutureRoot, PRICE_SERIES } from "../catalog/instruments.js";
import {
  type CatalogSeries,
  type SeriesKeys,
  searchCatalog,
  seriesKeysOf,
  servedWith,
} from "../catalog/series.js";
import type { ForkDeps } from "../deps.js";
import {
  canonicalKey,
  KOREAN_MARKETS,
  type KoreanMarket,
  type Listing,
  parseListing,
  US_VENUES,
} from "../listings.js";
import { type DartCompany, type DartCorpList, dartKeyNeeded, dartSource } from "../sources/dart.js";
import { ECB_CURRENCIES } from "../sources/ecb.js";
import { ecosKeyNeeded } from "../sources/ecos.js";
import { kosisKeyNeeded } from "../sources/kosis.js";
import { hasHangul } from "../sources/naver.js";
import { type SecCompany, secTicker, secTickers } from "../sources/sec-tickers.js";
import {
  koreanCandidates,
  planOf,
  type Raw,
  readQuotes,
  record,
  rememberKorean,
  text,
  US_EXCHANGES,
} from "../sources/yahoo.js";
import { yahooCall } from "../sources/yahoo-call.js";

/** The name answers give this provider. */
export const INSTRUMENTS_SOURCE = "Instrument search";

/**
 * How Yahoo's search is first asked: listings only, no news, `quotesCount` matches. Yahoo answers at most the
 * matches asked for and publishes no maximum, so an answer holding as many as asked is asked again for ten
 * times as many, until Yahoo answers fewer than asked; every match it answers is read.
 */
export const YAHOO_SEARCH = { quotesCount: 100, newsCount: 0 } as const;

/** How long Yahoo's answer to one search is kept: searches made together, or soon after, share it. */
const YAHOO_KEEP_MS = 3_600_000;

export function instrumentsProvider(deps: ForkDeps): DataProvider {
  return {
    name: INSTRUMENTS_SOURCE,
    capabilities: {
      instruments: { search: (query, kind, call) => searchInstruments(deps, query, kind, call) },
    },
  };
}

// What a match is ----------------------------------------------------------------------------------------

/** What a match is, for its `kind` and the capabilities that serve it. */
type Category = "us" | "venue" | "kr" | "future" | "fx" | "crypto" | "price_series" | "value_series";

/** find_instrument's kinds, by the categories each holds. */
const KINDS: Readonly<Record<(typeof INSTRUMENT_KINDS)[number], readonly Category[]>> = {
  security: ["us", "venue", "kr"],
  future: ["future"],
  fx: ["fx"],
  crypto: ["crypto"],
  series: ["price_series", "value_series"],
};

/**
 * How well a match answers the search, lower first (see the top of this file): the catalogs' economic series
 * a broader search finds come in macro_series' own order, before other catalog entries holding every word;
 * `filer` holds SEC's and OpenDART's other companies.
 */
const TIER = { name: 0, key: 1, code: 2, company: 3, series: 4, words: 5, yahoo: 6, filer: 7 } as const;
type Tier = (typeof TIER)[keyof typeof TIER];

/** Where a match's name and type come from, the first preferred: the catalogs', OpenDART's, Yahoo's, SEC's. */
const ORIGIN = { catalog: 0, dart: 1, yahoo: 2, sec: 3 } as const;
type Origin = keyof typeof ORIGIN;

/** One source's match, before matches of one key are joined. */
type Candidate = {
  key: string;
  category: Category;
  tier: Tier;
  from: Origin;
  name: string | null;
  type: string | null;
  /** A US listing Yahoo answers on a US venue, or SEC lists on an exchange. */
  traded?: boolean;
  /** Yahoo's type for it is a fund's (an ETF, a mutual fund, a money market fund). */
  fund?: boolean;
  /** SEC's row for a US listing. */
  sec?: SecCompany;
  /** OpenDART's company listed under a Korean listing's code. */
  dart?: DartCompany;
  /** For a catalog entry holding every word searched: how closely its own name is the search. */
  fit?: number;
};

/** A key's match, joined from every source that found it. */
type Found = Required<Omit<Candidate, "sec" | "dart" | "from">> & {
  order: number;
  nameFrom: number;
  typeFrom: number;
  sec?: SecCompany;
  dart?: DartCompany;
};

/** Matches by key, the best tier each was found at, in the order first found. */
function collector() {
  const byKey = new Map<string, Found>();
  return {
    add(candidate: Candidate): void {
      const from = ORIGIN[candidate.from];
      const known = byKey.get(candidate.key);
      if (!known) {
        byKey.set(candidate.key, {
          key: candidate.key,
          category: candidate.category,
          tier: candidate.tier,
          order: byKey.size,
          name: candidate.name,
          nameFrom: candidate.name ? from : Number.POSITIVE_INFINITY,
          type: candidate.type,
          typeFrom: candidate.type ? from : Number.POSITIVE_INFINITY,
          traded: candidate.traded ?? false,
          fund: candidate.fund ?? false,
          fit: candidate.fit ?? 0,
          ...(candidate.sec ? { sec: candidate.sec } : {}),
          ...(candidate.dart ? { dart: candidate.dart } : {}),
        });
        return;
      }
      known.tier = Math.min(known.tier, candidate.tier) as Tier;
      if (candidate.name && from < known.nameFrom) {
        known.name = candidate.name;
        known.nameFrom = from;
      }
      if (candidate.type && from < known.typeFrom) {
        known.type = candidate.type;
        known.typeFrom = from;
      }
      known.traded ||= candidate.traded ?? false;
      known.fund ||= candidate.fund ?? false;
      known.fit = Math.max(known.fit, candidate.fit ?? 0);
      if (candidate.sec && !known.sec) known.sec = candidate.sec;
      if (candidate.dart && !known.dart) known.dart = candidate.dart;
    },
    sorted(): Found[] {
      const fit = (one: Found) => (one.tier === TIER.words ? one.fit : 0);
      return [...byKey.values()].sort((a, b) => a.tier - b.tier || fit(b) - fit(a) || a.order - b.order);
    },
  };
}

// Words ----------------------------------------------------------------------------------------------------

/** A word as searches compare it: a plural of letters read as its singular ("futures", "yields"). */
function stem(word: string): string {
  return /^[a-z]{4,}s$/.test(word) && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/**
 * The words of `value` as searches compare them: lower case in any script, `&` between letters dropped
 * (S&P, AT&T), apostrophes and dots dropped, anything else that is not a letter or a digit a break.
 */
function wordsOf(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(\p{L})&(\p{L})/gu, "$1$2")
    .replace(/['’.]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .map(stem);
}

/** Words a search for an instrument does without ("the price of gold" is "gold"). */
const STOP = new Set(["the", "a", "an", "of", "and", "price", "spot"]);

/** A name or a search as names are compared: its words, those above left out, in order. */
function phraseOf(value: string): string {
  return wordsOf(value)
    .filter((word) => !STOP.has(word))
    .join(" ");
}

/** The distinct words of a search a catalog entry must hold, those above left out. */
function searchWordsOf(value: string): string[] {
  return [...new Set(wordsOf(value).filter((word) => !STOP.has(word)))];
}

/** Text in a script other than the Latin one (digits, punctuation and spaces are of every script). */
const OTHER_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

// The catalogs: price series, futures roots, crypto pairs ---------------------------------------------------

/** A catalog instrument found by name: a price series, a futures root's front month, a crypto pair. */
type Entry = {
  key: string;
  category: "price_series" | "future" | "crypto";
  name: string;
  type: string;
  /** Names that name exactly it. */
  names: readonly string[];
  /** Codes for it (a futures root, Yahoo's symbol): after a listing whose ticker is the same letters. */
  codes: readonly string[];
  /** Words a broader search finds it by. */
  keywords: readonly string[];
};

/** Other names of the catalog's price series, by key. */
const SERIES_NAMES: Readonly<Record<string, readonly string[]>> = {
  "us.equity_index.sp500": ["S&P 500 index", "S&P", "S&P500", "SPX", "Standard & Poor's 500"],
  "us.equity_index.nasdaq_composite": ["Nasdaq", "Nasdaq Composite index", "IXIC", "나스닥", "나스닥 종합"],
  "us.equity_index.nasdaq_100": ["Nasdaq 100", "NDX", "나스닥 100", "나스닥100"],
  "us.equity_index.dow_jones": ["Dow", "Dow Jones", "DJIA", "Dow 30", "다우", "다우존스"],
  "us.equity_index.russell_2000": ["Russell 2000 index", "RUT", "러셀 2000", "러셀2000"],
  "us.equity_index.nyse_composite": ["NYSE Composite index", "NYA"],
  "us.volatility.vix": [
    "VIX",
    "VIX index",
    "Cboe VIX",
    "Cboe Volatility Index",
    "volatility index",
    "fear index",
  ],
  "us.volatility.vix_9d": ["VIX9D", "9-day VIX"],
  "us.volatility.vix_3m": ["VIX3M", "3-month VIX", "VXV"],
  "us.volatility.vix_6m": ["VIX6M", "6-month VIX"],
  "us.volatility.vix_1y": ["VIX1Y", "1-year VIX"],
  "us.volatility.move": ["MOVE", "MOVE index", "ICE BofA MOVE", "Treasury volatility", "bond volatility"],
  "us.volatility.oil": ["OVX", "oil volatility", "crude oil volatility"],
  "us.volatility.gold": ["GVZ", "gold volatility"],
  "us.currency_index.dollar": [
    "DXY",
    "dollar index",
    "US dollar index",
    "USDX",
    "달러 인덱스",
    "달러인덱스",
    "달러지수",
  ],
  "us.commodity_index.bloomberg": ["BCOM", "Bloomberg Commodity", "Bloomberg commodities"],
  "us.commodity_index.sp_gsci": ["GSCI", "SPGSCI", "S&P GSCI index"],
  "kr.equity_index.kospi": [
    "KOSPI",
    "KOSPI index",
    "Korea Composite Stock Price Index",
    "코스피",
    "코스피 지수",
    "코스피지수",
    "종합주가지수",
  ],
  "kr.equity_index.kosdaq": ["KOSDAQ", "KOSDAQ index", "코스닥", "코스닥 지수", "코스닥지수"],
  "kr.equity_index.kospi200": ["KOSPI200", "KOSPI 200 index", "코스피 200", "코스피200"],
  "jp.equity_index.nikkei225": ["Nikkei", "Nikkei 225 index", "Nikkei Stock Average", "N225", "닛케이"],
  "gb.equity_index.ftse100": ["FTSE", "FTSE 100 index", "Footsie", "UKX"],
  "de.equity_index.dax": ["DAX 40", "DAX index", "GDAXI"],
  "fr.equity_index.cac40": ["CAC", "CAC 40 index", "FCHI"],
  "eu.equity_index.euro_stoxx50": ["Euro Stoxx 50", "Euro Stoxx", "Eurostoxx 50", "SX5E"],
  "hk.equity_index.hang_seng": ["Hang Seng", "HSI", "항셍"],
  "cn.equity_index.sse_composite": ["Shanghai Composite", "SSE Composite index", "상해종합", "상하이종합"],
  "tw.equity_index.taiex": ["Taiwan Weighted", "Taiwan Weighted index", "TWII"],
  "in.equity_index.nifty50": ["Nifty", "Nifty 50 index", "NSEI"],
  "au.equity_index.asx200": ["ASX 200", "ASX200", "S&P/ASX 200 index"],
  "ca.equity_index.tsx": ["TSX", "TSX Composite", "S&P/TSX", "GSPTSE"],
};

/** Words a broader search finds a price series by, by its family. */
const FAMILY_WORDS: Readonly<Record<string, readonly string[]>> = {
  equity_index: ["index", "stock index", "equity index", "stocks", "equities", "stock market", "benchmark"],
  volatility: ["volatility", "implied volatility", "index"],
  currency_index: ["index", "currency index", "currencies", "dollar"],
  commodity_index: ["index", "commodity index", "commodities"],
};

/** Words a broader search finds a price series by, by its area. */
const AREA_WORDS: Readonly<Record<string, readonly string[]>> = {
  us: ["us", "united states", "american", "america"],
  kr: ["korea", "korean", "south korea", "한국"],
  jp: ["japan", "japanese", "일본"],
  gb: ["uk", "united kingdom", "britain", "british", "england"],
  de: ["germany", "german"],
  fr: ["france", "french"],
  eu: ["europe", "european", "euro area", "eurozone"],
  hk: ["hong kong"],
  cn: ["china", "chinese"],
  tw: ["taiwan", "taiwanese"],
  in: ["india", "indian"],
  au: ["australia", "australian"],
  ca: ["canada", "canadian"],
};

/** Other names of the futures roots, by root. */
const FUTURE_NAMES: Readonly<Record<string, readonly string[]>> = {
  CL: ["crude oil", "crude", "oil", "WTI", "WTI crude", "West Texas Intermediate", "원유", "유가"],
  BZ: ["Brent", "Brent crude", "Brent oil", "브렌트유"],
  NG: ["natural gas", "nat gas", "gas", "Henry Hub", "천연가스"],
  RB: ["gasoline", "RBOB", "unleaded gasoline", "휘발유"],
  HO: ["heating oil", "diesel", "ULSD", "난방유"],
  PL: ["platinum", "백금"],
  PA: ["palladium", "팔라듐"],
  GC: ["gold", "금"],
  SI: ["silver"],
  HG: ["copper", "구리"],
  ZC: ["corn", "옥수수"],
  ZW: ["wheat", "SRW wheat", "Chicago wheat", "밀"],
  ZS: ["soybeans", "soybean", "soy", "대두"],
  ZM: ["soybean meal", "soymeal"],
  ZL: ["soybean oil", "soyoil"],
  ZO: ["oats", "oat"],
  ZN: ["10-year note", "10-year T-note", "ten-year note", "10-year Treasury note futures"],
  ZB: ["Treasury bond futures", "T-bond", "30-year bond", "long bond"],
  ZF: ["5-year note", "5-year T-note", "five-year note"],
  ZT: ["2-year note", "2-year T-note", "two-year note"],
  YM: ["Dow futures", "E-mini Dow", "mini Dow", "Dow Jones futures"],
  ES: ["S&P 500 futures", "S&P futures", "E-mini S&P"],
  NQ: ["Nasdaq futures", "Nasdaq 100 futures", "E-mini Nasdaq"],
  RTY: ["Russell 2000 futures", "Russell futures", "E-mini Russell"],
  LE: ["live cattle", "cattle"],
  GF: ["feeder cattle"],
  HE: ["lean hogs", "lean hog", "hogs", "hog"],
  KC: ["coffee", "arabica", "커피"],
  SB: ["sugar", "raw sugar", "설탕"],
  CC: ["cocoa", "코코아"],
  CT: ["cotton", "면화"],
};

const ENERGY = ["energy", "commodities", "commodity"];
const METALS = ["metals", "metal", "commodities", "commodity"];
const PRECIOUS = [...METALS, "precious metals", "precious"];
const GRAINS = ["grains", "grain", "agriculture", "agricultural", "commodities", "commodity"];
const SOFTS = ["softs", "soft commodities", "agriculture", "agricultural", "commodities", "commodity"];
const LIVESTOCK = ["livestock", "meats", "agriculture", "commodities", "commodity"];
const RATE_FUTURES = ["rates", "interest rates", "treasury", "treasuries", "bonds", "bond"];
const INDEX_FUTURES = ["equity index", "stock index", "index", "stocks", "equities"];

/** Words a broader search finds a futures root by, by root. */
const FUTURE_GROUPS: Readonly<Record<string, readonly string[]>> = {
  CL: ENERGY,
  BZ: ENERGY,
  NG: ENERGY,
  RB: ENERGY,
  HO: ENERGY,
  PL: PRECIOUS,
  PA: PRECIOUS,
  GC: PRECIOUS,
  SI: PRECIOUS,
  HG: [...METALS, "industrial metals", "base metals"],
  ZC: GRAINS,
  ZW: GRAINS,
  ZS: GRAINS,
  ZM: GRAINS,
  ZL: GRAINS,
  ZO: GRAINS,
  ZN: RATE_FUTURES,
  ZB: RATE_FUTURES,
  ZF: RATE_FUTURES,
  ZT: RATE_FUTURES,
  YM: INDEX_FUTURES,
  ES: INDEX_FUTURES,
  NQ: INDEX_FUTURES,
  RTY: INDEX_FUTURES,
  LE: LIVESTOCK,
  GF: LIVESTOCK,
  HE: LIVESTOCK,
  KC: SOFTS,
  SB: SOFTS,
  CC: SOFTS,
  CT: SOFTS,
};

/** Coins whose pair against the US dollar Yahoo lists as `<code>-USD`, by name; `names` name it exactly. */
const COINS: readonly { code: string; name: string; names: readonly string[] }[] = [
  { code: "BTC", name: "Bitcoin", names: ["BTC", "XBT", "비트코인"] },
  { code: "ETH", name: "Ethereum", names: ["ETH", "Ether", "이더리움"] },
  { code: "USDT", name: "Tether", names: ["USDT", "테더"] },
  { code: "XRP", name: "XRP", names: ["Ripple", "리플"] },
  { code: "BNB", name: "BNB", names: ["Binance Coin"] },
  { code: "SOL", name: "Solana", names: ["솔라나"] },
  { code: "USDC", name: "USD Coin", names: ["USDC"] },
  { code: "DOGE", name: "Dogecoin", names: ["DOGE", "도지코인"] },
  { code: "ADA", name: "Cardano", names: ["에이다"] },
  { code: "TRX", name: "TRON", names: ["TRX", "트론"] },
  { code: "AVAX", name: "Avalanche", names: ["AVAX"] },
  { code: "LINK", name: "Chainlink", names: [] },
  { code: "DOT", name: "Polkadot", names: [] },
  { code: "LTC", name: "Litecoin", names: ["LTC"] },
  { code: "BCH", name: "Bitcoin Cash", names: ["BCH"] },
  { code: "XLM", name: "Stellar", names: ["XLM", "Stellar Lumens"] },
];

const CRYPTO_WORDS = [
  "crypto",
  "cryptocurrency",
  "cryptocurrencies",
  "coin",
  "digital asset",
  "암호화폐",
  "코인",
];

/** A futures root's front month, as answers name it (as the Yahoo composite names it). */
function frontMonthName(root: FutureRoot): string {
  return `${root.name} futures, continuous front month`;
}

/** A coin's pair against the US dollar, as answers name it. */
function coinPairName(coin: { code: string; name: string }): string {
  return coin.name === coin.code ? `${coin.code} in US dollars` : `${coin.name} (${coin.code}) in US dollars`;
}

const ENTRIES: readonly Entry[] = [
  ...Object.entries(PRICE_SERIES).map(([key, series]): Entry => {
    const [area = "", family = ""] = key.split(".");
    return {
      key: `series:${key}`,
      category: "price_series",
      name: series.name,
      type: "index",
      names: [series.name, ...(SERIES_NAMES[key] ?? [])],
      codes: [series.yahoo],
      keywords: [...(FAMILY_WORDS[family] ?? []), ...(AREA_WORDS[area] ?? [])],
    };
  }),
  ...Object.entries(FUTURE_ROOTS).map(
    ([root, future]): Entry => ({
      key: `future:${future.mic}:${root}`,
      category: "future",
      name: frontMonthName(future),
      type: "future",
      names: [future.name, `${future.name} futures`, ...(FUTURE_NAMES[root] ?? [])],
      codes: [root, `${root}=F`],
      keywords: ["futures", "continuous", "front month", ...(FUTURE_GROUPS[root] ?? [])],
    }),
  ),
  ...COINS.map(
    (coin): Entry => ({
      key: `crypto:${coin.code}-USD`,
      category: "crypto",
      name: coinPairName(coin),
      type: "crypto",
      names: [coin.name, ...coin.names],
      codes: [coin.code, `${coin.code}-USD`],
      keywords: CRYPTO_WORDS,
    }),
  ),
];

/** The entries each phrase names, or is a code of. */
function indexBy(field: "names" | "codes"): Map<string, Entry[]> {
  const index = new Map<string, Entry[]>();
  for (const entry of ENTRIES) {
    for (const phrase of new Set(entry[field].map(phraseOf))) {
      if (!phrase) continue;
      const entries = index.get(phrase);
      if (entries) entries.push(entry);
      else index.set(phrase, [entry]);
    }
  }
  return index;
}
const BY_NAME = indexBy("names");
const BY_CODE = indexBy("codes");
const BY_KEY = new Map(ENTRIES.map((entry) => [entry.key, entry]));

/** Each entry's words for a broader search: those of its names and its keywords. */
const ENTRY_WORDS = new Map(
  ENTRIES.map((entry) => [entry, new Set([...entry.names, ...entry.keywords].flatMap(searchWordsOf))]),
);

/** The words of each entry's own name: the catalog's (its first name), without what answers add to it. */
const NAME_WORDS = new Map(ENTRIES.map((entry) => [entry, searchWordsOf(entry.names[0] ?? entry.name)]));

/**
 * How closely an entry's own name is a search of `words`, every one of which the entry holds: one more when
 * its name holds them all, plus the share of its name's words they are ("crude oil": Brent crude oil before
 * the Cboe Crude Oil Volatility Index).
 */
function fitOf(entry: Entry, words: readonly string[]): number {
  const own = NAME_WORDS.get(entry) ?? [];
  const held = words.filter((word) => own.includes(word)).length;
  return (held === words.length ? 1 : 0) + (own.length ? held / own.length : 0);
}

function entryCandidate(entry: Entry, tier: Tier): Candidate {
  return {
    key: entry.key,
    category: entry.category,
    tier,
    from: "catalog",
    name: entry.name,
    type: entry.type,
  };
}

/** An economic series of catalog/series.ts, as macro_series names it. */
function seriesCandidate(entry: CatalogSeries, tier: Tier): Candidate {
  return {
    key: `series:${entry.key}`,
    category: "value_series",
    tier,
    from: "catalog",
    name: entry.name,
    type: "economic",
  };
}

// Currency pairs --------------------------------------------------------------------------------------------

type Currency = { code: string; name: string; names: readonly string[] };

/** Currencies by their names; `name` is how answers name it. */
const CURRENCIES: readonly Currency[] = [
  {
    code: "USD",
    name: "US dollar",
    names: [
      "US dollar",
      "United States dollar",
      "American dollar",
      "dollar",
      "greenback",
      "달러",
      "미국 달러",
    ],
  },
  { code: "EUR", name: "Euro", names: ["euro", "유로", "유로화"] },
  { code: "JPY", name: "Japanese yen", names: ["Japanese yen", "yen", "엔", "엔화"] },
  {
    code: "GBP",
    name: "British pound",
    names: ["British pound", "pound sterling", "pound", "sterling", "파운드"],
  },
  { code: "CHF", name: "Swiss franc", names: ["Swiss franc", "franc", "스위스 프랑"] },
  { code: "CAD", name: "Canadian dollar", names: ["Canadian dollar", "loonie", "캐나다 달러"] },
  {
    code: "AUD",
    name: "Australian dollar",
    names: ["Australian dollar", "Aussie dollar", "Aussie", "호주 달러"],
  },
  { code: "NZD", name: "New Zealand dollar", names: ["New Zealand dollar", "Kiwi dollar", "kiwi"] },
  { code: "CNY", name: "Chinese yuan", names: ["Chinese yuan", "yuan", "renminbi", "RMB", "위안", "위안화"] },
  { code: "HKD", name: "Hong Kong dollar", names: ["Hong Kong dollar", "홍콩 달러"] },
  { code: "KRW", name: "South Korean won", names: ["South Korean won", "Korean won", "won", "원", "원화"] },
  { code: "TWD", name: "New Taiwan dollar", names: ["New Taiwan dollar", "Taiwan dollar"] },
  { code: "SGD", name: "Singapore dollar", names: ["Singapore dollar"] },
  { code: "INR", name: "Indian rupee", names: ["Indian rupee", "rupee"] },
  { code: "IDR", name: "Indonesian rupiah", names: ["Indonesian rupiah", "rupiah"] },
  { code: "MYR", name: "Malaysian ringgit", names: ["Malaysian ringgit", "ringgit"] },
  { code: "PHP", name: "Philippine peso", names: ["Philippine peso"] },
  { code: "THB", name: "Thai baht", names: ["Thai baht", "baht"] },
  { code: "MXN", name: "Mexican peso", names: ["Mexican peso"] },
  { code: "BRL", name: "Brazilian real", names: ["Brazilian real"] },
  { code: "ZAR", name: "South African rand", names: ["South African rand", "rand"] },
  { code: "TRY", name: "Turkish lira", names: ["Turkish lira", "lira"] },
  { code: "SEK", name: "Swedish krona", names: ["Swedish krona"] },
  { code: "NOK", name: "Norwegian krone", names: ["Norwegian krone"] },
  { code: "DKK", name: "Danish krone", names: ["Danish krone"] },
  { code: "PLN", name: "Polish zloty", names: ["Polish zloty", "zloty"] },
  { code: "CZK", name: "Czech koruna", names: ["Czech koruna"] },
  { code: "HUF", name: "Hungarian forint", names: ["Hungarian forint", "forint"] },
  { code: "RON", name: "Romanian leu", names: ["Romanian leu"] },
  { code: "ISK", name: "Icelandic krona", names: ["Icelandic krona"] },
  { code: "ILS", name: "Israeli new shekel", names: ["Israeli new shekel", "Israeli shekel", "shekel"] },
  { code: "RUB", name: "Russian ruble", names: ["Russian ruble", "ruble", "rouble"] },
  { code: "SAR", name: "Saudi riyal", names: ["Saudi riyal", "riyal"] },
  { code: "AED", name: "UAE dirham", names: ["UAE dirham", "dirham"] },
  { code: "ARS", name: "Argentine peso", names: ["Argentine peso"] },
  { code: "CLP", name: "Chilean peso", names: ["Chilean peso"] },
  { code: "COP", name: "Colombian peso", names: ["Colombian peso"] },
  { code: "VND", name: "Vietnamese dong", names: ["Vietnamese dong", "dong"] },
];

const CURRENCY_BY_CODE = new Map(CURRENCIES.map((currency) => [currency.code, currency]));

/** Each currency's names and its code, as phrases, by the currency's code. */
const CURRENCY_BY_NAME = (() => {
  const index = new Map<string, string>();
  for (const currency of CURRENCIES) {
    for (const name of [...currency.names, currency.code]) index.set(phraseOf(name), currency.code);
  }
  return index;
})();

/** The longest currency name, in words. */
const LONGEST_NAME = Math.max(...[...CURRENCY_BY_NAME.keys()].map((phrase) => phrase.split(" ").length));

/** Words a search for a pair holds besides currencies ("euro to dollar exchange rate", "EURUSD=X"). */
const CONNECTORS = new Set(
  [
    "to",
    "vs",
    "versus",
    "against",
    "per",
    "in",
    "into",
    "and",
    "exchange",
    "rate",
    "rates",
    "fx",
    "forex",
    "currency",
    "currencies",
    "pair",
    "cross",
    "x",
    "환율",
    "대",
  ].map(stem),
);

/** Market convention: of two currencies, the one earlier here is the pair's base (EURUSD, USDJPY). */
const BASE_ORDER = ["EUR", "GBP", "AUD", "NZD", "USD", "CAD", "CHF", "JPY"];

/** The currencies a word of two of them run together names ("eurusd", "원달러"). */
function runTogether(word: string): string[] | undefined {
  for (let at = 1; at < word.length; at++) {
    const first = CURRENCY_BY_NAME.get(word.slice(0, at));
    const second = CURRENCY_BY_NAME.get(word.slice(at));
    if (first && second) return [first, second];
  }
  return undefined;
}

/** The currencies a search names in order, when it names nothing else; undefined otherwise. */
function currenciesNamed(search: string): string[] | undefined {
  const words = wordsOf(search).filter((word) => !STOP.has(word));
  const named: string[] = [];
  let at = 0;
  while (at < words.length) {
    let taken = 0;
    for (let length = Math.min(LONGEST_NAME, words.length - at); length >= 1 && !taken; length--) {
      const code = CURRENCY_BY_NAME.get(words.slice(at, at + length).join(" "));
      if (code) {
        named.push(code);
        taken = length;
      }
    }
    if (taken) {
      at += taken;
      continue;
    }
    const word = words[at] as string;
    const pair = runTogether(word);
    if (pair) named.push(...pair);
    else if (!CONNECTORS.has(word)) return undefined;
    at++;
  }
  return named.length ? [...new Set(named)] : undefined;
}

type Pair = { base: string; quote: string };

/** The pairs a search for currencies means: the pair as markets quote it, then as named when that differs. */
function pairsOf(codes: readonly string[]): Pair[] {
  if (codes.length === 1) {
    const [only] = codes as [string];
    return only === "USD" ? [] : [conventional(only, "USD")];
  }
  if (codes.length !== 2) return [];
  const [first, second] = codes as [string, string];
  const quoted = conventional(first, second);
  return quoted.base === first ? [quoted] : [quoted, { base: first, quote: second }];
}

function conventional(a: string, b: string): Pair {
  const ra = BASE_ORDER.indexOf(a);
  const rb = BASE_ORDER.indexOf(b);
  if (ra < 0 && rb >= 0) return { base: b, quote: a };
  if (rb < 0 || ra <= rb) return { base: a, quote: b };
  return { base: b, quote: a };
}

/** A pair's key, when listings.ts reads it as one. */
function pairKey({ base, quote }: Pair): string | undefined {
  const listing = parseListing(`fx:${base}${quote}`);
  return listing.kind === "fx" ? listing.key : undefined;
}

/** A pair as answers name it: "Euro / US dollar (EUR/USD)". */
function pairName({ base, quote }: Pair): string {
  const named = (code: string) => CURRENCY_BY_CODE.get(code)?.name;
  const [b, q] = [named(base), named(quote)];
  return b && q ? `${b} / ${q} (${base}/${quote})` : `${base}/${quote}`;
}

function pairCandidate(pair: Pair, tier: Tier): Candidate | undefined {
  const key = pairKey(pair);
  return key
    ? { key, category: "fx", tier, from: "catalog", name: pairName(pair), type: "currency_pair" }
    : undefined;
}

/** Whether the ECB sets both currencies' reference rates, which price_history reads for a pair. */
function ecbPair(key: string): boolean {
  const listing = parseListing(key);
  return (
    listing.kind === "fx" &&
    [listing.base, listing.quote].every((code) => code === "EUR" || ECB_CURRENCIES.includes(code))
  );
}

/** Whether both of a pair's currencies are among those above (the catalogs answer it without Yahoo). */
function knownPair(listing: Extract<Listing, { kind: "fx" }>): boolean {
  return CURRENCY_BY_CODE.has(listing.base) && CURRENCY_BY_CODE.has(listing.quote);
}

// What the catalogs find ------------------------------------------------------------------------------------

/** The catalogs' matches for a search: see the top of this file. */
function catalogCandidates(search: string, listing: Listing, keys: SeriesKeys): Candidate[] {
  const found: Candidate[] = [];
  // A typed key the catalogs know.
  if (listing.kind === "future" || listing.kind === "price_series" || listing.kind === "crypto") {
    const entry = BY_KEY.get(listing.key);
    if (entry) {
      const named = listing.kind === "crypto" && listing.note ? `${entry.name}; ${listing.note}` : entry.name;
      found.push({ ...entryCandidate(entry, TIER.key), name: named });
    }
  }
  if (listing.kind === "fx" && knownPair(listing)) {
    const pair = pairCandidate({ base: listing.base, quote: listing.quote }, TIER.key);
    if (pair) found.push(pair);
  }
  // Names, then codes.
  const phrase = phraseOf(search);
  for (const entry of BY_NAME.get(phrase) ?? []) found.push(entryCandidate(entry, TIER.name));
  for (const entry of BY_CODE.get(phrase) ?? []) found.push(entryCandidate(entry, TIER.code));
  // A currency pair, from the currencies named; Yahoo's spelling of one too (EURUSD=X, JPY=X).
  const yahooPair = /^([A-Z]{3})?([A-Z]{3})=X$/i.exec(search);
  const codes = yahooPair
    ? [yahooPair[1] ?? "USD", yahooPair[2] as string].map((code) => code.toUpperCase())
    : currenciesNamed(search);
  if (codes?.every((code) => CURRENCY_BY_CODE.has(code))) {
    for (const pair of pairsOf(codes)) {
      const candidate = pairCandidate(pair, yahooPair ? TIER.code : TIER.name);
      if (candidate) found.push(candidate);
    }
  }
  // The economic series, as macro_series finds them (Korea's with their keys).
  for (const { entry, exact } of searchCatalog(search, keys)) {
    found.push(seriesCandidate(entry, exact ? TIER.name : TIER.series));
  }
  // Every word.
  const words = searchWordsOf(search);
  if (words.length) {
    for (const entry of ENTRIES) {
      const known = ENTRY_WORDS.get(entry);
      if (known && words.every((word) => known.has(word))) {
        found.push({ ...entryCandidate(entry, TIER.words), fit: fitOf(entry, words) });
      }
    }
  }
  return found;
}

// Company names ---------------------------------------------------------------------------------------------

/** Words a company's name does without. */
const NAME_STOP = new Set(["the", "of", "and"]);

/** Words at the end of a company's name that say only its legal form. */
const LEGAL = new Set(
  [
    "inc",
    "incorporated",
    "corp",
    "corporation",
    "co",
    "company",
    "companies",
    "ltd",
    "limited",
    "plc",
    "llc",
    "lp",
    "llp",
    "sa",
    "ag",
    "nv",
    "se",
    "spa",
    "holdings",
    "group",
    "adr",
  ].map(stem),
);

/** A company's name as SEC writes it, the state after a slash ("BANK OF AMERICA CORP /DE/") left out. */
function secNameOf(name: string): string {
  return name.replace(/\s\/[A-Za-z]{2,5}\/?\s*$/, "");
}

/** The words of a company's name a search must hold. */
function nameWords(name: string): string[] {
  return wordsOf(name).filter((word) => !NAME_STOP.has(word));
}

/** A company's name as an exact search compares it: its words, its legal form at the end left out. */
function companyName(name: string): string {
  const words = nameWords(name);
  while (words.length > 1 && LEGAL.has(words.at(-1) as string)) words.pop();
  return words.join(" ");
}

// SEC's ticker list -----------------------------------------------------------------------------------------

/** SEC's rows by ticker, by each word of their names, and each row's words and exact name. */
type SecIndex = {
  tickers: Map<string, number[]>;
  words: Map<string, number[]>;
  held: Set<string>[];
  exact: string[];
};
const SEC_INDEXES = new WeakMap<readonly SecCompany[], SecIndex>();

function secIndexOf(rows: readonly SecCompany[]): SecIndex {
  let index = SEC_INDEXES.get(rows);
  if (index) return index;
  index = { tickers: new Map(), words: new Map(), held: [], exact: [] };
  for (const [at, row] of rows.entries()) {
    const listed = index.tickers.get(row.ticker);
    if (listed) listed.push(at);
    else index.tickers.set(row.ticker, [at]);
    const name = secNameOf(row.name);
    const held = new Set(nameWords(name));
    index.held.push(held);
    index.exact.push(companyName(name));
    for (const word of held) {
      const rowsOf = index.words.get(word);
      if (rowsOf) rowsOf.push(at);
      else index.words.set(word, [at]);
    }
  }
  SEC_INDEXES.set(rows, index);
  return index;
}

/** The rows whose names hold every word, in SEC's order. */
function rowsHolding(index: SecIndex, words: readonly string[]): number[] {
  const lists = words.map((word) => index.words.get(word) ?? []);
  const shortest = lists.reduce((a, b) => (b.length < a.length ? b : a));
  return shortest.filter((at) => words.every((word) => index.held[at]?.has(word)));
}

function secCandidate(row: SecCompany, tier: Tier): Candidate {
  const exchange = row.exchange?.trim() ?? "";
  return {
    key: row.ticker,
    category: "us",
    tier,
    from: "sec",
    name: row.name || null,
    // SEC's list does not say what a security is.
    type: "security",
    traded: exchange !== "" && exchange.toUpperCase() !== "OTC",
    sec: row,
  };
}

/** SEC's matches: the ticker searched, then every company whose name holds each word searched. */
async function secCandidates(deps: ForkDeps, search: string, call: Call | undefined): Promise<Candidate[]> {
  const rows = await secTickers(deps).all(call);
  const index = secIndexOf(rows);
  const found: Candidate[] = [];
  const ticker = secTicker(search);
  for (const at of ticker ? (index.tickers.get(ticker) ?? []) : []) {
    found.push(secCandidate(rows[at] as SecCompany, TIER.key));
  }
  const words = [...new Set(nameWords(search))];
  if (words.length) {
    const exact = companyName(search);
    for (const at of rowsHolding(index, words)) {
      found.push(secCandidate(rows[at] as SecCompany, index.exact[at] === exact ? TIER.company : TIER.filer));
    }
  }
  return found;
}

// Yahoo's search --------------------------------------------------------------------------------------------

/** A match of Yahoo's search, under the key the tools take. */
type Hit = Omit<Candidate, "tier"> & { symbol: string; yahooName: string | null };

/** What each of Yahoo's quote types is, as answers say it (as the Yahoo composite says it). */
const YAHOO_TYPES: Readonly<Record<string, string>> = {
  EQUITY: "stock",
  ETF: "etf",
  MUTUALFUND: "fund",
  MONEYMARKET: "money market fund",
  INDEX: "index",
  FUTURE: "future",
  CURRENCY: "currency_pair",
  CRYPTOCURRENCY: "crypto",
};

/** Yahoo's quote types that are funds. */
const FUNDS = new Set(["ETF", "MUTUALFUND", "MONEYMARKET"]);

/** The MIC of the venue each of Yahoo's suffixes names, for the venues listings.ts reads. */
const SUFFIX_MIC: Readonly<Record<string, string>> = {
  L: "XLON",
  T: "XTKS",
  HK: "XHKG",
  TO: "XTSE",
  NS: "XNSE",
  BO: "XBOM",
  DE: "XETR",
  PA: "XPAR",
  AX: "XASX",
};

/** Price series by Yahoo's symbol. */
const SERIES_BY_SYMBOL = new Map(Object.entries(PRICE_SERIES).map(([key, series]) => [series.yahoo, key]));

/** A coin's catalog entry by its pair's key. */
const COIN_ENTRY = new Map(ENTRIES.filter((entry) => entry.category === "crypto").map((e) => [e.key, e]));

/**
 * The key and category of a security Yahoo lists as `symbol` on `exchange`: a Korean listing by its
 * suffix; a listing on a venue listings.ts reads, its suffix that venue's and its exchange one the Yahoo
 * composite takes there; a listing on a US venue by its exchange.
 */
function securityOf(
  symbol: string,
  exchange: string | null,
): { key: string; category: Category } | undefined {
  if (/\.(KS|KQ)$/.test(symbol)) {
    const listing = parseListing(symbol);
    return listing.kind === "kr" && listing.key ? { key: listing.key, category: "kr" } : undefined;
  }
  const dot = symbol.lastIndexOf(".");
  if (dot > 0) {
    const mic = SUFFIX_MIC[symbol.slice(dot + 1)];
    if (!mic) return undefined;
    const listing = parseListing(`${mic}:${symbol.slice(0, dot)}`);
    if (listing.kind !== "venue" || listing.yahoo !== symbol) return undefined;
    const plan = planOf(listing.key);
    return plan.kind === "target" && plan.target.exchanges?.includes(exchange ?? "")
      ? { key: listing.key, category: "venue" }
      : undefined;
  }
  if (!US_EXCHANGES.includes(exchange ?? "")) return undefined;
  const listing = parseListing(symbol);
  return listing.kind === "us" ? { key: listing.key, category: "us" } : undefined;
}

/** One of Yahoo's rows as a match, or undefined for one no tool here takes. */
function hitOf(row: Raw): Hit | undefined {
  if (row.isYahooFinance === false) return undefined;
  const symbol = text(row.symbol)?.toUpperCase();
  if (!symbol) return undefined;
  const quoteType = text(row.quoteType)?.toUpperCase() ?? "";
  const yahooName = text(row.longname) ?? text(row.shortname);
  const yahooType = YAHOO_TYPES[quoteType] ?? null;
  const series = SERIES_BY_SYMBOL.get(symbol);
  if (series) {
    const entry = BY_KEY.get(`series:${series}`) as Entry;
    return { ...entryCandidate(entry, TIER.yahoo), symbol, yahooName };
  }
  switch (quoteType) {
    case "FUTURE": {
      const root = /^([A-Z0-9]{1,6})=F$/.exec(symbol)?.[1];
      const listing = root ? parseListing(`future:${root}`) : undefined;
      if (!root || listing?.kind !== "future") return undefined;
      const known = FUTURE_ROOTS[root];
      return {
        key: listing.key,
        category: "future",
        from: known ? "catalog" : "yahoo",
        name: known
          ? frontMonthName(known)
          : `${root} futures, continuous front month${yahooName ? ` (${yahooName})` : ""}`,
        type: "future",
        symbol,
        yahooName,
      };
    }
    case "CURRENCY": {
      const match = /^([A-Z]{3})?([A-Z]{3})=X$/.exec(symbol);
      if (!match) return undefined;
      const pair = { base: match[1] ?? "USD", quote: match[2] as string };
      const key = pairKey(pair);
      if (!key) return undefined;
      const named = CURRENCY_BY_CODE.has(pair.base) && CURRENCY_BY_CODE.has(pair.quote);
      return {
        key,
        category: "fx",
        from: named ? "catalog" : "yahoo",
        name: named ? pairName(pair) : (yahooName ?? `${pair.base}/${pair.quote}`),
        type: "currency_pair",
        symbol,
        yahooName,
      };
    }
    case "CRYPTOCURRENCY": {
      const listing = parseListing(`crypto:${symbol}`);
      if (listing.kind !== "crypto" || listing.note) return undefined;
      const coin = COIN_ENTRY.get(listing.key);
      return {
        key: listing.key,
        category: "crypto",
        from: coin ? "catalog" : "yahoo",
        name: coin?.name ?? yahooName,
        type: "crypto",
        symbol,
        yahooName,
      };
    }
    case "EQUITY":
    case "ETF":
    case "MUTUALFUND":
    case "MONEYMARKET": {
      const security = securityOf(symbol, text(row.exchange));
      if (!security) return undefined;
      return {
        ...security,
        from: "yahoo",
        name: yahooName,
        type: yahooType,
        traded: true,
        fund: FUNDS.has(quoteType),
        symbol,
        yahooName,
      };
    }
    default:
      return undefined;
  }
}

/** Yahoo's matches in its answer, in its order; an answer without its list of quotes is unreadable. */
function hitsOf(answer: unknown): Hit[] {
  const quotes = (answer as { quotes?: unknown } | null)?.quotes;
  if (!Array.isArray(quotes)) {
    throw new DataError("unavailable", "Yahoo answered its search in a form this app does not read.", {
      source: "Yahoo",
    });
  }
  return quotes.flatMap((row) => hitOf(record(row)) ?? []);
}

/**
 * Yahoo's matches for `words`, kept an hour; Yahoo refusing the words (HTTP 400) finds nothing. An answer
 * holding as many matches as asked is asked again for ten times as many (YAHOO_SEARCH); when that larger
 * request fails, the answer already read stands.
 */
async function yahooHits(deps: ForkDeps, words: string, call: Call | undefined): Promise<Hit[]> {
  const signal = call?.signal;
  const ask = (quotesCount: number) =>
    yahooCall(
      () =>
        deps.yahoo.search(
          words,
          { ...YAHOO_SEARCH, quotesCount },
          { validateResult: false, fetchOptions: signal ? { signal } : {} },
        ),
      {
        signal,
        notFound: "unavailable",
        notFoundMessage: "Yahoo's search is not at its address (HTTP 404).",
      },
    );
  return deps.cache.remember(
    `yahoo:instrument-search:${words.toLowerCase()}`,
    YAHOO_KEEP_MS,
    async () => {
      let asked: number = YAHOO_SEARCH.quotesCount;
      let answer: unknown;
      try {
        answer = await ask(asked);
      } catch (error) {
        if (error instanceof DataError && error.details.status === 400) return [];
        throw error;
      }
      while (quoteCount(answer) === asked) {
        asked *= 10;
        try {
          answer = await ask(asked);
        } catch (error) {
          if (signal?.aborted || !(error instanceof DataError)) throw error;
          break;
        }
      }
      return hitsOf(answer);
    },
    { signal },
  );
}

/** How many quote rows Yahoo's search answered (none when it answered no list of them). */
function quoteCount(answer: unknown): number {
  const quotes = (answer as { quotes?: unknown } | null)?.quotes;
  return Array.isArray(quotes) ? quotes.length : 0;
}

/**
 * What Yahoo's search is asked for a search, or undefined when Yahoo is not asked: text in another script
 * (Yahoo refuses Hangul); a typed key the catalogs resolve, a series key, a key of a venue Yahoo does not
 * list. A key is asked as its Yahoo symbol, a Korean listing by its code or its Yahoo symbol, anything else
 * as written.
 */
function yahooWords(search: string, listing: Listing): string | undefined {
  if (OTHER_SCRIPT.test(search) || !/[\p{L}\p{N}]/u.test(search)) return undefined;
  if (!search.includes(":")) return search;
  switch (listing.kind) {
    case "us":
      return listing.yahoo;
    case "venue":
      return listing.yahoo ?? undefined;
    case "kr":
      return listing.market ? listing.yahoo[0] : listing.code;
    case "future":
      return listing.known ? undefined : listing.yahoo;
    case "fx":
      return knownPair(listing) ? undefined : listing.yahoo;
    case "crypto":
      return COIN_ENTRY.has(listing.key) ? undefined : listing.yahoo;
    default:
      return undefined;
  }
}

/** Whether Yahoo's match is the listing a search names by its key, its ticker or Yahoo's symbol. */
function sameListing(hit: Hit, search: string, listing: Listing): boolean {
  if (hit.symbol === search.toUpperCase()) return true;
  if (canonicalKey(search) === hit.key) return true;
  if (hit.category === "us" && secTicker(search) === hit.key) return true;
  return listing.kind === "kr" && hit.category === "kr" && hit.key.endsWith(`:${listing.code}`);
}

function yahooTier(hit: Hit, search: string, listing: Listing): Tier {
  if (sameListing(hit, search, listing)) return TIER.key;
  const security = hit.category === "us" || hit.category === "venue" || hit.category === "kr";
  if (security && hit.yahooName && companyName(hit.yahooName) === companyName(search)) return TIER.company;
  return TIER.yahoo;
}

// OpenDART's company list ----------------------------------------------------------------------------------

/**
 * The codes KRX gives a company's preferred shares beside its common share's (a code ending in 0): the
 * common's first five characters and 5, 7 or 9 (older listings) or K, L or M (newer ones).
 */
export function preferredCodes(code: string): string[] {
  if (!/^[0-9][0-9A-Z]{4}0$/.test(code)) return [];
  return ["5", "7", "9", "K", "L", "M"].map((last) => `${code.slice(0, 5)}${last}`);
}

/** A company of OpenDART's list as answers name it: its Korean name, with its English one when given. */
function dartName(company: DartCompany): string {
  return company.corp_eng_name ? `${company.corp_name} (${company.corp_eng_name})` : company.corp_name;
}

/** A Korean listing's code and market, from its key (XKRX:005930). */
function koreanKeyOf(key: string): { market: KoreanMarket; code: string } | undefined {
  const listing = parseListing(key);
  return listing.kind === "kr" && listing.market ? { market: listing.market, code: listing.code } : undefined;
}

/** A listed company of OpenDART's list a search names, before its market is known. */
type DartWanted = {
  company: DartCompany;
  code: string;
  tier: Tier;
  /** The company named exactly: its preferred shares are looked for too. */
  exact: boolean;
};

/**
 * The listed companies of OpenDART's list a search names, each code once (as the list's row for it): the one
 * listed under a Korean code or key, or those whose names answer the search, best first (sources/dart.ts).
 */
function dartWanted(list: DartCorpList, search: string, listing: Listing): DartWanted[] {
  if (listing.kind === "kr") {
    const company = list.byStockCode(listing.code);
    return company ? [{ company, code: listing.code, tier: TIER.key, exact: false }] : [];
  }
  const wanted = new Map<string, DartWanted>();
  for (const { company, tier } of list.search(search)) {
    const code = company.stock_code;
    if (!code || wanted.has(code)) continue;
    wanted.set(code, {
      company: list.byStockCode(code) ?? company,
      code,
      tier: tier === "exact" ? TIER.company : TIER.filer,
      exact: tier === "exact",
    });
  }
  return [...wanted.values()];
}

/** Yahoo's quotes of Korean listings' symbols, in one request, by symbol; kept an hour. */
async function koreanQuotes(
  deps: ForkDeps,
  symbols: readonly string[],
  call: Call | undefined,
): Promise<ReadonlyMap<string, Raw>> {
  return deps.cache.remember(
    `yahoo:korean-listings:${symbols.join(",")}`,
    YAHOO_KEEP_MS,
    () => readQuotes(deps, symbols, call),
    { signal: call?.signal },
  );
}

/**
 * OpenDART's matches, each placed on its market: by Yahoo's search where it found the listing, else by one
 * batched quote of the candidates' KOSPI and KOSDAQ spellings, which also asks for the preferred shares of the
 * company named exactly. A listing Yahoo places on no market is left out; so is every one the quote was needed
 * for when it failed (its failure answered with the matches).
 */
async function dartCandidates(
  deps: ForkDeps,
  list: DartCorpList,
  search: string,
  listing: Listing,
  hits: readonly Hit[],
  call: Call | undefined,
): Promise<{ candidates: Candidate[]; failure?: DataError }> {
  const wanted = dartWanted(list, search, listing);
  if (!wanted.length) return { candidates: [] };
  // The markets Yahoo's search found each code on.
  const placed = new Map<string, Set<KoreanMarket>>();
  for (const hit of hits) {
    const found = hit.category === "kr" ? koreanKeyOf(hit.key) : undefined;
    if (!found) continue;
    const markets = placed.get(found.code) ?? new Set<KoreanMarket>();
    markets.add(found.market);
    placed.set(found.code, markets);
  }
  const symbols = new Set<string>();
  for (const one of wanted) {
    if (!placed.has(one.code) || one.exact) {
      for (const { symbol } of koreanCandidates(one.code)) symbols.add(symbol);
    }
    if (!one.exact) continue;
    for (const code of preferredCodes(one.code)) {
      for (const { symbol } of koreanCandidates(code)) symbols.add(symbol);
    }
  }
  let quoted: ReadonlyMap<string, Raw> = new Map();
  let failure: DataError | undefined;
  if (symbols.size) {
    try {
      quoted = await koreanQuotes(deps, [...symbols].sort(), call);
    } catch (error) {
      if (!(error instanceof DataError) || call?.signal?.aborted) throw error;
      failure = error;
    }
  }
  const candidates: Candidate[] = [];
  for (const one of wanted) {
    // The market Yahoo places the listing on (a key typed with the other market's prefix finds the listing).
    const markets = new Set<KoreanMarket>(placed.get(one.code));
    for (const { market, symbol } of koreanCandidates(one.code)) if (quoted.has(symbol)) markets.add(market);
    for (const market of markets) {
      const suffix = KOREAN_MARKETS[market].yahooSuffix;
      const row = quoted.get(`${one.code}${suffix}`);
      candidates.push({
        key: `${market}:${one.code}`,
        category: "kr",
        tier: one.tier,
        from: "dart",
        name: dartName(one.company),
        type: "stock",
        traded: true,
        fund: FUNDS.has(text(row?.quoteType)?.toUpperCase() ?? ""),
        dart: one.company,
      });
      if (markets.size === 1) await rememberKorean(deps, one.code, market);
      // The preferred shares Yahoo quotes on the same market under the company's name.
      const named = text(row?.longName);
      if (!one.exact || !named) continue;
      for (const code of preferredCodes(one.code)) {
        const preferred = quoted.get(`${code}${suffix}`);
        if (!preferred || text(preferred.longName) !== named) continue;
        const listed = list.byStockCode(code);
        candidates.push({
          key: `${market}:${code}`,
          category: "kr",
          tier: one.tier,
          from: "dart",
          name: dartName(one.company),
          type: "preferred stock",
          traded: true,
          ...(listed ? { dart: listed } : {}),
        });
      }
    }
  }
  return { candidates, ...(failure ? { failure } : {}) };
}

// The search -----------------------------------------------------------------------------------------------

/** What this setup knows of SEC's ticker list for this search: not set up, read, or not read. */
type SecState = "off" | "read" | "unread";

/** What this setup knows of OpenDART's company list for this search: not set up, read, or not read. */
type DartState = "off" | "read" | "unread";

/** How the search was answered, for each match's capabilities. */
type Known = { sec: SecState; dart: DartState };

/** The capabilities this setup serves a match's key with (see the top of this file). */
function servesOf(found: Found, { sec, dart }: Known): Capability[] {
  const listed: Capability[] = [
    "quotes",
    "priceHistory",
    "technicals",
    "profiles",
    "ownership",
    "corporateActions",
    "news",
  ];
  const priced: Capability[] = ["quotes", "priceHistory", "technicals", "news"];
  switch (found.category) {
    case "us": {
      // A ticker SEC's list does not hold is no filer's; when the list could not be read, SEC is asked.
      const filer = sec !== "off" && (found.sec !== undefined || sec === "unread");
      const yahoo = found.traded;
      return [
        ...(yahoo ? (["quotes", "priceHistory", "technicals", "profiles"] as const) : []),
        ...(filer && !found.fund ? (["statements"] as const) : []),
        ...(filer ? (["filings"] as const) : []),
        ...(yahoo || filer ? (["ownership"] as const) : []),
        ...(yahoo ? (["corporateActions"] as const) : []),
        "news",
      ];
    }
    case "kr": {
      // A code OpenDART's list does not hold is no filer's; when the list could not be read, OpenDART is asked.
      const filer = dart !== "off" && (found.dart !== undefined || dart === "unread");
      if (!filer) return listed;
      return [
        "quotes",
        "priceHistory",
        "technicals",
        "profiles",
        ...(found.fund ? [] : (["statements"] as const)),
        "filings",
        "ownership",
        "corporateActions",
        "news",
      ];
    }
    case "venue":
      return listed;
    case "fx":
      return ecbPair(found.key) ? priced : priced.filter((capability) => capability !== "priceHistory");
    case "future":
    case "crypto":
    case "price_series":
      return priced;
    case "value_series":
      return ["macroSeries"];
  }
}

function matchOf(found: Found, known: Known): InstrumentMatch {
  const security = found.category === "us" || found.category === "venue" || found.category === "kr";
  return {
    key: found.key,
    name: found.name,
    type: found.type,
    listing_state: security && found.traded ? "listed" : null,
    serves: servesOf(found, known),
  };
}

/** The failure of every source that failed, one or several. */
function failureOf(failed: readonly DataError[]): DataError {
  const last = failed.at(-1) as DataError;
  if (failed.length === 1) return last;
  const said = failed.map((error) =>
    message("data.attempt", { source: error.details.source, outcome: error.kind, detail: error.message }),
  );
  return new DataError(last.kind, said.join("; "), {
    ...last.details,
    source: failed.map((error) => error.details.source).join(" and "),
    code: "every_source_failed",
  });
}

/** Instruments matching `query`, best first; of one kind when `kind` is given: see the top of this file. */
export async function searchInstruments(
  deps: ForkDeps,
  query: string,
  kind: string | undefined,
  call?: Call,
): Promise<InstrumentMatch[]> {
  const categories =
    kind === undefined ? undefined : Object.hasOwn(KINDS, kind) ? KINDS[kind as keyof typeof KINDS] : null;
  if (categories === null) {
    throw new DataError("invalid", `kind ${kind} is not one of ${INSTRUMENT_KINDS.join(", ")}`, {
      source: INSTRUMENTS_SOURCE,
      retry: "change_request",
    });
  }
  const allows = (category: Category) => !categories || categories.includes(category);
  const search = query.trim().replace(/\s+/g, " ");
  if (!search) return [];
  const listing = parseListing(search);
  const found = collector();
  for (const candidate of catalogCandidates(search, listing, seriesKeysOf(deps.config))) found.add(candidate);

  // SEC's list holds US listings: read for a search in the Latin script, unless a key names another kind.
  const asksSec =
    Boolean(deps.config.secUserAgent) &&
    allows("us") &&
    !OTHER_SCRIPT.test(search) &&
    /[\p{L}\p{N}]/u.test(search) &&
    (listing.kind === "us" ||
      (listing.kind === "venue" && US_VENUES.has(listing.mic)) ||
      (listing.kind === "invalid" && !search.includes(":")));
  // OpenDART's list holds Korean companies: read with DART_API_KEY for a name, or a Korean code or key.
  const asksDart =
    Boolean(deps.config.dartKey) &&
    allows("kr") &&
    /[\p{L}\p{N}]/u.test(search) &&
    (listing.kind === "kr" || listing.kind === "us" || (listing.kind === "invalid" && !search.includes(":")));
  // Yahoo lists no economic series, and its price series are the catalog's.
  const seriesOnly = categories?.every(
    (category) => category === "price_series" || category === "value_series",
  );
  const asked = seriesOnly ? undefined : yahooWords(search, listing);
  const [secRead, yahooRead, dartRead] = await Promise.allSettled([
    asksSec ? secCandidates(deps, search, call) : Promise.resolve(undefined),
    asked === undefined ? Promise.resolve(undefined) : yahooHits(deps, asked, call),
    asksDart ? dartSource(deps).corpList(call) : Promise.resolve(undefined),
  ]);
  if (call?.signal?.aborted) throw call.signal.reason;
  const failed: DataError[] = [];
  for (const read of [secRead, yahooRead, dartRead]) {
    if (read.status === "rejected") {
      if (!(read.reason instanceof DataError)) throw read.reason;
      failed.push(read.reason);
    }
  }
  const list = dartRead.status === "fulfilled" ? dartRead.value : undefined;
  const hits = yahooRead.status === "fulfilled" ? (yahooRead.value ?? []) : [];
  for (const hit of hits) {
    // A Korean listing Yahoo finds is OpenDART's company when the list holds its code.
    const korean = list && hit.category === "kr" ? koreanKeyOf(hit.key) : undefined;
    const company = korean ? list?.byStockCode(korean.code) : undefined;
    found.add({ ...hit, tier: yahooTier(hit, search, listing), ...(company ? { dart: company } : {}) });
  }
  if (secRead.status === "fulfilled") for (const candidate of secRead.value ?? []) found.add(candidate);
  if (list) {
    const { candidates, failure } = await dartCandidates(deps, list, search, listing, hits, call);
    for (const candidate of candidates) found.add(candidate);
    if (failure) failed.push(failure);
  }

  const known: Known = {
    sec: !deps.config.secUserAgent
      ? "off"
      : secRead.status === "fulfilled" && secRead.value
        ? "read"
        : "unread",
    dart: !deps.config.dartKey ? "off" : list ? "read" : "unread",
  };
  const matches = found
    .sorted()
    .filter((one) => allows(one.category))
    .map((one) => matchOf(one, known));
  if (!matches.length) {
    // A Korean series named exactly: its key is what is missing, whatever else failed.
    const series = seriesKeyNeeded(deps, search, allows);
    if (series) throw series;
    if (failed.length) throw failureOf(failed);
    // A name in Hangul: only OpenDART's company list reads Korean names here.
    if (!deps.config.dartKey && allows("kr") && hasHangul(search)) {
      throw dartKeyNeeded("Finding Korean companies by their Korean names");
    }
  }
  return matches;
}

/**
 * The failure of a search that found nothing because it names exactly a Korean series of the catalog this
 * setup lacks the key of: that key, as macro_series says it. Undefined otherwise.
 */
function seriesKeyNeeded(
  deps: ForkDeps,
  search: string,
  allows: (category: Category) => boolean,
): DataError | undefined {
  if (!allows("value_series")) return undefined;
  const keys = seriesKeysOf(deps.config);
  const named = searchCatalog(search, "all").find((match) => match.exact && !servedWith(match.entry, keys));
  if (!named) return undefined;
  const what = `${named.entry.name} (series:${named.entry.key})`;
  return named.entry.origin.publisher === "kosis" ? kosisKeyNeeded(what) : ecosKeyNeeded(what);
}
