// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The fork's providers as a setup builds them: one per routing-table key (FSC aside until Phase 4), Yahoo's
 * as upstream serves it today and the others declaring nothing yet; built without a request or a file.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTES } from "../../../src/data/routes.js";
import { dataProviders } from "../../../src/engine/factory.js";
import { forkProviders } from "../../../src/fork/data/index.js";
import { buildTools, fixedClock, fixture, fixtureFetch, YAHOO_AAPL } from "./harness.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fork-providers-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("one provider per routing key, each named for its sources", () => {
  const providers = forkProviders({}, { fetch: fixtureFetch([]) });
  expect(
    Object.fromEntries(Object.entries(providers).map(([key, provider]) => [key, provider?.name])),
  ).toEqual({
    yahoo: "Yahoo",
    filers: "SEC EDGAR",
    frames: "SEC EDGAR",
    ecb: "ECB",
    statistics: "Public statistics",
    markets: "Market overview",
    instruments: "Instrument search",
    news: "News search",
  });
});

test("today only Yahoo serves, as upstream did: quotes and daily price history", () => {
  const providers = forkProviders(
    { secUserAgent: "Jane Doe jane@example.com", fredKey: "fred-0123456789" },
    { fetch: fixtureFetch([]) },
  );
  const served = Object.fromEntries(
    Object.entries(providers).map(([key, provider]) => [
      key,
      Object.keys(provider?.capabilities ?? {}).sort(),
    ]),
  );
  expect(served).toEqual({
    yahoo: ["priceHistory", "quotes"],
    filers: [],
    frames: [],
    ecb: [],
    statistics: [],
    markets: [],
    instruments: [],
    news: [],
  });
  expect(Object.keys(providers.yahoo?.capabilities.priceHistory ?? {}).sort()).toEqual([
    "daily",
    "dailyPair",
  ]);
});

test("every provider the routing table names is built here, by the engine (Polymarket), or later (FSC)", () => {
  const built = new Set([...Object.keys(dataProviders({ fetch: fixtureFetch([]) })), "fsc"]);
  for (const names of Object.values(ROUTES)) for (const name of names) expect(built.has(name)).toBe(true);
  expect(Object.keys(dataProviders({ fetch: fixtureFetch([]) })).sort()).toEqual([
    "ecb",
    "filers",
    "frames",
    "instruments",
    "markets",
    "news",
    "polymarket",
    "statistics",
    "yahoo",
  ]);
});

test("building them sends no request and writes no file", async () => {
  const fetch = fixtureFetch([]);
  const cacheDir = join(dir, "cache", "fork-data");
  forkProviders({ cacheDir, secUserAgent: "Jane Doe jane@example.com" }, { fetch });
  dataProviders({ fetch, publicData: { cacheDir } });
  await Bun.sleep(0);
  expect(fetch.requests).toEqual([]);
  expect(existsSync(cacheDir)).toBe(false);
});

test("an answer yahoo-finance2's schema refuses is unavailable, and the library asks npm for nothing", async () => {
  // Hand-made: the AAPL quote fixture with a market state the library's schema does not know.
  const quote = JSON.parse(new TextDecoder().decode(fixture("yahoo/quote-aapl.json"))) as {
    quoteResponse: { result: Record<string, unknown>[] };
  };
  (quote.quoteResponse.result[0] as Record<string, unknown>).marketState = "SOMETHING_NEW";
  const fetch = fixtureFetch([
    {
      match: /\/v7\/finance\/quote\?/,
      body: JSON.stringify(quote),
      headers: { "content-type": "application/json" },
    },
    ...YAHOO_AAPL,
  ]);
  // The library's own version check would go through the global fetch, not the one it is given.
  const outside: string[] = [];
  const global = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    outside.push(input instanceof Request ? input.url : String(input));
    throw new Error("these tests send no request");
  }) as unknown as typeof globalThis.fetch;
  try {
    const clock = fixedClock("2026-11-25T22:00:00Z");
    const { runTool } = buildTools(forkProviders({}, { fetch, clock }), { clock });
    const run = await runTool("quote", { symbols: ["AAPL"] });
    expect(run.failure).toBe("data_unavailable");
    expect(run.text).toContain("Yahoo could not be read (Failed Yahoo Schema validation)");
    await Bun.sleep(20);
  } finally {
    globalThis.fetch = global;
  }
  expect(outside).toEqual([]);
  expect(fetch.unmatched).toEqual([]);
});
