// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/** The fixture recorder's cases and its recordings, offline: keys removed, failures never written. */
import { expect, test } from "bun:test";
import {
  DEV_USER_AGENT,
  loadCases,
  type ReadTools,
  recordOne,
  yahooAnswerer,
} from "../../../scripts/fork/record-fixtures.js";
import { DataError } from "../../../src/data/errors.js";
import { forkDeps } from "../../../src/fork/data/deps.js";
import { type Http, Pacer } from "../../../src/fork/data/http.js";
import { fakeTimer, fixtureFetch, YAHOO_AAPL } from "./harness.js";

const KEY = "fred-key-0123456789abcdef";

/** The recorder's clients over `fetch`, with a fake timer and a pacer of their own. */
function clients(fetch: typeof globalThis.fetch): { http: Http; tools: ReadTools } {
  const built = forkDeps(
    { fredKey: KEY },
    { fetch, timer: fakeTimer(), pacer: new Pacer(), userAgent: DEV_USER_AGENT },
  );
  return { http: built.http, tools: { yahoo: built.yahoo, yahooAnswer: yahooAnswerer(fetch) } };
}

test("the case modules load, each case with a source, a name and one way to read it", async () => {
  const cases = await loadCases();
  expect(cases.map((one) => `${one.source}/${one.name}`)).toContain("ecb/exr-usd-last5");
  for (const one of cases) expect(Boolean(one.url) !== Boolean(one.read)).toBe(true);
});

test("a text answer is written with every key removed, from its body and its URL", async () => {
  const url = `https://api.stlouisfed.org/fred/series?series_id=CPIAUCSL&api_key=${KEY}&file_type=json`;
  const fetch = fixtureFetch([
    {
      match: /api\.stlouisfed\.org/,
      body: JSON.stringify({ realtime_start: "2026-11-25", note: `echoed ${KEY}` }),
      headers: { "content-type": "application/json; charset=UTF-8" },
    },
  ]);
  const { http, tools } = clients(fetch);
  const { file, body, meta } = await recordOne(
    { source: "fred", name: "series-cpiaucsl", url },
    http,
    tools,
    [KEY],
  );
  expect(file).toBe("series-cpiaucsl.json");
  expect(new TextDecoder().decode(body)).toBe('{"realtime_start":"2026-11-25","note":"echoed ***"}');
  expect(meta).toMatchObject({
    source: "fred",
    url: "https://api.stlouisfed.org/fred/series?series_id=CPIAUCSL&api_key=***&file_type=json",
    status: 200,
    content_type: "application/json; charset=UTF-8",
    bytes: body.length,
    hand_made: false,
  });
  expect(JSON.stringify(meta)).not.toContain(KEY);
  expect(fetch.requests[0]?.headers.get("user-agent")).toBe(DEV_USER_AGENT);
});

test("a binary answer holding a key is refused; a failed answer throws, so nothing is written", async () => {
  const fetch = fixtureFetch([
    {
      match: /zip/,
      body: new TextEncoder().encode(`PK\u0003\u0004 ${KEY}`),
      headers: { "content-type": "application/zip" },
    },
    { match: /down/, status: 500 },
  ]);
  const { http, tools } = clients(fetch);
  await expect(
    recordOne({ source: "x", name: "zip", url: "https://example.org/zip" }, http, tools, [KEY]),
  ).rejects.toThrow("holds a key");
  const failed = recordOne({ source: "x", name: "down", url: "https://example.org/down" }, http, tools, [
    KEY,
  ]);
  await expect(failed).rejects.toBeInstanceOf(DataError);
});

test("Yahoo's raw answer to a library call is recorded as sent, its crumb removed from the URL", async () => {
  const fetch = fixtureFetch(YAHOO_AAPL);
  const { http, tools } = clients(fetch);
  const { file, body, meta } = await recordOne(
    {
      source: "yahoo",
      name: "quote-aapl",
      read: (_http, { yahooAnswer }) => yahooAnswer((yahoo) => yahoo.quote("AAPL"), /\/v7\/finance\/quote\?/),
    },
    http,
    tools,
    [],
  );
  expect(file).toBe("quote-aapl.json");
  expect(JSON.parse(new TextDecoder().decode(body))).toMatchObject({
    quoteResponse: { result: [{ symbol: "AAPL", regularMarketPrice: 342.37 }] },
  });
  expect(meta.url).toMatch(/^https:\/\/query\d\.finance\.yahoo\.com\/v7\/finance\/quote\?.*crumb=\*\*\*/);
  expect(String(meta.url)).not.toContain("FIXTURECRUMB");
  // Every request went out with the library's own User-Agent.
  for (const request of fetch.requests) {
    expect(request.headers.get("user-agent") ?? "").toStartWith("Mozilla/5.0 (compatible; yahoo-finance2/");
  }
  await expect(tools.yahooAnswer((yahoo) => yahoo.quote("AAPL"), /\/v99\/never/)).rejects.toThrow(
    "no Yahoo request matched",
  );
});
