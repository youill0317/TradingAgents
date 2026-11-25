// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The data-test harness, proved on what is served today: quote and price_history run through the real tools,
 * the router and the ToolRegistry on upstream's Yahoo provider over the fork's shared yahoo-finance2
 * client, answered by hand-made Yahoo fixtures (test/fork/fixtures/yahoo, marked hand_made: the library's
 * own User-Agent is the only one Yahoo answers, so these were not recorded here). No request reaches the
 * network; the read check shows which fields of upstream's answers the tools read and find missing.
 */
import { describe, expect, test } from "bun:test";
import { forkProviders } from "../../../src/fork/data/index.js";
import {
  buildTools,
  FIXTURES,
  fixedClock,
  fixture,
  fixtureFetch,
  fixtureMeta,
  readCheck,
  YAHOO_AAPL,
} from "./harness.js";

const clock = fixedClock("2026-11-25T22:00:00Z");

describe("the harness on upstream Yahoo, offline", () => {
  test("quote answers through the real tool, as the model reads it", async () => {
    const fetch = fixtureFetch(YAHOO_AAPL);
    const { runTool } = buildTools(forkProviders({}, { fetch, clock }), { clock, check: true });
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
    const fetch = fixtureFetch(YAHOO_AAPL);
    const { runTool } = buildTools(forkProviders({}, { fetch, clock }), { clock, check: true });
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
    const fetch = fixtureFetch(YAHOO_AAPL);
    const { runTool } = buildTools(forkProviders({}, { fetch, clock }), { clock });
    await runTool("quote", { symbols: ["AAPL"] });
    await runTool("price_history", { symbol: "AAPL", period: "5d" });
    const yahoo = fetch.requests.filter((request) => /yahoo\.com$/.test(new URL(request.url).hostname));
    expect(yahoo.length).toBeGreaterThan(0);
    for (const request of yahoo) {
      expect(request.headers.get("user-agent") ?? "").toStartWith("Mozilla/5.0 (compatible; yahoo-finance2/");
    }
  });

  test("a tool whose capability no provider serves yet says so", async () => {
    const fetch = fixtureFetch([]);
    const { runTool, available } = buildTools(forkProviders({}, { fetch, clock }), { clock });
    expect([...available].sort()).toEqual(["priceHistory", "quotes"]);
    const run = await runTool("statements", { symbol: "AAPL", statement: "income_statement" });
    expect(run.failure).toBe("data_not_configured");
    expect(run.text).toBe("Financial statements: not available in this setup.");
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

  test("every fixture under test/fork/fixtures has its meta, and a hand-made one says what it is made from", () => {
    const files = [...new Bun.Glob("*/*").scanSync(FIXTURES)].filter((file) => !file.endsWith(".meta.json"));
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
    expect(data).toEqual({ a: 1, nested: { b: 2 } });
  });
});
