// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The New York Fed's reference rates in the statistics provider (src/fork/data/sources/nyfed.ts and
 * providers/statistics.ts), on its own answers saved earlier (test/fork/fixtures/nyfed): EFFR with the FOMC's
 * target range on each day (a single target before 2008-12-16), SOFR, OBFR and TGCR through the real macro_series
 * tool, its text compared whole and every field it reads supplied; an earlier page read by a window of dates;
 * and the failures, each with the kind the router acts on. No request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import { statisticsProvider } from "../../../src/fork/data/providers/statistics.js";
import { latestUrl, parseRates, windowUrl } from "../../../src/fork/data/sources/nyfed.js";
import { buildTools, type FixtureRoute, fixture, testDeps } from "./harness.js";

const RATES = "https://markets.newyorkfed.org/api/rates";
const json = { "content-type": "application/json;charset=utf-8" };

const SAVED: readonly FixtureRoute[] = [
  { match: `${RATES}/unsecured/effr/last/5.json`, file: "nyfed/effr-last5.json" },
  { match: `${RATES}/secured/sofr/last/5.json`, file: "nyfed/sofr-last5.json" },
  { match: `${RATES}/unsecured/obfr/last/5.json`, file: "nyfed/obfr-last5.json" },
  { match: `${RATES}/secured/tgcr/last/1.json`, file: "nyfed/tgcr-last1.json" },
  // The saved answers for SOFR's 2026 and EFFR's October and December 2008 cover each window asked of them.
  { match: /\/secured\/sofr\/search\.json\?startDate=2026-/, file: "nyfed/sofr-search-2026.json" },
  { match: /\/unsecured\/effr\/search\.json\?startDate=2026-/, file: "nyfed/effr-search-2026-10.json" },
  { match: /\/unsecured\/effr\/search\.json\?startDate=2008-/, file: "nyfed/effr-search-2008-12.json" },
];

/** The statistics provider alone over `routes` (then the saved answers), its tools, and what it asked. */
function nyfed(routes: readonly FixtureRoute[] = []) {
  const { deps, fetch } = testDeps({}, [...routes, ...SAVED]);
  return { ...buildTools({ statistics: statisticsProvider(deps) }, { check: true }), fetch };
}

const saved = (file: string) => JSON.parse(new TextDecoder().decode(fixture(file))) as unknown;

describe("reading an answer", () => {
  test("EFFR: oldest day first, each with the FOMC's target range", () => {
    const days = parseRates(saved("nyfed/effr-last5.json"), "effr");
    expect(days.map((day) => day.date)).toEqual([
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
      "2026-11-23",
      "2026-11-24",
    ]);
    expect(days.at(-1)).toEqual({
      date: "2026-11-24",
      value: 3.88,
      revised: false,
      target: { from: 3.75, to: 4 },
    });
  });

  test("2008: a revised rate is said, and before 2008-12-16 the target is a single rate", () => {
    const days = parseRates(saved("nyfed/effr-search-2008-12.json"), "effr");
    expect(days.find((day) => day.date === "2008-12-19")).toMatchObject({
      revised: true,
      target: { to: 0.25 },
    });
    expect(days.find((day) => day.date === "2008-12-15")).toEqual({
      date: "2008-12-15",
      value: 0.18,
      revised: false,
      target: { from: 1, to: null },
    });
  });

  test("SOFR's days carry no target; a weekend has no day; anything without refRates is unreadable", () => {
    expect(parseRates(saved("nyfed/sofr-last5.json"), "sofr").at(-1)).toEqual({
      date: "2026-11-24",
      value: 3.94,
      revised: false,
    });
    expect(parseRates(saved("nyfed/sofr-search-weekend.json"), "sofr")).toEqual([]);
    expect(() => parseRates({ error: "x" }, "sofr")).toThrow(
      "New York Fed answered its rates in a form this app does not read.",
    );
  });

  test("the addresses: the latest days by count, an earlier page by a window", () => {
    expect(latestUrl("effr", 13)).toBe(`${RATES}/unsecured/effr/last/13.json`);
    expect(windowUrl("sofr", { from: "2026-10-02", to: "2026-10-31" })).toBe(
      `${RATES}/secured/sofr/search.json?startDate=2026-10-02&endDate=2026-10-31`,
    );
  });
});

describe("macro_series on the New York Fed's rates", () => {
  test("the fed funds rate is EFFR, each day with the FOMC's target range, every field read supplied", async () => {
    const { runTool, fetch } = nyfed();
    const run = await runTool("macro_series", { series: "fed funds rate", periods: 5 });
    expect(run.failure).toBeUndefined();
    expect(run.text).toBe(GOLDEN.effr);
    expect(run.reads.missing()).toEqual([]);
    expect(fetch.requests.map((request) => request.url)).toEqual([`${RATES}/unsecured/effr/last/5.json`]);
  });

  test("SOFR", async () => {
    const { runTool } = nyfed();
    const run = await runTool("macro_series", { series: "SOFR", periods: 5 });
    expect(run.text).toBe(GOLDEN.sofr);
    expect(run.reads.missing()).toEqual([]);
  });

  test("OBFR and TGCR by name", async () => {
    const { runTool } = nyfed();
    const obfr = await runTool("macro_series", { series: "overnight bank funding rate", periods: 5 });
    expect(obfr.payload).toMatchObject({
      key: "us.nyfed.obfr",
      periods: [{ label: "2026-11-18" }, {}, {}, {}, { label: "2026-11-24", value: 3.88, evidence: null }],
    });
    const tgcr = await runTool("macro_series", { series: "TGCR", periods: 1 });
    expect(tgcr.payload).toMatchObject({
      key: "us.nyfed.tgcr",
      periods: [{ label: "2026-11-24", value: 3.92 }],
    });
  });

  test("an earlier page is read by a window of dates wide enough for its business days", async () => {
    const { runTool, fetch } = nyfed();
    const run = await runTool("macro_series", { series: "us.nyfed.sofr", periods: 3, end: "2026-10-31" });
    expect(run.text).toBe(GOLDEN.sofrEarlier);
    expect(fetch.requests.map((request) => request.url)).toEqual([
      `${RATES}/secured/sofr/search.json?startDate=2026-10-16&endDate=2026-10-31`,
    ]);
    const effr = await runTool("macro_series", { series: "us.nyfed.effr", periods: 3, end: "2026-10-31" });
    expect(effr.payload).toMatchObject({
      periods: [{ label: "2026-10-28" }, { label: "2026-10-29" }, { label: "2026-10-30", value: 3.88 }],
      continue_end: "2026-10-27",
    });
  });

  test("December 2008: the single target before the range, and a revised rate's status", async () => {
    const { runTool } = nyfed();
    const run = await runTool("macro_series", { series: "us.nyfed.effr", periods: 6, end: "2008-12-19" });
    expect(run.failure).toBeUndefined();
    expect(run.payload).toMatchObject({
      periods: [
        { label: "2008-12-12", value: 0.15, evidence: "FOMC target 1.00", status: null },
        { label: "2008-12-15", value: 0.18, evidence: "FOMC target 1.00" },
        { label: "2008-12-16", value: 0.17, evidence: "FOMC target range 0.00-0.25" },
        { label: "2008-12-17" },
        { label: "2008-12-18" },
        { label: "2008-12-19", value: 0.11, evidence: "FOMC target range 0.00-0.25", status: "revised" },
      ],
    });
  });
});

describe("failures", () => {
  test("a window without a business day, or before the rate began: no data", async () => {
    const weekend: FixtureRoute = {
      match: /\/secured\/sofr\/search\.json/,
      file: "nyfed/sofr-search-weekend.json",
    };
    const { runTool } = nyfed([weekend]);
    const run = await runTool("macro_series", { series: "us.nyfed.sofr", periods: 1, end: "2026-11-22" });
    expect(run.failure).toBe("data_no_data");
    expect(run.text).toBe(
      "New York Fed has no data for this request: The New York Fed published no SOFR on or before 2026-11-22.",
    );
    const early = await runTool("macro_series", { series: "us.nyfed.sofr", end: "2010-01-01" });
    expect(early.text).toBe(
      "New York Fed has no data for this request: The New York Fed published no SOFR on or before 2010-01-01 (its SOFR starts 2018-04-02).",
    );
  });

  test("a malformed request (its 400, empty), a missing address, an answer that is not JSON or not rates: unavailable", async () => {
    const said: Record<string, string> = {};
    for (const [name, answer] of [
      ["400", { body: "", status: 400 }],
      ["404", { body: "", status: 404 }],
      ["html", { body: "<html>Maintenance</html>" }],
      ["shape", { body: '{"rates": []}' }],
    ] as const) {
      const { runTool } = nyfed([{ match: /\/effr\/last\//, headers: json, ...answer }]);
      const run = await runTool("macro_series", { series: "EFFR", periods: 5 });
      expect(run.failure, name).toBe("data_unavailable");
      said[name] = run.text.replace(
        "New York Fed could not be reached or answered unreadably; this is not a fact about the market. ",
        "",
      );
    }
    expect(said).toEqual({
      "400": "New York Fed answered HTTP 400.",
      "404": "The New York Fed's EFFR is not at its address (HTTP 404).",
      html: "New York Fed answered with something other than JSON.",
      shape: "New York Fed answered its rates in a form this app does not read.",
    });
  });
});

const GOLDEN = {
  effr: `[e1] macro_series fed funds rate (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
effective federal funds rate (key us.nyfed.effr), percent (volume-weighted median; a volume-weighted mean before March 2016), daily (business days)
Latest: 3.88 for 2026-11-24; change from the period before: +0.00 percentage points (from 3.88 in 2026-11-23); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2026-11-24: 3.88 (FOMC target range 3.75-4.00)
2026-11-23: 3.88 (FOMC target range 3.75-4.00)
2026-11-20: 3.88 (FOMC target range 3.75-4.00)
2026-11-19: 3.88 (FOMC target range 3.75-4.00)
2026-11-18: 3.88 (FOMC target range 3.75-4.00)
earlier periods: macro_series with series=us.nyfed.effr, end=2026-11-17`,
  sofr: `[e1] macro_series SOFR (as of Tuesday 2026-11-24; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
SOFR (key us.nyfed.sofr), percent (volume-weighted median), daily (business days)
Latest: 3.94 for 2026-11-24; change from the period before: +0.02 percentage points (from 3.92 in 2026-11-23); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2026-11-24: 3.94
2026-11-23: 3.92
2026-11-20: 3.92
2026-11-19: 3.91
2026-11-18: 3.9
earlier periods: macro_series with series=us.nyfed.sofr, end=2026-11-17`,
  sofrEarlier: `[e1] macro_series us.nyfed.sofr Oct 31 (as of Friday 2026-10-30; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
SOFR (key us.nyfed.sofr), percent (volume-weighted median), daily (business days)
Latest: 3.95 for 2026-10-30; change from the period before: +0.01 percentage points (from 3.94 in 2026-10-29); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2026-10-30: 3.95
2026-10-29: 3.94
2026-10-28: 3.94
earlier periods: macro_series with series=us.nyfed.sofr, end=2026-10-27`,
};
