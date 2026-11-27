// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The news provider (src/fork/data/providers/news.ts) with Naver's news search, through the real news and
 * article tools, the router and the ToolRegistry: with NAVER_CLIENT_ID and NAVER_CLIENT_SECRET, words in
 * Korean are answered from Naver's news search and GDELT together (hand-made answers of both to the same
 * words, test/fork/fixtures/naver): one list, newest first, an address both list shown once, each article's
 * publisher followed by the source that listed it, Naver's snippet as its summary. Without both settings, and
 * for every other request (words without Hangul, a topic, the market's latest, a listing's news), nothing
 * changes. Paging through Naver's pages up to the start it publishes as its furthest, a window past its reach,
 * filters Naver cannot honour, a source failing, and the client id and secret kept to their headers. Each
 * text the model reads is compared whole (golden) where it is the point. No request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../../../src/data/capabilities.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import { gdeltQuery } from "../../../src/fork/data/sources/gdelt.js";
import {
  buildTools,
  type FixtureFetch,
  type FixtureRoute,
  fixtureFetch,
  type TestOptions,
  testProviders,
} from "./harness.js";

// Settings and fixture routes ------------------------------------------------------------------------------

/** The client id and secret (invented). */
const ID = "nvClientId7Qx2Lw";
const SECRET = "nvSecret9Zk4Pd";
const KEYS: PublicDataConfig = { naverClientId: ID, naverClientSecret: SECRET };
const WORDS = "삼성전자 반도체";
const JSON_TYPE = { "content-type": "application/json;charset=utf-8" };

/** Naver's answer to `words` (any start), a fixture or written inline. */
function naver(
  words: string,
  answer: { file?: string; body?: string; status?: number; headers?: Record<string, string> },
): FixtureRoute {
  return {
    match: (url) =>
      url.hostname === "openapi.naver.com" &&
      url.pathname === "/v1/search/news.json" &&
      url.searchParams.get("query") === words,
    ...(answer.file ? { file: answer.file } : {}),
    ...(answer.body !== undefined ? { body: answer.body, headers: answer.headers ?? JSON_TYPE } : {}),
    ...(answer.status ? { status: answer.status } : {}),
  };
}

/** GDELT's answer to the search `query`, a fixture or written inline. */
function gdelt(
  query: string,
  answer: { file?: string; body?: string; status?: number; headers?: Record<string, string> },
): FixtureRoute {
  return {
    match: (url) => url.hostname === "api.gdeltproject.org" && url.searchParams.get("query") === query,
    ...(answer.file ? { file: answer.file } : {}),
    ...(answer.body !== undefined ? { body: answer.body, headers: answer.headers ?? JSON_TYPE } : {}),
    ...(answer.status ? { status: answer.status } : {}),
  };
}

/** Yahoo's news search for `symbol`. */
function yahooSearch(symbol: string, file: string): FixtureRoute {
  return {
    match: (url) => url.pathname === "/v1/finance/search" && url.searchParams.get("q") === symbol,
    file,
  };
}

/**
 * A fixture fetch whose Naver answers are Naver's for the page asked (`display` articles from `start`, of the
 * answer's whole list) and whose Yahoo news search gives at most `newsCount` articles, as each source does.
 */
function newsFetch(routes: readonly FixtureRoute[]): FixtureFetch {
  const base = fixtureFetch(routes);
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await base(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!response.ok) return response;
    if (url.pathname === "/v1/finance/search") {
      const body = (await response.json()) as { news?: unknown[] };
      if (Array.isArray(body.news)) body.news = body.news.slice(0, Number(url.searchParams.get("newsCount")));
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    }
    if (url.hostname === "openapi.naver.com") {
      const body = (await response.json()) as { items?: unknown[]; start?: number; display?: number };
      const start = Number(url.searchParams.get("start") ?? "1");
      const display = Number(url.searchParams.get("display") ?? "10");
      if (Array.isArray(body.items)) body.items = body.items.slice(start - 1, start - 1 + display);
      body.start = start;
      body.display = body.items?.length ?? 0;
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    }
    return response;
  };
  return Object.assign(answer, { requests: base.requests, unmatched: base.unmatched }) as FixtureFetch;
}

const ROUTES: readonly FixtureRoute[] = [
  naver(WORDS, { file: "naver/news-samsung-semiconductor.json" }),
  gdelt(gdeltQuery({ words: WORDS }), { file: "naver/gdelt-artlist-samsung-semiconductor.json" }),
  gdelt(gdeltQuery({ words: "chip export controls" }), { file: "gdelt/artlist-chip-export-controls.json" }),
  gdelt(gdeltQuery({ topic: "fed" }), { file: "gdelt/artlist-fed.json" }),
  gdelt(gdeltQuery({}), { file: "gdelt/artlist-market.json" }),
  yahooSearch("AAPL", "yahoo-news/search-aapl.json"),
];

/** The fork's providers with `config` over `routes` (before these tests' own), and the tools with the read check. */
function setup(
  routes: readonly FixtureRoute[] = [],
  config: PublicDataConfig = KEYS,
  extra: TestOptions = {},
) {
  const fetch = newsFetch([...routes, ...ROUTES]);
  const { providers, clock } = testProviders(config, fetch, extra);
  return { ...buildTools(providers, { clock, check: true }), providers, fetch };
}

/** The requests made to Naver (its words, display, start, sort) and to GDELT (its search). */
function asked(fetch: FixtureFetch): string[] {
  return fetch.requests.map(({ url }) => {
    const address = new URL(url);
    const params = address.searchParams;
    if (address.hostname === "openapi.naver.com") {
      return `naver ${params.get("query")} display=${params.get("display")} start=${params.get("start")} sort=${params.get("sort")}`;
    }
    if (address.hostname === "api.gdeltproject.org") return `gdelt ${params.get("query")}`;
    return `yahoo ${params.get("q")}`;
  });
}

/** The text the model reads, compared whole with the golden one. */
function golden(name: string, text: string): void {
  expect(GOLDEN[name]).toBeDefined();
  expect(text).toBe(GOLDEN[name] as string);
}

type Listed = { id: string; published_at: string; publisher: string; title: string; summary: string | null };
const listedOf = (payload: unknown) => (payload as { articles: Listed[] }).articles;
const cursorOf = (payload: unknown) => (payload as { next_cursor: string | null }).next_cursor;

// Naver's answers written inline -------------------------------------------------------------------------------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An instant in RFC 822's form at +0900, as Naver writes pubDate. */
function pubDate(ms: number): string {
  const kst = new Date(ms + 9 * 3_600_000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[kst.getUTCDay()]}, ${two(kst.getUTCDate())} ${MONTHS[kst.getUTCMonth()]} ${kst.getUTCFullYear()} ${two(kst.getUTCHours())}:${two(kst.getUTCMinutes())}:${two(kst.getUTCSeconds())} +0900`;
}

const NEWEST = Date.parse("2026-11-25T21:00:00Z");
const STEP = 6 * 60_000;

/** The time of Naver's `n`-th article (from 1) of a generated list: one every six minutes back from NEWEST. */
const timeOf = (n: number) => NEWEST - (n - 1) * STEP;

/** Naver's answer holding `count` generated articles (newest first), all of them; the fetch pages it. */
function generated(count: number, total = count): string {
  return JSON.stringify({
    lastBuildDate: "Thu, 26 Nov 2026 07:00:00 +0900",
    total,
    start: 1,
    display: count,
    items: Array.from({ length: count }, (_, i) => ({
      title: `<b>반도체</b> 기사 ${i + 1}`,
      originallink: `https://news.example.com/chips/${i + 1}`,
      link: `https://n.news.naver.com/mnews/article/905/${String(i + 1).padStart(10, "0")}`,
      description: `<b>반도체</b> 업황 기사 ${i + 1}의 요약`,
      pubDate: pubDate(timeOf(i + 1)),
    })),
  });
}

/** An instant as GDELT writes seendate ("20261125T071500Z"). */
const seendate = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;

const CHIPS = "반도체 업황";
const EMPTY_GDELT = gdelt(gdeltQuery({ words: CHIPS }), { body: "{}" });

// The tests --------------------------------------------------------------------------------------------

describe("what it declares", () => {
  test("news.articles and news.article, with Naver's settings or without, and nothing asked to build it", () => {
    for (const config of [KEYS, {}]) {
      const { providers, fetch } = setup([], config);
      const news = providers.news as DataProvider;
      expect(Object.keys(news.capabilities.news ?? {}).sort()).toEqual(["article", "articles"]);
      expect(fetch.requests).toEqual([]);
    }
  });
});

describe("words in Korean, with both of Naver's settings", () => {
  test("Naver's and GDELT's articles in one list, newest first, each address once, each naming its source", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("news", { query: WORDS });
    expect(run.failure).toBeUndefined();
    golden("korean-page-1", run.text);
    expect(run.summary).toBe("8 articles (more exist)");
    expect(run.reads.missing()).toEqual([]);
    expect(asked(fetch)).toEqual([`naver ${WORDS} display=100 start=1 sort=date`, `gdelt ${WORDS}`]);
    // The address both list is shown once, as GDELT's listing (it saw it after Naver's time for it).
    const listed = listedOf(run.payload);
    expect(listed.filter((article) => article.title.includes("2나노"))).toEqual([
      expect.objectContaining({ publisher: "biz.example.net (via GDELT)", summary: null }),
    ]);
  });

  test("the next page, by the cursor the first gave, from the answers kept", async () => {
    const { runTool, fetch } = setup();
    const first = await runTool("news", { query: WORDS });
    const run = await runTool("news", { query: WORDS, after: cursorOf(first.payload) });
    expect(run.failure).toBeUndefined();
    golden("korean-page-2", run.text);
    expect(cursorOf(run.payload)).toBeNull();
    expect(run.reads.missing()).toEqual([]);
    expect(fetch.requests).toHaveLength(2);
  });

  test("article: a Naver article listed this session, its snippet as its points, its publication time", async () => {
    const { runTool, fetch } = setup();
    const list = await runTool("news", { query: WORDS });
    const id = listedOf(list.payload)[0]?.id as string;
    expect(id).toMatch(/^nv:[A-Za-z0-9_-]{16}$/);
    const run = await runTool("article", { id });
    expect(run.failure).toBeUndefined();
    golden("korean-article", run.text.replace(id, "<id>"));
    expect(run.reads.missing()).toEqual([]);
    expect(run.payload).toMatchObject({ time_kind: "published", topics: [], instruments: [], events: [] });
    expect(fetch.requests).toHaveLength(2);
  });

  test("a window: Naver's articles outside it passed over, GDELT asked for it", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("news", { query: WORDS, since: "2026-11-24", until: "2026-11-24" });
    expect(run.failure).toBeUndefined();
    expect(listedOf(run.payload).map((article) => [article.published_at, article.publisher])).toEqual([
      ["2026-11-24T11:15:00Z", "trade.example.org (via Naver)"],
      ["2026-11-24T08:45:00Z", "example.com (via Naver)"],
      ["2026-11-24T01:30:00Z", "biz.example.net (via Naver)"],
      ["2026-11-24T01:30:00Z", "wire.example.com (via GDELT)"],
    ]);
    expect(asked(fetch)).toEqual([`naver ${WORDS} display=100 start=1 sort=date`, `gdelt ${WORDS}`]);
    const window = new URL(fetch.requests[1]?.url as string).searchParams;
    expect([window.get("startdatetime"), window.get("enddatetime")]).toEqual([
      "20261124000000",
      "20261124235959",
    ]);
  });
});

describe("as before, wherever Naver is not the source", () => {
  test("without both settings, words in Korean go to GDELT alone, as they did", async () => {
    for (const config of [{}, { naverClientId: ID }, { naverClientSecret: SECRET }]) {
      const { runTool, fetch } = setup([], config);
      const run = await runTool("news", { query: WORDS });
      expect(run.failure, JSON.stringify(config)).toBeUndefined();
      golden("korean-gdelt-alone", run.text);
      expect(asked(fetch)).toEqual([`gdelt ${WORDS}`]);
    }
  });

  test("with them, words without Hangul, a topic, the market's latest and a listing's news read as without them", async () => {
    const requests: { query?: string; topic?: string; symbol?: string; limit?: number }[] = [
      { query: "chip export controls" },
      { topic: "fed" },
      { limit: 3 },
      { symbol: "AAPL" },
    ];
    for (const input of requests) {
      const withKeys = setup([], KEYS);
      const without = setup([], {});
      const [a, b] = [await withKeys.runTool("news", input), await without.runTool("news", input)];
      expect(a.failure, JSON.stringify(input)).toBeUndefined();
      expect(a.text, JSON.stringify(input)).toBe(b.text);
      expect(asked(withKeys.fetch), JSON.stringify(input)).toEqual(asked(without.fetch));
      expect(
        asked(withKeys.fetch).some((line) => line.startsWith("naver")),
        JSON.stringify(input),
      ).toBe(false);
    }
  });
});

describe("filters Naver cannot honour", () => {
  test("words in Korean with a topic or a tone are refused, never ignored, and nothing is asked", async () => {
    const { runTool, fetch } = setup();
    const topic = await runTool("news", { query: WORDS, topic: "semiconductor" });
    expect(topic.failure).toBe("data_invalid");
    golden("korean-topic-refused", topic.text);
    const tone = await runTool("news", { query: WORDS, sentiment: "bullish", topic: "earnings" });
    expect(tone.failure).toBe("data_invalid");
    expect(tone.text).toContain("cannot be narrowed by a topic or a tone (sentiment); ask without them");
    expect(fetch.requests).toEqual([]);
  });

  test("impact and event type name Naver among the sources none of which honours them", async () => {
    const { runTool, fetch } = setup();
    const impact = await runTool("news", { query: WORDS, impact: "high" });
    expect(impact.text).toBe(
      "News search cannot answer this request as asked: impact high: no news source here (Yahoo's news search, GDELT, Naver's news search) rates an article's expected impact; ask without impact",
    );
    const event = await runTool("news", { query: WORDS, event_type: "earnings" });
    expect(event.text).toBe(
      "News search cannot answer this request as asked: event_type earnings: no news source here classifies articles by the event they report; ask without event_type (a topic or words narrow the subject)",
    );
    expect(fetch.requests).toEqual([]);
  });

  test("a cursor of another search is refused", async () => {
    const { runTool, fetch } = setup();
    for (const after of ["gd:20261125120000:0", "yh:8", "ng:x:x", "ng:20261131120000.0:-"]) {
      const run = await runTool("news", { query: WORDS, after });
      expect(run.failure, after).toBe("data_invalid");
      expect(run.text, after).toContain("is not a cursor of a search in Korean");
    }
    expect(fetch.requests).toEqual([]);
  });
});

describe("paging through Naver's list", () => {
  test("pages of ten from one request of a hundred; the cursor walks Naver's list to its end", async () => {
    const { runTool, fetch } = setup([naver(CHIPS, { body: generated(25) }), EMPTY_GDELT]);
    const pages: string[][] = [];
    let after: string | null | undefined;
    do {
      const run = await runTool("news", { query: CHIPS, limit: 10, ...(after ? { after } : {}) });
      expect(run.failure).toBeUndefined();
      pages.push(listedOf(run.payload).map((article) => article.title));
      after = cursorOf(run.payload);
    } while (after);
    expect(pages.map((page) => page.length)).toEqual([10, 10, 5]);
    expect(pages.flat()).toEqual(Array.from({ length: 25 }, (_, i) => `반도체 기사 ${i + 1}`));
    expect(asked(fetch)).toEqual([`naver ${CHIPS} display=100 start=1 sort=date`, `gdelt ${CHIPS}`]);
  });

  test("a window down the list reads Naver's pages until it reaches it", async () => {
    const { runTool, fetch } = setup([naver(CHIPS, { body: generated(300) }), EMPTY_GDELT]);
    const until = new Date(timeOf(150)).toISOString().replace(".000Z", "Z");
    const run = await runTool("news", { query: CHIPS, until, limit: 5 });
    expect(run.failure).toBeUndefined();
    expect(listedOf(run.payload).map((article) => article.title)).toEqual(
      [150, 151, 152, 153, 154].map((n) => `반도체 기사 ${n}`),
    );
    expect(asked(fetch).filter((line) => line.startsWith("naver"))).toEqual([
      `naver ${CHIPS} display=100 start=1 sort=date`,
      `naver ${CHIPS} display=100 start=101 sort=date`,
    ]);
  });

  test("since ends the reading where Naver's list passes it", async () => {
    const { runTool, fetch } = setup([naver(CHIPS, { body: generated(300) }), EMPTY_GDELT]);
    const since = new Date(timeOf(12)).toISOString().replace(".000Z", "Z");
    const run = await runTool("news", { query: CHIPS, since, limit: 10 });
    const next = await runTool("news", { query: CHIPS, since, limit: 10, after: cursorOf(run.payload) });
    expect(listedOf(next.payload).map((article) => article.title)).toEqual([
      "반도체 기사 11",
      "반도체 기사 12",
    ]);
    expect(cursorOf(next.payload)).toBeNull();
    expect(asked(fetch).filter((line) => line.startsWith("naver"))).toHaveLength(1);
  });

  test("the list ends at the furthest start Naver takes (1,000), a page of a hundred from it, its first not repeated", async () => {
    const { runTool, fetch } = setup([naver(CHIPS, { body: generated(1500) }), EMPTY_GDELT]);
    const at = new Date(timeOf(1095)).toISOString().slice(0, 19).replace(/[-T:]/g, "");
    const run = await runTool("news", { query: CHIPS, limit: 10, after: `ng:${at}.1:x` });
    expect(run.failure).toBeUndefined();
    expect(listedOf(run.payload).map((article) => article.title)).toEqual(
      [1096, 1097, 1098, 1099].map((n) => `반도체 기사 ${n}`),
    );
    expect(cursorOf(run.payload)).toBeNull();
    expect(
      asked(fetch)
        .filter((line) => line.startsWith("naver"))
        .map((line) => line.split(" ")[4]),
    ).toEqual([
      "start=1",
      "start=101",
      "start=201",
      "start=301",
      "start=401",
      "start=501",
      "start=601",
      "start=701",
      "start=801",
      "start=901",
      "start=1000",
    ]);
  });

  test("a window past Naver's reach, with nothing from GDELT either, is said with that reach (unsupported)", async () => {
    const { runTool } = setup([naver(CHIPS, { body: generated(1500) }), EMPTY_GDELT]);
    const until = new Date(timeOf(1200)).toISOString().replace(".000Z", "Z");
    const run = await runTool("news", { query: CHIPS, until });
    expect(run.failure).toBe("data_unsupported");
    golden("korean-past-reach", run.text);
  });

  test("nothing in either source is no_data, saying what each covers", async () => {
    const { runTool } = setup([
      naver(CHIPS, {
        body: JSON.stringify({ lastBuildDate: "x", total: 0, start: 1, display: 0, items: [] }),
      }),
      EMPTY_GDELT,
    ]);
    const run = await runTool("news", { query: CHIPS });
    expect(run.failure).toBe("data_no_data");
    golden("korean-nothing", run.text);
  });
});

describe("an address both sources list", () => {
  test("shown once as its newer listing: Naver's when Naver's time is the later", async () => {
    const twin = "https://news.example.com/chips/2";
    const { runTool } = setup([
      naver(CHIPS, { body: generated(3) }),
      gdelt(gdeltQuery({ words: CHIPS }), {
        body: JSON.stringify({
          articles: [
            {
              url: twin,
              url_mobile: "",
              title: "GDELT's listing",
              seendate: seendate(timeOf(3) - 60_000),
              socialimage: "",
              domain: "news.example.com",
              language: "Korean",
              sourcecountry: "South Korea",
            },
          ],
        }),
      }),
    ]);
    const run = await runTool("news", { query: CHIPS });
    expect(listedOf(run.payload).map((article) => [article.title, article.publisher])).toEqual([
      ["반도체 기사 1", "news.example.com (via Naver)"],
      ["반도체 기사 2", "news.example.com (via Naver)"],
      ["반도체 기사 3", "news.example.com (via Naver)"],
    ]);
  });

  test("never again on a later page: GDELT's newer listing on the first, Naver's older one passed over on the third", async () => {
    const twin = "https://news.example.com/chips/25";
    const { runTool } = setup([
      naver(CHIPS, { body: generated(30) }),
      gdelt(gdeltQuery({ words: CHIPS }), {
        body: JSON.stringify({
          articles: [
            {
              url: twin.replace("https://", "http://www."),
              url_mobile: "",
              title: "반도체 기사 25 (GDELT)",
              seendate: seendate(timeOf(2) - 60_000),
              socialimage: "",
              domain: "news.example.com",
              language: "Korean",
              sourcecountry: "South Korea",
            },
          ],
        }),
      }),
    ]);
    const titles: string[] = [];
    let after: string | null | undefined;
    do {
      const run = await runTool("news", { query: CHIPS, limit: 10, ...(after ? { after } : {}) });
      titles.push(...listedOf(run.payload).map((article) => article.title));
      after = cursorOf(run.payload);
    } while (after);
    expect(titles.filter((title) => title.startsWith("반도체 기사 25"))).toEqual(["반도체 기사 25 (GDELT)"]);
    expect(titles).toHaveLength(30);
    expect(titles.slice(0, 3)).toEqual(["반도체 기사 1", "반도체 기사 2", "반도체 기사 25 (GDELT)"]);
  });
});

describe("a source failing", () => {
  test("Naver limiting requests: GDELT's articles, and the search goes on without Naver", async () => {
    const { runTool } = setup([naver(WORDS, { file: "naver/error-rate-limit.json" })]);
    const run = await runTool("news", { query: WORDS });
    expect(run.failure).toBeUndefined();
    expect(listedOf(run.payload).map((article) => article.publisher)).toEqual([
      "biz.example.net (via GDELT)",
      "koreanews.example.org (via GDELT)",
      "wire.example.com (via GDELT)",
    ]);
    expect(cursorOf(run.payload)).toBeNull();
  });

  test("GDELT down: Naver's articles alone", async () => {
    const { runTool } = setup([
      gdelt(gdeltQuery({ words: WORDS }), { body: "Service Unavailable", status: 503 }),
    ]);
    const run = await runTool("news", { query: WORDS, limit: 10 });
    expect(run.failure).toBeUndefined();
    const listed = listedOf(run.payload);
    expect(listed).toHaveLength(9);
    expect(listed.every((article) => article.publisher.endsWith("(via Naver)"))).toBe(true);
  });

  test("both failing: the call's failure, each source's reason said", async () => {
    const { runTool } = setup([
      naver(WORDS, { file: "naver/error-daily-limit.json" }),
      gdelt(gdeltQuery({ words: WORDS }), { body: "Service Unavailable", status: 503 }),
    ]);
    const run = await runTool("news", { query: WORDS });
    expect(run.failure).toBe("data_quota");
    golden("korean-both-failed", run.text);
  });

  test("Naver failing while GDELT finds nothing: Naver's failure, not an answer that there is no news", async () => {
    const { runTool } = setup([naver(CHIPS, { file: "naver/error-authentication.json" }), EMPTY_GDELT]);
    const run = await runTool("news", { query: CHIPS });
    expect(run.failure).toBe("data_rejected");
    expect(run.text).toBe(
      "Naver is not available with the current credentials; this is not a fact about the market.",
    );
  });
});

describe("the client id and secret", () => {
  test("sent in their headers to Naver alone, and in no address, text, payload or provenance", async () => {
    const { runTool, fetch } = setup();
    const list = await runTool("news", { query: WORDS });
    const article = await runTool("article", { id: listedOf(list.payload)[0]?.id as string });
    for (const { url, headers } of fetch.requests) {
      const toNaver = new URL(url).hostname === "openapi.naver.com";
      expect([headers.get("x-naver-client-id"), headers.get("x-naver-client-secret")], url).toEqual(
        toNaver ? [ID, SECRET] : [null, null],
      );
      expect(url).not.toContain(ID);
      expect(url).not.toContain(SECRET);
    }
    for (const run of [list, article]) {
      const said = JSON.stringify([run.text, run.summary, run.payload, run.provenance]);
      expect(said).not.toContain(ID);
      expect(said).not.toContain(SECRET);
    }
  });

  test("a secret fetch cannot send (given past the settings' check): Naver's failure beside GDELT's, never sent", async () => {
    const pasted = `${SECRET}${String.fromCharCode(0x200b)}`;
    const { runTool, fetch } = setup(
      [gdelt(gdeltQuery({ words: WORDS }), { body: "Service Unavailable", status: 503 })],
      { naverClientId: ID, naverClientSecret: pasted },
    );
    const run = await runTool("news", { query: WORDS });
    expect(run.failure).toBe("data_unavailable");
    expect(run.text).toBe(
      "Naver could not be reached (Naver was not asked: the X-Naver-Client-Secret header of its request holds a character a header cannot carry.); GDELT could not be reached (GDELT answered HTTP 503.). None of this is a fact about the market.",
    );
    expect(run.text).not.toContain(SECRET);
    expect(asked(fetch).filter((one) => one.startsWith("naver"))).toEqual([]);
  });

  test("Naver's words quoting them are said without them", async () => {
    const { runTool } = setup([
      naver(CHIPS, {
        body: JSON.stringify({ errorMessage: `Rate limit exceeded for ${ID}:${SECRET}`, errorCode: "012" }),
        status: 429,
      }),
      gdelt(gdeltQuery({ words: CHIPS }), { body: "Service Unavailable", status: 503 }),
    ]);
    const run = await runTool("news", { query: CHIPS });
    expect(run.failure).toBe("data_rate_limited");
    expect(run.text).not.toContain(ID);
    expect(run.text).not.toContain(SECRET);
  });
});

// Golden texts -------------------------------------------------------------------------------------------

const GOLDEN: Readonly<Record<string, string>> = {
  "korean-page-1": `[e1] news 삼성전자 반도체 (reference its data as {"ref":"e1","path":"<field>"})
source: News search
8 articles on this page on "삼성전자 반도체"
2026-11-25T09:40:00Z example.com (via Naver): 삼성전자, HBM4 양산 앞두고 반도체 설비 투자 확대 [article nv:T3prXAvAiv4uEklt]
  삼성전자가 차세대 고대역폭메모리(HBM4) 양산을 앞두고 평택 캠퍼스의 반도체 설비 투자를 늘린다. 업계에 따르면 ...
  https://www.example.com/news/articleView.html?idxno=1001
2026-11-25T07:15:00Z biz.example.net (via GDELT): 삼성전자 파운드리, 2나노 고객사 추가 확보 [article gd:TfH4xZS8Ntr4OQ-Q]
  https://biz.example.net/semiconductor/2026/11/25/samsung-foundry-2nm
2026-11-25T07:05:00Z news.example.net (via Naver): "반도체 겨울은 끝났다"…삼성전자 목표주가 줄상향 [article nv:hmbgx-pENJ62Gc6f]
  증권가가 삼성전자의 목표주가를 잇달아 올리고 있다. 메모리 반도체 가격 상승과 HBM 공급 확대 & 파운드리 수주가 ...
  https://news.example.net/stock/20261125/samsung-targets
2026-11-25T04:00:00Z koreanews.example.org (via GDELT): 삼성전자 반도체 설비투자 확대 발표 [article gd:iygBeeJUpqlfZhmi]
  https://koreanews.example.org/biz/20261125/samsung-chips
2026-11-25T02:20:00Z economy.example.org (via Naver): 코스피, 외국인 매수에 상승…삼성전자 1%대 강세 [article nv:Nttm5bKeaEvSLjDU]
  코스피가 외국인 매수세에 힘입어 상승하고 있다. 시가총액 1위 삼성전자는 1%대 강세를 보이며 <반도체> 업종 상승을 이끌고 있다.
  https://economy.example.org/market/1120-kospi
2026-11-25T00:02:00Z news.example.net (via Naver): [특징주] 삼성전자, 장 초반 상승…반도체주 동반 강세 [article nv:85ErisO_Errz4ZIx]
  삼성전자가 장 초반 상승세를 보이고 있다. SK하이닉스 등 반도체주도 동반 강세다.
  https://news.example.net/stock/20261125/opening-samsung
2026-11-24T11:15:00Z trade.example.org (via Naver): 반도체 수출 13개월 연속 증가…삼성전자·SK하이닉스 수혜 [article nv:fDbR1sPqeJdlrAGF]
  이달 반도체 수출이 13개월 연속 증가세를 이어갔다. 삼성전자와 SK하이닉스의 실적 개선 기대가 ...
  https://trade.example.org/export/2026/11/24/chips
2026-11-24T08:45:00Z example.com (via Naver): 삼성전자, 美 테일러 공장 가동 일정 공개 [article nv:1f1j1_5ncyDs2r1Y]
  삼성전자가 미국 텍사스 '테일러 팹'의 가동 일정을 공개했다. 첨단 반도체 생산을 ...
  https://www.example.com/news/articleView.html?idxno=1002
more: news with after=ng:20261124084500.1:20261125040000.1 and the same filters`,
  "korean-page-2": `[e2] news 삼성전자 반도체 (reference its data as {"ref":"e2","path":"<field>"})
source: News search
3 articles on this page on "삼성전자 반도체"
2026-11-24T01:30:00Z biz.example.net (via Naver): R&D 늘리는 삼성전자…반도체 인재 확보 경쟁 [article nv:N_mFZwP6UO_pz0Kp]
  삼성전자가 연구개발(R&D) 투자를 늘리며 반도체 인재 확보에 나섰다.
  https://biz.example.net/people/2026/11/24/samsung-rnd
2026-11-24T01:30:00Z wire.example.com (via GDELT): 메모리 가격 반등에 삼성전자 반도체 실적 기대 [article gd:T2Gje_XfW0-ch_HY]
  https://wire.example.com/tech/2026/11/24/samsung-memory-prices
2026-11-23T05:00:00Z economy.example.org (via Naver): 삼성전자 노사, 임금협상 잠정 합의 [article nv:q2GIPPNlktFDMIeR]
  삼성전자 노사가 올해 임금협상에 잠정 합의했다. 반도체 부문 성과급 기준도 ...
  https://economy.example.org/labor/1123-samsung-wage`,
  "korean-article": `[e2] article 삼성전자, HBM4 양산 앞두고 반도체 설비 투자 확대 (reference its data as {"ref":"e2","path":"<field>"})
source: News search
2026-11-25T09:40:00Z example.com (via Naver): 삼성전자, HBM4 양산 앞두고 반도체 설비 투자 확대
https://www.example.com/news/articleView.html?idxno=1001
tone not stated, expected impact not stated
points:
  삼성전자가 차세대 고대역폭메모리(HBM4) 양산을 앞두고 평택 캠퍼스의 반도체 설비 투자를 늘린다. 업계에 따르면 ...`,
  "korean-gdelt-alone": `[e1] news 삼성전자 반도체 (reference its data as {"ref":"e1","path":"<field>"})
source: News search
3 articles on this page on "삼성전자 반도체"
2026-11-25T07:15:00Z biz.example.net: 삼성전자 파운드리, 2나노 고객사 추가 확보 [article gd:TfH4xZS8Ntr4OQ-Q]
  https://biz.example.net/semiconductor/2026/11/25/samsung-foundry-2nm
2026-11-25T04:00:00Z koreanews.example.org: 삼성전자 반도체 설비투자 확대 발표 [article gd:iygBeeJUpqlfZhmi]
  https://koreanews.example.org/biz/20261125/samsung-chips
2026-11-24T01:30:00Z wire.example.com: 메모리 가격 반등에 삼성전자 반도체 실적 기대 [article gd:T2Gje_XfW0-ch_HY]
  https://wire.example.com/tech/2026/11/24/samsung-memory-prices`,
  "korean-topic-refused": `News search cannot answer this request as asked: words in Korean ("삼성전자 반도체") are searched in Naver's news search and GDELT together, and Naver's search cannot be narrowed by a topic; ask without it, with the subject's words in query`,
  "korean-past-reach": `News search does not cover this request (Naver's news search reaches the newest 1,099 articles of a search (start at most 1,000, display at most 100): those of "반도체 업황" go back to 2026-11-21T07:12:00Z, none up to 2026-11-20T21:06:00Z, and GDELT lists none to 2026-11-20T21:06:00Z; GDELT's article lists cover a rolling window of about three months); this is not a fact about the market.`,
  "korean-nothing": `News search has no data for this request: no article matching "반도체 업황" in Naver's news search or GDELT; Naver's news search reaches the newest 1,099 articles of a search (start at most 1,000, display at most 100); GDELT's article lists cover a rolling window of about three months`,
  "korean-both-failed": `Naver is out of quota (Naver's news search allows this application no more requests today (HTTP 429, 010: Request limit exceeded. (요청 한도를 초과했습니다.))); GDELT could not be reached (GDELT answered HTTP 503.). None of this is a fact about the market.`,
};
