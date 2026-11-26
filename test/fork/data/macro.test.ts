// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The statistics and ECB providers as the engine sees them: what they declare (in every setup, with or without
 * FRED_API_KEY, built without a request); every series name the skills, agents and tool texts ask macro_series
 * for, run through the real tool and ToolRegistry, taken at once (an exact name) and answered from its publisher
 * with every field the tool reads supplied; the category words a model may try, answered with candidates; price
 * series pointed to price_history; keys of publishers not served. Fixtures are the publishers' own answers saved
 * earlier and FRED's hand-made ones; no request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../../../src/data/capabilities.js";
import { ecbProvider } from "../../../src/fork/data/providers/ecb.js";
import { statisticsProvider } from "../../../src/fork/data/providers/statistics.js";
import { buildTools, type FixtureRoute, testDeps, testProviders } from "./harness.js";

/** The Treasury's file of `curve` for `year`. */
const curve = (kind: "par" | "real", year: number, file: string): FixtureRoute => ({
  match: (url) =>
    url.hostname === "home.treasury.gov" &&
    url.pathname.endsWith(`/daily-treasury-rates.csv/${year}/all`) &&
    url.searchParams.get("type") ===
      (kind === "par" ? "daily_treasury_yield_curve" : "daily_treasury_real_yield_curve"),
  file,
});

/** FRED's keyless download of `code`. */
const graph = (code: string): FixtureRoute => ({
  match: (url) => url.hostname === "fred.stlouisfed.org" && url.searchParams.get("id") === code,
  file: `fred/graph-${code.toLowerCase()}.csv`,
});

const ROUTES: readonly FixtureRoute[] = [
  curve("par", 2026, "treasury/par-2026.csv"),
  curve("real", 2026, "treasury/real-2026.csv"),
  {
    match: "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/5.json",
    file: "nyfed/effr-last5.json",
  },
  {
    match: "https://markets.newyorkfed.org/api/rates/secured/sofr/last/5.json",
    file: "nyfed/sofr-last5.json",
  },
  {
    match: /\/FM\/D\.U2\.EUR\.4F\.KR\.DFR\.LEV\?format=csvdata&detail=dataonly&startPeriod=2024-01-01$/,
    file: "ecb/fm-dfr-since2024.csv",
  },
  graph("CPIAUCSL"),
  graph("CPILFESL"),
  graph("UNRATE"),
  graph("PAYEMS"),
  graph("GDPC1"),
];

/** The statistics and ECB providers alone (without a key unless given), their tools, and what they asked. */
function macro(config: { fredKey?: string } = {}) {
  const { deps, fetch } = testDeps(config, ROUTES);
  const statistics = statisticsProvider(deps);
  const ecb = ecbProvider(deps);
  return { ...buildTools({ statistics, ecb }, { check: true }), statistics, ecb, fetch };
}

/** A provider's capabilities and their methods. */
const declared = (provider: DataProvider) =>
  Object.fromEntries(
    Object.entries(provider.capabilities).map(([name, methods]) => [
      name,
      Object.keys(methods as object).sort(),
    ]),
  );

/**
 * Every series name the specs and tool texts ask macro_series for (specs/skills/*, specs/agents/*,
 * src/tools/macro.ts, src/tools/series.ts, src/tools/valuation.ts), and the series it must be.
 */
const ASKED: readonly [string, string][] = [
  ["CPI", "us.fred.cpiaucsl"],
  ["core CPI", "us.fred.cpilfesl"],
  ["unemployment rate", "us.fred.unrate"],
  ["UNRATE", "us.fred.unrate"],
  ["payrolls", "us.fred.payems"],
  ["nonfarm payrolls", "us.fred.payems"],
  ["GDP", "us.fred.gdpc1"],
  ["10-year Treasury yield", "us.treasury.par_10y"],
  ["Treasury bill yield", "us.treasury.par_3m"],
  ["3-month Treasury bill yield", "us.treasury.par_3m"],
  ["2-year Treasury yield", "us.treasury.par_2y"],
  ["effective federal funds rate", "us.nyfed.effr"],
  ["fed funds rate", "us.nyfed.effr"],
  ["SOFR", "us.nyfed.sofr"],
  ["10-year breakeven inflation", "us.treasury.breakeven_10y"],
  ["ECB deposit facility rate", "ea.ecb.dfr"],
];

describe("what the providers declare", () => {
  test("in every setup, with or without FRED_API_KEY: macro series, and a pair's reference rates", () => {
    for (const config of [{}, { fredKey: "fred-test-key-0123456789abcdef" }]) {
      const { statistics, ecb, fetch } = macro(config);
      expect(statistics.name).toBe("Public statistics");
      expect(declared(statistics)).toEqual({ macroSeries: ["observations", "search"] });
      expect(ecb.name).toBe("ECB");
      expect(declared(ecb)).toEqual({ priceHistory: ["referenceRates"] });
      expect(fetch.requests).toEqual([]);
    }
  });

  test("through every fork provider, macro_series answers from Public statistics", async () => {
    const { providers, clock } = testProviders({}, ROUTES);
    const { runTool, available } = buildTools(providers, { clock });
    expect(available.has("macroSeries")).toBe(true);
    const run = await runTool("macro_series", { series: "10-year Treasury yield", periods: 2 });
    expect(run.source).toBe("Public statistics");
  });
});

describe("every name asked for, through macro_series", () => {
  for (const [name, key] of ASKED) {
    test(`"${name}" is taken at once as ${key}, and answered with every field the tool reads`, async () => {
      const { runTool } = macro();
      const run = await runTool("macro_series", { series: name, periods: 5 });
      expect(run.failure).toBeUndefined();
      expect(run.payload).toMatchObject({ key });
      expect((run.payload as { periods: unknown[] }).periods.length).toBeGreaterThan(0);
      expect(run.reads.missing()).toEqual([]);
    });
  }

  test("the tool's own examples (CPI, unemployment rate, 10-year Treasury yield, UNRATE) list no candidates", async () => {
    const { runTool } = macro();
    for (const series of ["CPI", "unemployment rate", "10-year Treasury yield", "UNRATE", "cpi", "Unrate"]) {
      const run = await runTool("macro_series", { series, periods: 2 });
      expect(run.payload, series).not.toHaveProperty("candidates");
    }
  });

  test("a key as given is read without a search", async () => {
    const { runTool, fetch } = macro();
    const run = await runTool("macro_series", { series: "series:us.treasury.par_2y", periods: 2 });
    expect(run.payload).toMatchObject({ key: "us.treasury.par_2y" });
    expect(fetch.requests).toHaveLength(1);
  });
});

describe("broader words", () => {
  test("the categories the tool and the macro agent name each list candidates, never a refusal", async () => {
    const { runTool } = macro();
    for (const word of [
      "inflation",
      "employment",
      "rates",
      "growth",
      "money",
      "sentiment",
      "housing",
      "central banks",
      "the yield curve",
      "credit",
      "volatility",
    ]) {
      const run = await runTool("macro_series", { series: word });
      expect(run.failure, word).toBeUndefined();
      const candidates = (run.payload as { candidates: string[] }).candidates;
      expect(candidates.length, word).toBeGreaterThan(0);
      // macro_series takes only a name that is one series': a search never answers two of one name.
      const names = candidates.map((line) => line.slice(0, line.indexOf(" (key ")));
      expect(new Set(names).size, word).toBe(names.length);
      expect(run.reads.missing(), word).toEqual([]);
    }
  });

  test("inflation lists CPI and core CPI first", async () => {
    const { runTool } = macro();
    const run = await runTool("macro_series", { series: "inflation" });
    expect((run.payload as { candidates: string[] }).candidates.slice(0, 2)).toEqual([
      "CPI (key us.fred.cpiaucsl), Index 1982-1984=100, Monthly, Seasonally Adjusted",
      "core CPI (key us.fred.cpilfesl), Index 1982-1984=100, Monthly, Seasonally Adjusted",
    ]);
  });
});

describe("what macro_series does not read here", () => {
  test("a price series by name is pointed to price_history; by key it is a request to change", async () => {
    const { runTool, fetch } = macro();
    const vix = await runTool("macro_series", { series: "VIX" });
    expect(vix.failure).toBe("refused");
    expect(vix.text).toBe(
      "VIX (key us.volatility.vix), index, daily, daily price bars is a price series with daily bars, which this tool does not read.",
    );
    const move = await runTool("macro_series", { series: "MOVE" });
    expect(move.text).toContain("(key us.volatility.move)");
    const byKey = await runTool("macro_series", { series: "us.equity_index.sp500" });
    expect(byKey.failure).toBe("data_invalid");
    expect(byKey.text).toBe(
      "Public statistics cannot answer this request as asked: series:us.equity_index.sp500 (S&P 500) is a price series with daily bars: read it with price_history",
    );
    expect(fetch.requests).toEqual([]);
  });

  test("a key of a publisher not served here is unsupported, unasked", async () => {
    const { runTool, fetch } = macro();
    const run = await runTool("macro_series", { series: "kr.ecos.722y001.0101000" });
    expect(run.failure).toBe("data_unsupported");
    expect(run.text).toBe(
      "Public statistics does not cover this request (series:kr.ecos.722y001.0101000: this source serves the U.S. Treasury's, the New York Fed's, the ECB's and FRED's series (keys us.treasury.*, us.nyfed.*, ea.ecb.*, us.fred.*)); this is not a fact about the market.",
    );
    expect(fetch.requests).toEqual([]);
  });
});
