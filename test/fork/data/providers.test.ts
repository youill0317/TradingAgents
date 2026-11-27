// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The fork's providers as a setup builds them: one per routing-table key, each declaring what it serves in that
 * setup (the SEC-backed ones only with SEC_USER_AGENT, the FSC's prices only with DATA_GO_KR_API_KEY, OpenDART's
 * Korean statements, filings and insider reports only with DART_API_KEY); built without a request or a file.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTES } from "../../../src/data/routes.js";
import { dataProviders } from "../../../src/engine/factory.js";
import { forkProviders } from "../../../src/fork/data/index.js";
import { MODULES } from "../../../src/fork/data/sources/yahoo.js";
import { buildTools, fixture, fixtureFetch, testProviders, YAHOO_AAPL } from "./harness.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fork-providers-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("one provider per routing key, each named for its sources", () => {
  const { providers } = testProviders();
  expect(
    Object.fromEntries(Object.entries(providers).map(([key, provider]) => [key, provider?.name])),
  ).toEqual({
    yahoo: "Yahoo",
    fsc: "FSC",
    filers: "SEC EDGAR",
    frames: "SEC EDGAR",
    ecb: "ECB",
    statistics: "Public statistics",
    markets: "Market overview",
    instruments: "Instrument search",
    news: "News search",
  });
});

/** What each provider declares in a setup: its capabilities, each with its methods. */
function declared(config: Parameters<typeof testProviders>[0]) {
  const { providers, fetch } = testProviders(config);
  const served = Object.fromEntries(
    Object.entries(providers).map(([key, provider]) => [
      key,
      Object.fromEntries(
        Object.entries(provider?.capabilities ?? {}).map(([capability, methods]) => [
          capability,
          Object.keys(methods ?? {}).sort(),
        ]),
      ),
    ]),
  );
  return { served, fetch };
}

/**
 * What is declared in every setup: the sources that need no key (Yahoo, the ECB, the agencies' series, news,
 * the market views, instrument search).
 */
const KEYLESS = {
  yahoo: {
    quotes: ["many", "quote"],
    priceHistory: ["daily", "dailyPair", "intraday"],
    technicals: ["latest"],
    profiles: ["analyst", "calendar", "profile"],
    corporateActions: ["list"],
    // Insider transactions are the filers'.
    ownership: ["holders"],
  },
  ecb: { priceHistory: ["referenceRates"] },
  statistics: { macroSeries: ["observations", "search"] },
  news: { news: ["article", "articles"] },
  // Yahoo, the Treasury, the New York Fed, the ECB and FRED's keyless download.
  markets: { markets: ["view"] },
  // The catalogs and Yahoo's search (SEC's ticker list joins with SEC_USER_AGENT, inside the same method).
  instruments: { instruments: ["search"] },
};

test("without SEC_USER_AGENT the keyless sources serve, and nothing is read from SEC EDGAR", () => {
  // FRED_API_KEY adds no capability: macro series are served without it, from the keyless publishers. SEC
  // EDGAR declares only ownership's insider view, which answers what to set (Yahoo serves the institutional).
  for (const config of [{}, { fredKey: "fred-0123456789" }]) {
    const { served, fetch } = declared(config);
    expect(served).toEqual({ ...KEYLESS, fsc: {}, filers: { ownership: ["transactions"] }, frames: {} });
    expect(fetch.requests).toEqual([]);
  }
});

test("without SEC_USER_AGENT, ownership's insider view says what to set; its institutional view is Yahoo's", async () => {
  const holders = {
    match: (url: URL) =>
      decodeURIComponent(url.pathname) === "/v10/finance/quoteSummary/AAPL" &&
      url.searchParams.get("modules") === MODULES.holders.join(","),
    file: "yahoo/quotesummary-aapl-holders.json",
  };
  const { providers, fetch, clock } = testProviders({}, [holders, ...YAHOO_AAPL]);
  const { runTool } = buildTools(providers, { clock, check: true });
  const insider = await runTool("ownership", { symbol: "AAPL" });
  expect(insider.failure).toBe("data_not_configured");
  expect(insider.text).toStartWith(
    "Insider transactions come from SEC EDGAR, which is read only with SEC_USER_AGENT",
  );
  expect(insider.text).toEndWith("Institutional holders are served: ownership with view=institutional.");
  const institutional = await runTool("ownership", { symbol: "AAPL", view: "institutional" });
  expect(institutional.failure).toBeUndefined();
  expect(institutional.source).toBe("Yahoo");
  // Nothing was asked of SEC.
  expect(fetch.requests.some((request) => request.url.includes("sec.gov"))).toBe(false);
  expect(fetch.unmatched).toEqual([]);
});

test("with SEC_USER_AGENT, SEC EDGAR serves statements, filings, insider transactions and screens too", () => {
  const { served, fetch } = declared({
    secUserAgent: "Jane Doe jane@example.com",
    fredKey: "fred-0123456789",
  });
  expect(served).toEqual({
    ...KEYLESS,
    fsc: {},
    filers: { statements: ["statement"], filings: ["list", "section"], ownership: ["transactions"] },
    frames: { crossSections: ["financials"] },
  });
  expect(fetch.requests).toEqual([]);
});

test("with the Korean keys: the FSC's prices, and OpenDART's statements, filings and insider reports", () => {
  const korean = {
    dartKey: "dart-0123456789",
    ecosKey: "ecos-0123456789",
    kosisKey: "kosis-0123456789",
    dataGoKrKey: "datagokr-0123456789",
    naverClientId: "naver-id",
    naverClientSecret: "naver-secret",
  };
  // ECOS, KOSIS and Naver serve inside capabilities declared in every setup (macro series, market views,
  // news): they add no method. Without SEC_USER_AGENT, OpenDART alone declares the filers' three for Korean
  // listings (a US listing's answer says to set SEC_USER_AGENT); screens stay SEC EDGAR's.
  const alone = declared(korean);
  expect(alone.served).toEqual({
    ...KEYLESS,
    fsc: { quotes: ["many", "quote"], priceHistory: ["daily"] },
    filers: { statements: ["statement"], filings: ["list", "section"], ownership: ["transactions"] },
    frames: {},
  });
  const both = declared({ ...korean, secUserAgent: "Jane Doe jane@example.com" });
  expect(both.served).toEqual({ ...alone.served, frames: { crossSections: ["financials"] } });
  expect(testProviders(korean).providers.filers?.name).toBe("SEC EDGAR / OpenDART");
  expect([...alone.fetch.requests, ...both.fetch.requests]).toEqual([]);
});

test("every provider the routing table names is built here, or by the engine (Polymarket)", () => {
  const built = new Set(Object.keys(dataProviders({ fetch: fixtureFetch([]) })));
  for (const names of Object.values(ROUTES)) for (const name of names) expect(built.has(name)).toBe(true);
  expect(Object.keys(dataProviders({ fetch: fixtureFetch([]) })).sort()).toEqual([
    "ecb",
    "filers",
    "frames",
    "fsc",
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
  const routes = [
    {
      match: /\/v7\/finance\/quote\?/,
      body: JSON.stringify(quote),
      headers: { "content-type": "application/json" },
    },
    ...YAHOO_AAPL,
  ];
  // The library's own version check would go through the global fetch, not the one it is given.
  const outside: string[] = [];
  const global = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    outside.push(input instanceof Request ? input.url : String(input));
    throw new Error("these tests send no request");
  }) as unknown as typeof globalThis.fetch;
  const { providers, fetch, clock } = testProviders({}, routes);
  try {
    const { runTool } = buildTools(providers, { clock });
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
