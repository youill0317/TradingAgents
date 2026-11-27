// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * FRED in the statistics provider (src/fork/data/sources/fred.ts and providers/statistics.ts), on fixtures
 * hand-made in FRED's documented formats (test/fork/fixtures/fred; FRED's website did not answer the session
 * that built them and no key was used) and FRED's one saved 400: without FRED_API_KEY its keyless download of
 * the catalog's series (the latest vintage); with the key every vintage, each value with the day it became
 * known and, when revised, its first release; a code outside the catalog found and read with the key; and the
 * failures, each with the kind the router acts on and, where a key would change it, FRED_API_KEY named. The key
 * reaches FRED's API only, never an answer, a message or a payload. No request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import {
  observationWindow,
  periodOf,
  statisticsProvider,
} from "../../../src/fork/data/providers/statistics.js";
import {
  graphUrl,
  parseGraph,
  parseVintages,
  periodKindOf,
  unitOf,
} from "../../../src/fork/data/sources/fred.js";
import { buildTools, type FixtureRoute, fixture, testDeps } from "./harness.js";

const KEY = "fred-test-key-0123456789abcdef";
const API = "https://api.stlouisfed.org/fred";
const GRAPH = "https://fred.stlouisfed.org/graph/fredgraph.csv";

const SAVED: readonly FixtureRoute[] = [
  { match: /fredgraph\.csv\?id=CPIAUCSL&/, file: "fred/graph-cpiaucsl.csv" },
  { match: /fredgraph\.csv\?id=GDPC1&/, file: "fred/graph-gdpc1.csv" },
  { match: /\/fred\/series\?series_id=CPIAUCSL&/, file: "fred/series-cpiaucsl.json" },
  { match: /\/fred\/series\/observations\?series_id=CPIAUCSL&/, file: "fred/observations-cpiaucsl.json" },
  { match: /\/fred\/series\?series_id=DEXJPUS&/, file: "fred/series-dexjpus.json" },
  { match: /\/fred\/series\/search\?/, file: "fred/search-dexjpus.json" },
  { match: /\/fred\/series\/observations\?series_id=DEXJPUS&/, file: "fred/observations-dexjpus.json" },
  { match: /\/fred\/series\?series_id=NOSUCHCODE&/, file: "fred/error-no-series.json" },
];

/** The statistics provider alone, with or without the key, over `routes` (then the fixtures). */
function fred(key: boolean, routes: readonly FixtureRoute[] = []) {
  const { deps, fetch } = testDeps(key ? { fredKey: KEY } : {}, [...routes, ...SAVED]);
  const tools = buildTools({ statistics: statisticsProvider(deps) }, { check: true });
  // Every address asked for, the key shown as KEY.
  const asked = () => fetch.requests.map((request) => request.url.replace(KEY, "KEY"));
  return { ...tools, fetch, asked };
}

const json = (file: string) => JSON.parse(new TextDecoder().decode(fixture(file))) as Record<string, unknown>;

describe("reading FRED's answers", () => {
  test("the keyless download: the date column by either name, the series' column by its code, '.' and empty as no value", () => {
    expect(
      parseGraph(new TextDecoder().decode(fixture("fred/graph-cpiaucsl.csv")), "CPIAUCSL").slice(4, 7),
    ).toEqual([
      { date: "2025-09-01", value: 324.8 },
      { date: "2025-10-01", value: null },
      { date: "2025-11-01", value: 325.031 },
    ]);
    expect(parseGraph("DATE,UNRATE,CPIAUCSL\n2026-09-01,,331\n2026-10-01,4.4,332\n", "unrate")).toEqual([
      { date: "2026-09-01", value: null },
      { date: "2026-10-01", value: 4.4 },
    ]);
    expect(parseGraph("", "UNRATE")).toEqual([]);
    expect(() => parseGraph("<html><body>Checking your browser</body></html>", "UNRATE")).toThrow(
      "FRED answered its download in a form this app does not read.",
    );
    expect(graphUrl("CPIAUCSL", { start: "2025-05-01", end: "2026-11-25" })).toBe(
      `${GRAPH}?id=CPIAUCSL&cosd=2025-05-01&coed=2026-11-25`,
    );
  });

  test("every vintage: today's value known from the first vintage holding it, and its first release", () => {
    const points = parseVintages(json("fred/observations-cpiaucsl.json"));
    const of = (date: string) => points.find((point) => point.date === date);
    // Revised by the vintage of 2026-02-11.
    expect(of("2025-12-01")).toEqual({
      date: "2025-12-01",
      value: 325.554,
      knownFrom: "2026-02-11",
      first: { date: "2026-01-13", value: 324.89 },
    });
    // A later vintage repeating the value changes nothing: known from its first release.
    expect(of("2025-07-01")).toEqual({
      date: "2025-07-01",
      value: 323.048,
      knownFrom: "2025-08-12",
      first: { date: "2025-08-12", value: 323.048 },
    });
    expect(of("2025-10-01")?.value).toBeNull();
    expect(points).toHaveLength(18);
  });

  test("units and periods as FRED words them", () => {
    expect(
      [
        "Index 1982-1984=100",
        "Percent",
        "Percent Change from Preceding Period",
        "Billions of Chained 2017 Dollars",
        "Thousands of Persons",
        "Dollars per Hour",
        "Japanese Yen to One U.S. Dollar",
        "Basis Points",
      ].map((units) => unitOf(units)),
    ).toEqual([
      { kind: "index", multiplier: 1, currency: null, per: null },
      { kind: "percent", multiplier: 1, currency: null, per: null },
      { kind: "percent", multiplier: 1, currency: null, per: null },
      { kind: "currency", multiplier: 1e9, currency: "USD", per: null },
      { kind: "count", multiplier: 1000, currency: null, per: null },
      { kind: "currency", multiplier: 1, currency: "USD", per: "hour" },
      { kind: "ratio", multiplier: 1, currency: null, per: null },
      { kind: "percentage_points", multiplier: 0.01, currency: null, per: null },
    ]);
    expect(["D", "W", "BW", "M", "Q", "SA", "A"].map(periodKindOf)).toEqual([
      "calendar_day",
      "week",
      "week",
      "month",
      "quarter",
      "half_year",
      "year",
    ]);
    expect(periodOf("week", "2026-11-21", true)).toEqual({
      kind: "week",
      start: "2026-11-15",
      label: "week ending 2026-11-21",
    });
    expect(periodOf("quarter", "2026-07-01")).toEqual({
      kind: "quarter",
      start: "2026-07-01",
      label: "2026-Q3",
    });
    expect(periodOf("half_year", "2026-07-01").label).toBe("2026-H2");
    expect(periodOf("year", "2025-01-01").label).toBe("2025");
  });

  test("the dates read for a page: its periods and some more, a week's to its last day", () => {
    expect(observationWindow("month", 13, "2026-11-25", "2026-11-25")).toEqual({
      start: "2025-05-01",
      end: "2026-11-25",
    });
    expect(observationWindow("quarter", 13, "2026-11-25", "2026-11-25").start).toBe("2023-01-01");
    expect(observationWindow("year", 5, "2026-11-25", "2026-11-25").start).toBe("2020-01-01");
    expect(observationWindow("week", 5, "2026-11-10", "2026-11-25", true)).toEqual({
      start: "2026-08-25",
      end: "2026-11-16",
    });
  });
});

describe("without FRED_API_KEY", () => {
  test("CPI from FRED's keyless download: the latest vintage, a month FRED has no value for said, one request", async () => {
    const { runTool, asked } = fred(false);
    const run = await runTool("macro_series", { series: "CPI" });
    expect(run.failure).toBeUndefined();
    expect(run.text).toBe(GOLDEN.cpiKeyless);
    expect(run.reads.missing()).toEqual([]);
    expect(asked()).toEqual([`${GRAPH}?id=CPIAUCSL&cosd=2025-05-01&coed=2026-11-25`]);
  });

  test("GDP is real GDP, quarterly: quarters compared with the one before and a year earlier", async () => {
    const { runTool } = fred(false);
    const run = await runTool("macro_series", { series: "GDP", periods: 6 });
    expect(run.text).toBe(GOLDEN.gdpKeyless);
    expect(run.reads.missing()).toEqual([]);
  });

  test("a FRED code outside the catalog, or a search the catalog cannot answer, needs the key: said as is, unasked", async () => {
    const { runTool, asked } = fred(false);
    const code = await runTool("macro_series", { series: "us.fred.dexjpus" });
    expect(code.failure).toBe("data_not_configured");
    expect(code.text).toBe(
      'FRED series DEXJPUS, outside this app\'s catalog, needs FRED_API_KEY (a free key from https://fred.stlouisfed.org/docs/api/api_key.html), set in the environment or under "data" in credentials.json.',
    );
    const search = await runTool("macro_series", { series: "Japan GDP" });
    expect(search.failure).toBe("data_not_configured");
    expect(search.text).toBe(
      "No series in this app's catalog matched \"Japan GDP\" (it holds the U.S. Treasury's yields, the New York Fed's reference rates, the ECB's key interest rates and FRED's headline series); a search of all of FRED's series needs FRED_API_KEY (a free key from https://fred.stlouisfed.org/docs/api/api_key.html), set in the environment or under \"data\" in credentials.json.",
    );
    expect(asked()).toEqual([]);
  });

  test("the keyless download failing, cut off or answering a page that is not its CSV: unavailable, naming FRED_API_KEY", async () => {
    const reset = Object.assign(new TypeError("socket closed"), { code: "ECONNRESET" });
    const said: Record<string, string> = {};
    for (const [name, route] of [
      ["503", { match: /fredgraph/, body: "busy", status: 503 }],
      ["page", { match: /fredgraph/, body: "<html><body>Checking your browser</body></html>" }],
      [
        "reset",
        {
          match: (url: URL) => {
            if (url.hostname === "fred.stlouisfed.org") throw reset;
            return false;
          },
        },
      ],
    ] as const) {
      const { runTool } = fred(false, [route as FixtureRoute]);
      const run = await runTool("macro_series", { series: "CPI" });
      expect(run.failure, name).toBe("data_unavailable");
      said[name] = run.text.replace(
        "FRED could not be reached or answered unreadably; this is not a fact about the market. ",
        "",
      );
    }
    const key =
      "With FRED_API_KEY set (a free key from https://fred.stlouisfed.org/docs/api/api_key.html), FRED's API serves this series, with the day each value became known.";
    expect(said).toEqual({
      "503": `FRED's keyless download failed: FRED answered HTTP 503. ${key}`,
      page: `FRED's keyless download failed: FRED answered its download in a form this app does not read. ${key}`,
      reset: `FRED's keyless download failed: FRED could not be reached (ECONNRESET). ${key}`,
    });
  });

  test("the keyless download asking to wait longer than the call may: rate limited", async () => {
    const { runTool } = fred(false, [
      { match: /fredgraph/, body: "slow down", status: 429, headers: { "retry-after": "120" } },
    ]);
    const run = await runTool("macro_series", { series: "CPI" });
    expect(run.failure).toBe("data_rate_limited");
  });
});

describe("with FRED_API_KEY", () => {
  test("CPI with every vintage: each value known from its release, a revised one with its first release", async () => {
    const { runTool, asked } = fred(true);
    const run = await runTool("macro_series", { series: "CPI" });
    expect(run.failure).toBeUndefined();
    expect(run.text).toBe(GOLDEN.cpiKeyed);
    expect(run.reads.missing()).toEqual([]);
    expect(asked()).toEqual([
      `${API}/series?series_id=CPIAUCSL&api_key=KEY&file_type=json`,
      `${API}/series/observations?series_id=CPIAUCSL&realtime_start=1776-07-04&realtime_end=9999-12-31&observation_start=2025-05-01&observation_end=2026-11-25&api_key=KEY&file_type=json`,
    ]);
    expect((run.payload as { periods: unknown[] }).periods.slice(0, 4)).toMatchObject([
      { label: "2025-10", value: null, known_from: null },
      { label: "2025-11", status: "revised", known_from: "2026-02-11" },
      {},
      { label: "2026-01", status: null, known_from: "2026-02-11", evidence: "first release" },
    ]);
  });

  test("a name the catalog holds exactly asks FRED's search nothing", async () => {
    const { runTool, asked } = fred(true);
    const run = await runTool("macro_series", { series: "consumer price index", periods: 1 });
    expect(run.payload).toMatchObject({ key: "us.fred.cpiaucsl" });
    expect(asked().some((url) => url.includes("/series/search"))).toBe(false);
  });

  test("a FRED code outside the catalog: found by FRED's search, named as asked, read with FRED's description", async () => {
    const { runTool, asked } = fred(true);
    const run = await runTool("macro_series", { series: "DEXJPUS", periods: 5 });
    expect(run.failure).toBeUndefined();
    expect(run.text).toBe(GOLDEN.yen);
    expect(run.reads.missing()).toEqual([]);
    expect(asked()).toEqual([
      `${API}/series/search?search_text=DEXJPUS&limit=5&order_by=search_rank&sort_order=desc&api_key=KEY&file_type=json`,
      `${API}/series?series_id=DEXJPUS&api_key=KEY&file_type=json`,
      `${API}/series/observations?series_id=DEXJPUS&realtime_start=1776-07-04&realtime_end=9999-12-31&observation_start=2026-10-28&observation_end=2026-11-25&api_key=KEY&file_type=json`,
    ]);
  });

  test("a text the catalog does not find: FRED's best matches, after any of the catalog's", async () => {
    const { runTool } = fred(true);
    const run = await runTool("macro_series", { series: "yen dollar exchange rate" });
    expect(run.text).toBe(GOLDEN.yenSearch);
    expect(run.reads.missing()).toEqual([]);
  });

  test("a key FRED does not take is rejected, said as is with FRED_API_KEY named", async () => {
    for (const file of ["fred/error-not-registered.json", "fred/error-no-key.json"]) {
      const { runTool } = fred(true, [{ match: /\/fred\/series\/observations/, file }]);
      const run = await runTool("macro_series", { series: "CPI" });
      expect(run.failure, file).toBe("data_rejected");
      expect(run.text, file).toStartWith("FRED refused FRED_API_KEY (Bad Request.");
      expect(run.text, file).toEndWith(
        "for more information). A free key comes from https://fred.stlouisfed.org/docs/api/api_key.html.",
      );
    }
  });

  test("a code FRED does not know is invalid; FRED failing twice is unavailable", async () => {
    const { runTool } = fred(true, [{ match: /\/fred\/series\/observations/, body: "oops", status: 500 }]);
    const unknown = await runTool("macro_series", { series: "us.fred.nosuchcode" });
    expect(unknown.failure).toBe("data_invalid");
    expect(unknown.text).toBe("FRED cannot answer this request as asked: FRED has no series NOSUCHCODE");
    const failing = await runTool("macro_series", { series: "CPI" });
    expect(failing.failure).toBe("data_unavailable");
    expect(failing.text).toBe(
      "FRED could not be reached or answered unreadably; this is not a fact about the market. FRED answered HTTP 500.",
    );
  });

  test("the key reaches FRED's API only: never a text, a payload, a message or another host", async () => {
    const { runTool, fetch } = fred(true, [
      {
        match: /\/fred\/series\/observations\?series_id=CPIAUCSL&.*observation_start=2026-/,
        file: "fred/error-not-registered.json",
      },
    ]);
    const runs = [
      await runTool("macro_series", { series: "CPI" }),
      await runTool("macro_series", { series: "DEXJPUS", periods: 5 }),
      await runTool("macro_series", { series: "yen dollar exchange rate" }),
      await runTool("macro_series", { series: "CPI", periods: 3 }),
      await runTool("macro_series", { series: "us.fred.nosuchcode" }),
    ];
    for (const run of runs) {
      expect(run.text).not.toContain(KEY);
      expect(JSON.stringify(run.payload ?? null)).not.toContain(KEY);
    }
    const carrying = fetch.requests.filter((request) => request.url.includes(KEY));
    expect(carrying.length).toBeGreaterThan(0);
    for (const request of carrying) expect(new URL(request.url).hostname).toBe("api.stlouisfed.org");
  });
});

const GOLDEN = {
  cpiKeyless: `[e1] macro_series CPI (as of Thursday 2026-10-01; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
CPI (key us.fred.cpiaucsl), Index 1982-1984=100, Monthly, Seasonally Adjusted
Latest: 332.763 for 2026-10; change from the period before: +0.20% (from 332.097 in 2026-09); change from a year earlier: not available (no value for 2025-10)
periods, newest first:
2026-10: 332.763 (latest vintage)
2026-09: 332.097 (latest vintage)
2026-08: 331.452 (latest vintage)
2026-07: 330.718 (latest vintage)
2026-06: 330.109 (latest vintage)
2026-05: 329.412 (latest vintage)
2026-04: 328.881 (latest vintage)
2026-03: 328.104 (latest vintage)
2026-02: 327.46 (latest vintage)
2026-01: 326.588 (latest vintage)
2025-12: 325.554 (latest vintage)
2025-11: 325.031 (latest vintage)
2025-10: no value; value: FRED has no value for this period
earlier periods: macro_series with series=us.fred.cpiaucsl, end=2025-09-30`,
  gdpKeyless: `[e1] macro_series GDP (as of Wednesday 2026-07-01; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
GDP (key us.fred.gdpc1), Billions of Chained 2017 Dollars, Quarterly, Seasonally Adjusted Annual Rate
Latest: 23972.66 for 2026-Q3; change from the period before: +0.53% (from 23846.199 in 2026-Q2); change from a year earlier: +1.78% (from 23552.318 in 2025-Q3)
periods, newest first:
2026-Q3: 23972.66 (latest vintage)
2026-Q2: 23846.199 (latest vintage)
2026-Q1: 23711.436 (latest vintage)
2025-Q4: 23599.801 (latest vintage)
2025-Q3: 23552.318 (latest vintage)
2025-Q2: 23420.874 (latest vintage)
earlier periods: macro_series with series=us.fred.gdpc1, end=2025-03-31`,
  cpiKeyed: `[e1] macro_series CPI (as of Thursday 2026-10-01; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
CPI (key us.fred.cpiaucsl), Index 1982-1984=100, Monthly, Seasonally Adjusted
Latest: 332.763 for 2026-10; change from the period before: +0.20% (from 332.097 in 2026-09); change from a year earlier: not available (no value for 2025-10)
periods, newest first:
2026-10: 332.763, known from 2026-11-13 (first release)
2026-09: 332.097, known from 2026-10-15 (first release)
2026-08: 331.452, known from 2026-09-11 (first release)
2026-07: 330.718, known from 2026-08-12 (first release)
2026-06: 330.109, known from 2026-07-14 (first release)
2026-05: 329.412, known from 2026-06-10 (first release)
2026-04: 328.881, known from 2026-05-12 (first release)
2026-03: 328.104, known from 2026-04-10 (first release)
2026-02: 327.46, known from 2026-03-11 (first release)
2026-01: 326.588, known from 2026-02-11 (first release)
2025-12: 325.554, known from 2026-02-11 (first released 2026-01-13 as 324.89)
2025-11: 325.031, known from 2026-02-11 (first released 2025-12-18 as 324.122)
2025-10: no value; value: FRED has no value for this period
earlier periods: macro_series with series=us.fred.cpiaucsl, end=2025-09-30`,
  yen: `[e1] macro_series DEXJPUS (as of Friday 2026-11-20; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
Japanese Yen to U.S. Dollar Spot Exchange Rate (key us.fred.dexjpus), Japanese Yen to One U.S. Dollar, Daily, Not Seasonally Adjusted
Latest: 154.47 for 2026-11-20; change from the period before: +0.18% (from 154.2 in 2026-11-19); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2026-11-20: 154.47, known from 2026-11-23 (first release)
2026-11-19: 154.2, known from 2026-11-23 (first release)
2026-11-18: 154.61, known from 2026-11-23 (first release)
2026-11-17: 154.35, known from 2026-11-23 (first release)
2026-11-16: 153.88, known from 2026-11-23 (first release)
earlier periods: macro_series with series=us.fred.dexjpus, end=2026-11-15`,
  yenSearch: `[e1] macro_series yen dollar exchange rate (reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
"yen dollar exchange rate" is not certain to mean one series; call macro_series again with the key of the one you mean:
- Japanese Yen to U.S. Dollar Spot Exchange Rate (key us.fred.dexjpus), Japanese Yen to One U.S. Dollar, Daily, Not Seasonally Adjusted
- Japanese Yen to U.S. Dollar Spot Exchange Rate (key us.fred.exjpus), Japanese Yen to One U.S. Dollar, Monthly, Not Seasonally Adjusted
- Japanese Yen to U.S. Dollar Spot Exchange Rate (key us.fred.aexjpus), Japanese Yen to One U.S. Dollar, Annual, Not Seasonally Adjusted`,
};
