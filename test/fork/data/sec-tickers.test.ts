// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * SEC's ticker list, the module the SEC providers share, on the hand-made fixture of its documented form
 * (test/fork/fixtures/sec/company-tickers-exchange.json; www.sec.gov answers only a User-Agent naming a
 * contact, so no real answer could be saved): rows read by field name, US listings in every spelling, a
 * listing on another venue never taken for the US filer with its letters, one request for callers asking
 * together, not_configured without SEC_USER_AGENT, and a day-old list served when SEC cannot be read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataError } from "../../../src/data/errors.js";
import { createCache } from "../../../src/fork/data/cache.js";
import {
  paddedCik,
  parseSecTickers,
  SEC_TICKERS_TTL_MS,
  SEC_TICKERS_URL,
  secTicker,
  secTickers,
} from "../../../src/fork/data/sources/sec-tickers.js";
import { type FixtureRoute, testDeps } from "./harness.js";

const UA = "Test Agent test@example.com";
const LIST: FixtureRoute = { match: SEC_TICKERS_URL, file: "sec/company-tickers-exchange.json" };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fork-sec-tickers-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The DataError `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<DataError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error("it answered");
}

describe("the list as SEC writes it", () => {
  test("rows are read by field name, whatever the columns' order; CIKs padded to ten digits", () => {
    const rows = parseSecTickers({
      fields: ["exchange", "ticker", "cik", "name"],
      data: [
        ["Nasdaq", "AAPL", 320193, "Apple Inc."],
        [null, "brk.b", "0001067983", "BERKSHIRE HATHAWAY INC"],
        ["OTC", "TSMWF", 1046179, "TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD"],
        // Rows that cannot be read are left out: no ticker, a CIK that is not one, not a row.
        ["NYSE", "", 1, "No ticker"],
        ["NYSE", "XYZ", "CIK1", "Not a CIK"],
        "not a row",
      ],
    });
    expect(rows).toEqual([
      { cik: "0000320193", name: "Apple Inc.", ticker: "AAPL", exchange: "Nasdaq" },
      { cik: "0001067983", name: "BERKSHIRE HATHAWAY INC", ticker: "BRK-B", exchange: null },
      {
        cik: "0001046179",
        name: "TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD",
        ticker: "TSMWF",
        exchange: "OTC",
      },
    ]);
    expect(paddedCik(70858)).toBe("0000070858");
    expect(paddedCik("0000070858")).toBe("0000070858");
  });

  test("an answer in another form is SEC being unavailable", () => {
    for (const body of [{ "0": { cik_str: 320193, ticker: "AAPL" } }, { fields: ["name"], data: [] }, null]) {
      expect(() => parseSecTickers(body)).toThrow(DataError);
    }
  });

  test("a US listing in every spelling the tools pass; anything else is no US listing", () => {
    for (const key of ["BRK.B", "brk-b", "XNYS:BRK.B", "security:BRK.B", "SECURITY:XNYS:BRK-B"]) {
      expect(secTicker(key)).toBe("BRK-B");
    }
    expect(secTicker("XNAS:AAPL")).toBe("AAPL");
    for (const key of [
      "XLON:BA",
      "XPAR:AI",
      "XTSE:T",
      "XLON:III",
      "XKRX:005930",
      "005930.KS",
      "005930",
      "FX:EURUSD",
      "CRYPTO:BTC-USD",
      "SERIES:US.FRED.CPIAUCSL",
      "FUTURE:XNYM:CL",
      "",
    ]) {
      expect(secTicker(key)).toBeUndefined();
    }
  });
});

describe("the list as the providers read it", () => {
  test("bySymbol finds a US listing's filer, share classes and preferreds included", async () => {
    const { deps, fetch } = testDeps({ secUserAgent: UA }, [LIST]);
    const tickers = secTickers(deps);
    expect(await tickers.bySymbol("AAPL")).toEqual({
      cik: "0000320193",
      name: "Apple Inc.",
      ticker: "AAPL",
      exchange: "Nasdaq",
    });
    for (const key of ["BRK.B", "BRK-B", "XNYS:BRK.B"]) {
      expect((await tickers.bySymbol(key))?.cik).toBe("0001067983");
    }
    expect(await tickers.bySymbol("BAC-PB")).toMatchObject({ cik: "0000070858", exchange: "NYSE" });
    expect(await tickers.bySymbol("TSMWF")).toMatchObject({ cik: "0001046179", exchange: "OTC" });
    expect(await tickers.bySymbol("ZZZZ")).toBeUndefined();
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]?.headers.get("user-agent")).toBe(UA);
    expect(fetch.unmatched).toEqual([]);
  });

  test("a listing on another venue is not the US filer that shares its letters, and asks SEC nothing", async () => {
    const { deps, fetch } = testDeps({ secUserAgent: UA }, [LIST]);
    const tickers = secTickers(deps);
    // BAE Systems trades in London as BA, Boeing in New York; TSMC and Walmart likewise elsewhere.
    for (const key of ["XLON:BA", "XTSE:WMT", "XPAR:AAPL", "XHKG:TSM", "XKRX:005930", "fx:EURUSD"]) {
      expect(await tickers.bySymbol(key)).toBeUndefined();
    }
    expect(fetch.requests).toHaveLength(0);
    expect(await tickers.bySymbol("BA")).toMatchObject({ cik: "0000012927", name: "BOEING CO" });
  });

  test("byCik lists a CIK's tickers in SEC's order; all is the whole list", async () => {
    const { deps } = testDeps({ secUserAgent: UA }, [LIST]);
    const tickers = secTickers(deps);
    expect((await tickers.byCik(1067983)).map((row) => row.ticker)).toEqual(["BRK-B", "BRK-A"]);
    expect((await tickers.byCik("0000070858")).map((row) => row.ticker)).toEqual(["BAC", "BAC-PB", "BACRP"]);
    expect(await tickers.byCik("9999999999")).toEqual([]);
    const all = await tickers.all();
    expect(all).toHaveLength(12);
    expect(new Set(all.map((row) => row.exchange))).toEqual(new Set(["Nasdaq", "NYSE", "OTC"]));
  });

  test("callers asking together share one request; the list is kept a day", async () => {
    let now = Date.parse("2026-11-25T22:00:00Z");
    const { deps, fetch } = testDeps({ secUserAgent: UA }, [LIST], {
      cache: createCache({ now: () => now }),
    });
    const tickers = secTickers(deps);
    await Promise.all([
      tickers.bySymbol("AAPL"),
      tickers.byCik(320193),
      tickers.all(),
      tickers.bySymbol("BA"),
    ]);
    expect(fetch.requests).toHaveLength(1);
    now += SEC_TICKERS_TTL_MS - 1;
    await tickers.bySymbol("MSFT");
    expect(fetch.requests).toHaveLength(1);
    now += 1;
    await tickers.bySymbol("MSFT");
    expect(fetch.requests).toHaveLength(2);
  });

  test("without SEC_USER_AGENT: not_configured, and no request", async () => {
    const { deps, fetch } = testDeps({}, [LIST]);
    const error = await failure(secTickers(deps).bySymbol("AAPL"));
    expect([error.kind, error.details.source]).toEqual(["not_configured", "SEC EDGAR"]);
    expect(error.message).toContain("SEC_USER_AGENT");
    expect(fetch.requests).toHaveLength(0);
  });

  test("a list past its day is served when SEC cannot be read; with none kept, SEC's failure is said", async () => {
    let now = Date.parse("2026-11-25T22:00:00Z");
    const config = { secUserAgent: UA, cacheDir: dir };
    const first = testDeps(config, [LIST], { cache: createCache({ dir, now: () => now }) });
    expect((await secTickers(first.deps).bySymbol("AAPL"))?.cik).toBe("0000320193");
    now += 2 * SEC_TICKERS_TTL_MS;
    const down: FixtureRoute = { match: SEC_TICKERS_URL, body: "unavailable", status: 503 };
    const later = testDeps(config, [down], { cache: createCache({ dir, now: () => now }) });
    expect((await secTickers(later.deps).bySymbol("AAPL"))?.cik).toBe("0000320193");
    // Asked once, and once more after a pause, as a 5xx is.
    expect(later.fetch.requests).toHaveLength(2);
    const empty = await mkdtemp(join(tmpdir(), "fork-sec-tickers-empty-"));
    try {
      const none = testDeps({ secUserAgent: UA, cacheDir: empty }, [down], {
        cache: createCache({ dir: empty, now: () => now }),
      });
      const error = await failure(secTickers(none.deps).bySymbol("AAPL"));
      expect([error.kind, error.details.status]).toEqual(["unavailable", 503]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("a caller's cancellation ends its wait", async () => {
    const { deps } = testDeps({ secUserAgent: UA }, [LIST]);
    const controller = new AbortController();
    controller.abort();
    await expect(secTickers(deps).bySymbol("AAPL", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
