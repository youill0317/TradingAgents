// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The fixture routes the market views' tests (markets.test.ts, markets-failures.test.ts) share; it holds no
 * test of its own. Yahoo answers each batched quote request with the row of every symbol it asks for that a
 * fixture quotes (test/fork/fixtures/markets/quotes.json, then the hand-made quotes of
 * test/fork/fixtures/yahoo), leaving out the others as Yahoo leaves out symbols it does not know; every other
 * request is a fixture's: Yahoo's screens and charts (markets/), the Treasury's curves (treasury/), the New
 * York Fed's rates (nyfed/), the ECB's key interest rates (ecb/, markets/), FRED's keyless download (fred/,
 * markets/).
 */
import type { MarketViewName } from "../../../src/data/capabilities.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import { type FixtureFetch, type FixtureRoute, fixture, fixtureFetch, YAHOO_AAPL } from "./harness.js";

type Row = Record<string, unknown>;

function rowsOf(file: string): Row[] {
  const answer = JSON.parse(new TextDecoder().decode(fixture(file))) as { quoteResponse: { result: Row[] } };
  return answer.quoteResponse.result;
}

/** Every quote row the fixtures hold, by Yahoo symbol: markets/quotes.json first, then yahoo/'s. */
export const POOL: ReadonlyMap<string, Row> = (() => {
  const pool = new Map<string, Row>();
  for (const file of [
    "markets/quotes.json",
    "yahoo/quote-gspc.json",
    "yahoo/quote-cl-f.json",
    "yahoo/quote-eurusd-x.json",
    "yahoo/quote-btc-usd.json",
  ]) {
    for (const row of rowsOf(file)) if (!pool.has(row.symbol as string)) pool.set(row.symbol as string, row);
  }
  return pool;
})();

/** The pool without some symbols, as Yahoo answers when it does not know them. */
export function poolWithout(...symbols: string[]): ReadonlyMap<string, Row> {
  return new Map([...POOL].filter(([symbol]) => !symbols.includes(symbol)));
}

/** A request to one of Yahoo's API hosts with this path. */
export const yahooPath =
  (path: string) =>
  (url: URL): boolean =>
    /^query\d\.finance\.yahoo\.com$/.test(url.hostname) && decodeURIComponent(url.pathname) === path;

/** Yahoo's quote requests: answered from the pool (see marketsFetch). */
const QUOTES: FixtureRoute = {
  match: yahooPath("/v7/finance/quote"),
  body: "{}",
  headers: { "content-type": "application/json;charset=utf-8" },
};

/** The rotation's charts: the 11 sector funds and SPY. */
export const CHART_SYMBOLS = [
  "XLE",
  "XLB",
  "XLI",
  "XLY",
  "XLP",
  "XLV",
  "XLF",
  "XLK",
  "XLC",
  "XLU",
  "XLRE",
  "SPY",
];

/** A chart fixture's closes, by date (New York), oldest first. */
export function closesOf(symbol: string): { date: string; close: number }[] {
  const answer = JSON.parse(
    new TextDecoder().decode(fixture(`markets/chart-${symbol.toLowerCase()}-1d.json`)),
  ) as {
    chart: { result: { timestamp: number[]; indicators: { adjclose: { adjclose: number[] }[] } }[] };
  };
  const [result] = answer.chart.result;
  const closes = result?.indicators.adjclose[0]?.adjclose ?? [];
  return (result?.timestamp ?? []).map((time, index) => ({
    date: new Date((time - 5 * 3600) * 1000).toISOString().slice(0, 10),
    close: closes[index] as number,
  }));
}

/** The Treasury's file of `curve` for `year`. */
export const treasury = (kind: "par" | "real", year: number): ((url: URL) => boolean) => {
  return (url) =>
    url.hostname === "home.treasury.gov" &&
    url.pathname.endsWith(`/daily-treasury-rates.csv/${year}/all`) &&
    url.searchParams.get("type") ===
      (kind === "par" ? "daily_treasury_yield_curve" : "daily_treasury_real_yield_curve");
};

/** FRED's keyless download of `code`. */
export const fredGraph =
  (code: string) =>
  (url: URL): boolean =>
    url.hostname === "fred.stlouisfed.org" && url.searchParams.get("id") === code;

/** FRED's API, for series `code`. */
export const fredApi =
  (code: string) =>
  (url: URL): boolean =>
    url.hostname === "api.stlouisfed.org" && url.searchParams.get("series_id") === code;

/** One of the ECB's key interest rates since 2024. */
export const ecbRate =
  (rate: string) =>
  (url: URL): boolean =>
    url.hostname === "data-api.ecb.europa.eu" &&
    url.pathname === `/service/data/FM/D.U2.EUR.4F.KR.${rate}.LEV` &&
    url.searchParams.get("startPeriod") === "2024-01-01";

/** One of the New York Fed's rates, its latest days. */
export const nyfed =
  (rate: string) =>
  (url: URL): boolean =>
    url.hostname === "markets.newyorkfed.org" && url.pathname.endsWith(`/${rate}/last/5.json`);

/** Every fixture of the views. */
export const ROUTES: readonly FixtureRoute[] = [
  { match: treasury("par", 2026), file: "treasury/par-2026.csv" },
  { match: treasury("real", 2026), file: "treasury/real-2026.csv" },
  { match: nyfed("effr"), file: "nyfed/effr-last5.json" },
  { match: nyfed("sofr"), file: "nyfed/sofr-last5.json" },
  { match: nyfed("obfr"), file: "nyfed/obfr-last5.json" },
  { match: ecbRate("DFR"), file: "ecb/fm-dfr-since2024.csv" },
  { match: ecbRate("MRR_FR"), file: "markets/ecb-fm-mrr-fr-since2024.csv" },
  { match: ecbRate("MLFR"), file: "markets/ecb-fm-mlfr-since2024.csv" },
  ...["CPIAUCSL", "CPILFESL", "UNRATE", "PAYEMS", "GDPC1"].map((code) => ({
    match: fredGraph(code),
    file: `fred/graph-${code.toLowerCase()}.csv`,
  })),
  ...[
    "PCEPI",
    "PCEPILFE",
    "ICSA",
    "A191RL1Q225SBEA",
    "BAMLH0A0HYM2",
    "BAMLC0A0CM",
    "BAA10Y",
    "IRSTCB01JPM156N",
    "IRSTCB01INM156N",
  ].map((code) => ({ match: fredGraph(code), file: `markets/fred-graph-${code.toLowerCase()}.csv` })),
  // Each screen's first page; the gainers' runs on to a second, from row 6.
  ...["day_gainers", "day_losers", "most_actives"].map((id) => ({
    match: (url: URL) =>
      yahooPath("/v1/finance/screener/predefined/saved")(url) &&
      url.searchParams.get("scrIds") === id &&
      (url.searchParams.get("start") ?? "0") === "0",
    file: `markets/screener-${id.replaceAll("_", "-")}.json`,
  })),
  {
    match: (url: URL) =>
      yahooPath("/v1/finance/screener/predefined/saved")(url) &&
      url.searchParams.get("scrIds") === "day_gainers" &&
      url.searchParams.get("start") === "5",
    file: "markets/screener-day-gainers-start5.json",
  },
  ...CHART_SYMBOLS.map((symbol) => ({
    match: (url: URL) =>
      yahooPath(`/v8/finance/chart/${symbol}`)(url) && url.searchParams.get("interval") === "1d",
    file: `markets/chart-${symbol.toLowerCase()}-1d.json`,
  })),
];

/** What a markets test builds on: its own routes (before the views'), a quote pool, settings, the day. */
export type SetupOptions = {
  routes?: readonly FixtureRoute[];
  pool?: ReadonlyMap<string, Row>;
  config?: PublicDataConfig;
  now?: string;
};

/**
 * A fixture fetch over `routes`, then the views' (ROUTES), then Yahoo's cookie page and crumb: a quote request
 * a route answers with 200 is answered from `pool` (POOL unless given), the rows of the symbols it asks for.
 */
export function marketsFetch({ routes = [], pool = POOL }: SetupOptions = {}): FixtureFetch {
  const base = fixtureFetch([...routes, QUOTES, ...ROUTES, ...YAHOO_AAPL]);
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await base(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!yahooPath("/v7/finance/quote")(url) || !response.ok) return response;
    const asked = (url.searchParams.get("symbols") ?? "").split(",");
    const result = asked.flatMap((symbol) => (pool.has(symbol) ? [pool.get(symbol)] : []));
    return new Response(JSON.stringify({ quoteResponse: { result, error: null } }), {
      status: 200,
      headers: response.headers,
    });
  };
  return Object.assign(answer, { requests: base.requests, unmatched: base.unmatched }) as FixtureFetch;
}

/** An answer written inline (hand-made, in the shape its endpoint answers). */
export function inline(match: FixtureRoute["match"], body: unknown, status = 200): FixtureRoute {
  return {
    match,
    body: typeof body === "string" ? body : JSON.stringify(body),
    status,
    headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json" },
  };
}

/**
 * The keys each view's rows and summary must hold (null allowed): what the previews and the specs read. The read
 * check cannot see them, as the tool passes the rows and the summary on whole (markets.test.ts, all-tools.test.ts).
 */
const QUOTED = {
  "rows[]": ["instrument", "key", "price", "change", "source"],
  "rows[].change": ["absolute", "percent", "absolute_unit"],
};
const POINT = {
  "rows[]": ["maturity", "key", "unit", "latest", "previous", "change", "source"],
  "rows[].latest": ["value", "date"],
};
const SERIES = {
  "rows[]": ["key", "unit", "latest", "previous", "change", "source"],
  "rows[].latest": ["value", "date"],
};

export const VIEW_KEYS: { readonly [View in MarketViewName]: Readonly<Record<string, readonly string[]>> } = {
  equity_summary: {
    ...QUOTED,
    "summary.breadth": ["positive_sectors", "measured_sectors", "total_sectors", "breadth_percent"],
  },
  sectors: { ...QUOTED, "rows[]": [...QUOTED["rows[]"], "rank", "sector"] },
  gainers: { ...QUOTED, "rows[]": [...QUOTED["rows[]"], "rank", "volume", "market_cap"], "": ["summary"] },
  losers: { ...QUOTED, "rows[]": [...QUOTED["rows[]"], "rank", "volume", "market_cap"] },
  most_active: { ...QUOTED, "rows[]": [...QUOTED["rows[]"], "rank", "volume", "market_cap"] },
  volatility: {
    summary: ["spot", "vix_9d", "vix_3m", "vix_6m", "vix_1y", "structure"],
    "summary.spot": ["price"],
    "summary.vix_3m": ["price"],
  },
  yield_curve: POINT,
  central_banks: { "rows[]": ["bank", "rate", "key", "unit", "latest", "source"] },
  credit_spreads: { ...SERIES, "rows[]": [...SERIES["rows[]"], "name", "title"] },
  energy: QUOTED,
  metals: QUOTED,
  agriculture: QUOTED,
  fx: QUOTED,
  cross_asset: { ...QUOTED, "rows[]": [...QUOTED["rows[]"], "group"] },
  crypto: { ...QUOTED, "rows[]": [...QUOTED["rows[]"], "rank", "market_cap"] },
  macro: {
    ...SERIES,
    "rows[]": [...SERIES["rows[]"], "name", "year_ago", "change_1y"],
    "rows[].latest": ["value", "date", "period", "known_from"],
  },
  indices: { ...QUOTED, "rows[]": [...QUOTED["rows[]"], "region"] },
  sector_rotation: {
    "rows[]": [
      "rank",
      "sector",
      "key",
      "return_1w",
      "return_1m",
      "return_3m",
      "relative_1w",
      "relative_1m",
      "relative_3m",
      "score",
      "source",
    ],
    summary: ["leading_sectors", "lagging_sectors", "rotation_signal", "method", "benchmark"],
  },
  tips_breakevens: { ...POINT, "rows[]": [...POINT["rows[]"], "nominal", "real"] },
  rate_indicators: { ...QUOTED, summary: ["fed_funds_target"] },
  commodity_benchmarks: QUOTED,
  livestock: QUOTED,
};
