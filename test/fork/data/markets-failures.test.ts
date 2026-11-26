// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The market views when a source fails, offline: a view gives what its other sources gave, and lists each
 * row its failing source left out in `missing` with that source's reason, counted in `coverage` (a view
 * never leaves a row out silently); the caller's cancellation ends the call; a view's latest daily value
 * more than three business days old is stale; FRED_API_KEY reads FRED's API and never shows in an answer.
 * Every answer goes through the real markets tool and ToolRegistry with the read check. Failures are
 * answers written inline here in the sources' documented shapes (hand-made); no request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../../../src/data/capabilities.js";
import { DataError } from "../../../src/data/errors.js";
import {
  addMonths,
  marketsProvider,
  readScreen,
  STALE_AFTER_DAYS,
  weekdaysBetween,
} from "../../../src/fork/data/providers/markets.js";
import { buildTools, type FixtureRoute, fixture, testDeps, testProviders } from "./harness.js";
import {
  ecbRate,
  fredApi,
  fredGraph,
  inline,
  marketsFetch,
  nyfed,
  poolWithout,
  type SetupOptions,
  treasury,
  yahooPath,
} from "./markets-routes.test.js";

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

type Payload = {
  through: string | null;
  stale: boolean;
  summary: Record<string, unknown>;
  coverage: {
    requested: number | null;
    measured: number | null;
    byReason: { reason: string | null; count: number }[];
  } | null;
  missing: { key: string; reason?: string | null }[];
  rows: Record<string, unknown>[];
  more: boolean;
};

/** Runs one view and checks it answered (a source's failure is no failure of the view) with every field read. */
async function view(options: SetupOptions, name: string) {
  const { runTool, fetch } = setup(options);
  const run = await runTool("markets", { view: name });
  expect(run.failure, run.text).toBeUndefined();
  expect(run.reads.missing()).toEqual([]);
  expect(fetch.unmatched).toEqual([]);
  // Plain data: the recorded payload still holds the read check's views of the provider's answer.
  return { run, payload: JSON.parse(JSON.stringify(run.payload)) as Payload, fetch };
}

const YAHOO_QUOTES = yahooPath("/v7/finance/quote");
const SCREENER = yahooPath("/v1/finance/screener/predefined/saved");
const chart = (symbol: string) => yahooPath(`/v8/finance/chart/${symbol}`);
const FRED_KEY = "fred-test-key-0123456789abcdef";

describe("Yahoo failing", () => {
  test("its quote request answered 503: every quoted row is listed with Yahoo's reason, counted, nothing else", async () => {
    const { run, payload } = await view({ routes: [inline(YAHOO_QUOTES, "", 503)] }, "sectors");
    expect(payload.rows).toEqual([]);
    expect(payload.coverage).toEqual({
      requested: 11,
      measured: 0,
      byReason: [{ reason: "Yahoo answered HTTP 503.", count: 11 }],
    });
    // The one reason is said once, in the coverage; each row left out is listed by its key.
    expect(payload.missing).toHaveLength(11);
    expect(payload.missing[0]).toEqual({ key: "XLE", reason: null });
    expect([payload.through, payload.stale]).toEqual([null, false]);
    expect(run.text.split("\n").slice(2)).toEqual([
      "sectors, through ?",
      '{"ranked_by":"the session\'s percent change, highest first"}',
      "covers 0 of 11 (left out: 11 Yahoo answered HTTP 503.)",
      "some of those left out: XLE, XLB, XLI, XLY, XLP, XLV, XLF, XLK, XLC, XLU, XLRE",
    ]);
  });

  test("limiting requests (429): the reason says so; equity_summary still lists the breadth it never has", async () => {
    const { payload } = await view({ routes: [inline(YAHOO_QUOTES, "", 429)] }, "equity_summary");
    expect(payload.coverage).toEqual({
      requested: 15,
      measured: 0,
      byReason: [{ reason: "Yahoo is limiting requests (HTTP 429).", count: 15 }],
    });
    expect(payload.missing.at(-1)?.key).toBe("market_breadth");
    expect(payload.summary.breadth).toMatchObject({ measured_sectors: 0, breadth_percent: null });
  });

  test("a symbol Yahoo does not quote: that row alone is left out, named with its symbol", async () => {
    const { run, payload } = await view({ pool: poolWithout("^VIX1Y") }, "volatility");
    expect(payload.summary.vix_1y).toBeNull();
    expect(payload.summary.structure).toBe("contango");
    expect(payload.missing).toEqual([{ key: "series:us.volatility.vix_1y", reason: null }]);
    expect(payload.coverage).toEqual({
      requested: 5,
      measured: 4,
      byReason: [{ reason: "Yahoo has no quote for series:us.volatility.vix_1y (^VIX1Y)", count: 1 }],
    });
    expect(run.text).toContain(
      "covers 4 of 5 (left out: 1 Yahoo has no quote for series:us.volatility.vix_1y (^VIX1Y))",
    );
  });

  test("commodity_benchmarks gives the indices Yahoo serves, and lists the ones it does not", async () => {
    const { payload } = await view({ pool: poolWithout("^BCOM", "^SPGSCI") }, "commodity_benchmarks");
    expect(payload.rows.map((row) => row.key)).toEqual([
      "series:us.volatility.oil",
      "series:us.volatility.gold",
    ]);
    // Two reasons, each said with its key.
    expect(payload.missing).toEqual([
      {
        key: "series:us.commodity_index.bloomberg",
        reason: "Yahoo has no quote for series:us.commodity_index.bloomberg (^BCOM)",
      },
      {
        key: "series:us.commodity_index.sp_gsci",
        reason: "Yahoo has no quote for series:us.commodity_index.sp_gsci (^SPGSCI)",
      },
    ]);
  });

  test("cross_asset: Yahoo failing leaves the Treasury's yields; the Treasury failing leaves Yahoo's rows", async () => {
    const yahooDown = (await view({ routes: [inline(YAHOO_QUOTES, "", 503)] }, "cross_asset")).payload;
    expect(yahooDown.rows.map((row) => row.key)).toEqual([
      "series:us.treasury.par_2y",
      "series:us.treasury.par_10y",
    ]);
    expect(yahooDown.coverage).toMatchObject({ requested: 8, measured: 2 });
    const treasuryGone = (await view({ routes: [inline(treasury("par", 2026), "", 404)] }, "cross_asset"))
      .payload;
    expect(treasuryGone.rows).toHaveLength(6);
    expect(treasuryGone.missing.map((gap) => gap.key)).toEqual([
      "series:us.treasury.par_2y",
      "series:us.treasury.par_10y",
    ]);
    expect(treasuryGone.coverage?.byReason).toEqual([
      { reason: "The Treasury's par yield curve file for 2026 is not at its address (HTTP 404).", count: 2 },
    ]);
  });
});

describe("Yahoo's screens", () => {
  test("yahoo-finance2's strict validation refuses the losers' answer (a row without fulldayPrice); the view reads it", async () => {
    const { deps } = testDeps({}, marketsFetch());
    await expect(deps.yahoo.screener({ scrIds: "day_losers", count: 250 })).rejects.toMatchObject({
      name: "FailedYahooValidationError",
    });
    const { payload } = await view({}, "losers");
    expect(payload.rows.map((row) => row.key)).toEqual(["HALV", "MRKT", "SPNQ", "TRVL", "GDRK"]);
    expect(payload.rows[1]).toMatchObject({ price: 38.12, change: { percent: -14.75 } });
  });

  test("a screen Yahoo does not answer (404): no rows, the screen listed with the reason, no coverage", async () => {
    const { payload } = await view(
      { routes: [inline(SCREENER, { finance: { result: null, error: { code: "Not Found" } } }, 404)] },
      "gainers",
    );
    expect(payload.rows).toEqual([]);
    expect(payload.missing).toEqual([{ key: "day_gainers", reason: "Yahoo has no screen day_gainers" }]);
    expect([payload.coverage, payload.through, payload.more]).toEqual([null, null, false]);
  });

  test("an answer in another form than Yahoo's: unreadable, listed", async () => {
    const { payload } = await view(
      { routes: [inline(SCREENER, { finance: { result: [{ id: "x" }], error: null } })] },
      "most_active",
    );
    expect(payload.missing).toEqual([
      {
        key: "most_actives",
        reason: "Yahoo answered the most_actives screen in a form this app does not read.",
      },
    ]);
  });

  test("reading a screen fails with the kinds the router acts on: never no_data, which would end the call as a fact", async () => {
    const kindOf = async (route: FixtureRoute) => {
      const { deps } = testDeps({}, marketsFetch({ routes: [route] }));
      try {
        await readScreen(deps, "day_gainers", undefined);
        return "answered";
      } catch (error) {
        return error instanceof DataError ? [error.kind, error.message] : error;
      }
    };
    expect(await kindOf(inline(SCREENER, "", 404))).toEqual([
      "unavailable",
      "Yahoo has no screen day_gainers",
    ]);
    expect(await kindOf(inline(SCREENER, "", 429))).toEqual([
      "rate_limited",
      "Yahoo is limiting requests (HTTP 429).",
    ]);
    expect(await kindOf(inline(SCREENER, "", 401))).toEqual([
      "rejected",
      "Yahoo refused the request (HTTP 401).",
    ]);
    expect(await kindOf(inline(SCREENER, "", 500))).toEqual(["unavailable", "Yahoo answered HTTP 500."]);
    expect(await kindOf(inline(SCREENER, { finance: { result: [{}], error: null } }))).toEqual([
      "unavailable",
      "Yahoo answered the day_gainers screen in a form this app does not read.",
    ]);
    const unexpected = await kindOf(inline(SCREENER, { error: "something else" }));
    expect((unexpected as string[])[0]).toBe("unavailable");
  });

  test("every row of a screen, a page at a time until its total; `more` only when Yahoo stops short", async () => {
    const gainers = await view({}, "gainers");
    expect(gainers.payload).toMatchObject({ more: false, summary: { total: 7 } });
    expect(gainers.payload.rows.map((row) => [row.rank, row.key])).toEqual([
      [1, "QRSV"],
      [2, "BLNX"],
      [3, "CRDW"],
      [4, "VTRM"],
      [5, "OPLQ"],
      [6, "TSRB"],
      [7, "MRFL"],
    ]);
    const pages = gainers.fetch.requests
      .map((request) => new URL(request.url))
      .filter((url) => url.pathname === "/v1/finance/screener/predefined/saved")
      .map((url) => [url.searchParams.get("count"), url.searchParams.get("start")]);
    expect(pages).toEqual([
      ["250", null],
      ["250", "5"],
    ]);
    expect((await view({}, "most_active")).payload).toMatchObject({ more: false, summary: { total: 5 } });
  });

  test("a page that adds nothing, or starts elsewhere, ends the reading; a page that fails is listed", async () => {
    const page = (start: number, quotes: unknown[]) => {
      const first = JSON.parse(new TextDecoder().decode(fixture("markets/screener-day-gainers.json")));
      const screen = first.finance.result[0];
      return { finance: { result: [{ ...screen, start, count: quotes.length, quotes }], error: null } };
    };
    const second = (body: unknown, status = 200) =>
      inline((url: URL) => SCREENER(url) && url.searchParams.get("start") === "5", body, status);
    const empty = await view({ routes: [second(page(5, []))] }, "gainers");
    expect(empty.payload.rows).toHaveLength(5);
    expect(empty.payload).toMatchObject({ more: true, missing: [] });
    const elsewhere = await view({ routes: [second(page(0, [{ symbol: "QRSV" }]))] }, "gainers");
    expect(elsewhere.payload.rows).toHaveLength(5);
    expect(elsewhere.payload.more).toBe(true);
    const failed = await view({ routes: [second("", 500)] }, "gainers");
    expect(failed.payload.rows).toHaveLength(5);
    expect(failed.payload).toMatchObject({
      more: true,
      missing: [{ key: "ranks 6 to 7", reason: "Yahoo answered HTTP 500." }],
    });
  });
});

describe("the agencies failing", () => {
  test("the Treasury's par file missing: yield_curve lists every maturity with the reason; breakevens too", async () => {
    const routes = [inline(treasury("par", 2026), "", 404)];
    const curve = (await view({ routes }, "yield_curve")).payload;
    expect(curve.rows).toEqual([]);
    expect(curve.coverage).toEqual({
      requested: 14,
      measured: 0,
      byReason: [
        {
          reason: "The Treasury's par yield curve file for 2026 is not at its address (HTTP 404).",
          count: 14,
        },
      ],
    });
    const breakevens = (await view({ routes }, "tips_breakevens")).payload;
    expect(breakevens.coverage).toMatchObject({ requested: 5, measured: 0 });
  });

  test("the Treasury answering 503 twice (one retry): unavailable, listed, not hanging", async () => {
    const { payload } = await view({ routes: [inline(treasury("real", 2026), "", 503)] }, "tips_breakevens");
    expect(payload.coverage?.byReason).toEqual([{ reason: "U.S. Treasury answered HTTP 503.", count: 5 }]);
  });

  test("the New York Fed failing: rate_indicators keeps the MOVE index; central_banks keeps the ECB and FRED's", async () => {
    const routes = ["effr", "sofr", "obfr"].map((rate) => inline(nyfed(rate), "", 500));
    const rates = (await view({ routes }, "rate_indicators")).payload;
    expect(rates.rows.map((row) => row.key)).toEqual(["series:us.volatility.move"]);
    expect(rates.summary.fed_funds_target).toBeNull();
    expect(rates.missing.map((gap) => gap.key)).toEqual([
      "series:us.nyfed.effr",
      "series:us.nyfed.sofr",
      "series:us.nyfed.obfr",
    ]);
    expect(rates.coverage).toEqual({
      requested: 4,
      measured: 1,
      byReason: [{ reason: "New York Fed answered HTTP 500.", count: 3 }],
    });
    const banks = (await view({ routes }, "central_banks")).payload;
    expect(banks.rows.map((row) => row.bank)).toEqual([
      "European Central Bank",
      "European Central Bank",
      "European Central Bank",
      "Bank of Japan",
      "Reserve Bank of India",
    ]);
    expect(banks.coverage).toMatchObject({ requested: 6, measured: 5 });
  });

  test("the ECB failing: its three rates listed; a day missing from its file does not move when a rate took effect", async () => {
    const down = (
      await view(
        { routes: ["DFR", "MRR_FR", "MLFR"].map((rate) => inline(ecbRate(rate), "", 503)) },
        "central_banks",
      )
    ).payload;
    expect(down.missing.map((gap) => gap.key)).toEqual([
      "series:ea.ecb.dfr",
      "series:ea.ecb.mrr_fr",
      "series:ea.ecb.mlfr",
    ]);
    expect(down.coverage?.byReason).toEqual([{ reason: "ECB answered HTTP 503.", count: 3 }]);
    // Hand-made in the ECB's csvdata form (detail=dataonly): the deposit rate cut on 2024-01-04 with a day
    // missing after it, and a marginal lending rate unchanged since the first day read.
    const csv = (rate: string, days: [string, string][]) =>
      `KEY,FREQ,REF_AREA,CURRENCY,PROVIDER_FM,INSTRUMENT_FM,PROVIDER_FM_ID,DATA_TYPE_FM,TIME_PERIOD,OBS_VALUE\r\n${days
        .map(([date, value]) => `FM.D.U2.EUR.4F.KR.${rate}.LEV,D,U2,EUR,4F,KR,${rate},LEV,${date},${value}`)
        .join("\r\n")}\r\n`;
    const dfr = csv("DFR", [
      ["2024-01-01", "4"],
      ["2024-01-02", "4"],
      ["2024-01-03", "4"],
      ["2024-01-04", "3.75"],
      ["2024-01-05", "3.75"],
      ["2024-01-07", "3.75"],
      ["2024-01-08", "3.75"],
    ]);
    const mlfr = csv("MLFR", [
      ["2024-01-01", "4.75"],
      ["2024-01-02", "4.75"],
      ["2024-01-03", "4.75"],
    ]);
    const banks = (
      await view({ routes: [inline(ecbRate("DFR"), dfr), inline(ecbRate("MLFR"), mlfr)] }, "central_banks")
    ).payload;
    expect(banks.rows.find((row) => row.key === "series:ea.ecb.dfr")).toMatchObject({
      latest: { value: 3.75, date: "2024-01-08", in_effect_since: "2024-01-04" },
      previous: { value: 4, until: "2024-01-03" },
      change: { absolute: -0.25 },
    });
    expect(banks.rows.find((row) => row.key === "series:ea.ecb.mlfr")).toMatchObject({
      latest: { value: 4.75, in_effect_since: null, unchanged_since_at_least: "2024-01-01" },
      previous: null,
      change: { absolute: null },
    });
  });

  test("FRED's keyless download failing: each series listed with FRED's reason and what FRED_API_KEY changes", async () => {
    const routes = ["BAMLH0A0HYM2", "BAMLC0A0CM", "BAA10Y"].map((code) => inline(fredGraph(code), "", 503));
    const { run, payload } = await view({ routes }, "credit_spreads");
    expect(payload.rows).toEqual([]);
    expect(payload.missing.map((gap) => gap.key)).toEqual([
      "series:us.fred.bamlh0a0hym2",
      "series:us.fred.bamlc0a0cm",
      "series:us.fred.baa10y",
    ]);
    const reason =
      "FRED's keyless download failed: FRED answered HTTP 503; with FRED_API_KEY set (a free key from https://fred.stlouisfed.org/docs/api/api_key.html), FRED's API serves it";
    expect(payload.coverage).toEqual({ requested: 3, measured: 0, byReason: [{ reason, count: 3 }] });
    expect(run.text).toContain(`covers 0 of 3 (left out: 3 ${reason})`);
  });

  test("central_banks without FRED: the Fed and the ECB, the other banks listed", async () => {
    const routes = ["IRSTCB01JPM156N", "IRSTCB01INM156N"].map((code) => inline(fredGraph(code), "", 503));
    const { payload } = await view({ routes }, "central_banks");
    expect(payload.rows.map((row) => row.bank)).toEqual([
      "Federal Reserve",
      "European Central Bank",
      "European Central Bank",
      "European Central Bank",
    ]);
    expect(payload.missing.map((gap) => gap.key)).toEqual([
      "series:us.fred.irstcb01jpm156n",
      "series:us.fred.irstcb01inm156n",
    ]);
  });
});

describe("FRED_API_KEY", () => {
  /**
   * FRED's API answer for a series' observations with every vintage, hand-made in the JSON FRED documents
   * (https://fred.stlouisfed.org/docs/api/fred/): each date's latest vintage runs to 9999-12-31.
   */
  const observations = (rows: [string, string, string][]) => ({
    realtime_start: "1776-07-04",
    realtime_end: "9999-12-31",
    observations: rows.map(([date, value, known]) => ({
      realtime_start: known,
      realtime_end: "9999-12-31",
      date,
      value,
    })),
  });

  test("with the key, FRED's API: each latest value with the day it became known; the key in no answer", async () => {
    const routes = [
      inline(
        fredApi("BAMLH0A0HYM2"),
        observations([
          ["2026-11-23", "2.75", "2026-11-24"],
          ["2026-11-24", "2.80", "2026-11-25"],
        ]),
      ),
      inline(
        fredApi("BAMLC0A0CM"),
        observations([
          ["2026-11-23", "0.82", "2026-11-24"],
          ["2026-11-24", "0.81", "2026-11-25"],
        ]),
      ),
      inline(
        fredApi("BAA10Y"),
        observations([
          ["2026-11-23", "1.78", "2026-11-24"],
          ["2026-11-24", "1.77", "2026-11-25"],
        ]),
      ),
    ];
    const { run, payload, fetch } = await view({ routes, config: { fredKey: FRED_KEY } }, "credit_spreads");
    expect(payload.summary.read_from).toBe(
      "FRED's API: each latest value with the day it became known (known_from)",
    );
    expect(payload.rows[0]).toMatchObject({
      key: "series:us.fred.bamlh0a0hym2",
      latest: { date: "2026-11-24", value: 2.8, known_from: "2026-11-25" },
      previous: { date: "2026-11-23", value: 2.75 },
      change: { absolute: 0.05 },
    });
    expect(fetch.requests.every((request) => new URL(request.url).hostname !== "fred.stlouisfed.org")).toBe(
      true,
    );
    expect(run.text).not.toContain(FRED_KEY);
    expect(JSON.stringify(payload)).not.toContain(FRED_KEY);
  });

  test("a key FRED does not know: rejected, said without the key", async () => {
    const refusal = {
      error_code: 400,
      error_message: `Bad Request.  The value for variable api_key is not registered.  Read https://fred.stlouisfed.org/docs/api/api_key.html for more information.`,
    };
    const routes = ["BAMLH0A0HYM2", "BAMLC0A0CM", "BAA10Y"].map((code) =>
      inline(fredApi(code), refusal, 400),
    );
    const { run, payload } = await view({ routes, config: { fredKey: FRED_KEY } }, "credit_spreads");
    expect(payload.coverage?.byReason[0]?.reason).toStartWith(
      "FRED refused FRED_API_KEY (Bad Request. The value for variable api_key is not registered",
    );
    expect(`${run.text}${JSON.stringify(payload)}`).not.toContain(FRED_KEY);
  });
});

describe("sector_rotation's charts failing", () => {
  test("SPY's: the funds' own returns, no relative returns, ranks or reading; SPY listed", async () => {
    const { payload } = await view(
      { routes: [inline(chart("SPY"), { chart: { result: null, error: { code: "Not Found" } } }, 404)] },
      "sector_rotation",
    );
    expect(payload.rows).toHaveLength(11);
    for (const row of payload.rows)
      expect([row.rank, row.relative_1m, row.score]).toEqual([null, null, null]);
    expect(payload.summary).toMatchObject({
      rotation_signal: null,
      leading_sectors: [],
      benchmark_returns: null,
    });
    expect(payload.missing).toEqual([{ key: "SPY", reason: "Yahoo has no chart for SPY (SPY)" }]);
    expect(payload.coverage).toMatchObject({ requested: 11, measured: 11 });
  });

  test("one fund's: that sector listed and counted, the others ranked", async () => {
    const { payload } = await view({ routes: [inline(chart("XLC"), "", 500)] }, "sector_rotation");
    expect(payload.rows.map((row) => row.key)).not.toContain("XLC");
    expect(payload.rows.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(payload.missing).toEqual([{ key: "XLC", reason: null }]);
    expect(payload.coverage?.byReason).toEqual([{ reason: "Yahoo answered HTTP 500.", count: 1 }]);
    expect(payload.coverage).toMatchObject({ requested: 11, measured: 10 });
  });
});

describe("cancellation and staleness", () => {
  test("a cancelled call ends with the caller's reason, whatever the view's sources", async () => {
    const { deps } = testDeps({}, marketsFetch());
    const markets = (marketsProvider(deps) as DataProvider).capabilities.markets;
    const controller = new AbortController();
    const reason = new Error("the caller stopped");
    controller.abort(reason);
    for (const name of [
      "sectors",
      "gainers",
      "yield_curve",
      "central_banks",
      "credit_spreads",
      "sector_rotation",
    ] as const) {
      const view = markets?.view?.(name, { signal: controller.signal }) as Promise<unknown>;
      await expect(view, name).rejects.toBe(reason);
    }
  });

  test("a view whose latest daily value is more than three business days old is stale", async () => {
    expect(STALE_AFTER_DAYS).toBe(3);
    // Tuesday's curve is not stale on the Friday after; it is on the Monday after that.
    expect(weekdaysBetween("2026-11-24", "2026-11-27")).toBe(3);
    expect(weekdaysBetween("2026-11-24", "2026-11-30")).toBe(4);
    const fresh = (await view({ now: "2026-11-27T22:00:00Z" }, "yield_curve")).payload;
    expect([fresh.through, fresh.stale]).toEqual(["2026-11-24", false]);
    const { run, payload } = await view({ now: "2026-11-30T22:00:00Z" }, "yield_curve");
    expect([payload.through, payload.stale]).toEqual(["2026-11-24", true]);
    expect(run.text.split("\n")[2]).toBe("yield curve, through 2026-11-24 (the source calls it stale)");
    // Monthly and quarterly statistics are dated by their periods, not judged by business days.
    expect((await view({ now: "2026-11-30T22:00:00Z" }, "macro")).payload.stale).toBe(false);
  });

  test("addMonths keeps the day, or the month's last", () => {
    expect(addMonths("2026-11-25", -1)).toBe("2026-10-25");
    expect(addMonths("2026-05-31", -3)).toBe("2026-02-28");
    expect(addMonths("2026-01-15", -3)).toBe("2025-10-15");
  });
});

describe("what a failure is never", () => {
  test("a source's failure is not the view's: every view answers with Yahoo, the agencies and FRED all down", async () => {
    const down: FixtureRoute[] = [
      {
        match: (url) =>
          /^query\d\.finance\.yahoo\.com$/.test(url.hostname) && !url.pathname.includes("getcrumb"),
        body: "",
        status: 503,
      },
      {
        match: (url) =>
          [
            "home.treasury.gov",
            "markets.newyorkfed.org",
            "data-api.ecb.europa.eu",
            "fred.stlouisfed.org",
          ].includes(url.hostname),
        body: "",
        status: 503,
      },
    ];
    const { runTool } = setup({ routes: down });
    for (const name of ["sectors", "yield_curve", "central_banks", "macro", "sector_rotation", "losers"]) {
      const run = await runTool("markets", { view: name });
      expect(run.failure, `${name}: ${run.text}`).toBeUndefined();
      const payload = run.payload as Payload;
      expect(payload.rows, name).toEqual([]);
      expect(payload.missing.length, name).toBeGreaterThan(0);
      // Each row left out is listed; why is said with it, or once for all of them in the coverage.
      const reasons = payload.coverage?.byReason.map((one) => one.reason) ?? [];
      for (const reason of reasons) expect(typeof reason, name).toBe("string");
      for (const gap of payload.missing) {
        expect(typeof gap.reason === "string" || reasons.length === 1, `${name}: ${gap.key}`).toBe(true);
      }
      expect(run.reads.missing(), name).toEqual([]);
    }
  });

  test("a DataError is never thrown for a source's failure, and the read check sees every field", async () => {
    const { deps } = testDeps({}, marketsFetch({ routes: [inline(YAHOO_QUOTES, "", 503)] }));
    const markets = (marketsProvider(deps) as DataProvider).capabilities.markets;
    const answer = await markets?.view?.("fx");
    expect(answer).toBeDefined();
    expect(answer).not.toBeInstanceOf(DataError);
  });
});
