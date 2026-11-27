// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The FSC provider (src/fork/data/providers/fsc.ts) through the real quote and price_history tools, the router
 * and the ToolRegistry, built after the Yahoo composite as routes.ts orders them (quotes: yahoo, fsc;
 * priceHistory: yahoo, ecb, fsc), on hand-made answers of the FSC's getStockPriceInfo (test/fork/fixtures/fsc,
 * in its documented JSON form) and Yahoo failing for the Korean listing (its 503, no such code, or a chart
 * without a close or an adjusted close in the window): the router passes the call on and the FSC answers. Each
 * text the model reads is compared whole (golden), and the read check shows every field the tools read was
 * supplied. Without DATA_GO_KR_API_KEY the FSC declares nothing and Yahoo's answer stands. No request reaches
 * the network.
 */
import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../../../src/data/capabilities.js";
import type { Providers } from "../../../src/data/router.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import { fscProvider } from "../../../src/fork/data/providers/fsc.js";
import { yahooComposite } from "../../../src/fork/data/providers/yahoo.js";
import { FSC_ADDRESSES } from "../../../src/fork/data/sources/fsc.js";
import {
  buildTools,
  type FixtureFetch,
  type FixtureRoute,
  fixture,
  fixtureFetch,
  type TestOptions,
  testDeps,
  YAHOO_AAPL,
} from "./harness.js";

// The key, in data.go.kr's two spellings (invented: base64-like, as data.go.kr's keys are) -----------------------

const KEY_DECODED = "Fk3a9Q+Zr7Lw2/Xp5Tn8Vb1=Hc6Jd4Mg0Ks+Ye3Ru9Wq/Ai2Ov7Sl5Nf8Bh1Gx4==";
const KEY_ENCODED = encodeURIComponent(KEY_DECODED);

// Fixture routes ---------------------------------------------------------------------------------------

const HOST = "apis.data.go.kr";

/** The hand-made answers, by code: each the FSC's answer for the sessions from 2026-10-12 to 2026-11-24. */
const FSC_FILES: Readonly<Record<string, string>> = {
  "005930": "fsc/stock-price-005930.json",
  "005935": "fsc/stock-price-005935.json",
  "035900": "fsc/stock-price-035900.json",
  "069500": "fsc/stock-price-069500.json",
};

/** The FSC's answer for a code, at `address` (the first one unless given), from its fixture. */
function fscPrices(code: string, file: string, address: string = FSC_ADDRESSES[0]): FixtureRoute {
  const path = new URL(address).pathname;
  return {
    match: (url) =>
      url.hostname === HOST && url.pathname === path && url.searchParams.get("likeSrtnCd") === code,
    file,
  };
}

/** Every code's answer at the first address, and none for any other code (an empty answer, as the FSC gives). */
const FSC_ROUTES: readonly FixtureRoute[] = [
  ...Object.entries(FSC_FILES).map(([code, file]) => fscPrices(code, file)),
  {
    match: (url) => url.hostname === HOST,
    body: JSON.stringify({
      response: {
        header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
        body: { numOfRows: 10, pageNo: 1, totalCount: 0, items: "" },
      },
    }),
    headers: { "content-type": "application/json;charset=UTF-8" },
  },
];

type Item = Record<string, string>;

/** The rows of an answer's `items` (a list, one object, or empty). */
function itemsOf(items: unknown): Item[] {
  const listed = (items as { item?: unknown } | null)?.item;
  if (Array.isArray(listed)) return listed as Item[];
  return listed && typeof listed === "object" ? [listed as Item] : [];
}

/**
 * A fixture fetch whose FSC answers are the service's for the request asked: the fixture's rows within
 * beginBasDt (included) and endBasDt (left out), `numOfRows` a page, the `pageNo`-th page, and the count of
 * all of them, as the service pages its answer (rows newest first, as the fixture holds them).
 */
function fscFetch(routes: readonly FixtureRoute[]): FixtureFetch {
  const base = fixtureFetch(routes);
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await base(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== HOST || !response.ok) return response;
    const text = await response.text();
    let parsed: { response?: { body?: Record<string, unknown> } };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return new Response(text, { status: response.status, headers: response.headers });
    }
    const body = parsed.response?.body;
    if (!body) return new Response(text, { status: response.status, headers: response.headers });
    const from = url.searchParams.get("beginBasDt");
    const until = url.searchParams.get("endBasDt");
    const kept = itemsOf(body.items).filter(
      (item) => (!from || (item.basDt as string) >= from) && (!until || (item.basDt as string) < until),
    );
    const rows = Number(url.searchParams.get("numOfRows") ?? "10");
    const page = Number(url.searchParams.get("pageNo") ?? "1");
    const slice = kept.slice((page - 1) * rows, page * rows);
    (parsed.response as { body: unknown }).body = {
      numOfRows: rows,
      pageNo: page,
      totalCount: kept.length,
      items: slice.length ? { item: slice } : "",
    };
    return new Response(JSON.stringify(parsed), { status: response.status, headers: response.headers });
  };
  return Object.assign(answer, { requests: base.requests, unmatched: base.unmatched }) as FixtureFetch;
}

/** Yahoo failing for every quote and chart (its 503): a Korean listing passes on to the FSC. */
const YAHOO_DOWN: FixtureRoute = {
  match: (url) =>
    /^query\d\.finance\.yahoo\.com$/.test(url.hostname) &&
    (url.pathname.startsWith("/v7/finance/quote") || url.pathname.startsWith("/v8/finance/chart")),
  body: "Service Unavailable",
  status: 503,
  headers: { "content-type": "text/html" },
};

/**
 * Yahoo's daily chart of 005930.KS (the hand-made fixture: the sessions of 2026-11-18 to 2026-11-25), with
 * the values of the sessions numbered in `noValues` and the adjusted closes of those in `noAdjusted` written
 * as null.
 */
function yahooChart(noValues: (i: number) => boolean, noAdjusted: (i: number) => boolean): FixtureRoute {
  const chart = JSON.parse(new TextDecoder().decode(fixture("yahoo/chart-005930-ks-1d.json")));
  const result = chart.chart.result[0];
  const values = result.indicators.quote[0] as Record<string, unknown[]>;
  for (const field of Object.keys(values)) {
    values[field] = (values[field] ?? []).map((value, i) => (noValues(i) ? null : value));
  }
  const adjusted = result.indicators.adjclose[0] as { adjclose: unknown[] };
  adjusted.adjclose = adjusted.adjclose.map((value, i) => (noAdjusted(i) ? null : value));
  return {
    match: (url) => url.pathname === "/v8/finance/chart/005930.KS",
    body: JSON.stringify(chart),
    headers: { "content-type": "application/json;charset=utf-8" },
  };
}

/** That chart with every session's values written as null. */
const YAHOO_NO_CLOSE = yahooChart(
  () => true,
  () => true,
);

/** That chart with every session's close given and its adjusted close written as null. */
const YAHOO_NO_ADJUSTED_CLOSE = yahooChart(
  () => false,
  () => true,
);

/** That chart with the values of 2026-11-19 and 2026-11-20 and every adjusted close written as null. */
const YAHOO_NO_CLOSE_OR_ADJUSTED_CLOSE = yahooChart(
  (i) => i === 1 || i === 2,
  () => true,
);

/** Yahoo's quote of exactly these symbols: none of them listed (an empty result, as Yahoo answers unknown ones). */
function yahooKnowsNone(...symbols: string[]): FixtureRoute {
  const wanted = [...symbols].sort().join(",");
  return {
    match: (url) =>
      url.pathname === "/v7/finance/quote" &&
      (url.searchParams.get("symbols") ?? "").split(",").sort().join(",") === wanted,
    body: JSON.stringify({ quoteResponse: { result: [], error: null } }),
    headers: { "content-type": "application/json;charset=utf-8" },
  };
}

/** The Yahoo composite and the FSC provider over one set of deps, as forkProviders builds them, and the tools. */
function setup(
  routes: readonly FixtureRoute[] = [YAHOO_DOWN],
  config: PublicDataConfig = { dataGoKrKey: KEY_ENCODED },
  extra: TestOptions = {},
) {
  const fetch = fscFetch([...routes, ...FSC_ROUTES, ...YAHOO_AAPL]);
  const { deps, clock } = testDeps(config, fetch, extra);
  const providers: Providers = { yahoo: yahooComposite(deps), fsc: fscProvider(deps) };
  return { ...buildTools(providers, { clock, check: true }), providers, deps, fetch };
}

/** The FSC requests made, by what they asked (address, code, window, page). */
function asked(fetch: FixtureFetch): string[] {
  return fetch.requests
    .map((request) => new URL(request.url))
    .filter((url) => url.hostname === HOST)
    .map((url) => {
      const params = url.searchParams;
      const window = ["beginBasDt", "endBasDt"]
        .filter((name) => params.has(name))
        .map((name) => ` ${name}=${params.get(name)}`)
        .join("");
      const where = url.pathname.endsWith("_V2") ? "v2" : "v1";
      return `${where} ${params.get("likeSrtnCd")}${window} rows=${params.get("numOfRows")} page=${params.get("pageNo")} ${params.get("resultType")}`;
    });
}

/** The text the model reads, compared whole with the golden one. */
function golden(name: string, text: string): void {
  expect(GOLDEN[name]).toBeDefined();
  expect(text).toBe(GOLDEN[name] as string);
}

// The tests --------------------------------------------------------------------------------------------

describe("what the FSC provider declares", () => {
  test("with DATA_GO_KR_API_KEY: quotes (one and several) and daily price history, without a request", () => {
    const { providers, fetch } = setup();
    const fsc = providers.fsc as DataProvider;
    expect(fsc.name).toBe("FSC");
    expect(
      Object.fromEntries(
        Object.entries(fsc.capabilities).map(([name, methods]) => [name, Object.keys(methods ?? {}).sort()]),
      ),
    ).toEqual({ quotes: ["many", "quote"], priceHistory: ["daily"] });
    expect(fetch.requests).toEqual([]);
  });

  test("without it: nothing, so the router asks Yahoo alone", () => {
    const { providers, fetch } = setup([YAHOO_DOWN], {});
    expect(providers.fsc).toEqual({ name: "FSC", capabilities: {} });
    expect(fetch.requests).toEqual([]);
  });
});

describe("quote, after Yahoo", () => {
  test("Yahoo down for a KOSPI listing: the FSC's last official close, every field the tool reads", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("quote", { symbols: ["XKRX:005930"] });
    expect(run.failure).toBeUndefined();
    golden("quote-samsung", run.text);
    expect(run.summary).toBe("83000 +0.48% (close 2026-11-24)");
    expect(run.provenance?.source).toBe("FSC");
    expect(run.provenance?.after).toEqual(["Yahoo"]);
    expect(run.reads.missing()).toEqual([]);
    // One request: the share's rows of the last 31 days in Seoul (today there is 2026-11-26).
    expect(asked(fetch)).toEqual(["v2 005930 beginBasDt=20261026 rows=10000 page=1 json"]);
  });

  test("every Korean spelling names the listing; a bare code takes the market the FSC places it on", async () => {
    const { runTool } = setup();
    for (const symbol of ["005930.KS", "005930", "security:005930.KS", "035900", "XKOS:035900"]) {
      const run = await runTool("quote", { symbols: [symbol] });
      expect(run.failure, symbol).toBeUndefined();
      expect((run.payload as { quotes: { instrument: string }[] }).quotes[0]?.instrument, symbol).toBe(
        symbol.includes("035900")
          ? "JYP Ent. (XKOS:035900, KOSDAQ, KRW)"
          : "삼성전자 (XKRX:005930, KOSPI, KRW)",
      );
    }
  });

  test("a batch Yahoo cannot answer: the FSC answers each, one request a share", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("quote", { symbols: ["XKRX:005930", "005935.KS", "XKOS:035900"] });
    expect(run.failure).toBeUndefined();
    golden("quote-batch", run.text);
    expect(run.reads.missing()).toEqual(["quotes[].source"]);
    expect(asked(fetch).sort()).toEqual([
      "v2 005930 beginBasDt=20261026 rows=10000 page=1 json",
      "v2 005935 beginBasDt=20261026 rows=10000 page=1 json",
      "v2 035900 beginBasDt=20261026 rows=10000 page=1 json",
    ]);
  });

  test("a listing Yahoo quotes is Yahoo's: the FSC is not asked", async () => {
    const quote: FixtureRoute = {
      match: (url) => url.pathname === "/v7/finance/quote" && url.searchParams.get("symbols") === "005930.KS",
      file: "yahoo/quote-005930-ks.json",
    };
    const { runTool, fetch } = setup([quote]);
    const run = await runTool("quote", { symbols: ["XKRX:005930"] });
    expect(run.provenance?.source).toBe("Yahoo");
    expect(asked(fetch)).toEqual([]);
  });

  test("a code neither Yahoo nor the FSC lists: neither covers it, each source's reason said", async () => {
    const { runTool } = setup([yahooKnowsNone("999990.KQ")]);
    const run = await runTool("quote", { symbols: ["XKOS:999990"] });
    expect(run.failure).toBe("data_unsupported");
    golden("quote-unknown", run.text);
  });

  test("KODEX 200, a fund: the FSC's stock prices hold no row of it, so Yahoo's outage is said as such", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("quote", { symbols: ["XKRX:069500"] });
    expect(run.failure).toBe("data_unsupported");
    golden("quote-fund", run.text);
    // The last 31 days, then the whole history, both empty.
    expect(asked(fetch)).toEqual([
      "v2 069500 beginBasDt=20261026 rows=10000 page=1 json",
      "v2 069500 rows=10000 page=1 json",
    ]);
  });

  test("without the key, Yahoo's failure is the answer, as before", async () => {
    const { runTool, fetch } = setup([YAHOO_DOWN], {});
    const run = await runTool("quote", { symbols: ["XKRX:005930"] });
    expect(run.failure).toBe("data_unavailable");
    expect(run.text).not.toContain("FSC");
    expect(asked(fetch)).toEqual([]);
  });
});

describe("price_history, after Yahoo", () => {
  test("a KOSPI listing's daily bars: unadjusted official closes, earlier sessions to page back to", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("price_history", { symbol: "XKRX:005930", period: "1mo" });
    expect(run.failure).toBeUndefined();
    golden("history-samsung", run.text);
    expect(run.reads.missing()).toEqual([]);
    expect(asked(fetch)).toEqual([
      "v2 005930 beginBasDt=20261025 endBasDt=20261126 rows=10000 page=1 json",
      // Whether earlier sessions are held: one row asked, to count them.
      "v2 005930 endBasDt=20261025 rows=1 page=1 json",
    ]);
  });

  test("a KOSDAQ listing by its bare code, five days", async () => {
    const { runTool } = setup();
    const run = await runTool("price_history", { symbol: "035900", period: "5d" });
    expect(run.failure).toBeUndefined();
    golden("history-jyp", run.text);
    expect(run.reads.missing()).toEqual([]);
  });

  test("a bare code Yahoo lists on neither market (unsupported): the FSC's rows place it, and answer", async () => {
    const { runTool, fetch } = setup([yahooKnowsNone("035900.KS", "035900.KQ")]);
    const run = await runTool("price_history", { symbol: "035900", period: "5d" });
    expect(run.failure).toBeUndefined();
    expect(run.provenance?.source).toBe("FSC");
    expect(run.text).toContain(
      "Yahoo does not cover this (Yahoo quotes no KOSPI or KOSDAQ listing with the code 035900); this is from FSC.",
    );
    expect((run.payload as { instrument: string }).instrument).toBe("JYP Ent. (XKOS:035900, KOSDAQ, KRW)");
    expect(asked(fetch)).toHaveLength(2);
  });

  for (const [chart, route, reason] of [
    ["no close", YAHOO_NO_CLOSE, "no close for its 5 sessions"],
    ["closes but no adjusted close", YAHOO_NO_ADJUSTED_CLOSE, "no adjusted close for its 5 sessions"],
    [
      "no close for two sessions and no adjusted close for the others",
      YAHOO_NO_CLOSE_OR_ADJUSTED_CLOSE,
      "no close for 2 and no adjusted close for 3 of its 5 sessions",
    ],
  ] as const) {
    test(`a Korean listing whose Yahoo chart gives ${chart} in the window: the FSC is asked, and Yahoo's reason says which`, async () => {
      const { runTool, fetch } = setup([route]);
      const run = await runTool("price_history", { symbol: "XKRX:005930", period: "5d" });
      expect(run.failure).toBeUndefined();
      expect(run.provenance?.source).toBe("FSC");
      expect(run.text).toContain(
        `Yahoo does not cover this (Yahoo's chart of XKRX:005930 gives ${reason} from 2026-11-19 to 2026-11-25); this is from FSC.`,
      );
      expect(asked(fetch)).toHaveLength(2);
    });

    test(`without the key, a chart with ${chart} in the window is Yahoo's answer, as before: its sessions missing`, async () => {
      const { runTool, fetch } = setup([route], {});
      const run = await runTool("price_history", { symbol: "XKRX:005930", period: "5d" });
      expect(run.failure).toBeUndefined();
      expect(run.provenance?.source).toBe("Yahoo");
      expect(run.provenance?.after).toBeUndefined();
      expect(run.text).toBe(
        [
          `[e1] price_history XKRX:005930 5d (reference its data as {"ref":"e1","path":"<field>"})`,
          "source: Yahoo",
          "symbol: XKRX:005930",
          "instrument: Samsung Electronics Co., Ltd. (XKRX:005930, KOSPI, KRW)",
          "currency: KRW",
          "interval: daily",
          "price_basis: split_dividend_adjusted",
          "from: none",
          "through: none",
          "complete: none",
          "notes:",
          "- sessions the source flags as missing or not complete: 5",
          "quoted_as: price",
          "earlier: price_history with end=2026-11-18, period=5d",
          "dates,opens,highs,lows,closes,volumes,states",
        ].join("\n"),
      );
      expect(asked(fetch)).toEqual([]);
    });
  }

  test("a window of one session Yahoo's chart gives no adjusted close for: Yahoo's reason names the session", async () => {
    const { providers } = setup([YAHOO_NO_ADJUSTED_CLOSE]);
    const daily = (providers.yahoo as DataProvider).capabilities.priceHistory?.daily;
    await expect(daily?.("XKRX:005930", { from: "2026-11-25", to: "2026-11-25" })).rejects.toMatchObject({
      kind: "unsupported",
      message: "Yahoo's chart of XKRX:005930 gives no adjusted close for its session of 2026-11-25",
    });
  });

  test("a pair (settlement's dailyPair) is Yahoo's with the key too: the FSC answers no pair", async () => {
    const { capabilities, fetch } = setup([YAHOO_NO_CLOSE]);
    const pair = await capabilities.priceHistory.dailyPair(["XKRX:005930", "XKRX:005930"], {
      from: "2026-11-19",
      to: "2026-11-25",
    });
    expect(pair.source).toBe("Yahoo");
    expect(pair.data.map((leg) => [leg.bars.length, leg.coverage?.missing_sessions])).toEqual([
      [0, 5],
      [0, 5],
    ]);
    expect(asked(fetch)).toEqual([]);
  });

  test("returns_risk reads the FSC's bars as it reads Yahoo's, on their stated basis", async () => {
    const { runTool } = setup();
    const history = await runTool("price_history", { symbol: "XKRX:005930", period: "1mo" });
    const risk = await runTool("returns_risk", { series: [{ ref: history.evidence }] });
    expect(risk.failure).toBeUndefined();
    expect(risk.text).toContain("unadjusted: KRX's official end-of-day prices as traded");
  });
});

describe("the key", () => {
  test("in either of data.go.kr's spellings: sent encoded once, and in no text, payload or provenance the tools record", async () => {
    for (const configured of [KEY_ENCODED, KEY_DECODED]) {
      const { runTool, fetch } = setup([YAHOO_DOWN], { dataGoKrKey: configured });
      const runs = [
        await runTool("quote", { symbols: ["XKRX:005930", "XKOS:035900"] }),
        await runTool("price_history", { symbol: "XKRX:005930", period: "1mo" }),
        await runTool("quote", { symbols: ["XKRX:069500"] }),
      ];
      for (const run of runs) {
        const said = JSON.stringify([run.text, run.summary, run.payload, run.provenance]);
        expect(said, configured).not.toContain(KEY_DECODED);
        expect(said, configured).not.toContain(KEY_ENCODED);
      }
      const sent = fetch.requests
        .filter((request) => new URL(request.url).hostname === HOST)
        .map((request) => /[?&]serviceKey=([^&]*)/.exec(request.url)?.[1]);
      expect(new Set(sent), configured).toEqual(new Set([KEY_ENCODED]));
    }
  });
});

// Golden texts -------------------------------------------------------------------------------------------

const GOLDEN: Readonly<Record<string, string>> = {
  "quote-samsung": `[e1] quote XKRX:005930 (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: FSC, after Yahoo failed
Yahoo could not be reached (Yahoo answered HTTP 503.); this is from FSC.
symbol XKRX:005930; price 83000; instrument 삼성전자 (XKRX:005930, KOSPI, KRW); quote_kind last_close; price_basis as traded; session_date Tuesday 2026-11-24; previous_close {"value":82600,"date":"Monday 2026-11-23"}; change 400; change_percent 0.48; change_basis previous_close; day {"open":82700,"high":83300,"low":82300,"volume":15400000}; market_cap 485241124464000; field_states {"range_52w":{"reason":"the FSC publishes each session's prices, not a 52-week range"}}`,
  "quote-batch": `[e1] quote XKRX:005930, 005935.KS, XKOS:035900 (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: FSC, after Yahoo failed
Yahoo could not be reached (Yahoo answered HTTP 503.); this is from FSC.
symbol XKRX:005930; price 83000; instrument 삼성전자 (XKRX:005930, KOSPI, KRW); quote_kind last_close; price_basis as traded; session_date Tuesday 2026-11-24; previous_close {"value":82600,"date":"Monday 2026-11-23"}; change 400; change_percent 0.48; change_basis previous_close; day {"open":82700,"high":83300,"low":82300,"volume":15400000}; market_cap 485241124464000; field_states {"range_52w":{"reason":"the FSC publishes each session's prices, not a 52-week range"}}
symbol 005935.KS; price 67200; instrument 삼성전자우 (XKRX:005935, KOSPI, KRW); quote_kind last_close; price_basis as traded; session_date Tuesday 2026-11-24; previous_close {"value":66900,"date":"Monday 2026-11-23"}; change 300; change_percent 0.45; change_basis previous_close; day {"open":67100,"high":67900,"low":66800,"volume":1804000}; market_cap 54833497420800; field_states {"range_52w":{"reason":"the FSC publishes each session's prices, not a 52-week range"}}
symbol XKOS:035900; price 58000; instrument JYP Ent. (XKOS:035900, KOSDAQ, KRW); quote_kind last_close; price_basis as traded; session_date Tuesday 2026-11-24; previous_close {"value":58600,"date":"Monday 2026-11-23"}; change -600; change_percent -1.02; change_basis previous_close; day {"open":58400,"high":58600,"low":57600,"volume":537600}; market_cap 2064244186000; field_states {"range_52w":{"reason":"the FSC publishes each session's prices, not a 52-week range"}}`,
  "quote-unknown": `Yahoo does not cover this (Yahoo has no quote for XKOS:999990 (999990.KQ)); FSC does not cover this (its stock prices list KOSPI, KOSDAQ and KONEX shares and hold no row of the code 999990 (XKOS:999990)). None of this is a fact about the market.`,
  "quote-fund": `Yahoo could not be reached (Yahoo answered HTTP 503.); FSC does not cover this (its stock prices list KOSPI, KOSDAQ and KONEX shares and hold no row of the code 069500 (XKRX:069500)). None of this is a fact about the market.`,
  "history-samsung": `[e1] price_history XKRX:005930 1mo (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: FSC, after Yahoo failed
Yahoo could not be reached (Yahoo answered HTTP 503.); this is from FSC.
symbol: XKRX:005930
instrument: 삼성전자 (XKRX:005930, KOSPI, KRW)
currency: KRW
interval: daily
price_basis: unadjusted: KRX's official end-of-day prices as traded
from: 2026-10-26
through: 2026-11-24
complete: none
quoted_as: price
earlier: price_history with end=2026-10-24, period=1mo
dates,opens,highs,lows,closes,volumes,states
2026-10-26,80900,81800,80400,81500,20540000,
2026-10-27,81600,82200,80400,80800,20800000,
2026-10-28,80600,80900,79900,80200,21060000,
2026-10-29,80200,80800,79700,79900,21320000,
2026-10-30,80100,80900,79400,80600,21580000,
2026-11-02,80500,81900,79900,81300,21840000,
2026-11-03,81400,82200,80900,81900,22100000,
2026-11-04,81700,83100,81300,82500,22360000,
2026-11-05,82500,82800,81800,82100,13000000,
2026-11-06,82300,82900,81200,81400,13260000,
2026-11-09,81300,81600,80200,80900,13520000,
2026-11-10,81000,81600,79700,80300,13780000,
2026-11-11,80100,81000,79600,80700,14040000,
2026-11-12,80700,82100,80300,81500,14300000,
2026-11-13,81700,82300,81400,82000,14560000,
2026-11-16,81900,82500,81400,81600,14820000,
2026-11-17,81700,82000,80200,80900,15080000,
2026-11-18,80800,81500,80400,81200,12000000,
2026-11-19,81300,82700,80900,82400,12850000,
2026-11-20,82500,82800,81500,81900,13700000,
2026-11-23,82000,82900,81600,82600,14550000,
2026-11-24,82700,83300,82300,83000,15400000,`,
  "history-jyp": `[e1] price_history 035900 5d (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: FSC, after Yahoo failed
Yahoo could not be reached (Yahoo answered HTTP 503.); this is from FSC.
symbol: 035900
instrument: JYP Ent. (XKOS:035900, KOSDAQ, KRW)
currency: KRW
interval: daily
price_basis: unadjusted: KRX's official end-of-day prices as traded
from: 2026-11-19
through: 2026-11-24
complete: none
quoted_as: price
earlier: price_history with end=2026-11-18, period=5d
dates,opens,highs,lows,closes,volumes,states
2026-11-19,59100,59900,58400,59400,512400,
2026-11-20,59300,59500,58200,58800,520800,
2026-11-23,58900,59400,58100,58600,529200,
2026-11-24,58400,58600,57600,58000,537600,`,
};
