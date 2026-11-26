// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The Yahoo composite (src/fork/data/providers/yahoo.ts) through the real tools, the router and the
 * ToolRegistry, on hand-made Yahoo fixtures read by yahoo-finance2 itself (test/fork/fixtures/yahoo, marked
 * hand_made: Yahoo answers only the library's own User-Agent, so none was recorded here). Each data tool
 * that reads the composite's capabilities is run as the model's call would be and its text compared whole
 * (golden), with the read check showing that every field the tool reads was supplied; then the failures,
 * each with the kind the router acts on. No request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../../../src/data/capabilities.js";
import { DataError } from "../../../src/data/errors.js";
import { MODULES } from "../../../src/fork/data/sources/yahoo.js";
import {
  buildTools,
  type FixtureRoute,
  fixture,
  type TestOptions,
  testProviders,
  YAHOO_AAPL,
} from "./harness.js";

// Fixture routes ---------------------------------------------------------------------------------------

/** The hand-made quote fixtures, one Yahoo row each, by Yahoo symbol. */
const QUOTE_FILES: Readonly<Record<string, string>> = {
  "005930.KS": "yahoo/quote-005930-ks.json",
  "035900.KQ": "yahoo/quote-035900-kq.json",
  "CL=F": "yahoo/quote-cl-f.json",
  "EURUSD=X": "yahoo/quote-eurusd-x.json",
  "BTC-USD": "yahoo/quote-btc-usd.json",
  "^GSPC": "yahoo/quote-gspc.json",
};

function rowsOf(file: string): unknown[] {
  const answer = JSON.parse(new TextDecoder().decode(fixture(file))) as {
    quoteResponse: { result: unknown[] };
  };
  return answer.quoteResponse.result;
}

/**
 * Yahoo's answer to one quote request of exactly `symbols` (in any order): the row of each symbol a fixture
 * has, and none for the others, as Yahoo leaves out the symbols it does not know.
 */
function quotes(...symbols: string[]): FixtureRoute {
  const wanted = [...symbols].sort().join(",");
  return {
    match: (url) =>
      url.pathname === "/v7/finance/quote" &&
      (url.searchParams.get("symbols") ?? "").split(",").sort().join(",") === wanted,
    body: JSON.stringify({
      quoteResponse: {
        result: symbols.flatMap((symbol) =>
          QUOTE_FILES[symbol] ? rowsOf(QUOTE_FILES[symbol] as string) : [],
        ),
        error: null,
      },
    }),
    headers: { "content-type": "application/json;charset=utf-8" },
  };
}

/** Yahoo's chart of `symbol` at `interval`, for requests whose start `when` accepts (any, unless given). */
function chart(
  symbol: string,
  file: string,
  interval = "1d",
  when?: (period1: number) => boolean,
): FixtureRoute {
  return {
    match: (url) =>
      decodeURIComponent(url.pathname) === `/v8/finance/chart/${symbol}` &&
      url.searchParams.get("interval") === interval &&
      (!when || when(Number(url.searchParams.get("period1")))),
    file,
  };
}

/** Yahoo's quoteSummary of `symbol` with one use's modules. */
function summary(symbol: string, use: keyof typeof MODULES, file: string): FixtureRoute {
  return {
    match: (url) =>
      decodeURIComponent(url.pathname) === `/v10/finance/quoteSummary/${symbol}` &&
      url.searchParams.get("modules") === MODULES[use].join(","),
    file,
  };
}

/** An answer of Yahoo's written inline (hand-made, in the shape its endpoint answers). */
function inline(match: FixtureRoute["match"], body: unknown, status = 200): FixtureRoute {
  return {
    match,
    body: typeof body === "string" ? body : JSON.stringify(body),
    status,
    headers: { "content-type": typeof body === "string" ? "text/html" : "application/json" },
  };
}

/** A request to Yahoo's `path` (and, when given, with this symbol in it). */
const to =
  (path: string, symbol?: string) =>
  (url: URL): boolean =>
    decodeURIComponent(url.pathname).startsWith(path) &&
    (symbol === undefined ||
      decodeURIComponent(url.pathname).endsWith(`/${symbol}`) ||
      (url.searchParams.get("symbols") ?? "").split(",").includes(symbol));

/** A daily chart starting in 2025: the indicators' 600 days (a whole history's events start before 1970). */
const before2026 = (period1: number) => period1 > 0 && period1 < Date.parse("2026-01-01") / 1000;

/** Every fixture of these tests; setup puts a test's own routes first and Yahoo's cookie page and crumb last. */
const ROUTES: readonly FixtureRoute[] = [
  quotes("005930.KS"),
  quotes("005930.KS", "005930.KQ"),
  quotes("035900.KQ"),
  quotes("005930.KS", "CL=F", "EURUSD=X", "BTC-USD", "^GSPC"),
  chart("005930.KS", "yahoo/chart-005930-ks-1d.json"),
  chart("005930.KS", "yahoo/chart-005930-ks-1h.json", "1h"),
  chart("CL=F", "yahoo/chart-cl-f-1d.json"),
  chart("^GSPC", "yahoo/chart-gspc-1d.json"),
  chart("BTC-USD", "yahoo/chart-btc-usd-1d.json"),
  chart("EURUSD=X", "yahoo/chart-eurusd-x-1d.json"),
  chart("AAPL", "yahoo/chart-aapl-15m.json", "15m"),
  chart("AAPL", "yahoo/chart-aapl-events.json", "1d", (period1) => period1 < 0),
  chart("AAPL", "yahoo/chart-aapl-1d-600.json", "1d", before2026),
  summary("AAPL", "profile", "yahoo/quotesummary-aapl-profile.json"),
  summary("MSFT", "profile", "yahoo/quotesummary-msft-profile.json"),
  summary("GOOGL", "profile", "yahoo/quotesummary-googl-profile.json"),
  summary("META", "profile", "yahoo/quotesummary-meta-profile.json"),
  summary("AAPL", "analyst", "yahoo/quotesummary-aapl-analyst.json"),
  summary("AAPL", "calendar", "yahoo/quotesummary-aapl-calendar.json"),
  summary("AAPL", "holders", "yahoo/quotesummary-aapl-holders.json"),
  summary("005930.KS", "profile", "yahoo/quotesummary-005930-ks-profile.json"),
];

/** The fork's providers over `routes` (before the composite's own and Yahoo's crumb), the tools over them. */
function setup(
  routes: readonly FixtureRoute[] = [],
  extra: TestOptions = {},
  more: { fsc?: DataProvider } = {},
) {
  const { providers, fetch, clock } = testProviders({}, [...routes, ...ROUTES, ...YAHOO_AAPL], extra);
  const all = more.fsc ? { ...providers, fsc: more.fsc } : providers;
  const tools = buildTools(all, { clock, check: true });
  return { ...tools, providers: all, fetch, clock };
}

/** The paths of the requests made to Yahoo's API (not its cookie page or crumb), with their symbols. */
function asked(fetch: { requests: { url: string }[] }): string[] {
  return fetch.requests
    .map((request) => new URL(request.url))
    .filter(
      (url) => /^query\d\.finance\.yahoo\.com$/.test(url.hostname) && !url.pathname.includes("getcrumb"),
    )
    .map((url) => {
      const symbols = url.searchParams.get("symbols");
      return `${decodeURIComponent(url.pathname)}${symbols ? `?symbols=${symbols}` : ""}`;
    });
}

/** A stand-in FSC (Korea's official prices, Phase 4): it answers any listing it is asked for at 1000. */
function standInFsc(): DataProvider & { asked: string[] } {
  const seen: string[] = [];
  const quote = (key: string) => ({
    instrument: { key, name: "stand-in", venue: "KRX", currency: "KRW" },
    quote_kind: "last_close",
    price: 1000,
    price_basis: "as traded, official end of day",
    session_date: "2026-11-25",
  });
  return {
    name: "FSC",
    asked: seen,
    capabilities: {
      quotes: {
        quote: async (key) => {
          seen.push(key);
          return quote(key);
        },
        many: async (keys) => {
          seen.push(...keys);
          return { quotes: keys.map((key) => ({ instrument: key, quote: quote(key) })), errors: [] };
        },
      },
    },
  };
}

// Golden texts -----------------------------------------------------------------------------------------

/** The text the model reads, compared whole with the golden one. */
function golden(name: string, text: string): void {
  expect(GOLDEN[name]).toBeDefined();
  expect(text).toBe(GOLDEN[name] as string);
}

/** What upstream's Yahoo answer leaves out that the quote tool reads: optional fields, and the router's `source`. */
const UPSTREAM_QUOTE_LEFT_OUT = [
  "quotes[].quote.change_basis",
  "quotes[].quote.field_states",
  "quotes[].quote.instrument.listing",
  "quotes[].quote.instrument.price_scale",
  "quotes[].quote.stale",
  "quotes[].source",
];

// The tests --------------------------------------------------------------------------------------------

describe("what the Yahoo composite declares", () => {
  test("keyless: every capability it serves, from the first setup, without a setting or a request", () => {
    const { providers, fetch } = setup();
    const yahoo = providers.yahoo as DataProvider;
    expect(yahoo.name).toBe("Yahoo");
    const methods = Object.fromEntries(
      Object.entries(yahoo.capabilities).map(([name, implementation]) => [
        name,
        Object.keys(implementation as object).sort(),
      ]),
    );
    expect(methods).toEqual({
      quotes: ["many", "quote"],
      priceHistory: ["daily", "dailyPair", "intraday"],
      technicals: ["latest"],
      profiles: ["analyst", "calendar", "profile"],
      corporateActions: ["list"],
      // Insider transactions are the filers'; the router asks Yahoo for holders only.
      ownership: ["holders"],
    });
    expect(fetch.requests).toEqual([]);
  });
});

describe("quote", () => {
  test("a Korean listing by its canonical key: KOSPI, KRW, every field the tool reads", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("quote", { symbols: ["XKRX:005930"] });
    expect(run.failure).toBeUndefined();
    golden("quote-korea", run.text);
    expect(run.summary).toBe("84000 +1.20% (close 2026-11-25)");
    expect(run.reads.missing()).toEqual([]);
    expect(asked(fetch)).toEqual(["/v7/finance/quote?symbols=005930.KS"]);
  });

  test("every Korean spelling names the same listing; a bare code is resolved by one batched quote", async () => {
    const { runTool, fetch } = setup();
    for (const key of ["005930.KS", "005930.ks", "security:005930.KS", "005930"]) {
      const run = await runTool("quote", { symbols: [key] });
      expect(run.failure, key).toBeUndefined();
      expect((run.payload as { quotes: { instrument: string }[] }).quotes[0]?.instrument, key).toBe(
        "Samsung Electronics Co., Ltd. (XKRX:005930, KOSPI, KRW)",
      );
    }
    expect(asked(fetch)).toEqual([
      "/v7/finance/quote?symbols=005930.KS",
      "/v7/finance/quote?symbols=005930.KS",
      "/v7/finance/quote?symbols=005930.KS",
      "/v7/finance/quote?symbols=005930.KS,005930.KQ",
    ]);
    // The bare code's market is kept: its daily bars are asked of 005930.KS straight away.
    const history = await runTool("price_history", { symbol: "005930", period: "5d" });
    expect(history.failure).toBeUndefined();
    expect(asked(fetch).at(-1)).toBe("/v8/finance/chart/005930.KS");
    expect(asked(fetch).filter((path) => path.startsWith("/v7/"))).toHaveLength(4);
  });

  test("a KOSDAQ listing answers as XKOS:, venue KOSDAQ", async () => {
    const { runTool } = setup();
    const run = await runTool("quote", { symbols: ["035900.KQ"] });
    expect(run.payload).toMatchObject({
      quotes: [
        { symbol: "035900.KQ", instrument: "JYP Entertainment Corporation (XKOS:035900, KOSDAQ, KRW)" },
      ],
    });
  });

  test("a batch: one request for every listing the composite answers itself, upstream's own for a US one", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("quote", {
      symbols: [
        "XKRX:005930",
        "future:XNYM:CL",
        "fx:EURUSD",
        "crypto:BTC-USDT",
        "series:us.equity_index.sp500",
        "AAPL",
      ],
    });
    expect(run.failure).toBeUndefined();
    golden("quote-batch", run.text);
    expect(run.reads.missing()).toEqual(UPSTREAM_QUOTE_LEFT_OUT);
    expect(asked(fetch).sort()).toEqual([
      "/v7/finance/quote?symbols=005930.KS,CL=F,EURUSD=X,BTC-USD,^GSPC",
      "/v7/finance/quote?symbols=AAPL",
    ]);
  });

  test("crypto:BTC-USDT, the tools' own example, is read as BTC-USD, and every answer says so", async () => {
    const { runTool } = setup([quotes("BTC-USD")]);
    const run = await runTool("quote", { symbols: ["crypto:BTC-USDT"] });
    expect(run.failure).toBeUndefined();
    expect((run.payload as { quotes: { instrument: string }[] }).quotes[0]?.instrument).toBe(
      "Bitcoin USD; crypto:BTC-USDT is read as BTC-USD: Yahoo lists crypto pairs against USD, not against USDT (crypto:BTC-USD, USD)",
    );
    const history = await runTool("price_history", { symbol: "crypto:BTC-USDT", period: "5d" });
    expect((history.payload as { instrument: string }).instrument).toContain(
      "crypto:BTC-USDT is read as BTC-USD",
    );
  });

  test("a value series is not a price: invalid, pointing to macro_series, alone or in a batch", async () => {
    const { runTool, fetch } = setup();
    const alone = await runTool("quote", { symbols: ["series:us.fred.cpiaucsl"] });
    expect(alone.failure).toBe("data_invalid");
    expect(alone.text).toBe(
      "Yahoo cannot answer this request as asked: series:us.fred.cpiaucsl is an economic series, not a price: read it with macro_series",
    );
    const batch = await runTool("quote", { symbols: ["series:us.fred.cpiaucsl", "XKRX:005930"] });
    expect(batch.failure).toBeUndefined();
    expect(batch.text).toContain(
      "series:us.fred.cpiaucsl: no quote (series:us.fred.cpiaucsl is an economic series, not a price: read it with macro_series)",
    );
    for (const tool of ["price_history", "technicals"]) {
      const run = await runTool(tool, { symbol: "series:us.fred.cpiaucsl" });
      expect(run.failure, tool).toBe("data_invalid");
    }
    // No request for any of them, beyond the Korean listing's.
    expect(asked(fetch)).toEqual(["/v7/finance/quote?symbols=005930.KS"]);
  });

  test("a price series key the catalog does not hold is invalid, naming find_instrument", async () => {
    const { runTool } = setup();
    const run = await runTool("quote", { symbols: ["series:us.equity_index.nothing"] });
    expect(run.failure).toBe("data_invalid");
    expect(run.text).toContain("not a price series this source knows; find_instrument names them");
  });
});

describe("a Korean listing Yahoo does not answer passes the call on (never no_data)", () => {
  const nothing = [quotes("999990.KQ"), quotes("999990.KS", "999990.KQ"), quotes("999990.KQ", "005930.KS")];

  test("one quote: unsupported, so the router asks the next source (FSC), which answers", async () => {
    const fsc = standInFsc();
    const { runTool } = setup(nothing, {}, { fsc });
    const run = await runTool("quote", { symbols: ["XKOS:999990"] });
    expect(run.failure).toBeUndefined();
    expect(run.provenance?.source).toBe("FSC");
    expect(run.provenance?.after).toEqual(["Yahoo"]);
    expect(run.text).toContain(
      "source: FSC, after Yahoo failed\nYahoo does not cover this (Yahoo has no quote for XKOS:999990 (999990.KQ)); this is from FSC.",
    );
    expect(fsc.asked).toEqual(["XKOS:999990"]);
  });

  test("a bare code neither market lists: unsupported too, and FSC answers", async () => {
    const fsc = standInFsc();
    const { runTool } = setup(nothing, {}, { fsc });
    const run = await runTool("quote", { symbols: ["999990"] });
    expect(run.provenance?.source).toBe("FSC");
    expect(fsc.asked).toEqual(["999990"]);
  });

  test("in a batch: the listing goes on to FSC with its kind, the rest stand", async () => {
    const fsc = standInFsc();
    const { runTool } = setup(nothing, {}, { fsc });
    const run = await runTool("quote", { symbols: ["XKOS:999990", "XKRX:005930"] });
    expect(run.failure).toBeUndefined();
    expect(run.payload).toMatchObject({
      quotes: [
        { symbol: "XKRX:005930", price: 84000 },
        { symbol: "XKOS:999990", source: "FSC", price: 1000 },
      ],
      errors: [],
    });
    expect(fsc.asked).toEqual(["XKOS:999990"]);
  });

  test("without a next source, the model reads that Yahoo does not cover it, not that there is no data", async () => {
    const { runTool } = setup(nothing);
    const run = await runTool("quote", { symbols: ["XKOS:999990"] });
    expect(run.failure).toBe("data_unsupported");
    expect(run.text).toBe(
      "Yahoo does not cover this request (Yahoo has no quote for XKOS:999990 (999990.KQ)); this is not a fact about the market.",
    );
  });

  test("a code listed on both markets is ambiguous: invalid, with both listings as candidates", async () => {
    const both = {
      quoteResponse: {
        result: [
          rowsOf("yahoo/quote-005930-ks.json")[0],
          {
            ...(rowsOf("yahoo/quote-035900-kq.json")[0] as object),
            symbol: "005930.KQ",
            longName: "Stand-in",
          },
        ],
        error: null,
      },
    };
    const { runTool } = setup([inline(to("/v7/finance/quote", "005930.KQ"), both)]);
    const run = await runTool("quote", { symbols: ["005930"] });
    expect(run.failure).toBe("data_invalid");
    expect(run.text).toBe(
      "Yahoo cannot answer this request as asked: 005930 names a listing on both KOSPI and KOSDAQ: name the market Candidates: XKRX:005930 (Samsung Electronics Co., Ltd. (KOSPI)), XKOS:005930 (Stand-in (KOSDAQ)).",
    );
  });
});

describe("price_history", () => {
  test("a Korean listing's daily bars: adjusted for dividends, dated in Seoul, the last one provisional", async () => {
    const { runTool } = setup();
    const run = await runTool("price_history", { symbol: "XKRX:005930", period: "1mo" });
    expect(run.failure).toBeUndefined();
    golden("history-korea", run.text);
    expect(run.reads.missing()).toEqual([]);
  });

  test("a futures root's continuous front month: the roll note, the session ended at 17:00 New York time", async () => {
    const { runTool } = setup();
    const run = await runTool("price_history", { symbol: "future:XNYM:CL", period: "5d" });
    expect(run.failure).toBeUndefined();
    golden("history-future", run.text);
    expect(run.reads.missing()).toEqual([]);
    // future:CL names the same root (the catalog supplies its exchange); /continuous is the same series.
    for (const symbol of ["future:CL", "future:XNYM:CL/continuous"]) {
      const same = await runTool("price_history", { symbol, period: "5d" });
      expect((same.payload as { instrument: string }).instrument, symbol).toContain(
        "(future:XNYM:CL, NY Mercantile, USD)",
      );
    }
  });

  test("a price series: the index as published, classified as an index", async () => {
    const { runTool, providers } = setup();
    const run = await runTool("price_history", { symbol: "series:us.equity_index.sp500", period: "5d" });
    golden("history-index", run.text);
    expect(run.reads.missing()).toEqual([]);
    const answer = await (providers.yahoo as DataProvider).capabilities.priceHistory?.daily?.(
      "series:us.equity_index.sp500",
      { from: "2026-11-19", to: "2026-11-25" },
    );
    expect(answer?.instrument?.classification).toEqual({ instrument_type: "index" });
  });

  test("a crypto pair: the UTC day under way is left out", async () => {
    const { runTool } = setup();
    const run = await runTool("price_history", { symbol: "crypto:BTC-USD", period: "5d" });
    golden("history-crypto", run.text);
    expect((run.payload as { through: string }).through).toBe("2026-11-24");
  });

  test("a currency pair's daily history is its reference rates, not Yahoo's bars", async () => {
    const { providers, fetch } = setup();
    const daily = (providers.yahoo as DataProvider).capabilities.priceHistory?.daily;
    await expect(daily?.("fx:EURUSD", { from: "2026-11-19", to: "2026-11-25" })).rejects.toMatchObject({
      kind: "unsupported",
    });
    expect(fetch.requests).toEqual([]);
  });

  test("intraday bars of a Korean listing: regular hours, each bar's start in UTC and its session in Seoul", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("price_history", { symbol: "XKRX:005930", interval: "1h", period: "5d" });
    expect(run.failure).toBeUndefined();
    golden("intraday-korea", run.text);
    expect(run.reads.missing()).toEqual([]);
    const request = fetch.requests
      .map((one) => new URL(one.url))
      .find((url) => url.pathname.includes("/chart/"));
    expect(request?.searchParams.get("includePrePost")).toBe("false");
  });

  test("intraday bars of a US listing: the newest 100 of the period, and the line that pages back", async () => {
    const { runTool } = setup();
    const run = await runTool("price_history", { symbol: "AAPL", interval: "15m", period: "5d" });
    expect(run.failure).toBeUndefined();
    const payload = run.payload as {
      times: string[];
      dates: string[];
      states: (string | null)[];
      earlier?: string;
    };
    expect(payload.times).toHaveLength(100);
    expect([payload.times[0], payload.times.at(-1)]).toEqual([
      "2026-11-20T15:30:00Z",
      "2026-11-25T20:45:00Z",
    ]);
    expect(payload.earlier).toBe("price_history with interval=15m, period=5d, end=2026-11-20T15:29:59Z");
    // The session of 2026-11-25 has ended (16:00 New York time): its bars are final.
    expect(payload.states.every((state) => state === null)).toBe(true);
    expect(run.text).toContain("history_from: 2026-09-27");
    expect(run.reads.missing()).toEqual([]);
    // The next page ends a second before this one's first bar.
    const back = await runTool("price_history", {
      symbol: "AAPL",
      interval: "15m",
      period: "5d",
      end: "2026-11-20T15:29:59Z",
    });
    const older = back.payload as { times: string[]; earlier?: string };
    expect([older.times[0], older.times.at(-1), older.times.length]).toEqual([
      "2026-11-19T14:30:00Z",
      "2026-11-20T15:15:00Z",
      30,
    ]);
  });

  test("intraday bars from before what Yahoo keeps: unsupported, said with its depth, without a request", async () => {
    const { providers, fetch } = setup();
    const intraday = (providers.yahoo as DataProvider).capabilities.priceHistory?.intraday;
    await expect(
      intraday?.("AAPL", { interval: "15m", start: "2026-01-02", end: "2026-01-09", limit: 100 }),
    ).rejects.toMatchObject({
      kind: "unsupported",
      message: "Yahoo keeps 15m bars for about the last 60 days (from 2026-09-27), not before",
    });
    expect(fetch.requests).toEqual([]);
  });

  test("both legs of a comparison from Yahoo (settlement's dailyPair), a Korean and a US listing", async () => {
    const { capabilities } = setup();
    const pair = await capabilities.priceHistory.dailyPair(["XKRX:005930", "AAPL"], {
      from: "2026-11-19",
      to: "2026-11-25",
    });
    expect(pair.source).toBe("Yahoo");
    expect(pair.data.map((leg) => leg.bars.at(-1)?.date)).toEqual(["2026-11-25", "2026-11-25"]);
    expect(pair.data.map((leg) => leg.instrument?.key)).toEqual(["XKRX:005930", "AAPL"]);
  });
});

describe("technicals", () => {
  test("from about 400 daily bars: all 22 indicators on the tool's definitions, every field supplied", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("technicals", { symbol: "AAPL" });
    expect(run.failure).toBeUndefined();
    golden("technicals", run.text);
    expect(run.reads.missing()).toEqual([]);
    // The window asked: 600 calendar days to the engine's day, a week past it to tell what is final.
    const request = fetch.requests
      .map((one) => new URL(one.url))
      .find((url) => url.pathname.endsWith("/chart/AAPL"));
    expect(
      [request?.searchParams.get("period1"), request?.searchParams.get("period2")].map((s) =>
        new Date(Number(s) * 1000).toISOString().slice(0, 10),
      ),
    ).toEqual(["2025-04-03", "2026-12-03"]);
    const payload = run.payload as Record<string, unknown>;
    expect(payload.window).toEqual({
      bars: 413,
      missing: [{ date: "2026-06-10", reason: "the source gives no close" }],
      settled_through: "2026-11-24",
    });
  });

  test("a short history: what each indicator needs, under the rows there are and the rows needed", async () => {
    const { runTool } = setup();
    const run = await runTool("technicals", { symbol: "XKRX:005930" });
    expect(run.failure).toBeUndefined();
    golden("technicals-short", run.text);
    expect(run.reads.missing()).toEqual([]);
  });

  test("a currency pair has no volume: the volume-based indicators are said not to be given", async () => {
    const { runTool } = setup();
    const run = await runTool("technicals", { symbol: "fx:EURUSD" });
    expect(run.failure).toBeUndefined();
    golden("technicals-fx", run.text);
  });
});

describe("profile, estimates and comps", () => {
  test("a US company: every profile field, fractions as fractions, debt to equity as a ratio", async () => {
    const { runTool } = setup();
    const run = await runTool("profile", { symbol: "AAPL" });
    expect(run.failure).toBeUndefined();
    golden("profile", run.text);
    expect(run.reads.missing()).toEqual([]);
    expect(run.payload).toMatchObject({
      currency: "USD",
      refreshed_at: null,
      facts: { financial_currency: "USD", debt_to_equity: 1.5934, market_cap_basis: "price_times_shares" },
    });
  });

  test("a Korean company whose summaryDetail the library's schema refuses: read anyway, its yield a fraction", async () => {
    const { runTool } = setup();
    const run = await runTool("profile", { symbol: "005930.KS" });
    expect(run.failure).toBeUndefined();
    golden("profile-korea", run.text);
    expect(run.reads.missing()).toEqual([]);
    // From the refused module: the dividend, its yield sent as a percent (1.72) and read as a fraction.
    expect(run.payload).toMatchObject({
      currency: "KRW",
      facts: { dividend_rate: 1446, dividend_yield: 0.0172, pe_ratio: 17.9, financial_currency: "KRW" },
    });
  });

  test("several share classes: the market cap is stated, not price times this class's shares", async () => {
    const { runTool } = setup();
    const run = await runTool("profile", { symbol: "GOOGL" });
    expect((run.payload as { facts: Record<string, unknown> }).facts.market_cap_basis).toBe("stated");
  });

  test("estimates: the consensus and the calendar, each read on its own modules", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("estimates", { symbol: "AAPL" });
    expect(run.failure).toBeUndefined();
    golden("estimates", run.text);
    expect(run.reads.missing()).toEqual([]);
    const modules = fetch.requests
      .map((one) => new URL(one.url))
      .filter((url) => url.pathname.includes("quoteSummary"))
      .map((url) => url.searchParams.get("modules"))
      .sort();
    expect(modules).toEqual([MODULES.analyst.join(","), MODULES.calendar.join(",")].sort());
  });

  test("one use's modules failing does not sink another's: the calendar fails, the consensus stands", async () => {
    const down: FixtureRoute = {
      match: (url) =>
        url.pathname.endsWith("/quoteSummary/AAPL") &&
        url.searchParams.get("modules") === MODULES.calendar.join(","),
      body: "Service Unavailable",
      status: 503,
      headers: { "content-type": "text/html" },
    };
    const { runTool } = setup([down]);
    const run = await runTool("estimates", { symbol: "AAPL" });
    expect(run.failure).toBeUndefined();
    expect(run.payload).toMatchObject({
      analyst: { recommendation: "buy", target_low_price: 230, target_high_price: 420 },
      calendar: null,
      unavailable: ["calendar: not available (Yahoo answered HTTP 503.)"],
    });
  });

  test("comps against three peers, from their profiles", async () => {
    const { runTool } = setup();
    const run = await runTool("comps", { symbol: "AAPL", peers: ["MSFT", "GOOGL", "META"] });
    expect(run.failure).toBeUndefined();
    golden("comps", run.text);
    expect(run.reads.missing()).toEqual([]);
  });

  test("a company profile is for a listed security: a pair or a future is unsupported, with no request", async () => {
    const { runTool, fetch } = setup();
    for (const symbol of ["CRYPTO:BTC-USD", "FX:EURUSD", "FUTURE:XNYM:CL"]) {
      const run = await runTool("profile", { symbol });
      expect(run.failure, symbol).toBe("data_unsupported");
    }
    expect(fetch.requests).toEqual([]);
  });

  test("a ticker Yahoo resolves to another venue is not that listing: unsupported", async () => {
    const crypto = {
      quoteSummary: {
        result: [
          {
            price: {
              maxAge: 1,
              exchange: "CCC",
              exchangeName: "CCC",
              quoteType: "CRYPTOCURRENCY",
              symbol: "BTC-USD",
              underlyingSymbol: null,
              shortName: "Bitcoin USD",
              longName: "Bitcoin USD",
              lastMarket: null,
              fromCurrency: "BTC",
              priceHint: 2,
              currency: "USD",
            },
          },
        ],
        error: null,
      },
    };
    const { runTool } = setup([inline(to("/v10/finance/quoteSummary/BTC-USD"), crypto)]);
    const run = await runTool("profile", { symbol: "BTC-USD" });
    expect(run.failure).toBe("data_unsupported");
    expect(run.text).toContain("Yahoo's BTC-USD is a listing on CCC, not BTC-USD");
  });
});

describe("corporate_actions and ownership", () => {
  test("splits and dividends from the chart's events, over the whole history", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("corporate_actions", { symbol: "AAPL" });
    expect(run.failure).toBeUndefined();
    golden("actions", run.text);
    expect(run.reads.missing()).toEqual([]);
    expect(run.payload).toMatchObject({ through: "2026-11-25", stale: null });
    const request = fetch.requests
      .map((one) => new URL(one.url))
      .find((url) => url.pathname.endsWith("/chart/AAPL"));
    expect(request?.searchParams.get("events")).toBe("div|split");
  });

  test("institutional holders: Yahoo's top ten, never complete, its caveats, every holder field present", async () => {
    const { runTool } = setup();
    const run = await runTool("ownership", { symbol: "AAPL", view: "institutional" });
    expect(run.failure).toBeUndefined();
    golden("holders", run.text);
    expect(run.reads.missing()).toEqual([]);
    expect(run.payload).toMatchObject({ quarter: "2026-09-30", complete: false, quarters: ["2026-09-30"] });
    for (const holder of (run.payload as { holders: Record<string, unknown>[] }).holders) {
      expect(holder).toMatchObject({
        accession: "",
        filed: null,
        form: null,
        shares_type: "SH",
        value_unit: "dollars",
      });
    }
  });

  test("holders page within Yahoo's ten, and another quarter than Yahoo's is unsupported", async () => {
    const { runTool } = setup();
    const first = await runTool("ownership", { symbol: "AAPL", view: "institutional", limit: 4 });
    expect((first.payload as { next_cursor: string }).next_cursor).toBe("4");
    expect(first.text).toContain("more: ownership with view=institutional, after=4 and the same quarter");
    const second = await runTool("ownership", {
      symbol: "AAPL",
      view: "institutional",
      limit: 4,
      after: "4",
    });
    expect((second.payload as { holders: { manager: string }[] }).holders.map((one) => one.manager)).toEqual([
      "FMR, LLC",
      "Berkshire Hathaway, Inc",
      "Morgan Stanley",
      "JPMORGAN CHASE & CO",
    ]);
    const other = await runTool("ownership", {
      symbol: "AAPL",
      view: "institutional",
      quarter: "2026-06-30",
    });
    expect(other.failure).toBe("data_unsupported");
    expect(other.text).toContain(
      "Yahoo lists institutional holders as of its latest report date only (2026-09-30)",
    );
  });
});

describe("failures, offline, each with the kind the router acts on", () => {
  const quoteOf = (symbol: string) => (url: URL) =>
    url.pathname === "/v7/finance/quote" &&
    (url.searchParams.get("symbols") ?? "").split(",").includes(symbol);

  test("Yahoo limiting requests: rate_limited, which a Korean listing passes on to FSC", async () => {
    const limited = inline(quoteOf("005930.KS"), "Too Many Requests\r\n", 429);
    const alone = await setup([limited]).runTool("quote", { symbols: ["XKRX:005930"] });
    expect(alone.failure).toBe("data_rate_limited");
    const fsc = standInFsc();
    const passed = await setup([limited], {}, { fsc }).runTool("quote", { symbols: ["XKRX:005930"] });
    expect(passed.provenance).toMatchObject({ source: "FSC", after: ["Yahoo"] });
  });

  test("a source error (Yahoo's 5xx): unavailable, a kind that passes the call on", async () => {
    const down = inline(to("/v8/finance/chart/005930.KS"), "Bad Gateway", 502);
    const run = await setup([down]).runTool("price_history", { symbol: "XKRX:005930", period: "5d" });
    expect(run.failure).toBe("data_unavailable");
    expect(run.text).toContain("Yahoo answered HTTP 502.");
  });

  test("an empty answer: no_data where only Yahoo serves the instrument, unsupported for a Korean listing", async () => {
    const empty = { quoteResponse: { result: [], error: null } };
    const future = await setup([inline(quoteOf("CL=F"), empty)]).runTool("quote", {
      symbols: ["future:XNYM:CL"],
    });
    expect(future.failure).toBe("data_no_data");
    expect(future.text).toBe(
      "Yahoo has no data for this request: Yahoo has no quote for future:XNYM:CL (CL=F)",
    );
    const korea = await setup([inline(quoteOf("005930.KS"), empty)]).runTool("quote", {
      symbols: ["XKRX:005930"],
    });
    expect(korea.failure).toBe("data_unsupported");
    const noBars = {
      chart: {
        result: [
          {
            meta: JSON.parse(new TextDecoder().decode(fixture("yahoo/chart-cl-f-1d.json"))).chart.result[0]
              .meta,
            indicators: { quote: [{}] },
          },
        ],
        error: null,
      },
    };
    const technicals = await setup([inline(to("/v8/finance/chart/CL=F"), noBars)]).runTool("technicals", {
      symbol: "future:XNYM:CL",
    });
    expect(technicals.failure).toBe("data_no_data");
    expect(technicals.text).toBe(
      "Yahoo has no data for this request: Yahoo has no daily bars of future:XNYM:CL since 2025-04-04",
    );
  });

  test("Yahoo has no such company (its 404): no_data for a US listing, unsupported for a Korean one", async () => {
    const missing = {
      quoteSummary: {
        result: null,
        error: { code: "Not Found", description: "Quote not found for symbol: ZZZZ" },
      },
    };
    const us = await setup([inline(to("/v10/finance/quoteSummary/ZZZZ"), missing, 404)]).runTool("profile", {
      symbol: "ZZZZ",
    });
    expect(us.failure).toBe("data_no_data");
    const kr = await setup([inline(to("/v10/finance/quoteSummary/999990.KS"), missing, 404)]).runTool(
      "profile",
      {
        symbol: "XKRX:999990",
      },
    );
    expect(kr.failure).toBe("data_unsupported");
  });

  test("a malformed answer: unavailable (a body that is not JSON, a chart its schema refuses)", async () => {
    const page = await setup([inline(to("/v8/finance/chart/CL=F"), "<html>maintenance</html>")]).runTool(
      "price_history",
      {
        symbol: "future:XNYM:CL",
        period: "5d",
      },
    );
    expect(page.failure).toBe("data_unavailable");
    const shapeless = await setup([
      inline(to("/v8/finance/chart/CL=F"), {
        chart: { result: [{ meta: { symbol: "CL=F" }, indicators: { quote: [{}] } }], error: null },
      }),
    ]).runTool("price_history", { symbol: "future:XNYM:CL", period: "5d" });
    expect(shapeless.failure).toBe("data_unavailable");
    expect(shapeless.text).toContain("Failed Yahoo Schema validation");
  });

  test("a summary with none of the modules asked: no_data; a holders list with none: no_data", async () => {
    const bare = { quoteSummary: { result: [{}], error: null } };
    const profile = await setup([inline(to("/v10/finance/quoteSummary/AAPL"), bare)]).runTool("profile", {
      symbol: "AAPL",
    });
    expect(profile.failure).toBe("data_no_data");
    const noHolders = JSON.parse(new TextDecoder().decode(fixture("yahoo/quotesummary-aapl-holders.json")));
    noHolders.quoteSummary.result[0].institutionOwnership.ownershipList = [];
    const holders = await setup([inline(to("/v10/finance/quoteSummary/AAPL"), noHolders)]).runTool(
      "ownership",
      {
        symbol: "AAPL",
        view: "institutional",
      },
    );
    expect(holders.failure).toBe("data_no_data");
    expect(holders.text).toBe(
      "Yahoo has no data for this request: Yahoo lists no institutional holders of AAPL",
    );
  });

  test("no analyst coverage: the consensus is no_data, said beside the calendar", async () => {
    const uncovered = JSON.parse(new TextDecoder().decode(fixture("yahoo/quotesummary-aapl-analyst.json")));
    const result = uncovered.quoteSummary.result[0];
    result.financialData = { maxAge: 1, recommendationKey: "none", financialCurrency: "USD" };
    result.recommendationTrend.trend = [];
    result.earningsTrend.trend = [];
    const route = {
      match: (url: URL) =>
        url.pathname.endsWith("/quoteSummary/AAPL") &&
        url.searchParams.get("modules") === MODULES.analyst.join(","),
      body: JSON.stringify(uncovered),
      headers: { "content-type": "application/json" },
    };
    const run = await setup([route]).runTool("estimates", { symbol: "AAPL" });
    expect(run.failure).toBeUndefined();
    expect((run.payload as { unavailable: string[] }).unavailable).toEqual([
      "analyst: not available (Yahoo has no analysts' estimates for AAPL)",
    ]);
  });

  test("an intraday range past Yahoo's depth (its 422): unsupported", async () => {
    const past = inline(
      to("/v8/finance/chart/AAPL"),
      {
        chart: {
          result: null,
          error: { code: "Unprocessable Entity", description: "15m data not available" },
        },
      },
      422,
    );
    const run = await setup([past]).runTool("price_history", {
      symbol: "AAPL",
      interval: "15m",
      period: "5d",
    });
    expect(run.failure).toBe("data_unsupported");
  });

  test("the caller's cancellation is the caller's own error, and nothing more is asked", async () => {
    const { providers, fetch } = setup();
    const controller = new AbortController();
    const reason = new Error("stop");
    controller.abort(reason);
    const quote = (providers.yahoo as DataProvider).capabilities.quotes?.quote;
    await expect(quote?.("XKRX:005930", { signal: controller.signal })).rejects.toBe(reason);
    const profile = (providers.yahoo as DataProvider).capabilities.profiles?.profile;
    await expect(profile?.("AAPL", { signal: controller.signal })).rejects.toBe(reason);
    expect(
      fetch.requests.filter((one) => one.url.includes("/v7/") || one.url.includes("/v10/")),
    ).toHaveLength(0);
  });

  test("an invalid key: invalid, with the reason, before any request", async () => {
    const { providers, fetch } = setup();
    const quote = (providers.yahoo as DataProvider).capabilities.quotes?.quote;
    const failure = await quote?.("XKRX:12").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DataError);
    expect(failure).toMatchObject({
      kind: "invalid",
      message: "XKRX:12: a KOSPI code is six characters, such as 005930",
    });
    expect(fetch.requests).toEqual([]);
  });

  test("every request the composite makes carries yahoo-finance2's own User-Agent", async () => {
    const { runTool, fetch } = setup([quotes("005930.KS", "CL=F")]);
    await runTool("quote", { symbols: ["XKRX:005930", "future:XNYM:CL"] });
    await runTool("technicals", { symbol: "AAPL" });
    await runTool("profile", { symbol: "AAPL" });
    const yahoo = fetch.requests.filter((request) => /yahoo\.com$/.test(new URL(request.url).hostname));
    expect(yahoo.length).toBeGreaterThan(3);
    for (const request of yahoo) {
      expect(request.headers.get("user-agent") ?? "").toStartWith("Mozilla/5.0 (compatible; yahoo-finance2/");
    }
    expect(fetch.unmatched).toEqual([]);
  });
});

/** The texts the model reads, as the tools render the composite's answers on the fixtures. */
const GOLDEN: Readonly<Record<string, string>> = {
  "quote-korea": `[e1] quote XKRX:005930 (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
symbol XKRX:005930; price 84000; instrument Samsung Electronics Co., Ltd. (XKRX:005930, KOSPI, KRW); quote_kind last_close; price_basis as traded; price_time 2026-11-25T06:30:00Z; session_date Wednesday 2026-11-25; market_state closed; previous_close 83000; change 1000; change_percent 1.20482; change_basis previous_close; day {"open":83100,"high":84300,"low":82900,"volume":15234567}; range_52w {"low":55100,"high":88800}; market_cap 501450000000000`,
  "quote-batch": `[e1] quote XKRX:005930, future:XNYM:CL, fx:EURUSD, crypto:… (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
symbol XKRX:005930; price 84000; instrument Samsung Electronics Co., Ltd. (XKRX:005930, KOSPI, KRW); quote_kind last_close; price_basis as traded; price_time 2026-11-25T06:30:00Z; session_date Wednesday 2026-11-25; market_state closed; previous_close 83000; change 1000; change_percent 1.20482; change_basis previous_close; day {"open":83100,"high":84300,"low":82900,"volume":15234567}; range_52w {"low":55100,"high":88800}; market_cap 501450000000000
symbol future:XNYM:CL; price 67.72; instrument WTI crude oil futures, continuous front month (Crude Oil Jan 27) (future:XNYM:CL, NY Mercantile, USD); quote_kind last_close; price_basis as traded; price_time 2026-11-25T21:59:58Z; session_date Wednesday 2026-11-25; market_state closed; previous_close 68.72; change -1; change_percent -1.4553; change_basis previous_close; day {"open":68.65,"high":68.91,"low":67.31,"volume":198765}; range_52w {"low":57.13,"high":80.77}
symbol fx:EURUSD; price 1.0786; instrument EUR/USD (fx:EURUSD, USD); quote_kind last; price_basis as traded; price_time 2026-11-25T21:59:00Z; market_state regular; previous_close 1.0763; change 0.0023; change_percent 0.2138; change_basis previous_close; day {"open":1.0763,"high":1.0801,"low":1.0751,"volume":0}; range_52w {"low":1.0179,"high":1.1918}
symbol crypto:BTC-USDT; price 97250.5; instrument Bitcoin USD; crypto:BTC-USDT is read as BTC-USD: Yahoo lists crypto pairs against USD, not against USDT (crypto:BTC-USD, USD); quote_kind last; price_basis as traded; price_time 2026-11-25T21:58:00Z; market_state regular; previous_close 95026.1; change 2224.4; change_percent 2.3407; change_basis previous_close; day {"open":95026.1,"high":97890.2,"low":94810.7,"volume":41234567890}; range_52w {"low":74420.7,"high":126198.1}; market_cap 1934000000000
symbol series:us.equity_index.sp500; price 6912.4; instrument S&P 500 (series:us.equity_index.sp500, USD); quote_kind last_close; price_basis as published; price_time 2026-11-25T21:15:01Z; session_date Wednesday 2026-11-25; market_state closed; previous_close 6883.99; change 28.41; change_percent 0.4127; change_basis previous_close; day {"open":6890.1,"high":6921.7,"low":6879.3,"volume":3123456789}; range_52w {"low":5502.6,"high":6955.1}
symbol AAPL; price 342.37; instrument Apple Inc. (AAPL, NasdaqGS, USD); quote_kind last_close; price_basis as traded; price_time 2026-11-25T21:00:00.000Z; session_date Wednesday 2026-11-25; market_state post; previous_close 344.16; change -1.79; change_percent -0.5201; day {"open":344,"high":345.1,"low":340.2,"volume":41234567}; range_52w {"low":201.5,"high":360}; market_cap 5084000000000`,
  "history-korea": `[e1] price_history XKRX:005930 1mo (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
symbol: XKRX:005930
instrument: Samsung Electronics Co., Ltd. (XKRX:005930, KOSPI, KRW)
currency: KRW
interval: daily
price_basis: split_dividend_adjusted
from: 2026-11-18
through: 2026-11-25
complete: none
quoted_as: price
earlier: price_history with end=2026-10-24, period=1mo
dates,opens,highs,lows,closes,volumes,states
2026-11-18,80452.56,81149.55,80054.28,80850.84,12000000,
2026-11-19,81300,82700,80900,82400,12850000,
2026-11-20,82500,82800,81500,81900,13700000,
2026-11-23,82000,82900,81600,82600,14550000,
2026-11-24,82700,83300,82300,83000,15400000,
2026-11-25,83100,84300,82700,84000,16250000,provisional`,
  "history-future": `[e1] price_history future:XNYM:CL 5d (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
symbol: future:XNYM:CL
instrument: WTI crude oil futures, continuous front month (Crude Oil Jan 27) (future:XNYM:CL, NY Mercantile, USD)
currency: USD
interval: daily
price_basis: as traded
from: 2026-11-19
through: 2026-11-25
complete: none
notes:
- A continuous front-month series: the roll dates are not marked, so a change across a roll compares different contracts.
quoted_as: price
earlier: price_history with end=2026-11-18, period=5d
dates,opens,highs,lows,closes,volumes,states
2026-11-19,69.41,69.83,68.44,68.95,189000,
2026-11-20,68.95,70.3,68.44,69.88,198000,
2026-11-23,69.88,70.3,68.51,69.02,207000,
2026-11-24,69.02,69.44,68.21,68.72,216000,
2026-11-25,68.72,69.14,67.21,67.72,225000,provisional`,
  "history-index": `[e1] price_history series:us.equity_index.sp500 5d (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
symbol: series:us.equity_index.sp500
instrument: S&P 500 (series:us.equity_index.sp500, USD)
currency: USD
interval: daily
price_basis: as published
from: 2026-11-19
through: 2026-11-25
complete: none
quoted_as: price
earlier: price_history with end=2026-11-18, period=5d
dates,opens,highs,lows,closes,volumes,states
2026-11-19,6854.7,6884.85,6844.9,6873.55,2945000000,
2026-11-20,6877.05,6888.35,6832.3,6842.1,2990000000,
2026-11-23,6845.6,6881.05,6835.8,6869.75,3035000000,
2026-11-24,6873.25,6895.29,6863.45,6883.99,3080000000,
2026-11-25,6887.49,6923.7,6877.69,6912.4,3125000000,provisional`,
  "history-crypto": `[e1] price_history crypto:BTC-USD 5d (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
symbol: crypto:BTC-USD
instrument: Bitcoin USD (crypto:BTC-USD, USD)
currency: USD
interval: daily
price_basis: as traded
from: 2026-11-19
through: 2026-11-24
complete: none
quoted_as: price
earlier: price_history with end=2026-11-18, period=5d
dates,opens,highs,lows,closes,volumes,states
2026-11-19,93120.4,95223.3,92375.5,94410.9,39500000000,
2026-11-20,94410.9,95223.3,92132.4,92877.3,41000000000,
2026-11-21,92877.3,94762.4,92132.4,93950,42500000000,
2026-11-22,93950,96322.6,93205.1,95510.2,44000000000,
2026-11-23,95510.2,96322.6,93555.9,94300.8,45500000000,
2026-11-24,94300.8,95838.5,93555.9,95026.1,47000000000,provisional`,
  "intraday-korea": `[e1] price_history XKRX:005930 1h 5d (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
symbol: XKRX:005930
instrument: Samsung Electronics Co., Ltd. (XKRX:005930, KOSPI, KRW)
interval: 1h
price_basis: split_adjusted
from: 2026-11-24
through: 2026-11-25
history_from: 2024-11-26
notes:
- times are each bar's start in UTC; dates are its session's
earlier: price_history with interval=1h, period=5d, end=2026-11-23T23:59:59Z
times,dates,opens,highs,lows,closes,volumes,states
2026-11-24T00:00:00Z,2026-11-24,83000,83100,82800,83000,1500000,
2026-11-24T01:00:00Z,2026-11-24,83000,83100,82800,83000,1610000,
2026-11-24T02:00:00Z,2026-11-24,83000,83100,82800,83000,1720000,
2026-11-24T03:00:00Z,2026-11-24,83000,83300,82800,83200,1830000,
2026-11-24T04:00:00Z,2026-11-24,83200,83500,83000,83400,1940000,
2026-11-24T05:00:00Z,2026-11-24,83400,83700,83200,83600,2050000,
2026-11-24T06:00:00Z,2026-11-24,83600,83700,83400,83600,2160000,
2026-11-25T00:00:00Z,2026-11-25,83600,84000,83400,83900,1500000,
2026-11-25T01:00:00Z,2026-11-25,83900,84300,83700,84200,1610000,
2026-11-25T02:00:00Z,2026-11-25,84200,84600,84000,84500,1720000,
2026-11-25T03:00:00Z,2026-11-25,84500,84600,84200,84400,1830000,
2026-11-25T04:00:00Z,2026-11-25,84400,84500,84100,84300,1940000,
2026-11-25T05:00:00Z,2026-11-25,84300,84400,84000,84200,2050000,
2026-11-25T06:00:00Z,2026-11-25,84200,84600,84000,84500,2160000,`,
  technicals: `[e1] technicals AAPL (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
Apple Inc. (AAPL, NasdaqGS, USD): technical indicators through 2026-11-25 (close 347.97 on 2026-11-25), from 413 daily bars, split_dividend_adjusted
- RSI(14, Wilder): 31 (0-100; 30 and 70 are the customary thresholds)
- MACD(12, 26): line 0.16, signal (9-period EMA of the line) 1.93, histogram -1.78 (price units)
- moving averages: SMA 50 351.91, SMA 200 320.59, EMA 10 353.8, EMA 50 349.39; the close is below SMA 50 and above SMA 200; SMA 50 is above SMA 200
- Bollinger (20, 2 standard deviations): upper 364.64, middle 357.18, lower 349.72
- average true range: ATR(14) 4.04, ATR(5) 4.26
- stochastic (KDJ, 9-period): %K 13.45, %D 22.2; CCI(14) -146.39; ADX(14) 41.96
- z-score of the close against 75 sessions: 0.37; one-session change -0.97%
- volume: MFI(14) 18.8, VWMA(20) 356.77, PVO(12, 26) 3.43%
sessions after 2026-11-24 are not settled yet (values may still change)
sessions left out of the computation: 2026-06-10 (the source gives no close)`,
  "technicals-short": `[e1] technicals XKRX:005930 (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
Samsung Electronics Co., Ltd. (XKRX:005930, KOSPI, KRW): technical indicators through 2026-11-25 (close 84000 on 2026-11-25), from 6 daily bars, split_dividend_adjusted
- RSI(14, Wilder): n/a (0-100; 30 and 70 are the customary thresholds)
- MACD(12, 26): line n/a, signal (9-period EMA of the line) n/a, histogram n/a (price units)
- moving averages: SMA 50 n/a, SMA 200 n/a, EMA 10 n/a, EMA 50 n/a; the close is ? SMA 50 and ? SMA 200; SMA 50 is ? SMA 200
- Bollinger (20, 2 standard deviations): upper n/a, middle n/a, lower n/a
- average true range: ATR(14) n/a, ATR(5) 1409.83
- stochastic (KDJ, 9-period): %K n/a, %D n/a; CCI(14) n/a; ADX(14) n/a
- z-score of the close against 75 sessions: n/a; one-session change 1.2%
- volume: MFI(14) n/a, VWMA(20) n/a, PVO(12, 26) n/a%
sessions after 2026-11-24 are not settled yet (values may still change)
not enough history: 6 daily rows, 200 needed (rsi: needs 15 daily bars; macd: needs 34 daily bars; macd_signal: needs 34 daily bars; macd_histogram: needs 34 daily bars; sma_50: needs 50 daily bars; sma_200: needs 200 daily bars; ema_10: needs 10 daily bars; ema_50: needs 50 daily bars; bb_upper: needs 20 daily bars; bb_middle: needs 20 daily bars; bb_lower: needs 20 daily bars; atr: needs 15 daily bars; adx: needs 28 daily bars; stochastic_k: needs 9 daily bars; stochastic_d: needs 9 daily bars; cci: needs 14 daily bars; z_score_75: needs 75 daily bars; mfi: needs 15 daily bars; vwma: needs 20 daily bars; pvo: needs 26 daily bars)`,
  "technicals-fx": `[e1] technicals fx:EURUSD (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
EUR/USD (fx:EURUSD, USD): technical indicators through 2026-11-24 (close 1.09 on 2026-11-24), from 42 daily bars, as traded
- RSI(14, Wilder): 84.42 (0-100; 30 and 70 are the customary thresholds)
- MACD(12, 26): line 0, signal (9-period EMA of the line) 0, histogram 0 (price units)
- moving averages: SMA 50 n/a, SMA 200 n/a, EMA 10 1.08, EMA 50 n/a; the close is ? SMA 50 and ? SMA 200; SMA 50 is ? SMA 200
- Bollinger (20, 2 standard deviations): upper 1.09, middle 1.08, lower 1.06
- average true range: ATR(14) 0.01, ATR(5) 0.01
- stochastic (KDJ, 9-period): %K 84.78, %D 80.14; CCI(14) 138.61; ADX(14) 34.94
- z-score of the close against 75 sessions: n/a; one-session change 0.2%
- volume-based indicators (MFI, VWMA, PVO): not given, volume is not available for this instrument
sessions after 2026-11-23 are not settled yet (values may still change)
not enough history: 42 daily rows, 200 needed (sma_50: needs 50 daily bars; sma_200: needs 200 daily bars; ema_50: needs 50 daily bars; z_score_75: needs 75 daily bars)`,
  profile: `[e1] profile AAPL (reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
Apple Inc. (AAPL, NasdaqGS, USD): profile
sector: Technology
industry: Consumer Electronics
country: United States
financial_currency: USD
market_cap: 5,084,000,000,000
market_cap_basis: price_times_shares
market_cap_price_date: 2026-11-25
enterprise_value: 5,141,000,000,000
pe_ratio: 41.27
forward_pe: 36.62
peg_ratio: 2.84
price_to_book: 68.6
price_to_sales: 11.62
profit_margin: 26.71% (fraction 0.2671)
operating_margin: 31.97% (fraction 0.3197)
return_on_assets: 24.12% (fraction 0.2412)
return_on_equity: 151.33% (fraction 1.5133)
revenue_growth: 8.3% (fraction 0.083)
earnings_growth: 12.1% (fraction 0.121)
total_cash: 61,300,000,000
total_debt: 118,200,000,000
debt_to_equity: 1.5934
current_ratio: 0.92
quick_ratio: 0.79
dividend_rate: 1.08
dividend_yield: 0.32% (fraction 0.0032)
payout_ratio: 14.21% (fraction 0.1421)
beta: 1.21
shares_outstanding: 14,850,000,000
float_shares: 14,810,000,000
employees: 166,000
website: https://www.apple.com
description: Apple Inc. designs, manufactures, and markets smartphones, personal computers, tablets, wearables, and accessories worldwide, and sells a range of related services.
shares_short: 121,000,000
days_to_cover: 2.41
short_interest_of_float: 0.0082
institutional_ownership: 0.6312
insider_ownership: 0.0171
not given: industry_group: Yahoo classifies by its own sectors and industries, not by GICS, settled; sub_industry: Yahoo classifies by its own sectors and industries, not by GICS, settled`,
  "profile-korea": `[e1] profile 005930.KS (reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
Samsung Electronics Co., Ltd. (XKRX:005930, KOSPI, KRW): profile
sector: Technology
industry: Consumer Electronics
country: South Korea
financial_currency: KRW
market_cap: 501,450,000,000,000
market_cap_price_date: 2026-11-25
enterprise_value: 431,200,000,000,000
pe_ratio: 17.9
forward_pe: 11.2
price_to_book: 1.42
price_to_sales: 1.6
profit_margin: 11.23% (fraction 0.1123)
operating_margin: 13.42% (fraction 0.1342)
return_on_equity: 8.71% (fraction 0.0871)
revenue_growth: 7.1% (fraction 0.071)
total_cash: 104,100,000,000,000
total_debt: 12,700,000,000,000
debt_to_equity: 0.0321
dividend_rate: 1,446
dividend_yield: 1.72% (fraction 0.0172)
payout_ratio: 28.74% (fraction 0.2874)
beta: 0.92
shares_outstanding: 5,919,637,922
float_shares: 4,321,000,000
employees: 125,000
website: https://www.samsung.com
description: Samsung Electronics Co., Ltd. engages in the consumer electronics, information technology and mobile communications, and device solutions businesses worldwide.
institutional_ownership: 0.3712
insider_ownership: 0.2091
not given: industry_group: Yahoo classifies by its own sectors and industries, not by GICS, settled; sub_industry: Yahoo classifies by its own sectors and industries, not by GICS, settled; market_cap_basis: Yahoo does not give the shares behind its market cap, may change if asked later; peg_ratio: not given by Yahoo, may change if asked later; return_on_assets: not given by Yahoo, may change if asked later; earnings_growth: not given by Yahoo, may change if asked later; current_ratio: not given by Yahoo, may change if asked later; quick_ratio: not given by Yahoo, may change if asked later; shares_short: not given by Yahoo, may change if asked later; days_to_cover: not given by Yahoo, may change if asked later; short_interest_of_float: not given by Yahoo, may change if asked later`,
  estimates: `[e1] estimates AAPL (reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
symbol: AAPL
analyst: {"recommendation":"buy","recommendation_mean":1.94,"analysts":41,"target_mean_price":361.8,"target_median_price":365,"target_low_price":230,"target_high_price":420,"target_currency":"USD","ratings":[{"months_ago":0,"strong_buy":7,"buy":23,"hold":14,"sell":1,"strong_sell":2},{"months_ago":1,"strong_buy":7,"buy":22,"hold":15,"sell":1,"strong_sell":2},{"months_ago":2,"strong_buy":6,"buy":22,"hold":16,"sell":1,"strong_sell":2},{"months_ago":3,"strong_buy":6,"buy":21,"hold":16,"sell":2,"strong_sell":2}],"eps_estimates":[{"period":"current_quarter","period_end":"2026-12-31","average":2.67,"low":2.45,"high":2.88,"analysts":29,"year_ago":2.4,"growth":0.1125,"currency":"USD","trend":{"7_days_ago":2.66,"30_days_ago":2.64,"60_days_ago":2.62,"90_days_ago":2.59},"revisions":{"up_7_days":3,"up_30_days":9,"down_7_days":0,"down_30_days":2}},{"period":"next_quarter","period_end":"2027-03-31","average":1.83,"low":1.69,"high":2.01,"analysts":27,"year_ago":1.65,"growth":0.1091,"currency":"USD","trend":{"7_days_ago":1.82,"30_days_ago":1.8,"60_days_ago":1.78,"90_days_ago":1.75},"revisions":{"up_7_days":3,"up_30_days":9,"down_7_days":0,"down_30_days":2}},{"period":"current_fiscal_year","period_end":"2027-09-30","average":8.71,"low":8.22,"high":9.43,"analysts":38,"year_ago":7.91,"growth":0.1011,"currency":"USD","trend":{"7_days_ago":8.7,"30_days_ago":8.68,"60_days_ago":8.66,"90_days_ago":8.63},"revisions":{"up_7_days":3,"up_30_days":9,"down_7_days":0,"down_30_days":2}},{"period":"next_fiscal_year","period_end":"2028-09-30","average":9.58,"low":8.71,"high":10.82,"analysts":38,"year_ago":8.71,"growth":0.0999,"currency":"USD","trend":{"7_days_ago":9.57,"30_days_ago":9.55,"60_days_ago":9.53,"90_days_ago":9.5},"revisions":{"up_7_days":3,"up_30_days":9,"down_7_days":0,"down_30_days":2}}],"revenue_estimates":[{"period":"current_quarter","period_end":"2026-12-31","average":139800000000,"low":135100000000,"high":145200000000,"analysts":27,"year_ago":124300000000,"growth":0.1247,"currency":"USD"},{"period":"next_quarter","period_end":"2027-03-31","average":103500000000,"low":99800000000,"high":108100000000,"analysts":25,"year_ago":95400000000,"growth":0.0849,"currency":"USD"},{"period":"current_fiscal_year","period_end":"2027-09-30","average":471000000000,"low":452100000000,"high":497700000000,"analysts":37,"year_ago":437600000000,"growth":0.0763,"currency":"USD"},{"period":"next_fiscal_year","period_end":"2028-09-30","average":503400000000,"low":470200000000,"high":548000000000,"analysts":36,"year_ago":471000000000,"growth":0.0688,"currency":"USD"}],"refreshed_at":null}
calendar: {"earnings":{"earnings_date":"2027-01-28","status":"upcoming","is_estimate":false,"eps_estimate":2.67,"eps_low":2.45,"eps_high":2.88,"revenue_estimate":139800000000,"revenue_low":135100000000,"revenue_high":145200000000},"dividend":{"ex_date":"2026-11-09","pay_date":"2026-11-12","amount":0.27,"currency":"USD","annual_rate":1.08},"refreshed_at":null}`,
  comps: `[e1] comps AAPL vs MSFT, GOOGL, META (reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
AAPL against MSFT, GOOGL, META: multiple, AAPL, peers' median (how many), range, AAPL's value at the median
- P/E (trailing): 41.27, median 27.4 (3), range 25.3 to 36.1, -33.6%
- P/E (forward): 36.62, median 24.9 (3), range 23.1 to 31.2, -32%
- PEG: 2.84, median 1.62 (3), range 1.33 to 2.21, -43%
- price to book: 68.6, median 8.9 (3), range 8.1 to 10.4, -87%
- price to sales: 11.62, median 9.4 (3), range 9.1 to 12.9, -19.1%`,
  actions: `[e1] corporate_actions AAPL (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
Apple Inc. (AAPL, NasdaqGS, USD): splits and cash distributions, newest first, through 2026-11-25
2026-11-09: dividend 0.27 USD (split adjusted)
2026-08-10: dividend 0.27 USD (split adjusted)
2026-05-11: dividend 0.27 USD (split adjusted)
2026-02-09: dividend 0.26 USD (split adjusted)
2025-11-10: dividend 0.26 USD (split adjusted)
2025-08-11: dividend 0.26 USD (split adjusted)
2025-05-12: dividend 0.26 USD (split adjusted)
2025-02-10: dividend 0.25 USD (split adjusted)
2024-11-08: dividend 0.25 USD (split adjusted)
2024-08-12: dividend 0.25 USD (split adjusted)
2024-05-10: dividend 0.25 USD (split adjusted)
2024-02-09: dividend 0.24 USD (split adjusted)
2020-08-31: split 4 shares for each 1
2014-06-09: split 7 shares for each 1
2005-02-28: split 2 shares for each 1
2000-06-21: split 2 shares for each 1
1987-06-16: split 2 shares for each 1`,
  holders: `[e1] ownership AAPL institutional (as of Wednesday 2026-09-30; reference its data as {"ref":"e1","path":"<field>"})
source: Yahoo
Apple Inc. (AAPL, NasdaqGS, USD): institutional holders (13F) for the quarter ending 2026-09-30; each line is one manager's report as filed, never summed across managers
the source covers this quarter's filings in part: more holders may report
quarters served: 2026-09-30
Yahoo's list of the largest institutional holders, at most ten, as Yahoo aggregates them from managers' 13F reports: not the 13F filings themselves, so no accession numbers or filing dates, and more holders report than these
Yahoo also states that institutions hold 63.1% of the shares (6812 institutions) and insiders 1.7%
Vanguard Group Inc: 1,412,300,000 shares, value 483,531,130,000 dollars; 13F 
Blackrock Inc.: 1,146,400,000 shares, value 392,492,000,000 dollars; 13F 
State Street Corporation: 595,600,000 shares, value 203,915,700,000 dollars; 13F 
Geode Capital Management, LLC: 347,100,000 shares, value 118,836,300,000 dollars; 13F 
FMR, LLC: 308,900,000 shares, value 105,758,100,000 dollars; 13F 
Berkshire Hathaway, Inc: 240,600,000 shares, value 82,374,200,000 dollars; 13F 
Morgan Stanley: 224,300,000 shares, value 76,793,600,000 dollars; 13F 
JPMORGAN CHASE & CO: 184,200,000 shares, value 63,062,600,000 dollars; 13F 
Price (T.Rowe) Associates Inc: 175,300,000 shares, value 60,015,600,000 dollars; 13F 
Norges Bank Investment Management: 139,900,000 shares, value 47,896,300,000 dollars; 13F `,
};
