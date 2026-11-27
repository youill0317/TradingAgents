// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The market views (src/fork/data/providers/markets.ts) through the real markets tool, the router and the
 * ToolRegistry, on fixtures: Yahoo's quotes, screens and charts (hand-made in yahoo-finance2's schemas, read
 * by the library itself), the Treasury's curves, the New York Fed's rates and the ECB's key interest rates
 * (their answers saved earlier), FRED's keyless download (hand-made). Every one of the 22 views runs as the
 * model's call would and its text is compared whole (golden), with the read check showing that every field
 * the tool reads was supplied, the keys the tool's previews and the specs read checked on its rows and
 * summary, and each row naming its source. The failures are in markets-failures.test.ts. No request reaches
 * the network.
 */
import { describe, expect, test } from "bun:test";
import { type DataProvider, MARKET_VIEWS, type MarketViewName } from "../../../src/data/capabilities.js";
import { FRED_BANK_RATES } from "../../../src/fork/data/catalog/markets.js";
import { catalogSeries } from "../../../src/fork/data/catalog/series.js";
import { parseListing } from "../../../src/fork/data/listings.js";
import { marketsProvider } from "../../../src/fork/data/providers/markets.js";
import { marketsTool } from "../../../src/tools/markets.js";
import { previewOf } from "../../../src/tools/preview.js";
import { buildTools, expectKeys, readLog, testDeps, testProviders } from "./harness.js";
import {
  CHART_SYMBOLS,
  closesOf,
  marketsFetch,
  type SetupOptions,
  VIEW_KEYS,
} from "./markets-routes.test.js";

/** The fork's providers over the market views' fixtures, and the tools over them. */
function setup(options: SetupOptions = {}) {
  const fetch = marketsFetch(options);
  const { providers, clock } = testProviders(
    options.config ?? {},
    fetch,
    options.now ? { now: options.now } : {},
  );
  const tools = buildTools(providers, { clock, check: true });
  return { ...tools, providers, fetch };
}

/** The text the model reads, compared whole with the golden one. */
function golden(name: string, text: string): void {
  if (GOLDEN[name] === undefined) console.log(`GOLDEN ${name}:\n${text}\n`);
  expect(GOLDEN[name]).toBeDefined();
  expect(text).toBe(GOLDEN[name] as string);
}

type Payload = {
  view: string;
  through: string | null;
  stale: boolean;
  summary: Record<string, unknown>;
  coverage: { requested: number | null; measured: number | null; byReason: unknown[] } | null;
  missing: { key: string; reason?: string | null }[];
  rows: Record<string, unknown>[];
  more: boolean;
};

/** Which preview each view's rows get, as markets.ts picks them (the first hint all rows fit). */
const PREVIEW: { readonly [View in MarketViewName]: "quoted" | "point" | "volatility" | "none" } = {
  equity_summary: "quoted",
  sectors: "quoted",
  gainers: "quoted",
  losers: "quoted",
  most_active: "quoted",
  volatility: "volatility",
  yield_curve: "point",
  central_banks: "none",
  credit_spreads: "none",
  energy: "quoted",
  metals: "quoted",
  agriculture: "quoted",
  fx: "quoted",
  cross_asset: "quoted",
  crypto: "quoted",
  macro: "none",
  indices: "quoted",
  sector_rotation: "none",
  tips_breakevens: "point",
  rate_indicators: "quoted",
  commodity_benchmarks: "quoted",
  livestock: "quoted",
};

/** The markets tool's previews, to see which one a payload gets. */
const TOOL = marketsTool({ view: async () => ({ data: {} as never, source: "", notes: [], after: [] }) });

describe("what the markets provider declares", () => {
  test("markets.view in every setup, built without a request", () => {
    for (const config of [
      {},
      { fredKey: "fred-test-key-0123456789abcdef", secUserAgent: "Test Agent test@example.com" },
    ]) {
      const { deps, fetch } = testDeps(config);
      const markets = marketsProvider(deps) as DataProvider;
      expect(markets.name).toBe("Market overview");
      expect(
        Object.fromEntries(
          Object.entries(markets.capabilities).map(([name, methods]) => [
            name,
            Object.keys(methods as object),
          ]),
        ),
      ).toEqual({
        markets: ["view"],
      });
      expect(fetch.requests).toEqual([]);
    }
  });

  test("through every fork provider, the router sends markets to it", () => {
    const { available } = setup();
    expect(available.has("markets")).toBe(true);
  });
});

describe("every view, through the markets tool", () => {
  for (const view of MARKET_VIEWS) {
    test(view, async () => {
      const { runTool, fetch } = setup();
      const run = await runTool("markets", { view });
      expect(run.failure, run.text).toBeUndefined();
      expect(run.source).toBe("Market overview");
      golden(view, run.text);
      // Every field the tool read of the answer was supplied.
      expect(run.reads.paths().length).toBeGreaterThan(0);
      expect(run.reads.missing()).toEqual([]);
      // The keys its previews and the specs read, on every row and in the summary.
      const payload = run.payload as Payload;
      const log = readLog();
      expectKeys(payload, VIEW_KEYS[view], log);
      expect(log.missing()).toEqual([]);
      expect(log.paths().length).toBeGreaterThan(0);
      // Every row names its own source, and the view asked no request a fixture did not answer.
      for (const row of payload.rows) expect(typeof row.source, JSON.stringify(row)).toBe("string");
      expect(fetch.unmatched).toEqual([]);
      // The preview the person watching sees.
      const preview = previewOf(payload, { specs: TOOL.preview ?? [], year: 2026 });
      if (PREVIEW[view] === "none") expect(preview).toBeUndefined();
      else expect(preview?.rows.length, view).toBeGreaterThan(0);
      if (PREVIEW[view] === "point")
        expect(preview?.rows[0]).toEqual([String(payload.rows[0]?.maturity), expect.stringMatching(/%$/)]);
      if (PREVIEW[view] === "volatility") {
        expect(preview?.rows[0]?.[0]).toStartWith("VIX ");
        expect(preview?.rows[0]).toContain(String(payload.summary.structure));
      }
    });
  }
});

describe("what the views say", () => {
  test("keys the model copies are keys the tools take", async () => {
    const { runTool, fetch } = setup();
    const keys = new Set<string>();
    for (const view of MARKET_VIEWS) {
      const payload = (await runTool("markets", { view })).payload as Payload;
      for (const row of payload.rows) {
        if (typeof row.key !== "string") continue;
        // The screens' listings (invented companies in the fixtures) are US tickers as the tools spell them.
        if (view === "gainers" || view === "losers" || view === "most_active") {
          expect(parseListing(row.key)).toMatchObject({ kind: "us", key: row.key });
        } else keys.add(row.key);
      }
    }
    for (const key of keys) {
      // The instrument search names each typed key a view gives as that instrument, from its catalogs and
      // without a request (a ticker it looks up in Yahoo's search, which these fixtures do not answer).
      if (key.includes(":")) {
        const found = await runTool("find_instrument", { query: key });
        expect(found.failure, `${key}: ${found.text}`).toBeUndefined();
        expect((found.payload as { matches: { key: string }[] }).matches[0]?.key, key).toBe(key);
      }
      // Quotes and price history take tickers and typed keys; macro_series takes series keys, each one its
      // catalog holds, so it reads them without a search and, for FRED's, without FRED_API_KEY.
      if (
        key.startsWith("series:us.treasury.") ||
        key.startsWith("series:us.nyfed.") ||
        key.startsWith("series:ea.ecb.") ||
        key.startsWith("series:us.fred.")
      ) {
        expect(key, key).toMatch(/^series:[a-z0-9_]+(\.[a-z0-9_]+)+$/);
        expect(catalogSeries(key), key).toBeDefined();
        const read = await runTool("macro_series", { series: key, periods: 5 });
        expect(read.failure, `${key}: ${read.text}`).toBeUndefined();
        continue;
      }
      const quoted = await runTool("quote", { symbols: [key] });
      expect(quoted.failure, `${key}: ${quoted.text}`).toBeUndefined();
    }
    // The central banks FRED serves: catalog/series.ts reads them as the view does.
    for (const bank of FRED_BANK_RATES) {
      const entry = catalogSeries(`us.fred.${bank.id.toLowerCase()}`);
      expect(entry?.origin, bank.id).toEqual({ publisher: "fred", id: bank.id });
      expect(entry?.period, bank.id).toBe(bank.period);
    }
    expect(fetch.unmatched).toEqual([]);
  });

  test("sectors ranks the 11 funds by the session's move; equity_summary counts the funds that rose", async () => {
    const { runTool } = setup();
    const sectors = (await runTool("markets", { view: "sectors" })).payload as Payload;
    const moves = sectors.rows.map((row) => (row.change as { percent: number }).percent);
    expect(moves).toEqual([...moves].sort((a, b) => b - a));
    expect(sectors.rows.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const summary = (await runTool("markets", { view: "equity_summary" })).payload as Payload;
    expect(summary.summary.breadth).toMatchObject({
      positive_sectors: moves.filter((move) => move > 0).length,
      measured_sectors: 11,
      total_sectors: 11,
    });
  });

  test("crypto ranks the assets by the market capitalization Yahoo states", async () => {
    const { runTool } = setup();
    const payload = (await runTool("markets", { view: "crypto" })).payload as Payload;
    const caps = payload.rows.map((row) => row.market_cap as number);
    expect(caps).toEqual([...caps].sort((a, b) => b - a));
    expect(payload.summary.listed_market_cap).toBe(caps.reduce((sum, cap) => sum + cap, 0));
  });

  test("the volatility term structure: contango when the 3-month VIX is above spot", async () => {
    const { runTool } = setup();
    const payload = (await runTool("markets", { view: "volatility" })).payload as Payload;
    const price = (field: string) => (payload.summary[field] as { price: number }).price;
    expect(price("vix_3m")).toBeGreaterThan(price("spot"));
    expect(payload.summary.structure).toBe("contango");
    expect(payload.rows).toEqual([]);
  });

  test("breakevens are the par yield less the real yield, from the Treasury's curves of one day", async () => {
    const { runTool } = setup();
    const payload = (await runTool("markets", { view: "tips_breakevens" })).payload as Payload;
    for (const row of payload.rows) {
      const latest = row.latest as { value: number };
      expect(latest.value).toBeCloseTo((row.nominal as number) - (row.real as number), 10);
    }
  });

  test("sector_rotation's returns are the funds' closes over each window, less SPY's", async () => {
    const { runTool } = setup();
    const payload = (await runTool("markets", { view: "sector_rotation" })).payload as Payload;
    const windows = payload.summary.windows as Record<"1w" | "1m" | "3m", { from: string; to: string }>;
    const returnOf = (symbol: string, window: "1w" | "1m" | "3m") => {
      const closes = closesOf(symbol);
      const end = closes.filter((bar) => bar.date <= windows[window].to).at(-1) as { close: number };
      const start = closes.filter((bar) => bar.date <= windows[window].from).at(-1) as { close: number };
      return ((end.close - start.close) / start.close) * 100;
    };
    expect(payload.rows).toHaveLength(CHART_SYMBOLS.length - 1);
    for (const row of payload.rows) {
      for (const window of ["1w", "1m", "3m"] as const) {
        const own = returnOf(row.key as string, window);
        expect(row[`return_${window}`] as number).toBeCloseTo(own, 2);
        expect(row[`relative_${window}`] as number).toBeCloseTo(own - returnOf("SPY", window), 1);
      }
    }
    const scores = payload.rows.map((row) => row.score as number);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(payload.summary.leading_sectors).toEqual(payload.rows.slice(0, 3).map((row) => row.sector));
  });

  test("macro gives each statistic with its period, and its changes from the period before and a year earlier", async () => {
    const { runTool } = setup();
    const payload = (await runTool("markets", { view: "macro" })).payload as Payload;
    const cpi = payload.rows.find((row) => row.key === "series:us.fred.cpiaucsl") as Record<string, unknown>;
    expect(cpi).toMatchObject({
      name: "CPI",
      latest: { period: "2026-10", date: "2026-10-01", value: 332.763, known_from: null },
      previous: { period: "2026-09", value: 332.097 },
      change: { absolute: 0.666, percent: 0.2, absolute_unit: null },
      year_ago: { period: "2025-10" },
    });
    const unemployment = payload.rows.find((row) => row.key === "series:us.fred.unrate") as Record<
      string,
      unknown
    >;
    expect(unemployment).toMatchObject({
      change: { percent: null, absolute_unit: { kind: "percentage_points" } },
    });
    // The latest day the statistics reach: the last week's end of the weekly claims.
    expect(payload.through).toBe("2026-11-21");
    expect(payload.stale).toBe(false);
  });
});

/**
 * The golden texts, as the model reads them, on the fixtures of 2026-11-25 (TEST_DAY). Recording the fixtures
 * again (scripts/fork/fixture-cases/markets.ts and the sources' own) changes them.
 */
const GOLDEN: Readonly<Record<string, string>> = {
  equity_summary: `[e1] markets equity_summary (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
equity summary, through 2026-11-25
{"breadth":{"positive_sectors":7,"negative_sectors":4,"unchanged_sectors":0,"measured_sectors":11,"total_sectors":11,"breadth_percent":63.6,"basis":"the SPDR sector funds that rose on the session, of those quoted"}}
{"instrument":"S&P 500","key":"series:us.equity_index.sp500","group":"index","price":6912.4,"change":{"absolute":28.41,"percent":0.4127,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:15:01Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Dow Jones Industrial Average","key":"series:us.equity_index.dow_jones","group":"index","price":47850.12,"change":{"absolute":152.3,"percent":0.3193,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:15:01Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Nasdaq Composite","key":"series:us.equity_index.nasdaq_composite","group":"index","price":23510.55,"change":{"absolute":141.2,"percent":0.6042,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:15:01Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Russell 2000","key":"series:us.equity_index.russell_2000","group":"index","price":2465.3,"change":{"absolute":-8.42,"percent":-0.3404,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:15:01Z","market_state":"closed","source":"Yahoo"}
{"rank":1,"instrument":"Energy Select Sector SPDR Fund","key":"XLE","group":"sector","sector":"energy","price":90.15,"change":{"absolute":1,"percent":1.1217,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":2,"instrument":"Technology Select Sector SPDR Fund","key":"XLK","group":"sector","sector":"information_technology","price":288.4,"change":{"absolute":2.71,"percent":0.9486,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":3,"instrument":"Consumer Discretionary Select Sector SPDR Fund","key":"XLY","group":"sector","sector":"consumer_discretionary","price":232.1,"change":{"absolute":1.96,"percent":0.8517,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":4,"instrument":"Financial Select Sector SPDR Fund","key":"XLF","group":"sector","sector":"financials","price":54.3,"change":{"absolute":0.36,"percent":0.6674,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":5,"instrument":"Industrial Select Sector SPDR Fund","key":"XLI","group":"sector","sector":"industrials","price":152.3,"change":{"absolute":0.64,"percent":0.422,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":6,"instrument":"Communication Services Select Sector SPDR Fund","key":"XLC","group":"sector","sector":"communication_services","price":112.6,"change":{"absolute":0.35,"percent":0.3118,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":7,"instrument":"Health Care Select Sector SPDR Fund","key":"XLV","group":"sector","sector":"health_care","price":146.8,"change":{"absolute":0.22,"percent":0.1501,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":8,"instrument":"Real Estate Select Sector SPDR Fund","key":"XLRE","group":"sector","sector":"real_estate","price":41.2,"change":{"absolute":-0.1,"percent":-0.2421,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":9,"instrument":"Materials Select Sector SPDR Fund","key":"XLB","group":"sector","sector":"materials","price":92.4,"change":{"absolute":-0.32,"percent":-0.3451,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":10,"instrument":"Consumer Staples Select Sector SPDR Fund","key":"XLP","group":"sector","sector":"consumer_staples","price":79.2,"change":{"absolute":-0.38,"percent":-0.4775,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":11,"instrument":"Utilities Select Sector SPDR Fund","key":"XLU","group":"sector","sector":"utilities","price":84.5,"change":{"absolute":-0.61,"percent":-0.7167,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
not included: market_breadth (advancing and declining issues, new highs and lows: no source this app reads publishes them)`,
  sectors: `[e1] markets sectors (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
sectors, through 2026-11-25
{"ranked_by":"the session's percent change, highest first"}
{"rank":1,"instrument":"Energy Select Sector SPDR Fund","key":"XLE","sector":"energy","price":90.15,"change":{"absolute":1,"percent":1.1217,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":2,"instrument":"Technology Select Sector SPDR Fund","key":"XLK","sector":"information_technology","price":288.4,"change":{"absolute":2.71,"percent":0.9486,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":3,"instrument":"Consumer Discretionary Select Sector SPDR Fund","key":"XLY","sector":"consumer_discretionary","price":232.1,"change":{"absolute":1.96,"percent":0.8517,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":4,"instrument":"Financial Select Sector SPDR Fund","key":"XLF","sector":"financials","price":54.3,"change":{"absolute":0.36,"percent":0.6674,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":5,"instrument":"Industrial Select Sector SPDR Fund","key":"XLI","sector":"industrials","price":152.3,"change":{"absolute":0.64,"percent":0.422,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":6,"instrument":"Communication Services Select Sector SPDR Fund","key":"XLC","sector":"communication_services","price":112.6,"change":{"absolute":0.35,"percent":0.3118,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":7,"instrument":"Health Care Select Sector SPDR Fund","key":"XLV","sector":"health_care","price":146.8,"change":{"absolute":0.22,"percent":0.1501,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":8,"instrument":"Real Estate Select Sector SPDR Fund","key":"XLRE","sector":"real_estate","price":41.2,"change":{"absolute":-0.1,"percent":-0.2421,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":9,"instrument":"Materials Select Sector SPDR Fund","key":"XLB","sector":"materials","price":92.4,"change":{"absolute":-0.32,"percent":-0.3451,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":10,"instrument":"Consumer Staples Select Sector SPDR Fund","key":"XLP","sector":"consumer_staples","price":79.2,"change":{"absolute":-0.38,"percent":-0.4775,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}
{"rank":11,"instrument":"Utilities Select Sector SPDR Fund","key":"XLU","sector":"utilities","price":84.5,"change":{"absolute":-0.61,"percent":-0.7167,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:00:01Z","market_state":"post","source":"Yahoo"}`,
  gainers: `[e1] markets gainers (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
gainers, through 2026-11-25
{"screen":"day_gainers","title":"Day Gainers","criteria":"Stocks ordered in descending order by price percent change greater than 3% with respect to the previous close","ranked_by":"percentchange, descending","total":7}
{"rank":1,"instrument":"Quorvis Therapeutics Inc.","key":"QRSV","price":48.62,"change":{"absolute":9.51,"percent":24.31,"absolute_unit":null},"volume":18234500,"average_volume_3m":3120000,"market_cap":4120000000,"currency":"USD","exchange":"NasdaqGS","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}
{"rank":2,"instrument":"Bellnex Systems Inc.","key":"BLNX","price":131.4,"change":{"absolute":14.97,"percent":12.86,"absolute_unit":null},"volume":9876500,"average_volume_3m":2450000,"market_cap":21300000000,"currency":"USD","exchange":"NYSE","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}
{"rank":3,"instrument":"Cardwell Mining Corp.","key":"CRDW","price":22.75,"change":{"absolute":1.96,"percent":9.43,"absolute_unit":null},"volume":14560200,"average_volume_3m":6230000,"market_cap":3870000000,"currency":"USD","exchange":"NYSE","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}
{"rank":4,"instrument":"Vantrum Energy Inc.","key":"VTRM","price":67.18,"change":{"absolute":4.93,"percent":7.92,"absolute_unit":null},"volume":5432100,"average_volume_3m":2210000,"market_cap":8640000000,"currency":"USD","exchange":"NasdaqGS","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}
{"rank":5,"instrument":"Oplique Software Inc.","key":"OPLQ","price":15.06,"change":{"absolute":0.9,"percent":6.35,"absolute_unit":null},"volume":7012300,"average_volume_3m":4105000,"market_cap":2310000000,"currency":"USD","exchange":"NasdaqGM","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}
{"rank":6,"instrument":"Tessaly Robotics Inc.","key":"TSRB","price":33.48,"change":{"absolute":1.63,"percent":5.12,"absolute_unit":null},"volume":4123400,"average_volume_3m":2980000,"market_cap":5210000000,"currency":"USD","exchange":"NYSE","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}
{"rank":7,"instrument":"Marlow Freight Lines Inc.","key":"MRFL","price":58.9,"change":{"absolute":2.31,"percent":4.08,"absolute_unit":null},"volume":3210800,"average_volume_3m":1740000,"market_cap":7940000000,"currency":"USD","exchange":"NasdaqGS","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}`,
  losers: `[e1] markets losers (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
losers, through 2026-11-25
{"screen":"day_losers","title":"Day Losers","criteria":"Stocks ordered in ascending order by price percent change with respect to the previous close","ranked_by":"percentchange, ascending","total":5}
{"rank":1,"instrument":"Halvern Biosciences Inc.","key":"HALV","price":9.84,"change":{"absolute":-4.46,"percent":-31.2,"absolute_unit":null},"volume":25670100,"average_volume_3m":2980000,"market_cap":2050000000,"currency":"USD","exchange":"NasdaqGS","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}
{"rank":2,"instrument":"Merket Retail Group Inc.","key":"MRKT","price":38.12,"change":{"absolute":-6.6,"percent":-14.75,"absolute_unit":null},"volume":8123400,"average_volume_3m":2760000,"market_cap":5610000000,"currency":"USD","exchange":"NYSE","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}
{"rank":3,"instrument":"Spinq Semiconductor Corp.","key":"SPNQ","price":74.5,"change":{"absolute":-7.46,"percent":-9.1,"absolute_unit":null},"volume":6543200,"average_volume_3m":3320000,"market_cap":12800000000,"currency":"USD","exchange":"NasdaqGS","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}
{"rank":4,"instrument":"Travelle Holdings Inc.","key":"TRVL","price":27.3,"change":{"absolute":-2,"percent":-6.84,"absolute_unit":null},"volume":4321000,"average_volume_3m":1980000,"market_cap":3340000000,"currency":"USD","exchange":"NYSE","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}
{"rank":5,"instrument":"Goodrake Foods Inc.","key":"GDRK","price":51.95,"change":{"absolute":-2.75,"percent":-5.02,"absolute_unit":null},"volume":3210400,"average_volume_3m":1570000,"market_cap":6720000000,"currency":"USD","exchange":"NYSE","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}`,
  most_active: `[e1] markets most_active (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
most active, through 2026-11-25
{"screen":"most_actives","title":"Most Actives","criteria":"Stocks ordered in descending order by intraday trade volume","ranked_by":"dayvolume, descending","total":5}
{"rank":1,"instrument":"Novalith Computing Inc.","key":"NVLT","price":182.35,"change":{"absolute":2.55,"percent":1.42,"absolute_unit":null},"volume":245678900,"average_volume_3m":210450000,"market_cap":4450000000000,"currency":"USD","exchange":"NasdaqGS","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}
{"rank":2,"instrument":"Halvern Biosciences Inc.","key":"HALV","price":9.84,"change":{"absolute":-4.46,"percent":-31.2,"absolute_unit":null},"volume":125670100,"average_volume_3m":2980000,"market_cap":2050000000,"currency":"USD","exchange":"NasdaqGS","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}
{"rank":3,"instrument":"Teslavia Motors Inc.","key":"TSLV","price":412.6,"change":{"absolute":-8.64,"percent":-2.05,"absolute_unit":null},"volume":98765400,"average_volume_3m":102340000,"market_cap":1320000000000,"currency":"USD","exchange":"NasdaqGS","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}
{"rank":4,"instrument":"Fordham Auto Works Inc.","key":"FORD","price":12.48,"change":{"absolute":0.09,"percent":0.73,"absolute_unit":null},"volume":76543200,"average_volume_3m":64320000,"market_cap":49800000000,"currency":"USD","exchange":"NYSE","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}
{"rank":5,"instrument":"Planar Data Inc.","key":"PLNR","price":166.2,"change":{"absolute":6.21,"percent":3.88,"absolute_unit":null},"volume":65432100,"average_volume_3m":58760000,"market_cap":392000000000,"currency":"USD","exchange":"NasdaqGS","date":"2026-11-25","time":"2026-11-25T21:00:02Z","market_state":"post","source":"Yahoo"}`,
  volatility: `[e1] markets volatility (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
volatility, through 2026-11-25
{"vix_9d":{"key":"series:us.volatility.vix_9d","price":14.1,"change":{"absolute":-0.6,"percent":-4.0816},"date":"2026-11-25","time":"2026-11-25T21:15:00Z","source":"Yahoo"},"spot":{"key":"series:us.volatility.vix","price":15.85,"change":{"absolute":-0.42,"percent":-2.5814},"date":"2026-11-25","time":"2026-11-25T21:15:00Z","source":"Yahoo"},"vix_3m":{"key":"series:us.volatility.vix_3m","price":17.9,"change":{"absolute":-0.25,"percent":-1.3774},"date":"2026-11-25","time":"2026-11-25T21:15:00Z","source":"Yahoo"},"vix_6m":{"key":"series:us.volatility.vix_6m","price":19.2,"change":{"absolute":-0.15,"percent":-0.7752},"date":"2026-11-25","time":"2026-11-25T21:15:00Z","source":"Yahoo"},"vix_1y":{"key":"series:us.volatility.vix_1y","price":20.4,"change":{"absolute":-0.1,"percent":-0.4878},"date":"2026-11-25","time":"2026-11-25T21:15:00Z","source":"Yahoo"},"structure":"contango","vix_to_vix3m":0.885,"structure_basis":"the 3-month VIX against the spot VIX: contango when the 3-month is higher, backwardation when lower"}`,
  yield_curve: `[e1] markets yield_curve (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
yield curve, through 2026-11-24
{"date":"2026-11-24","previous_date":"2026-11-23","basis":"the Treasury's daily par yield curve: yields in percent, on a bond-equivalent basis","spreads":{"10y_minus_2y":0.28,"10y_minus_3m":0.55,"unit":"percentage points"}}
{"maturity":"1M","key":"series:us.treasury.par_1m","unit":{"kind":"percent"},"latest":{"value":4.21,"date":"2026-11-24"},"previous":{"value":4.2,"date":"2026-11-23"},"change":{"absolute":0.01,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"1.5M","key":"series:us.treasury.par_1_5m","unit":{"kind":"percent"},"latest":{"value":4.27,"date":"2026-11-24"},"previous":{"value":4.27,"date":"2026-11-23"},"change":{"absolute":0,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"2M","key":"series:us.treasury.par_2m","unit":{"kind":"percent"},"latest":{"value":4.28,"date":"2026-11-24"},"previous":{"value":4.3,"date":"2026-11-23"},"change":{"absolute":-0.02,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"3M","key":"series:us.treasury.par_3m","unit":{"kind":"percent"},"latest":{"value":4.36,"date":"2026-11-24"},"previous":{"value":4.37,"date":"2026-11-23"},"change":{"absolute":-0.01,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"4M","key":"series:us.treasury.par_4m","unit":{"kind":"percent"},"latest":{"value":4.36,"date":"2026-11-24"},"previous":{"value":4.36,"date":"2026-11-23"},"change":{"absolute":0,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"6M","key":"series:us.treasury.par_6m","unit":{"kind":"percent"},"latest":{"value":4.46,"date":"2026-11-24"},"previous":{"value":4.45,"date":"2026-11-23"},"change":{"absolute":0.01,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"1Y","key":"series:us.treasury.par_1y","unit":{"kind":"percent"},"latest":{"value":4.59,"date":"2026-11-24"},"previous":{"value":4.57,"date":"2026-11-23"},"change":{"absolute":0.02,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"2Y","key":"series:us.treasury.par_2y","unit":{"kind":"percent"},"latest":{"value":4.63,"date":"2026-11-24"},"previous":{"value":4.63,"date":"2026-11-23"},"change":{"absolute":0,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"3Y","key":"series:us.treasury.par_3y","unit":{"kind":"percent"},"latest":{"value":4.67,"date":"2026-11-24"},"previous":{"value":4.69,"date":"2026-11-23"},"change":{"absolute":-0.02,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"5Y","key":"series:us.treasury.par_5y","unit":{"kind":"percent"},"latest":{"value":4.69,"date":"2026-11-24"},"previous":{"value":4.74,"date":"2026-11-23"},"change":{"absolute":-0.05,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"7Y","key":"series:us.treasury.par_7y","unit":{"kind":"percent"},"latest":{"value":4.79,"date":"2026-11-24"},"previous":{"value":4.81,"date":"2026-11-23"},"change":{"absolute":-0.02,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"10Y","key":"series:us.treasury.par_10y","unit":{"kind":"percent"},"latest":{"value":4.91,"date":"2026-11-24"},"previous":{"value":4.92,"date":"2026-11-23"},"change":{"absolute":-0.01,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"20Y","key":"series:us.treasury.par_20y","unit":{"kind":"percent"},"latest":{"value":5.33,"date":"2026-11-24"},"previous":{"value":5.33,"date":"2026-11-23"},"change":{"absolute":0,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"30Y","key":"series:us.treasury.par_30y","unit":{"kind":"percent"},"latest":{"value":5.3,"date":"2026-11-24"},"previous":{"value":5.29,"date":"2026-11-23"},"change":{"absolute":0.01,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}`,
  credit_spreads: `[e1] markets credit_spreads (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
credit spreads, through 2026-11-24
{"read_from":"FRED's keyless download: the latest vintage of each value, without the day it became known"}
{"name":"high-yield credit spread","title":"ICE BofA US High Yield Index Option-Adjusted Spread","key":"series:us.fred.bamlh0a0hym2","unit":{"kind":"percentage_points"},"as_published":"Percent","frequency":"daily","seasonal_adjustment":"not seasonally adjusted","latest":{"date":"2026-11-24","value":2.8,"known_from":null},"previous":{"date":"2026-11-23","value":2.75},"change":{"absolute":0.05,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"FRED"}
{"name":"investment-grade credit spread","title":"ICE BofA US Corporate Index Option-Adjusted Spread","key":"series:us.fred.bamlc0a0cm","unit":{"kind":"percentage_points"},"as_published":"Percent","frequency":"daily","seasonal_adjustment":"not seasonally adjusted","latest":{"date":"2026-11-24","value":0.81,"known_from":null},"previous":{"date":"2026-11-23","value":0.82},"change":{"absolute":-0.01,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"FRED"}
{"name":"Baa corporate bond spread","title":"Moody's Seasoned Baa Corporate Bond Yield Relative to Yield on 10-Year Treasury Constant Maturity","key":"series:us.fred.baa10y","unit":{"kind":"percentage_points"},"as_published":"Percent","frequency":"daily","seasonal_adjustment":"not seasonally adjusted","latest":{"date":"2026-11-24","value":1.77,"known_from":null},"previous":{"date":"2026-11-23","value":1.78},"change":{"absolute":-0.01,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"FRED"}`,
  energy: `[e1] markets energy (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
energy, through 2026-11-25
{"contracts":"Yahoo's continuous front-month futures (the nearest contract); a roll to the next contract is not marked"}
{"instrument":"WTI crude oil","key":"future:XNYM:CL","price":67.72,"change":{"absolute":-1,"percent":-1.4553,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Brent crude oil","key":"future:XNYM:BZ","price":71.9,"change":{"absolute":-0.95,"percent":-1.304,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Henry Hub natural gas","key":"future:XNYM:NG","price":4.215,"change":{"absolute":0.082,"percent":1.984,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"RBOB gasoline","key":"future:XNYM:RB","price":1.985,"change":{"absolute":-0.021,"percent":-1.0469,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"NY Harbor ULSD (heating oil)","key":"future:XNYM:HO","price":2.341,"change":{"absolute":-0.0185,"percent":-0.7841,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}`,
  metals: `[e1] markets metals (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
metals, through 2026-11-25
{"contracts":"Yahoo's continuous front-month futures (the nearest contract); a roll to the next contract is not marked"}
{"instrument":"Gold","key":"future:XCEC:GC","price":4105.3,"change":{"absolute":18.4,"percent":0.4502,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Silver","key":"future:XCEC:SI","price":51.2,"change":{"absolute":0.45,"percent":0.8867,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Copper","key":"future:XCEC:HG","price":5.015,"change":{"absolute":-0.032,"percent":-0.634,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Platinum","key":"future:XNYM:PL","price":1580.4,"change":{"absolute":12.3,"percent":0.7844,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Palladium","key":"future:XNYM:PA","price":1395.6,"change":{"absolute":-8.2,"percent":-0.5841,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}`,
  agriculture: `[e1] markets agriculture (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
agriculture, through 2026-11-25
{"contracts":"Yahoo's continuous front-month futures (the nearest contract); a roll to the next contract is not marked"}
{"instrument":"Corn","key":"future:XCBT:ZC","price":432.25,"change":{"absolute":2.75,"percent":0.6403,"absolute_unit":null},"currency":"USD","price_scale":0.01,"date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Chicago SRW wheat","key":"future:XCBT:ZW","price":538.5,"change":{"absolute":-4.25,"percent":-0.783,"absolute_unit":null},"currency":"USD","price_scale":0.01,"date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Soybeans","key":"future:XCBT:ZS","price":1125.75,"change":{"absolute":6.5,"percent":0.5807,"absolute_unit":null},"currency":"USD","price_scale":0.01,"date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Coffee C","key":"future:IFUS:KC","price":395.2,"change":{"absolute":3.4,"percent":0.8678,"absolute_unit":null},"currency":"USD","price_scale":0.01,"date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Sugar No. 11","key":"future:IFUS:SB","price":15.42,"change":{"absolute":-0.11,"percent":-0.7083,"absolute_unit":null},"currency":"USD","price_scale":0.01,"date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Cocoa","key":"future:IFUS:CC","price":5820,"change":{"absolute":65,"percent":1.1295,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Cotton No. 2","key":"future:IFUS:CT","price":66.35,"change":{"absolute":0.28,"percent":0.4238,"absolute_unit":null},"currency":"USD","price_scale":0.01,"date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}`,
  fx: `[e1] markets fx (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
fx, through 2026-11-25
{"convention":"a pair's price is units of its second currency per unit of its first (EUR/USD: dollars per euro)"}
{"instrument":"EUR/USD","key":"fx:EURUSD","price":1.0786,"change":{"absolute":0.0023,"percent":0.2138,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:00Z","market_state":"regular","source":"Yahoo"}
{"instrument":"USD/JPY","key":"fx:USDJPY","price":151.42,"change":{"absolute":-0.38,"percent":-0.2503,"absolute_unit":null},"currency":"JPY","date":"2026-11-25","time":"2026-11-25T21:59:00Z","market_state":"regular","source":"Yahoo"}
{"instrument":"GBP/USD","key":"fx:GBPUSD","price":1.2915,"change":{"absolute":0.0031,"percent":0.2406,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:00Z","market_state":"regular","source":"Yahoo"}
{"instrument":"USD/CHF","key":"fx:USDCHF","price":0.8085,"change":{"absolute":-0.0012,"percent":-0.1482,"absolute_unit":null},"currency":"CHF","date":"2026-11-25","time":"2026-11-25T21:59:00Z","market_state":"regular","source":"Yahoo"}
{"instrument":"AUD/USD","key":"fx:AUDUSD","price":0.6612,"change":{"absolute":0.0018,"percent":0.273,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:00Z","market_state":"regular","source":"Yahoo"}
{"instrument":"USD/CAD","key":"fx:USDCAD","price":1.3955,"change":{"absolute":-0.0021,"percent":-0.1503,"absolute_unit":null},"currency":"CAD","date":"2026-11-25","time":"2026-11-25T21:59:00Z","market_state":"regular","source":"Yahoo"}
{"instrument":"NZD/USD","key":"fx:NZDUSD","price":0.593,"change":{"absolute":0.0009,"percent":0.152,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:00Z","market_state":"regular","source":"Yahoo"}
{"instrument":"USD/CNY","key":"fx:USDCNY","price":7.121,"change":{"absolute":-0.0045,"percent":-0.0632,"absolute_unit":null},"currency":"CNY","date":"2026-11-25","time":"2026-11-25T21:59:00Z","market_state":"regular","source":"Yahoo"}
{"instrument":"USD/KRW","key":"fx:USDKRW","price":1418.5,"change":{"absolute":-3.2,"percent":-0.2251,"absolute_unit":null},"currency":"KRW","date":"2026-11-25","time":"2026-11-25T21:59:00Z","market_state":"regular","source":"Yahoo"}
{"instrument":"US Dollar Index (DXY)","key":"series:us.currency_index.dollar","price":99.85,"change":{"absolute":-0.22,"percent":-0.2198,"absolute_unit":null},"currency":null,"date":"2026-11-25","time":"2026-11-25T21:59:00Z","market_state":"closed","source":"Yahoo"}`,
  cross_asset: `[e1] markets cross_asset (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
cross asset, through 2026-11-25
{"instrument":"2-year Treasury yield","key":"series:us.treasury.par_2y","group":"rates","price":4.63,"change":{"absolute":0,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"previous":{"value":4.63,"date":"2026-11-23"},"currency":null,"date":"2026-11-24","source":"U.S. Treasury"}
{"instrument":"10-year Treasury yield","key":"series:us.treasury.par_10y","group":"rates","price":4.91,"change":{"absolute":-0.01,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"previous":{"value":4.92,"date":"2026-11-23"},"currency":null,"date":"2026-11-24","source":"U.S. Treasury"}
{"instrument":"S&P 500","key":"series:us.equity_index.sp500","group":"equities","price":6912.4,"change":{"absolute":28.41,"percent":0.4127,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:15:01Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Cboe Volatility Index (VIX)","key":"series:us.volatility.vix","group":"volatility","price":15.85,"change":{"absolute":-0.42,"percent":-2.5814,"absolute_unit":null},"currency":null,"date":"2026-11-25","time":"2026-11-25T21:15:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"US Dollar Index (DXY)","key":"series:us.currency_index.dollar","group":"currencies","price":99.85,"change":{"absolute":-0.22,"percent":-0.2198,"absolute_unit":null},"currency":null,"date":"2026-11-25","time":"2026-11-25T21:59:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Gold","key":"future:XCEC:GC","group":"commodities","price":4105.3,"change":{"absolute":18.4,"percent":0.4502,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"WTI crude oil","key":"future:XNYM:CL","group":"commodities","price":67.72,"change":{"absolute":-1,"percent":-1.4553,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Bitcoin","key":"crypto:BTC-USD","group":"crypto","price":97250.5,"change":{"absolute":2224.4,"percent":2.3407,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","source":"Yahoo"}`,
  crypto: `[e1] markets crypto (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
crypto, through 2026-11-25
{"ranked_by":"market capitalization in US dollars, as Yahoo states it","universe":"16 large crypto assets, each as Yahoo's USD pair","listed_market_cap":3147400000000}
{"rank":1,"instrument":"Bitcoin","key":"crypto:BTC-USD","price":97250.5,"change":{"absolute":2224.4,"percent":2.3407,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":1934000000000,"source":"Yahoo"}
{"rank":2,"instrument":"Ethereum","key":"crypto:ETH-USD","price":3620.4,"change":{"absolute":65.76,"percent":1.85,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":437000000000,"source":"Yahoo"}
{"rank":3,"instrument":"Tether","key":"crypto:USDT-USD","price":1.0002,"change":{"absolute":0.0001,"percent":0.01,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":185000000000,"source":"Yahoo"}
{"rank":4,"instrument":"XRP","key":"crypto:XRP-USD","price":2.415,"change":{"absolute":-0.0219,"percent":-0.8987,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":145000000000,"source":"Yahoo"}
{"rank":5,"instrument":"BNB","key":"crypto:BNB-USD","price":905.3,"change":{"absolute":6.74,"percent":0.7501,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":126000000000,"source":"Yahoo"}
{"rank":6,"instrument":"Solana","key":"crypto:SOL-USD","price":182.4,"change":{"absolute":5.48,"percent":3.0974,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":100000000000,"source":"Yahoo"}
{"rank":7,"instrument":"USD Coin","key":"crypto:USDC-USD","price":0.9999,"change":{"absolute":0,"percent":0,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":76000000000,"source":"Yahoo"}
{"rank":8,"instrument":"Dogecoin","key":"crypto:DOGE-USD","price":0.214,"change":{"absolute":0.005,"percent":2.3923,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":32000000000,"source":"Yahoo"}
{"rank":9,"instrument":"TRON","key":"crypto:TRX-USD","price":0.301,"change":{"absolute":0.0012,"percent":0.4003,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":28500000000,"source":"Yahoo"}
{"rank":10,"instrument":"Cardano","key":"crypto:ADA-USD","price":0.712,"change":{"absolute":-0.0086,"percent":-1.1934,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":26000000000,"source":"Yahoo"}
{"rank":11,"instrument":"Chainlink","key":"crypto:LINK-USD","price":17.4,"change":{"absolute":0.16,"percent":0.9281,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":11800000000,"source":"Yahoo"}
{"rank":12,"instrument":"Stellar","key":"crypto:XLM-USD","price":0.345,"change":{"absolute":0.0054,"percent":1.5901,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":11000000000,"source":"Yahoo"}
{"rank":13,"instrument":"Avalanche","key":"crypto:AVAX-USD","price":24.8,"change":{"absolute":0.27,"percent":1.1007,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":10500000000,"source":"Yahoo"}
{"rank":14,"instrument":"Bitcoin Cash","key":"crypto:BCH-USD","price":520.1,"change":{"absolute":-3.67,"percent":-0.7007,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":10300000000,"source":"Yahoo"}
{"rank":15,"instrument":"Litecoin","key":"crypto:LTC-USD","price":98.5,"change":{"absolute":0.29,"percent":0.2953,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":7500000000,"source":"Yahoo"}
{"rank":16,"instrument":"Polkadot","key":"crypto:DOT-USD","price":4.2,"change":{"absolute":-0.0211,"percent":-0.4999,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:58:00Z","market_state":"regular","market_cap":6800000000,"source":"Yahoo"}`,
  macro: `[e1] markets macro (as of Saturday 2026-11-21; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
macro, through 2026-11-21
{"read_from":"FRED's keyless download: the latest vintage of each value, without the day it became known"}
{"name":"CPI","key":"series:us.fred.cpiaucsl","unit":{"kind":"index"},"as_published":"Index 1982-1984=100","frequency":"monthly","seasonal_adjustment":"seasonally adjusted","latest":{"period":"2026-10","date":"2026-10-01","value":332.763,"known_from":null},"previous":{"period":"2026-09","date":"2026-09-01","value":332.097},"change":{"absolute":0.666,"percent":0.2,"absolute_unit":null},"year_ago":{"period":"2025-10","date":"2025-10-01","value":null},"change_1y":{"absolute":null,"percent":null,"absolute_unit":null},"source":"FRED"}
{"name":"core CPI","key":"series:us.fred.cpilfesl","unit":{"kind":"index"},"as_published":"Index 1982-1984=100","frequency":"monthly","seasonal_adjustment":"seasonally adjusted","latest":{"period":"2026-10","date":"2026-10-01","value":340.15,"known_from":null},"previous":{"period":"2026-09","date":"2026-09-01","value":339.465},"change":{"absolute":0.685,"percent":0.2,"absolute_unit":null},"year_ago":{"period":"2025-10","date":"2025-10-01","value":null},"change_1y":{"absolute":null,"percent":null,"absolute_unit":null},"source":"FRED"}
{"name":"PCE price index","key":"series:us.fred.pcepi","unit":{"kind":"index"},"as_published":"Index 2017=100","frequency":"monthly","seasonal_adjustment":"seasonally adjusted","latest":{"period":"2026-10","date":"2026-10-01","value":130.214,"known_from":null},"previous":{"period":"2026-09","date":"2026-09-01","value":129.998},"change":{"absolute":0.216,"percent":0.17,"absolute_unit":null},"year_ago":{"period":"2025-10","date":"2025-10-01","value":127.395},"change_1y":{"absolute":2.819,"percent":2.21,"absolute_unit":null},"source":"FRED"}
{"name":"core PCE price index","key":"series:us.fred.pcepilfe","unit":{"kind":"index"},"as_published":"Index 2017=100","frequency":"monthly","seasonal_adjustment":"seasonally adjusted","latest":{"period":"2026-10","date":"2026-10-01","value":130.092,"known_from":null},"previous":{"period":"2026-09","date":"2026-09-01","value":129.866},"change":{"absolute":0.226,"percent":0.17,"absolute_unit":null},"year_ago":{"period":"2025-10","date":"2025-10-01","value":127.013},"change_1y":{"absolute":3.079,"percent":2.42,"absolute_unit":null},"source":"FRED"}
{"name":"unemployment rate","key":"series:us.fred.unrate","unit":{"kind":"percent"},"as_published":"Percent","frequency":"monthly","seasonal_adjustment":"seasonally adjusted","latest":{"period":"2026-10","date":"2026-10-01","value":4.4,"known_from":null},"previous":{"period":"2026-09","date":"2026-09-01","value":4.5},"change":{"absolute":-0.1,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"year_ago":{"period":"2025-10","date":"2025-10-01","value":null},"change_1y":{"absolute":null,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"FRED"}
{"name":"payrolls","key":"series:us.fred.payems","unit":{"kind":"count"},"as_published":"Thousands of Persons","frequency":"monthly","seasonal_adjustment":"seasonally adjusted","latest":{"period":"2026-10","date":"2026-10-01","value":160606,"known_from":null},"previous":{"period":"2026-09","date":"2026-09-01","value":160541},"change":{"absolute":65,"percent":0.04,"absolute_unit":null},"year_ago":{"period":"2025-10","date":"2025-10-01","value":null},"change_1y":{"absolute":null,"percent":null,"absolute_unit":null},"source":"FRED"}
{"name":"initial jobless claims","key":"series:us.fred.icsa","unit":{"kind":"count"},"as_published":"Number","frequency":"weekly","seasonal_adjustment":"seasonally adjusted","latest":{"period":"week ending 2026-11-21","date":"2026-11-21","value":245000,"known_from":null},"previous":{"period":"week ending 2026-11-14","date":"2026-11-14","value":219000},"change":{"absolute":26000,"percent":11.87,"absolute_unit":null},"year_ago":{"period":"week ending 2025-11-22","date":"2025-11-22","value":228000},"change_1y":{"absolute":17000,"percent":7.46,"absolute_unit":null},"source":"FRED"}
{"name":"GDP","key":"series:us.fred.gdpc1","unit":{"kind":"currency"},"as_published":"Billions of Chained 2017 Dollars","frequency":"quarterly","seasonal_adjustment":"seasonally adjusted annual rate","latest":{"period":"2026-Q3","date":"2026-07-01","value":23972.66,"known_from":null},"previous":{"period":"2026-Q2","date":"2026-04-01","value":23846.199},"change":{"absolute":126.461,"percent":0.53,"absolute_unit":null},"year_ago":{"period":"2025-Q3","date":"2025-07-01","value":23552.318},"change_1y":{"absolute":420.342,"percent":1.78,"absolute_unit":null},"source":"FRED"}
{"name":"real GDP growth","key":"series:us.fred.a191rl1q225sbea","unit":{"kind":"percent"},"as_published":"Percent Change from Preceding Period","frequency":"quarterly","seasonal_adjustment":"seasonally adjusted annual rate","latest":{"period":"2026-Q3","date":"2026-07-01","value":2.1,"known_from":null},"previous":{"period":"2026-Q2","date":"2026-04-01","value":2.1},"change":{"absolute":0,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"year_ago":{"period":"2025-Q3","date":"2025-07-01","value":4.3},"change_1y":{"absolute":-2.2,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"FRED"}`,
  indices: `[e1] markets indices (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
indices, through 2026-11-25
{"instrument":"S&P 500","key":"series:us.equity_index.sp500","region":"US","price":6912.4,"change":{"absolute":28.41,"percent":0.4127,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:15:01Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Dow Jones Industrial Average","key":"series:us.equity_index.dow_jones","region":"US","price":47850.12,"change":{"absolute":152.3,"percent":0.3193,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:15:01Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Nasdaq Composite","key":"series:us.equity_index.nasdaq_composite","region":"US","price":23510.55,"change":{"absolute":141.2,"percent":0.6042,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:15:01Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Nasdaq-100","key":"series:us.equity_index.nasdaq_100","region":"US","price":25780.1,"change":{"absolute":160.75,"percent":0.6275,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:15:01Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Russell 2000","key":"series:us.equity_index.russell_2000","region":"US","price":2465.3,"change":{"absolute":-8.42,"percent":-0.3404,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:15:01Z","market_state":"closed","source":"Yahoo"}
{"instrument":"NYSE Composite","key":"series:us.equity_index.nyse_composite","region":"US","price":21180.4,"change":{"absolute":45.1,"percent":0.2134,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:15:01Z","market_state":"closed","source":"Yahoo"}
{"instrument":"KOSPI Composite","key":"series:kr.equity_index.kospi","region":"KR","price":4120.55,"change":{"absolute":35.8,"percent":0.8764,"absolute_unit":null},"currency":"KRW","date":"2026-11-25","time":"2026-11-25T06:30:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"KOSDAQ Composite","key":"series:kr.equity_index.kosdaq","region":"KR","price":905.3,"change":{"absolute":-3.1,"percent":-0.3413,"absolute_unit":null},"currency":"KRW","date":"2026-11-25","time":"2026-11-25T06:30:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"KOSPI 200","key":"series:kr.equity_index.kospi200","region":"KR","price":565.4,"change":{"absolute":5.25,"percent":0.9372,"absolute_unit":null},"currency":"KRW","date":"2026-11-25","time":"2026-11-25T06:30:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Nikkei 225","key":"series:jp.equity_index.nikkei225","region":"JP","price":50210.3,"change":{"absolute":310.4,"percent":0.622,"absolute_unit":null},"currency":"JPY","date":"2026-11-25","time":"2026-11-25T06:30:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Hang Seng Index","key":"series:hk.equity_index.hang_seng","region":"HK","price":26150.8,"change":{"absolute":-120.5,"percent":-0.4587,"absolute_unit":null},"currency":"HKD","date":"2026-11-25","time":"2026-11-25T08:10:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"SSE Composite (Shanghai)","key":"series:cn.equity_index.sse_composite","region":"CN","price":3950.2,"change":{"absolute":8.6,"percent":0.2182,"absolute_unit":null},"currency":"CNY","date":"2026-11-25","time":"2026-11-25T07:00:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"TAIEX","key":"series:tw.equity_index.taiex","region":"TW","price":28120.45,"change":{"absolute":150.3,"percent":0.5374,"absolute_unit":null},"currency":"TWD","date":"2026-11-25","time":"2026-11-25T05:30:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"NIFTY 50","key":"series:in.equity_index.nifty50","region":"IN","price":26050.1,"change":{"absolute":60.25,"percent":0.2318,"absolute_unit":null},"currency":"INR","date":"2026-11-25","time":"2026-11-25T10:00:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"S&P/ASX 200","key":"series:au.equity_index.asx200","region":"AU","price":8650.4,"change":{"absolute":-20.1,"percent":-0.2318,"absolute_unit":null},"currency":"AUD","date":"2026-11-25","time":"2026-11-25T05:10:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"FTSE 100","key":"series:gb.equity_index.ftse100","region":"GB","price":9720.15,"change":{"absolute":30.4,"percent":0.3137,"absolute_unit":null},"currency":"GBP","date":"2026-11-25","time":"2026-11-25T16:35:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"DAX","key":"series:de.equity_index.dax","region":"DE","price":24310.6,"change":{"absolute":95.2,"percent":0.3931,"absolute_unit":null},"currency":"EUR","date":"2026-11-25","time":"2026-11-25T16:35:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"CAC 40","key":"series:fr.equity_index.cac40","region":"FR","price":8105.25,"change":{"absolute":-12.3,"percent":-0.1515,"absolute_unit":null},"currency":"EUR","date":"2026-11-25","time":"2026-11-25T16:35:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"EURO STOXX 50","key":"series:eu.equity_index.euro_stoxx50","region":"EU","price":5710.3,"change":{"absolute":15.6,"percent":0.2739,"absolute_unit":null},"currency":"EUR","date":"2026-11-25","time":"2026-11-25T16:50:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"S&P/TSX Composite","key":"series:ca.equity_index.tsx","region":"CA","price":30850.2,"change":{"absolute":110.4,"percent":0.3591,"absolute_unit":null},"currency":"CAD","date":"2026-11-25","time":"2026-11-25T21:20:00Z","market_state":"closed","source":"Yahoo"}`,
  sector_rotation: `[e1] markets sector_rotation (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
sector rotation, through 2026-11-25
{"benchmark":"SPY","through":"2026-11-25","windows":{"1w":{"from":"2026-11-18","to":"2026-11-25"},"1m":{"from":"2026-10-25","to":"2026-11-25"},"3m":{"from":"2026-08-25","to":"2026-11-25"}},"benchmark_returns":{"1w":0.52,"1m":3.13,"3m":8.41},"leading_sectors":["information_technology","consumer_discretionary","energy"],"lagging_sectors":["consumer_staples","communication_services","health_care"],"cyclical_minus_defensive":6.76,"rotation_signal":"risk-on","method":"each sector fund's return over 1 week, 1 month and 3 months (Yahoo's daily closes adjusted for splits and dividends: the latest close against the last close on or before the window's start) less SPY's over the same window, in percentage points; score: the average of the three; sectors ranked by score; rotation_signal: risk-on when the cyclical sectors' average score (energy, materials, industrials, consumer discretionary, financials, information technology, communication services) exceeds the defensive sectors' (consumer staples, health care, utilities, real estate) by more than 0.5 percentage points, risk-off when it trails them by more than that, neutral otherwise"}
{"rank":1,"sector":"information_technology","fund":"Technology Select Sector SPDR Fund","key":"XLK","group":"cyclical","return_1w":4.09,"return_1m":10.46,"return_3m":26.89,"relative_1w":3.57,"relative_1m":7.33,"relative_3m":18.48,"score":9.79,"source":"Yahoo"}
{"rank":2,"sector":"consumer_discretionary","fund":"Consumer Discretionary Select Sector SPDR Fund","key":"XLY","group":"cyclical","return_1w":3.28,"return_1m":13.4,"return_3m":20.17,"relative_1w":2.76,"relative_1m":10.27,"relative_3m":11.76,"score":8.26,"source":"Yahoo"}
{"rank":3,"sector":"energy","fund":"Energy Select Sector SPDR Fund","key":"XLE","group":"cyclical","return_1w":7.49,"return_1m":6.2,"return_3m":9.74,"relative_1w":6.97,"relative_1m":3.07,"relative_3m":1.33,"score":3.79,"source":"Yahoo"}
{"rank":4,"sector":"materials","fund":"Materials Select Sector SPDR Fund","key":"XLB","group":"cyclical","return_1w":2.56,"return_1m":9.1,"return_3m":6.33,"relative_1w":2.04,"relative_1m":5.97,"relative_3m":-2.08,"score":1.98,"source":"Yahoo"}
{"rank":5,"sector":"industrials","fund":"Industrial Select Sector SPDR Fund","key":"XLI","group":"cyclical","return_1w":0.81,"return_1m":2.76,"return_3m":6.16,"relative_1w":0.29,"relative_1m":-0.37,"relative_3m":-2.25,"score":-0.78,"source":"Yahoo"}
{"rank":6,"sector":"utilities","fund":"Utilities Select Sector SPDR Fund","key":"XLU","group":"defensive","return_1w":-0.73,"return_1m":-2.57,"return_3m":5.52,"relative_1w":-1.25,"relative_1m":-5.7,"relative_3m":-2.89,"score":-3.28,"source":"Yahoo"}
{"rank":7,"sector":"real_estate","fund":"Real Estate Select Sector SPDR Fund","key":"XLRE","group":"defensive","return_1w":0.78,"return_1m":-0.41,"return_3m":-2,"relative_1w":0.26,"relative_1m":-3.54,"relative_3m":-10.41,"score":-4.56,"source":"Yahoo"}
{"rank":8,"sector":"financials","fund":"Financial Select Sector SPDR Fund","key":"XLF","group":"cyclical","return_1w":1.72,"return_1m":2.22,"return_3m":-6.97,"relative_1w":1.2,"relative_1m":-0.91,"relative_3m":-15.38,"score":-5.03,"source":"Yahoo"}
{"rank":9,"sector":"health_care","fund":"Health Care Select Sector SPDR Fund","key":"XLV","group":"defensive","return_1w":-1.78,"return_1m":-1.62,"return_3m":-2.3,"relative_1w":-2.3,"relative_1m":-4.75,"relative_3m":-10.71,"score":-5.92,"source":"Yahoo"}
{"rank":10,"sector":"communication_services","fund":"Communication Services Select Sector SPDR Fund","key":"XLC","group":"cyclical","return_1w":-0.5,"return_1m":3.51,"return_3m":-11.67,"relative_1w":-1.02,"relative_1m":0.38,"relative_3m":-20.08,"score":-6.91,"source":"Yahoo"}
{"rank":11,"sector":"consumer_staples","fund":"Consumer Staples Select Sector SPDR Fund","key":"XLP","group":"defensive","return_1w":-1.8,"return_1m":-3.95,"return_3m":-2.95,"relative_1w":-2.32,"relative_1m":-7.08,"relative_3m":-11.36,"score":-6.92,"source":"Yahoo"}`,
  tips_breakevens: `[e1] markets tips_breakevens (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
tips breakevens, through 2026-11-24
{"date":"2026-11-24","method":"the Treasury's par (nominal) yield less its real (TIPS) par yield at each maturity, in percent, as FRED derives T5YIE and T10YIE"}
{"maturity":"5Y","key":"series:us.treasury.breakeven_5y","unit":{"kind":"percent"},"latest":{"value":2.11,"date":"2026-11-24"},"nominal":4.69,"real":2.58,"previous":{"value":2.15,"date":"2026-11-23"},"change":{"absolute":-0.04,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"7Y","key":"series:us.treasury.breakeven_7y","unit":{"kind":"percent"},"latest":{"value":2.12,"date":"2026-11-24"},"nominal":4.79,"real":2.67,"previous":{"value":2.13,"date":"2026-11-23"},"change":{"absolute":-0.01,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"10Y","key":"series:us.treasury.breakeven_10y","unit":{"kind":"percent"},"latest":{"value":2.12,"date":"2026-11-24"},"nominal":4.91,"real":2.79,"previous":{"value":2.13,"date":"2026-11-23"},"change":{"absolute":-0.01,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"20Y","key":"series:us.treasury.breakeven_20y","unit":{"kind":"percent"},"latest":{"value":2.28,"date":"2026-11-24"},"nominal":5.33,"real":3.05,"previous":{"value":2.29,"date":"2026-11-23"},"change":{"absolute":-0.01,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}
{"maturity":"30Y","key":"series:us.treasury.breakeven_30y","unit":{"kind":"percent"},"latest":{"value":2.11,"date":"2026-11-24"},"nominal":5.3,"real":3.19,"previous":{"value":2.12,"date":"2026-11-23"},"change":{"absolute":-0.01,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"U.S. Treasury"}`,
  rate_indicators: `[e1] markets rate_indicators (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
rate indicators, through 2026-11-25
{"fed_funds_target":{"from":3.75,"to":4,"date":"2026-11-24","source":"New York Fed"}}
{"instrument":"Effective federal funds rate (EFFR)","key":"series:us.nyfed.effr","price":3.88,"change":{"absolute":0,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"previous":{"value":3.88,"date":"2026-11-23"},"currency":null,"date":"2026-11-24","source":"New York Fed"}
{"instrument":"Secured overnight financing rate (SOFR)","key":"series:us.nyfed.sofr","price":3.94,"change":{"absolute":0.02,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"previous":{"value":3.92,"date":"2026-11-23"},"currency":null,"date":"2026-11-24","source":"New York Fed"}
{"instrument":"Overnight bank funding rate (OBFR)","key":"series:us.nyfed.obfr","price":3.88,"change":{"absolute":0,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"previous":{"value":3.88,"date":"2026-11-23"},"currency":null,"date":"2026-11-24","source":"New York Fed"}
{"instrument":"ICE BofA MOVE Index (Treasury volatility)","key":"series:us.volatility.move","price":78.4,"change":{"absolute":-1.2,"percent":-1.5075,"absolute_unit":null},"currency":null,"date":"2026-11-25","time":"2026-11-25T21:15:00Z","market_state":"closed","source":"Yahoo"}`,
  commodity_benchmarks: `[e1] markets commodity_benchmarks (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
commodity benchmarks, through 2026-11-25
{"instrument":"Cboe Crude Oil Volatility Index (OVX)","key":"series:us.volatility.oil","group":"volatility","price":32.1,"change":{"absolute":0.85,"percent":2.72,"absolute_unit":null},"currency":null,"date":"2026-11-25","time":"2026-11-25T21:15:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Cboe Gold Volatility Index (GVZ)","key":"series:us.volatility.gold","group":"volatility","price":18.4,"change":{"absolute":-0.22,"percent":-1.1815,"absolute_unit":null},"currency":null,"date":"2026-11-25","time":"2026-11-25T21:15:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Bloomberg Commodity Index","key":"series:us.commodity_index.bloomberg","group":"index","price":102.35,"change":{"absolute":0.42,"percent":0.412,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:15:00Z","market_state":"closed","source":"Yahoo"}
{"instrument":"S&P GSCI","key":"series:us.commodity_index.sp_gsci","group":"index","price":545.2,"change":{"absolute":3.1,"percent":0.5719,"absolute_unit":null},"currency":"USD","date":"2026-11-25","time":"2026-11-25T21:15:00Z","market_state":"closed","source":"Yahoo"}`,
  livestock: `[e1] markets livestock (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
livestock, through 2026-11-25
{"contracts":"Yahoo's continuous front-month futures (the nearest contract); a roll to the next contract is not marked"}
{"instrument":"Live cattle","key":"future:XCME:LE","price":228.45,"change":{"absolute":1.1,"percent":0.4838,"absolute_unit":null},"currency":"USD","price_scale":0.01,"date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Feeder cattle","key":"future:XCME:GF","price":335.6,"change":{"absolute":2.2,"percent":0.6599,"absolute_unit":null},"currency":"USD","price_scale":0.01,"date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}
{"instrument":"Lean hogs","key":"future:XCME:HE","price":84.25,"change":{"absolute":-0.65,"percent":-0.7656,"absolute_unit":null},"currency":"USD","price_scale":0.01,"date":"2026-11-25","time":"2026-11-25T21:59:58Z","market_state":"closed","source":"Yahoo"}`,
  central_banks: `[e1] markets central_banks (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
central banks, through 2026-11-25
{"bank":"Federal Reserve","rate":"federal funds rate","key":"series:us.nyfed.effr","unit":{"kind":"percent"},"target_range":{"from":3.75,"to":4,"date":"2026-11-24"},"latest":{"value":3.88,"date":"2026-11-24","measure":"effective federal funds rate (EFFR)"},"source":"New York Fed"}
{"bank":"European Central Bank","rate":"deposit facility rate","key":"series:ea.ecb.dfr","unit":{"kind":"percent"},"latest":{"value":2.5,"date":"2026-11-25","in_effect_since":"2026-09-16"},"previous":{"value":2.25,"until":"2026-09-15"},"change":{"absolute":0.25,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"ECB"}
{"bank":"European Central Bank","rate":"main refinancing operations rate","key":"series:ea.ecb.mrr_fr","unit":{"kind":"percent"},"latest":{"value":2.65,"date":"2026-11-25","in_effect_since":"2026-09-16"},"previous":{"value":2.4,"until":"2026-09-15"},"change":{"absolute":0.25,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"ECB"}
{"bank":"European Central Bank","rate":"marginal lending facility rate","key":"series:ea.ecb.mlfr","unit":{"kind":"percent"},"latest":{"value":2.9,"date":"2026-11-25","in_effect_since":"2026-09-16"},"previous":{"value":2.65,"until":"2026-09-15"},"change":{"absolute":0.25,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"ECB"}
{"bank":"Bank of Japan","rate":"central bank rate (immediate rates, less than 24 hours; OECD Main Economic Indicators)","key":"series:us.fred.irstcb01jpm156n","unit":{"kind":"percent"},"frequency":"monthly","latest":{"period":"2026-09","date":"2026-09-01","value":0.75,"known_from":null},"previous":{"period":"2026-08","date":"2026-08-01","value":0.75},"change":{"absolute":0,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"FRED"}
{"bank":"Reserve Bank of India","rate":"central bank rate (immediate rates, less than 24 hours; OECD Main Economic Indicators)","key":"series:us.fred.irstcb01inm156n","unit":{"kind":"percent"},"frequency":"monthly","latest":{"period":"2026-09","date":"2026-09-01","value":5.25,"known_from":null},"previous":{"period":"2026-08","date":"2026-08-01","value":5.25},"change":{"absolute":0,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"FRED"}`,
};
