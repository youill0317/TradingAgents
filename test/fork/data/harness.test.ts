// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The data-test harness, proved on what is served today: quote and price_history run through the real tools,
 * the router and the ToolRegistry on upstream's Yahoo provider over the fork's shared yahoo-finance2
 * client, answered by hand-made Yahoo fixtures (test/fork/fixtures/yahoo, marked hand_made: the library's
 * own User-Agent is the only one Yahoo answers, so these were not recorded here); compute tools read the
 * results of earlier calls; the read check finds what an answer leaves out, spread or not. No request
 * reaches the network.
 */
import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../../../src/data/capabilities.js";
import type { Providers } from "../../../src/data/router.js";
import {
  buildTools,
  FIXTURES,
  fixture,
  fixtureFetch,
  fixtureMeta,
  readCheck,
  readLog,
  testDeps,
  testProviders,
  YAHOO_AAPL,
} from "./harness.js";

/** Providers of one stand-in, routed for every capability it declares under the key the routing table names. */
function standIn(key: keyof Providers, capabilities: DataProvider["capabilities"]): Providers {
  return { [key]: { name: "Stand-in", capabilities } } as Providers;
}

describe("the harness on upstream Yahoo, offline", () => {
  test("quote answers through the real tool, as the model reads it", async () => {
    const { providers, fetch, clock } = testProviders({}, YAHOO_AAPL);
    const { runTool } = buildTools(providers, { clock, check: true });
    const run = await runTool("quote", { symbols: ["AAPL"] });
    expect(run.failure).toBeUndefined();
    expect(run.provenance).toEqual({ source: "Yahoo", subject: "AAPL", as_of: "2026-11-25" });
    expect(run.payload).toMatchObject({
      quotes: [
        {
          symbol: "AAPL",
          instrument: "Apple Inc. (AAPL, NasdaqGS, USD)",
          quote_kind: "last_close",
          price: 342.37,
          price_basis: "as traded",
          market_state: "post",
          change_percent: -0.5201,
          market_cap: 5084000000000,
        },
      ],
      errors: [],
    });
    expect(run.text).toContain("quote AAPL");
    expect(run.text).toContain("source: Yahoo");
    expect(run.text).toContain("price 342.37");
    expect(run.summary).toBe("342.37 -0.52% (close 2026-11-25)");
    // What upstream's Yahoo answer leaves out that the quote tool reads: optional fields it never sets.
    expect(run.reads.missing()).toEqual([
      "change_basis",
      "field_states",
      "instrument.listing",
      "instrument.price_scale",
      "stale",
    ]);
    expect(run.reads.paths()).toContain("previous_close");
    expect(fetch.unmatched).toEqual([]);
  });

  test("price_history answers the window's completed sessions, adjusted", async () => {
    const { providers, fetch, clock } = testProviders({}, YAHOO_AAPL);
    const { runTool } = buildTools(providers, { clock, check: true });
    const run = await runTool("price_history", { symbol: "AAPL", period: "5d" });
    expect(run.failure).toBeUndefined();
    expect(run.payload).toMatchObject({
      symbol: "AAPL",
      currency: "USD",
      interval: "daily",
      price_basis: "split_dividend_adjusted",
      from: "2026-11-19",
      through: "2026-11-25",
      dates: ["2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25"],
      closes: [337.4, 339.9, 341.2, 344.16, 342.37],
      // The last bar has no later session yet, so it may still change.
      states: [null, null, null, null, "provisional"],
      earlier: "price_history with end=2026-11-18, period=5d",
    });
    expect(run.provenance).toEqual({ source: "Yahoo", subject: "AAPL", as_of: "2026-11-25" });
    expect(run.text).toContain("price_history AAPL");
    expect(run.reads.paths()).toEqual(
      expect.arrayContaining(["bars[].close", "coverage.through", "earlier_end", "price_basis"]),
    );
    expect(fetch.unmatched).toEqual([]);
  });

  test("every Yahoo request carries the library's own User-Agent", async () => {
    const { providers, fetch, clock } = testProviders({}, YAHOO_AAPL);
    const { runTool } = buildTools(providers, { clock });
    await runTool("quote", { symbols: ["AAPL"] });
    await runTool("price_history", { symbol: "AAPL", period: "5d" });
    const yahoo = fetch.requests.filter((request) => /yahoo\.com$/.test(new URL(request.url).hostname));
    expect(yahoo.length).toBeGreaterThan(0);
    for (const request of yahoo) {
      expect(request.headers.get("user-agent") ?? "").toStartWith("Mozilla/5.0 (compatible; yahoo-finance2/");
    }
  });

  test("each client keeps its own cookies and crumb: a Yahoo test passes alone or after another", async () => {
    for (let i = 0; i < 2; i++) {
      const { providers, fetch, clock } = testProviders({}, YAHOO_AAPL);
      const run = await buildTools(providers, { clock }).runTool("quote", { symbols: ["AAPL"] });
      expect(run.failure).toBeUndefined();
      // Each serves the crumb flow itself: nothing carries over from the client before it.
      expect(fetch.requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/quote/AAPL",
        "/v1/test/getcrumb",
        "/v7/finance/quote",
      ]);
    }
  });

  test("Yahoo's requests are not queued: many asked at once are all in flight together", async () => {
    let inFlight = 0;
    let most = 0;
    const answers = fixtureFetch(YAHOO_AAPL);
    const counting = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).includes("/v7/finance/quote")) return answers(input, init);
        inFlight++;
        most = Math.max(most, inFlight);
        await Bun.sleep(50);
        inFlight--;
        return answers(input, init);
      },
      { requests: answers.requests, unmatched: answers.unmatched },
    ) as typeof answers;
    const { deps } = testDeps({}, counting);
    await deps.yahoo.quote("AAPL");
    await Promise.all(Array.from({ length: 10 }, () => deps.yahoo.quote("AAPL")));
    expect(most).toBe(10);
  });

  test("a tool whose capability no provider serves in the setup says so", async () => {
    // Without SEC_USER_AGENT: the keyless sources only, nothing from SEC EDGAR; the market views and
    // instrument search are not built yet.
    const { providers, fetch, clock } = testProviders();
    const { runTool, available } = buildTools(providers, { clock });
    expect([...available].sort()).toEqual([
      "corporateActions",
      "macroSeries",
      "news",
      "ownership",
      "priceHistory",
      "profiles",
      "quotes",
      "technicals",
    ]);
    const run = await runTool("statements", { symbol: "AAPL", statement: "income_statement" });
    expect(run.failure).toBe("data_not_configured");
    expect(run.text).toBe("Financial statements: not available in this setup.");
    const markets = await runTool("markets", { view: "yield_curve" });
    expect(markets.failure).toBe("data_not_configured");
    expect(fetch.requests).toEqual([]);
  });
});

describe("the harness itself", () => {
  test("a request no fixture answers fails loudly and is listed", async () => {
    const fetch = fixtureFetch([{ match: "https://example.test/a", body: "a" }]);
    expect(await (await fetch("https://example.test/a")).text()).toBe("a");
    const errors: unknown[] = [];
    const quiet = console.error;
    console.error = (...said: unknown[]) => errors.push(said.join(" "));
    try {
      await expect(fetch("https://example.test/b")).rejects.toThrow(
        "no fixture answers https://example.test/b",
      );
    } finally {
      console.error = quiet;
    }
    expect(errors).toHaveLength(1);
    expect(fetch.unmatched).toEqual(["https://example.test/b"]);
    expect(fetch.requests.map((request) => request.url)).toEqual([
      "https://example.test/a",
      "https://example.test/b",
    ]);
  });

  test("a fixture file answers with its meta's status and content type", async () => {
    const fetch = fixtureFetch([{ match: /quote/, file: "yahoo/quote-aapl.json" }]);
    const answer = await fetch("https://query2.finance.yahoo.com/v7/finance/quote?symbols=AAPL");
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(((await answer.json()) as { quoteResponse: unknown }).quoteResponse).toBeDefined();
  });

  test("an answer written inline is served with the status and headers given", async () => {
    // Hand-made in the ECB's documented problem+json form (its 404 for a series it does not have).
    const fetch = fixtureFetch([
      {
        match: /D\.XXX\.EUR/,
        body: JSON.stringify({ status: 404, title: "Not Found", detail: "No Series was returned" }),
        status: 404,
        headers: { "content-type": "application/problem+json" },
      },
    ]);
    const answer = await fetch(
      "https://data-api.ecb.europa.eu/service/data/EXR/D.XXX.EUR.SP00.A?format=csvdata&lastNObservations=1",
    );
    expect(answer.status).toBe(404);
    expect(answer.headers.get("content-type")).toBe("application/problem+json");
    expect(((await answer.json()) as { title: string }).title).toBe("Not Found");
  });

  test("every fixture under test/fork/fixtures, in any folder, has its meta, and a hand-made one says what it is made from", () => {
    const files = [...new Bun.Glob("**/*").scanSync(FIXTURES)].filter(
      (file) => !file.endsWith(".meta.json") && file !== "biome.json",
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const meta = fixtureMeta(file);
      expect(meta, file).toBeDefined();
      expect(meta?.bytes, file).toBe(fixture(file).length);
      if (meta?.hand_made) expect(meta.note, file).toStartWith("Hand-made");
      else expect([typeof meta?.status, meta?.url?.startsWith("https://")], file).toEqual(["number", true]);
    }
  });

  test("the read check logs each field read, and which held nothing", () => {
    const { value, log } = readCheck({
      a: 1,
      b: { c: null as number | null, d: undefined as number | undefined },
      list: [{ x: 1 }, { x: undefined as number | undefined }],
    });
    expect(value.a).toBe(1);
    expect(value.b.c).toBeNull();
    expect(value.b.d).toBeUndefined();
    expect(value.list.map((item) => item.x)).toEqual([1, undefined]);
    // Past the end of a list is a reader looking, not a field left out.
    expect(value.list[5]).toBeUndefined();
    expect(log.paths()).toEqual(["a", "b", "b.c", "b.d", "list", "list[]", "list[].x"]);
    expect(log.missing()).toEqual(["b.d", "list[].x"]);
  });

  test("the read check sees through spreads and entries, and leaves the data as it was", () => {
    const data = { a: 1, nested: { b: 2 } };
    const { value, log } = readCheck(data);
    expect({ ...value }).toEqual({ a: 1, nested: { b: 2 } });
    expect(Object.entries(value.nested)).toEqual([["b", 2]]);
    expect(log.missing()).toEqual([]);
    expect([...log.listed].sort()).toEqual(["", "nested"]);
    expect(data).toEqual({ a: 1, nested: { b: 2 } });
  });

  test("a field asked about with `in` counts as read, never as missing", () => {
    const { value, log } = readCheck({ candidates: [] as string[] } as Record<string, unknown>);
    expect("candidates" in value).toBe(true);
    expect("series" in value).toBe(false);
    expect(log.paths()).toEqual(["candidates", "series"]);
    expect(log.missing()).toEqual([]);
    expect(readLog().missing()).toEqual([]);
  });

  test("a spread answer's left-out keys are found: technicals' indicators", async () => {
    // A stand-in answers one indicator of the 22; the tool spreads the answer into its payload.
    const providers = standIn("yahoo", {
      technicals: {
        latest: async () => ({
          instrument: { key: "AAPL", name: "Apple Inc.", venue: "NasdaqGS", currency: "USD" },
          through: "2026-11-25",
          rsi: 55.1,
        }),
      },
    });
    const { runTool } = buildTools(providers, { check: true });
    const run = await runTool("technicals", { symbol: "AAPL" });
    expect(run.failure).toBeUndefined();
    const missing = run.reads.missing();
    for (const key of ["macd", "sma_50", "bb_upper", "atr_5", "pvo", "window", "last_value", "price_basis"]) {
      expect(missing).toContain(key);
    }
    expect(missing).not.toContain("rsi");
    expect(missing).not.toContain("through");
    expect(run.reads.listed.has("")).toBe(true);
  });
});

describe("compute tools over earlier results, as the engine offers them", () => {
  test("statements, then dcf reading the operating cash flow and capital expenditure lines", async () => {
    const filing = { accession: "0000320193-26-000010", form: "10-K", accepted_at: "2026-10-30T20:31:12Z" };
    const line = (name: string, value: number) => ({
      line: name,
      value,
      unit: "USD",
      period_start: "2025-09-28",
      sources: [{ ...filing, cik: "0000320193", predecessor: false }],
    });
    const providers = standIn("filers", {
      statements: {
        statement: async () => ({
          instrument: { key: "AAPL", name: "Apple Inc.", venue: "Nasdaq", currency: "USD" },
          periods: [
            {
              period_end: "2026-09-26",
              lines: [
                line("Net Cash from Operating Activities", 118_254_000_000),
                line("Payments to Acquire PP&E", -9_447_000_000),
              ],
            },
          ],
          succession: { registrants: [{ cik: "0000320193", complete: true }], stopsAt: [] },
          next_cursor: null,
        }),
      },
    });
    const { runTool, registry } = buildTools(providers, { check: true });
    expect(registry.kindOf("dcf")).toBe("compute");
    expect(registry.kindOf("evidence")).toBe("control");
    const statement = await runTool("statements", {
      symbol: "AAPL",
      statement: "cash_flow",
      period_type: "annual",
      periods: 1,
    });
    expect(statement.failure).toBeUndefined();
    expect(statement.evidence).toBe("e1");
    const dcf = await runTool("dcf", {
      cash_flow: { ref: "e1" },
      stages: [{ years: 5, growth_pct: 6 }],
      terminal_growth_pct: 2.5,
      discount: { rate_pct: 9 },
      net_debt: 0,
      shares: 15_000_000_000,
    });
    expect(dcf.failure).toBeUndefined();
    expect((dcf.payload as { inputs: { name: string; value: number }[] }).inputs.slice(0, 2)).toEqual([
      expect.objectContaining({ name: "Net Cash from Operating Activities", value: 118_254_000_000 }),
      expect.objectContaining({ name: "Payments to Acquire PP&E", value: -9_447_000_000 }),
    ]);
    // The evidence tool shows a recorded result again.
    const again = await runTool("evidence", { id: "e1", path: "periods[0].end" });
    expect(again.failure).toBeUndefined();
    expect(again.text).toContain("2026-09-26");
  });

  test("price_history, then returns_risk over its recorded result", async () => {
    const { providers, clock } = testProviders({}, YAHOO_AAPL);
    const { runTool } = buildTools(providers, { clock });
    const history = await runTool("price_history", { symbol: "AAPL", period: "5d" });
    expect(history.evidence).toBe("e1");
    const risk = await runTool("returns_risk", { series: [{ ref: "e1" }] });
    expect(risk.failure).toBeUndefined();
    expect(risk.text).toContain("returns_risk");
  });
});
