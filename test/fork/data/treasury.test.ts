// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The U.S. Treasury's yield curves in the statistics provider (src/fork/data/sources/treasury.ts and
 * providers/statistics.ts), on the Treasury's own files saved earlier (test/fork/fixtures/treasury): each year's
 * file read by its column names, whatever its year's maturities; par yields, real yields, breakevens (par less
 * real) and spreads through the real macro_series tool, its text compared whole and every field it reads
 * supplied; a page reaching back into the year before; and the failures, each with the kind the router acts
 * on. No request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import { statisticsProvider } from "../../../src/fork/data/providers/statistics.js";
import { curveUrl, maturityOf, parseCurve } from "../../../src/fork/data/sources/treasury.js";
import { buildTools, type FixtureRoute, fixture, type TestOptions, testDeps } from "./harness.js";

/** The Treasury's file of `curve` for `year`: a fixture, or a body written inline. */
function curve(
  kind: "par" | "real",
  year: number,
  answer: { file: string } | { body: string; status?: number },
) {
  const type = kind === "par" ? "daily_treasury_yield_curve" : "daily_treasury_real_yield_curve";
  return {
    match: (url: URL) =>
      url.hostname === "home.treasury.gov" &&
      url.pathname.endsWith(`/daily-treasury-rates.csv/${year}/all`) &&
      url.searchParams.get("type") === type,
    ...("file" in answer ? answer : { ...answer, headers: { "content-type": "text/csv; charset=UTF-8" } }),
  } satisfies FixtureRoute;
}

const FILES: readonly FixtureRoute[] = [
  curve("par", 2026, { file: "treasury/par-2026.csv" }),
  curve("par", 2025, { file: "treasury/par-2025.csv" }),
  curve("real", 2026, { file: "treasury/real-2026.csv" }),
];

/** The statistics provider alone over `routes` (then the saved files), its tools, and what it asked. */
function treasury(routes: readonly FixtureRoute[] = [], extra: TestOptions = {}) {
  const { deps, fetch } = testDeps({}, [...routes, ...FILES], extra);
  return { ...buildTools({ statistics: statisticsProvider(deps) }, { check: true }), fetch };
}

/** The years and curves of the files asked for, in order. */
function filesAsked(fetch: { requests: { url: string }[] }): string[] {
  return fetch.requests.map((request) => {
    const url = new URL(request.url);
    const year = /\/(\d{4})\/all$/.exec(url.pathname)?.[1];
    return `${url.searchParams.get("type")?.includes("real") ? "real" : "par"} ${year}`;
  });
}

const text = (file: string) => new TextDecoder().decode(fixture(file));

describe("reading a year's file", () => {
  test("the 2026 par curve: every maturity by its column's name, oldest day first", () => {
    const days = parseCurve(text("treasury/par-2026.csv"));
    expect(days).toHaveLength(225);
    expect(days[0]?.date).toBe("2026-01-02");
    expect(days.at(-1)).toEqual({
      date: "2026-11-24",
      yields: {
        "1m": 4.21,
        "1.5m": 4.27,
        "2m": 4.28,
        "3m": 4.36,
        "4m": 4.36,
        "6m": 4.46,
        "1y": 4.59,
        "2y": 4.63,
        "3y": 4.67,
        "5y": 4.69,
        "7y": 4.79,
        "10y": 4.91,
        "20y": 5.33,
        "30y": 5.3,
      },
    });
  });

  test("the real curve writes YR where the par curve writes Yr", () => {
    expect(parseCurve(text("treasury/real-2026.csv")).at(-1)).toEqual({
      date: "2026-11-24",
      yields: { "5y": 2.58, "7y": 2.67, "10y": 2.79, "20y": 3.05, "30y": 3.19 },
    });
  });

  test("older years have other columns: 2003 no 30-year or 2-month, 2020 no 4-month or 1.5-month", () => {
    const y2003 = parseCurve(text("treasury/par-2003.csv"));
    expect(Object.keys(y2003.at(-1)?.yields ?? {})).toEqual([
      "1m",
      "3m",
      "6m",
      "1y",
      "2y",
      "3y",
      "5y",
      "7y",
      "10y",
      "20y",
    ]);
    expect(y2003.map((day) => day.date)).toEqual([
      "2003-01-02",
      "2003-01-03",
      "2003-12-29",
      "2003-12-30",
      "2003-12-31",
    ]);
    const y2020 = parseCurve(text("treasury/par-2020.csv"));
    expect(Object.keys(y2020[0]?.yields ?? {})).toEqual([
      "1m",
      "2m",
      "3m",
      "6m",
      "1y",
      "2y",
      "3y",
      "5y",
      "7y",
      "10y",
      "20y",
      "30y",
    ]);
  });

  test("a blank cell is a maturity not quoted that day: the 1.5-month starts 2025-02-18", () => {
    const days = parseCurve(text("treasury/par-2025.csv"));
    expect(days.find((day) => day.date === "2025-02-14")?.yields["1.5m"]).toBeUndefined();
    expect(days.find((day) => day.date === "2025-02-18")?.yields["1.5m"]).toBe(4.41);
  });

  test("a year with no rows yet answers an empty body: no days; anything but a curve file is unreadable", () => {
    expect(parseCurve("")).toEqual([]);
    expect(() => parseCurve("<!DOCTYPE html><html><body>Service unavailable</body></html>")).toThrow(
      "U.S. Treasury answered a yield curve in a form this app does not read.",
    );
  });

  test("columns are maturities by name", () => {
    expect(
      ["10 Yr", "10 YR", "1.5 Month", "3 Mo", "30 Yr", "Date", "4 WEEKS BANK DISCOUNT"].map(maturityOf),
    ).toEqual(["10y", "10y", "1.5m", "3m", "30y", undefined, undefined]);
    expect(curveUrl("real", 2026)).toBe(
      "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all?type=daily_treasury_real_yield_curve&field_tdr_date_value=2026&page&_format=csv",
    );
  });
});

describe("macro_series on the Treasury's curves", () => {
  test("the 10-year Treasury yield: the latest 13 days, one file, every field read supplied", async () => {
    const { runTool, fetch } = treasury();
    const run = await runTool("macro_series", { series: "10-year Treasury yield" });
    expect(run.failure).toBeUndefined();
    expect(run.text).toBe(GOLDEN.tenYear);
    expect(run.reads.missing()).toEqual([]);
    expect(filesAsked(fetch)).toEqual(["par 2026"]);
    expect(run.payload).toMatchObject({ key: "us.treasury.par_10y", continue_end: "2026-11-04" });
  });

  test("the Treasury bill yield is the 3-month par yield, a percent a year", async () => {
    const { runTool } = treasury();
    const run = await runTool("macro_series", { series: "Treasury bill yield", periods: 3 });
    expect(run.text).toBe(GOLDEN.bill);
    expect(run.reads.missing()).toEqual([]);
  });

  test("a breakeven is the par yield less the real yield, each day's terms with it", async () => {
    const { runTool, fetch } = treasury();
    const run = await runTool("macro_series", { series: "10-year breakeven inflation", periods: 3 });
    expect(run.text).toBe(GOLDEN.breakeven);
    expect(run.reads.missing()).toEqual([]);
    expect(filesAsked(fetch).sort()).toEqual(["par 2026", "real 2026"]);
  });

  test("the 2s10s spread is the 10-year less the 2-year, in percentage points", async () => {
    const { runTool } = treasury();
    const run = await runTool("macro_series", { series: "2s10s spread", periods: 3 });
    expect(run.text).toBe(GOLDEN.spread);
  });

  test("a real yield", async () => {
    const { runTool } = treasury();
    const run = await runTool("macro_series", { series: "10-year real Treasury yield", periods: 3 });
    expect(run.text).toBe(GOLDEN.real);
  });

  test("a page reaching into the year before reads that year's file too, and pages on from its oldest day", async () => {
    const { runTool, fetch } = treasury();
    const run = await runTool("macro_series", {
      series: "us.treasury.par_10y",
      periods: 5,
      end: "2026-01-06",
    });
    expect(run.text).toBe(GOLDEN.intoLastYear);
    expect(filesAsked(fetch)).toEqual(["par 2026", "par 2025"]);
    const next = await runTool("macro_series", {
      series: "us.treasury.par_10y",
      periods: 3,
      end: "2025-12-29",
    });
    expect(next.text).toBe(GOLDEN.lastYear);
    // The 2025 file was kept: the next page asked for nothing more.
    expect(filesAsked(fetch)).toEqual(["par 2026", "par 2025"]);
  });

  test("a maturity first quoted in a year has no earlier page", async () => {
    const { runTool } = treasury();
    const run = await runTool("macro_series", {
      series: "1.5-month Treasury yield",
      periods: 5,
      end: "2025-02-19",
    });
    expect(run.payload).toMatchObject({
      key: "us.treasury.par_1_5m",
      periods: [
        { label: "2025-02-18", value: 4.41 },
        { label: "2025-02-19", value: 4.42 },
      ],
      continue_end: null,
    });
  });

  test("in January before the year's first file has rows, the year before answers", async () => {
    const { runTool, fetch } = treasury([curve("par", 2027, { body: "" })], { now: "2027-01-01T15:00:00Z" });
    const run = await runTool("macro_series", { series: "10-year Treasury yield", periods: 2 });
    expect(run.failure).toBeUndefined();
    expect(run.payload).toMatchObject({ periods: [{ label: "2026-11-23" }, { label: "2026-11-24" }] });
    expect(filesAsked(fetch)).toEqual(["par 2027", "par 2026"]);
  });
});

describe("failures", () => {
  test("a past year's file without rows is the source answering wrongly: unavailable", async () => {
    const { runTool } = treasury([curve("par", 2025, { body: "" })]);
    const run = await runTool("macro_series", {
      series: "us.treasury.par_10y",
      periods: 5,
      end: "2026-01-06",
    });
    expect(run.failure).toBe("data_unavailable");
    expect(run.text).toBe(
      "U.S. Treasury could not be reached or answered unreadably; this is not a fact about the market. The Treasury's par yield curve file for 2025 came back without rows.",
    );
  });

  test("the Treasury failing twice, a page that is not a file, or a file not at its address: unavailable", async () => {
    const said: Record<string, string> = {};
    for (const [name, answer] of [
      ["503", { body: "busy", status: 503 }],
      ["html", { body: "<html><body>Maintenance</body></html>" }],
      ["404", { body: "Not Found", status: 404 }],
    ] as const) {
      const { runTool } = treasury([curve("par", 2026, answer)]);
      const run = await runTool("macro_series", { series: "10-year Treasury yield" });
      expect(run.failure, name).toBe("data_unavailable");
      said[name] = run.text;
    }
    expect(said).toEqual({
      "503":
        "U.S. Treasury could not be reached or answered unreadably; this is not a fact about the market. U.S. Treasury answered HTTP 503.",
      html: "U.S. Treasury could not be reached or answered unreadably; this is not a fact about the market. U.S. Treasury answered a yield curve in a form this app does not read.",
      "404":
        "U.S. Treasury could not be reached or answered unreadably; this is not a fact about the market. The Treasury's par yield curve file for 2026 is not at its address (HTTP 404).",
    });
  });

  test("a page before a maturity's first year is no data, without a request", async () => {
    const { runTool, fetch } = treasury();
    const run = await runTool("macro_series", { series: "us.treasury.real_30y", end: "2005-01-01" });
    expect(run.failure).toBe("data_no_data");
    expect(run.text).toBe(
      "U.S. Treasury has no data for this request: The Treasury's files hold no 30-year real Treasury yield on or before 2005-01-01.",
    );
    expect(fetch.requests).toEqual([]);
  });

  test("a key under the Treasury the catalog does not hold is a request to change", async () => {
    const { runTool, fetch } = treasury();
    const run = await runTool("macro_series", { series: "us.treasury.par_25y" });
    expect(run.failure).toBe("data_invalid");
    expect(run.text).toBe(
      "Public statistics cannot answer this request as asked: series:us.treasury.par_25y is not a series this source serves: search macro_series by name for its key",
    );
    expect(fetch.requests).toEqual([]);
  });
});

const GOLDEN = {
  tenYear: `[e1] macro_series 10-year Treasury yield (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
10-year Treasury yield (key us.treasury.par_10y), percent (par yield, bond-equivalent basis), daily (business days)
Latest: 4.91 for 2026-11-24; change from the period before: -0.01 percentage points (from 4.92 in 2026-11-23); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2026-11-24: 4.91
2026-11-23: 4.92
2026-11-20: 4.92
2026-11-19: 5.04
2026-11-18: 5.07
2026-11-17: 5.1
2026-11-16: 5.12
2026-11-13: 5.15
2026-11-12: 5.1
2026-11-10: 4.98
2026-11-09: 4.88
2026-11-06: 4.86
2026-11-05: 4.84
earlier periods: macro_series with series=us.treasury.par_10y, end=2026-11-04`,
  bill: `[e1] macro_series Treasury bill yield (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
Treasury bill yield (key us.treasury.par_3m), percent (par yield, bond-equivalent basis), daily (business days)
Latest: 4.36 for 2026-11-24; change from the period before: -0.01 percentage points (from 4.37 in 2026-11-23); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2026-11-24: 4.36
2026-11-23: 4.37
2026-11-20: 4.32
earlier periods: macro_series with series=us.treasury.par_3m, end=2026-11-19`,
  breakeven: `[e1] macro_series 10-year breakeven inflation (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
10-year breakeven inflation (key us.treasury.breakeven_10y), percent (the Treasury's 10-year par yield less its 10-year real yield), daily (business days)
Latest: 2.12 for 2026-11-24; change from the period before: -0.01 percentage points (from 2.13 in 2026-11-23); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2026-11-24: 2.12 (4.91 less 2.79)
2026-11-23: 2.13 (4.92 less 2.79)
2026-11-20: 2.15 (4.92 less 2.77)
earlier periods: macro_series with series=us.treasury.breakeven_10y, end=2026-11-19`,
  spread: `[e1] macro_series 2s10s spread (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
10-year minus 2-year Treasury spread (key us.treasury.spread_10y_2y), percentage points (the Treasury's 10-year par yield less its 2-year par yield), daily (business days)
Latest: 0.28 for 2026-11-24; change from the period before: -0.01 percentage points (from 0.29 in 2026-11-23); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2026-11-24: 0.28 (4.91 less 4.63)
2026-11-23: 0.29 (4.92 less 4.63)
2026-11-20: 0.29 (4.92 less 4.63)
earlier periods: macro_series with series=us.treasury.spread_10y_2y, end=2026-11-19`,
  real: `[e1] macro_series 10-year real Treasury yield (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
10-year real Treasury yield (key us.treasury.real_10y), percent (real par yield of TIPS), daily (business days)
Latest: 2.79 for 2026-11-24; change from the period before: +0.00 percentage points (from 2.79 in 2026-11-23); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2026-11-24: 2.79
2026-11-23: 2.79
2026-11-20: 2.77
earlier periods: macro_series with series=us.treasury.real_10y, end=2026-11-19`,
  intoLastYear: `[e1] macro_series us.treasury.par_10y Jan 6 (as of Tuesday 2026-01-06; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
10-year Treasury yield (key us.treasury.par_10y), percent (par yield, bond-equivalent basis), daily (business days)
Latest: 4.18 for 2026-01-06; change from the period before: +0.01 percentage points (from 4.17 in 2026-01-05); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2026-01-06: 4.18
2026-01-05: 4.17
2026-01-02: 4.19
2025-12-31: 4.18
2025-12-30: 4.14
earlier periods: macro_series with series=us.treasury.par_10y, end=2025-12-29`,
  lastYear: `[e2] macro_series us.treasury.par_10y Dec 29 2025 (as of Monday 2025-12-29; reference its data as {"ref":"e2","path":"<field>"})
source: Public statistics
10-year Treasury yield (key us.treasury.par_10y), percent (par yield, bond-equivalent basis), daily (business days)
Latest: 4.12 for 2025-12-29; change from the period before: -0.02 percentage points (from 4.14 in 2025-12-26); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2025-12-29: 4.12
2025-12-26: 4.14
2025-12-24: 4.15
earlier periods: macro_series with series=us.treasury.par_10y, end=2025-12-23`,
};
