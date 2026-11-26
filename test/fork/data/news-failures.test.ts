// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * How the news provider fails and paces, offline. It needs no key, so it is declared without any setting.
 * Yahoo's search failing, limiting, answering no article or something unreadable, and GDELT's DOC API failing,
 * limiting, refusing a search in words, answering nothing (`{}`) or a body it does not read, each give the
 * DataError kind the router acts on (a source's failure never passed off as a fact about the market). Requests
 * the provider cannot honour are refused before anything is asked. GDELT's pace of one request every 5 seconds
 * is kept, identical searches share one answer and are kept 15 minutes, and a search whose turn would come after
 * its deadline is rate_limited. Paging past one GDELT answer of 250 articles goes on by time, losing and
 * repeating none of the articles seen at the time the answer is cut at. Every answer is a fixture or written
 * inline in the source's documented form.
 */
import { describe, expect, test } from "bun:test";
import { USER_AGENT } from "../../../src/contracts/index.js";
import { type DataProvider, NEWS_TOPICS } from "../../../src/data/capabilities.js";
import { DataError } from "../../../src/data/errors.js";
import { createCache } from "../../../src/fork/data/cache.js";
import { newsProvider } from "../../../src/fork/data/providers/news.js";
import {
  artListUrl,
  GDELT_MAX_RECORDS,
  gdeltQuery,
  gdeltTime,
  parseGdeltTime,
  searchWords,
  TOPIC_WORDS,
} from "../../../src/fork/data/sources/gdelt.js";
import {
  buildTools,
  type FixtureFetch,
  type FixtureRoute,
  fixtureFetch,
  type TestOptions,
  testDeps,
} from "./harness.js";

// Fixture routes ---------------------------------------------------------------------------------------

const GDELT = "api.gdeltproject.org";
const json = { "content-type": "application/json; charset=utf-8" };

/** GDELT's answer to the search `query` (or any search), inline or a fixture, for the requests `when` accepts. */
function gdelt(
  query: string | undefined,
  answer: { file?: string; body?: string; status?: number; headers?: Record<string, string> },
  when?: (url: URL) => boolean,
): FixtureRoute {
  return {
    match: (url) =>
      url.hostname === GDELT &&
      (query === undefined || url.searchParams.get("query") === query) &&
      (!when || when(url)),
    ...(answer.file ? { file: answer.file } : {}),
    ...(answer.body !== undefined ? { body: answer.body, headers: answer.headers ?? json } : {}),
    ...(answer.status ? { status: answer.status } : {}),
  };
}

/** Yahoo's news search for `symbol`: a fixture, or an answer written inline. */
function yahooSearch(
  symbol: string,
  answer: { file?: string; body?: string; status?: number; headers?: Record<string, string> },
): FixtureRoute {
  return {
    match: (url) => url.pathname === "/v1/finance/search" && url.searchParams.get("q") === symbol,
    ...(answer.file ? { file: answer.file } : {}),
    ...(answer.body !== undefined
      ? { body: answer.body, headers: answer.headers ?? { "content-type": "application/json;charset=utf-8" } }
      : {}),
    ...(answer.status ? { status: answer.status } : {}),
  };
}

/** Yahoo's search answer with these news articles (the library's SearchResult, quotesCount 0). */
function searchAnswer(news: unknown[]): string {
  return JSON.stringify({
    explains: [],
    count: news.length,
    quotes: [],
    news,
    nav: [],
    lists: [],
    researchReports: [],
    screenerFieldResults: [],
    culturalAssets: [],
    totalTime: 20,
    timeTakenForQuotes: 0,
    timeTakenForNews: 400,
    timeTakenForAlgowatchlist: 400,
    timeTakenForPredefinedScreener: 400,
    timeTakenForCrunchbase: 0,
    timeTakenForNav: 400,
    timeTakenForResearchReports: 0,
    timeTakenForScreenerField: 0,
    timeTakenForCulturalAssets: 0,
    timeTakenForSearchLists: 0,
  });
}

/** One news article of Yahoo's search, published at `iso`. */
function yahooArticle(uuid: string, iso: string, title: string): Record<string, unknown> {
  return {
    uuid,
    title,
    publisher: "Example Newswire",
    link: `https://finance.yahoo.com/news/${uuid}.html`,
    providerPublishTime: Date.parse(iso) / 1000,
    type: "STORY",
    relatedTickers: [],
  };
}

/** A fixture fetch whose Yahoo news search answers at most `newsCount` of a fixture's articles, as Yahoo does. */
function newsFetch(routes: readonly FixtureRoute[]): FixtureFetch {
  const base = fixtureFetch(routes);
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await base(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== "/v1/finance/search" || !response.ok) return response;
    const text = await response.text();
    let body: { news?: unknown[] };
    try {
      body = JSON.parse(text) as { news?: unknown[] };
    } catch {
      return new Response(text, { status: response.status, headers: response.headers });
    }
    if (Array.isArray(body.news)) body.news = body.news.slice(0, Number(url.searchParams.get("newsCount")));
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  };
  return Object.assign(answer, { requests: base.requests, unmatched: base.unmatched }) as FixtureFetch;
}

/** The news provider alone over `routes`, its tools, what it asked, and its timer. */
function news(routes: readonly FixtureRoute[], extra: TestOptions = {}) {
  const fetch = newsFetch(routes);
  const { deps, timer, clock } = testDeps({}, fetch, extra);
  const provider = newsProvider(deps);
  const implementation = provider.capabilities.news as NonNullable<DataProvider["capabilities"]["news"]>;
  const articles = (query: Record<string, unknown>, call?: { signal?: AbortSignal }) =>
    (
      implementation.articles as (
        q: unknown,
        c?: unknown,
      ) => Promise<{
        articles: { id: string; title: string | null; published_at?: string | null; annotations?: unknown }[];
        next_cursor?: string | null;
      }>
    )({ limit: 8, ...query }, call);
  return {
    ...buildTools({ news: provider }, { clock, check: true }),
    provider,
    articles,
    article: (id: string) => (implementation.article as (id: string) => Promise<unknown>)(id),
    fetch,
    timer,
  };
}

/** The DataError a provider call rejects with. */
async function failure(promise: Promise<unknown>): Promise<DataError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error("it answered");
}

/** The requests made to GDELT, and to Yahoo's search, by what they asked. */
function asked(fetch: FixtureFetch): string[] {
  return fetch.requests.map(({ url }) => {
    const address = new URL(url);
    const params = address.searchParams;
    if (address.hostname === GDELT) {
      return `gdelt ${params.get("query")}${params.has("enddatetime") ? ` to ${params.get("enddatetime")}` : ""}`;
    }
    return `yahoo ${params.get("q")} ${params.get("newsCount")}`;
  });
}

const AAPL = yahooSearch("AAPL", { file: "yahoo-news/search-aapl.json" });
const ANY_GDELT = gdelt(undefined, { file: "gdelt/artlist-market.json" });

/** GDELT's seendate for an instant. */
const seendate = (ms: number) => {
  const time = gdeltTime(ms);
  return `${time.slice(0, 8)}T${time.slice(8)}Z`;
};

/** A GDELT ArtList answer of the articles given (an address, a seen time), in GDELT's documented form. */
function artlist(rows: readonly { url: string; seen: number }[]): string {
  return JSON.stringify({
    articles: rows.map(({ url, seen }) => ({
      url,
      url_mobile: "",
      title: `Article ${url.split("/").slice(-2).join(" ")}`,
      seendate: seendate(seen),
      socialimage: "",
      domain: "wire.example.com",
      language: "English",
      sourcecountry: "United States",
    })),
  });
}

const MINUTE = 60_000;
const BASE = Date.parse("2026-11-25T21:00:00Z");

// The tests --------------------------------------------------------------------------------------------

describe("what it needs", () => {
  test("no key and no setting: both methods are declared, and building it asks nothing", () => {
    const { provider, fetch } = news([]);
    expect(provider.name).toBe("News search");
    expect(Object.keys(provider.capabilities.news ?? {}).sort()).toEqual(["article", "articles"]);
    expect(fetch.requests).toEqual([]);
  });

  test("Yahoo is asked through yahoo-finance2 with its own User-Agent, GDELT through the app's client with the app's", async () => {
    const { articles, fetch } = news([AAPL, ANY_GDELT]);
    await articles({ symbol: "AAPL" });
    await articles({ topic: "fed" });
    expect(fetch.requests.map((request) => request.headers.get("user-agent"))).toEqual([
      expect.stringMatching(/^Mozilla\/5\.0 \(compatible; yahoo-finance2\//),
      USER_AGENT,
    ]);
  });

  test("words in another script go to GDELT as written, with no language limit; Yahoo is never asked with them", async () => {
    const words = "삼성전자 반도체";
    const { articles, fetch } = news([gdelt(words, { file: "gdelt/artlist-market.json" })]);
    const page = await articles({ query: words });
    expect(page.articles).toHaveLength(5);
    expect(fetch.requests.map((request) => new URL(request.url).searchParams.get("query"))).toEqual([words]);
    // A symbol in another script is not a listing: refused, unsent.
    const error = await failure(articles({ symbol: "삼성전자" }));
    expect(error.kind).toBe("invalid");
    expect(fetch.requests).toHaveLength(1);
  });
});

describe("requests refused before anything is asked", () => {
  test("filters no source here honours, and a symbol narrowed by what Yahoo's news for it lacks", async () => {
    const { articles, fetch } = news([]);
    const cases: [Record<string, unknown>, string][] = [
      [{ impact: "low" }, "impact low: neither news source here"],
      [
        { eventType: "earnings", query: "chip export controls" },
        "event_type earnings: neither news source here",
      ],
      [{ sentiment: "mixed" }, "sentiment mixed: GDELT's tone is one score per article"],
      [{ symbol: "AAPL", topic: "lawsuit" }, "cannot be narrowed by a topic"],
      [{ symbol: "AAPL", query: "iPhone" }, "cannot be narrowed by words (query)"],
      [
        { symbol: "AAPL", sentiment: "neutral", topic: "earnings" },
        "cannot be narrowed by a topic or a tone",
      ],
    ];
    for (const [query, said] of cases) {
      const error = await failure(articles(query));
      expect([error.kind, error.details.source], JSON.stringify(query)).toEqual(["invalid", "News search"]);
      expect(error.details.retry).toBe("change_request");
      expect(error.message, JSON.stringify(query)).toContain(said);
    }
    expect(fetch.requests).toEqual([]);
  });

  test("a window that is not one, a cursor of another kind of request, and a query without words", async () => {
    const { articles, fetch } = news([]);
    const cases: [Record<string, unknown>, string][] = [
      [{ since: "2026-11-25T00:00:00Z", until: "2026-11-24T23:59:59.999Z" }, "is after until"],
      [{ since: "2026-11-26T00:00:00Z" }, "is later than now (2026-11-25T22:00:00Z)"],
      [{ symbol: "AAPL", after: "gd:20261125120000:0" }, "is not a cursor of a listing's news"],
      [{ query: "tariffs", after: "yh:8" }, "is not a cursor of GDELT's article search"],
      [{ topic: "fed", after: "gd:20261131120000:0" }, "is not a cursor of GDELT's article search"],
      [{ query: "?!?" }, 'query "?!?" has no words to search for'],
    ];
    for (const [query, said] of cases) {
      const error = await failure(articles(query));
      expect(error.kind, JSON.stringify(query)).toBe("invalid");
      expect(error.message, JSON.stringify(query)).toContain(said);
    }
    expect(fetch.requests).toEqual([]);
  });

  test("an economic series is not a listing (invalid); a venue Yahoo lists nothing on is unsupported", async () => {
    const { articles, fetch } = news([]);
    const series = await failure(articles({ symbol: "SERIES:US.FRED.CPIAUCSL" }));
    expect(series.kind).toBe("invalid");
    expect(series.message).toBe(
      "series:us.fred.cpiaucsl is an economic series, not a listing: ask news with query or topic (such as topic inflation)",
    );
    const venue = await failure(articles({ symbol: "XSWX:NESN" }));
    expect([venue.kind, venue.details.source, venue.message]).toEqual([
      "unsupported",
      "Yahoo",
      "it lists no listing on XSWX, so it has no news for XSWX:NESN",
    ]);
    expect(fetch.requests).toEqual([]);
  });

  test("a cancelled call is the caller's, and nothing is asked", async () => {
    const { articles, fetch } = news([AAPL, ANY_GDELT]);
    const controller = new AbortController();
    controller.abort(new Error("stopped by the caller"));
    for (const query of [{ symbol: "AAPL" }, { topic: "fed" }]) {
      const error = await articles(query, { signal: controller.signal }).catch((caught: unknown) => caught);
      expect((error as Error).message).toBe("stopped by the caller");
    }
    expect(fetch.requests).toEqual([]);
  });
});

describe("Yahoo's news search failing", () => {
  test("a server error is unavailable, a 429 rate_limited, a 404 unavailable (the endpoint, not the listing)", async () => {
    const cases: [number, string, string][] = [
      [500, "unavailable", "Yahoo answered HTTP 500."],
      [429, "rate_limited", "Yahoo is limiting requests (HTTP 429)."],
      [404, "unavailable", "Yahoo's search is not at its address (HTTP 404)."],
    ];
    for (const [status, kind, said] of cases) {
      const { articles } = news([
        yahooSearch("AAPL", { body: "Server says no", status, headers: { "content-type": "text/plain" } }),
      ]);
      const error = await failure(articles({ symbol: "AAPL" }));
      expect([error.kind, error.details.source, error.message], String(status)).toEqual([
        kind,
        "Yahoo",
        said,
      ]);
    }
  });

  test("no article is no_data; through the tool, said as Yahoo's answer about the listing", async () => {
    const { articles, runTool } = news([yahooSearch("AAPL", { body: searchAnswer([]) })]);
    const error = await failure(articles({ symbol: "AAPL" }));
    expect([error.kind, error.message]).toEqual(["no_data", "its news search lists no article about AAPL"]);
    const run = await runTool("news", { symbol: "AAPL" });
    expect(run.failure).toBe("data_no_data");
    expect(run.text).toBe("Yahoo has no data for this request: its news search lists no article about AAPL");
  });

  test("an answer without its news, one that is not JSON, and articles without an id or a time are unavailable", async () => {
    const cases: [string, string][] = [
      [
        JSON.stringify({ explains: [], count: 0, quotes: [] }),
        "Yahoo answered its news search in a form this app does not read.",
      ],
      [
        "<html>not json</html>",
        "Yahoo could not be read (Response.ok where we expect JSON, but the response was not parsable.",
      ],
      [
        searchAnswer([
          { title: "No id", providerPublishTime: 1795600000 },
          { uuid: "x-1", title: "No time" },
        ]),
        "Yahoo answered news articles without an id or a time.",
      ],
    ];
    for (const [body, said] of cases) {
      const { articles } = news([
        yahooSearch("AAPL", { body, headers: { "content-type": "application/json" } }),
      ]);
      const error = await failure(articles({ symbol: "AAPL" }));
      expect(error.kind, body).toBe("unavailable");
      expect(error.message, body).toStartWith(said);
    }
  });

  test("one article Yahoo describes incompletely is left out, the others kept", async () => {
    const body = searchAnswer([
      yahooArticle("a-1", "2026-11-25T10:00:00Z", "Kept"),
      { title: "No id", providerPublishTime: 1795600000 },
      yahooArticle("a-2", "2026-11-24T10:00:00Z", "Kept too"),
    ]);
    const { articles } = news([yahooSearch("AAPL", { body })]);
    const page = await articles({ symbol: "AAPL" });
    expect(page.articles.map((a) => [a.id, a.title])).toEqual([
      ["yh:a-1", "Kept"],
      ["yh:a-2", "Kept too"],
    ]);
  });
});

describe("a listing's news in a window", () => {
  test("a window older than the newest articles: Yahoo is asked for more until it has no more", async () => {
    const { articles, fetch } = news([AAPL]);
    const page = await articles({ symbol: "AAPL", until: "2026-11-21T23:59:59.999Z" });
    expect(page.articles.map((a) => a.published_at)).toEqual([
      "2026-11-21T20:30:00Z",
      "2026-11-20T17:45:00Z",
      "2026-11-19T22:10:00Z",
    ]);
    expect(page.next_cursor).toBeNull();
    expect(asked(fetch)).toEqual(["yahoo AAPL 9", "yahoo AAPL 18"]);
  });

  test("a window older than every article Yahoo lists is unsupported: its list does not reach back", async () => {
    const { articles } = news([AAPL]);
    const error = await failure(articles({ symbol: "AAPL", until: "2026-11-10T23:59:59.999Z" }));
    expect([error.kind, error.message]).toEqual([
      "unsupported",
      "its news search lists only the latest articles about AAPL, back to 2026-11-19T22:10:00Z, none up to 2026-11-10T23:59:59Z",
    ]);
  });

  test("a window Yahoo's list covers with no article in it is no_data", async () => {
    const { articles, fetch } = news([AAPL]);
    const error = await failure(articles({ symbol: "AAPL", since: "2026-11-25T21:00:00Z" }));
    expect([error.kind, error.message]).toEqual([
      "no_data",
      "its news search lists no article about AAPL from 2026-11-25T21:00:00Z",
    ]);
    expect(asked(fetch)).toEqual(["yahoo AAPL 9"]);
  });

  test("a bare Korean code is asked as a KOSPI listing, then as a KOSDAQ one", async () => {
    const { articles, fetch } = news([
      yahooSearch("035900.KS", { body: searchAnswer([]) }),
      yahooSearch("035900.KQ", {
        body: searchAnswer([yahooArticle("jyp-1", "2026-11-25T03:00:00Z", "JYP news")]),
      }),
    ]);
    const page = await articles({ symbol: "035900" });
    expect(page.articles.map((a) => a.id)).toEqual(["yh:jyp-1"]);
    expect(asked(fetch)).toEqual(["yahoo 035900.KS 9", "yahoo 035900.KQ 9"]);
    const none = news([
      yahooSearch("247540.KS", { body: searchAnswer([]) }),
      yahooSearch("247540.KQ", { body: searchAnswer([]) }),
    ]);
    const error = await failure(none.articles({ symbol: "247540" }));
    expect([error.kind, error.message]).toEqual(["no_data", "its news search lists no article about 247540"]);
  });
});

describe("GDELT failing", () => {
  test("nothing matching (`{}`) is no_data, saying GDELT's window; through the tool, as GDELT's answer", async () => {
    const query = gdeltQuery({ words: "zzqx vvkj" });
    const { articles, runTool } = news([gdelt(query, { file: "gdelt/artlist-empty.json" })]);
    const error = await failure(articles({ query: "zzqx vvkj", since: "2026-11-01T00:00:00Z" }));
    expect([error.kind, error.details.source, error.message]).toEqual([
      "no_data",
      "GDELT",
      `no article matching "zzqx vvkj" from 2026-11-01T00:00:00Z; GDELT's article lists cover a rolling window of about three months`,
    ]);
    const run = await runTool("news", { query: "zzqx vvkj" });
    expect(run.failure).toBe("data_no_data");
    expect(run.text).toBe(
      `GDELT has no data for this request: no article matching "zzqx vvkj"; GDELT's article lists cover a rolling window of about three months`,
    );
  });

  test("a search GDELT refuses in words is invalid, in its words; its pace in words rate_limited; a period unsupported", async () => {
    const cases: [FixtureRoute, string, string][] = [
      [
        gdelt(undefined, { file: "gdelt/refusal-keyword.txt" }),
        "invalid",
        'it refused the search ("Your query contained one or more keywords that were too short, too long or too common.")',
      ],
      [
        gdelt(undefined, {
          body: "Please limit requests to one every 5 seconds.",
          headers: { "content-type": "text/html" },
        }),
        "rate_limited",
        'GDELT is limiting requests ("Please limit requests to one every 5 seconds.").',
      ],
      [
        gdelt(undefined, {
          body: "Invalid STARTDATETIME specified.",
          headers: { "content-type": "text/html" },
        }),
        "unsupported",
        `it could not search that period ("Invalid STARTDATETIME specified."); GDELT's article lists cover a rolling window of about three months`,
      ],
      [
        gdelt(undefined, { body: "Something else happened", headers: { "content-type": "text/plain" } }),
        "unavailable",
        'GDELT answered in words this app does not read ("Something else happened").',
      ],
    ];
    for (const [route, kind, said] of cases) {
      const { articles } = news([route]);
      const error = await failure(articles({ query: "an" }));
      expect([error.kind, error.details.source, error.message]).toEqual([kind, "GDELT", said]);
    }
    const { runTool } = news([gdelt(undefined, { file: "gdelt/refusal-keyword.txt" })]);
    const run = await runTool("news", { query: "chip export controls" });
    expect(run.failure).toBe("data_invalid");
    expect(run.text).toBe(
      'GDELT cannot answer this request as asked: it refused the search ("Your query contained one or more keywords that were too short, too long or too common.")',
    );
  });

  test("an HTML page, broken JSON, a list that is not one, articles without an address or a time: unavailable", async () => {
    const cases: [string, string][] = [
      [
        "<html><body>Service Unavailable</body></html>",
        "GDELT answered an HTML page in a form this app does not read.",
      ],
      [
        '{"articles":[{"url":"https://wire.example.com/a","title":"cut',
        "GDELT answered its article list in a form this app does not read.",
      ],
      ['{"articles":"none"}', "GDELT answered its article list in a form this app does not read."],
      ['{"status":"busy"}', "GDELT answered its article list in a form this app does not read."],
      [
        '{"articles":[{"title":"No address"},{"url":"https://wire.example.com/b","seendate":"yesterday"}]}',
        "GDELT answered articles without an address or a time.",
      ],
      ["", "GDELT answered an empty body in a form this app does not read."],
    ];
    for (const [body, said] of cases) {
      const { articles } = news([gdelt(undefined, { body })]);
      const error = await failure(articles({ topic: "fed" }));
      expect([error.kind, error.message], body).toEqual(["unavailable", said]);
    }
  });

  test("JSON with a raw control character or a stray backslash in a title is mended and read", async () => {
    const body = `{"articles":[{"url":"https://wire.example.com/a","title":"Line${String.fromCharCode(10)}break \\q","seendate":"20261125T120000Z","domain":"wire.example.com"}]}`;
    const { articles } = news([gdelt(undefined, { body })]);
    const page = await articles({ topic: "fed" });
    expect(page.articles.map((a) => a.title)).toEqual(["Line break \\q"]);
  });

  test("its address missing is unavailable; a server error is asked once more, then unavailable", async () => {
    const missing = news([gdelt(undefined, { body: "", status: 404 })]);
    const error = await failure(missing.articles({ topic: "fed" }));
    expect([error.kind, error.message]).toEqual([
      "unavailable",
      "GDELT's DOC API is not at its address (HTTP 404).",
    ]);
    const down = news([
      gdelt(undefined, { body: "busy", status: 503, headers: { "content-type": "text/plain" } }),
    ]);
    const busy = await failure(down.articles({ topic: "fed" }));
    expect([busy.kind, busy.message]).toEqual(["unavailable", "GDELT answered HTTP 503."]);
    expect(down.fetch.requests).toHaveLength(2);
  });

  test("a Retry-After the deadline fits is waited out; a longer one is rate_limited with GDELT's wait", async () => {
    let calls = 0;
    const pausing: FixtureRoute = {
      match: (url) => url.hostname === GDELT && calls++ === 0,
      body: "",
      status: 429,
      headers: { "retry-after": "8" },
    };
    const short = news([pausing, ANY_GDELT]);
    const page = await short.articles({ topic: "fed" });
    expect(page.articles).toHaveLength(5);
    expect(short.timer.slept).toContain(8_000);
    expect(short.fetch.requests).toHaveLength(2);
    const long = news([gdelt(undefined, { body: "", status: 429, headers: { "retry-after": "120" } })]);
    const error = await failure(long.articles({ topic: "fed" }));
    expect([error.kind, error.details.retryAfterMs, error.message]).toEqual([
      "rate_limited",
      120_000,
      "GDELT asked to wait 120 s before the next request (HTTP 429).",
    ]);
    // The pause holds for the next search too: it fails at once, unsent.
    await failure(long.articles({ topic: "oil" }));
    expect(long.fetch.requests).toHaveLength(1);
  });
});

describe("GDELT's pace, shared answers and kept answers", () => {
  test("identical searches made together share one request", async () => {
    const { articles, fetch } = news([ANY_GDELT]);
    const [first, second] = await Promise.all([articles({ topic: "fed" }), articles({ topic: "fed" })]);
    expect(second).toEqual(first);
    expect(fetch.requests).toHaveLength(1);
  });

  test("an answer is kept 15 minutes (GDELT's update interval), then asked again", async () => {
    let now = Date.parse("2026-11-25T22:00:00Z");
    const { articles, fetch } = news([ANY_GDELT], { cache: createCache({ now: () => now }) });
    await articles({ topic: "fed" });
    now += 15 * MINUTE - 1;
    await articles({ topic: "fed", limit: 3 });
    expect(fetch.requests).toHaveLength(1);
    now += 2;
    await articles({ topic: "fed" });
    expect(fetch.requests).toHaveLength(2);
  });

  test("different searches are paced at one every 5 seconds; one whose turn comes after its deadline is rate_limited", async () => {
    const { articles, fetch, timer } = news([ANY_GDELT]);
    const topics = ["fed", "oil", "gdp", "trade", "tariffs", "inflation", "rates", "energy"];
    const outcomes = await Promise.allSettled(topics.map((topic) => articles({ topic })));
    expect(outcomes.map((outcome) => outcome.status)).toEqual([...Array(7).fill("fulfilled"), "rejected"]);
    const refused = (outcomes[7] as PromiseRejectedResult).reason as DataError;
    expect([refused.kind, refused.details.source, refused.message]).toEqual([
      "rate_limited",
      "GDELT",
      "GDELT allows 1 request every 5 s, and this one's turn comes after its 30 s deadline.",
    ]);
    expect(fetch.requests).toHaveLength(7);
    expect(timer.slept.filter((ms) => ms === 5_000).length).toBeGreaterThan(0);
  });
});

describe("paging GDELT past one answer", () => {
  const query = gdeltQuery({ topic: "fed" });
  // GDELT's 250: one article a minute back from BASE, the last three seen at one time (cut short there).
  const full = [
    ...Array.from({ length: GDELT_MAX_RECORDS - 3 }, (_, i) => ({
      url: `https://wire.example.com/full/${String(i).padStart(3, "0")}`,
      seen: BASE - i * MINUTE,
    })),
    ...[0, 1, 2].map((j) => ({
      url: `https://wire.example.com/full/cut-${j}`,
      seen: BASE - (GDELT_MAX_RECORDS - 3) * MINUTE,
    })),
  ];
  const oldest = BASE - (GDELT_MAX_RECORDS - 3) * MINUTE;
  // The next answer, up to a second past that time: all four articles seen at it, and three older.
  const rest = [
    ...[0, 1, 2, 3].map((j) => ({ url: `https://wire.example.com/full/cut-${j}`, seen: oldest })),
    ...[1, 2, 3].map((k) => ({ url: `https://wire.example.com/older/${k}`, seen: oldest - k * MINUTE })),
  ];
  const routes = [
    gdelt(
      query,
      { body: artlist(rest) },
      (url) => url.searchParams.get("enddatetime") === gdeltTime(oldest + 1000),
    ),
    gdelt(query, { body: artlist(full) }, (url) => !url.searchParams.has("enddatetime")),
  ];

  test("the articles of the time an answer is cut at are left to the next answer, which holds them all", async () => {
    const { articles, fetch } = news(routes);
    // After the 240th article: the last seven of the first answer, then the cursor to the time it was cut at.
    const late = await articles({ topic: "fed", limit: 10, after: `gd:${gdeltTime(BASE - 239 * MINUTE)}:1` });
    expect(late.articles.map((a) => a.published_at)).toEqual(
      [240, 241, 242, 243, 244, 245, 246].map((i) =>
        new Date(BASE - i * MINUTE).toISOString().replace(".000Z", "Z"),
      ),
    );
    expect(late.next_cursor).toBe(`gd:${gdeltTime(oldest)}:0`);
    const next = await articles({ topic: "fed", limit: 10, after: late.next_cursor as string });
    expect(next.articles.map((a) => a.title)).toEqual([
      "Article full cut-0",
      "Article full cut-1",
      "Article full cut-2",
      "Article full cut-3",
      "Article older 1",
      "Article older 2",
      "Article older 3",
    ]);
    expect(next.next_cursor).toBeNull();
    expect(asked(fetch)).toEqual([`gdelt ${query}`, `gdelt ${query} to ${gdeltTime(oldest + 1000)}`]);
  });

  test("a page the cut leaves empty goes on to the next answer in the same call", async () => {
    const { articles, fetch } = news(routes);
    const page = await articles({ topic: "fed", limit: 3, after: `gd:${gdeltTime(BASE - 246 * MINUTE)}:1` });
    expect(page.articles.map((a) => a.title)).toEqual([
      "Article full cut-0",
      "Article full cut-1",
      "Article full cut-2",
    ]);
    expect(page.next_cursor).toBe(`gd:${gdeltTime(oldest)}:3`);
    expect(fetch.requests).toHaveLength(2);
  });

  test("an answer all of one time is paged whole, then passed for the articles seen before it", async () => {
    const at = BASE;
    const single = Array.from({ length: GDELT_MAX_RECORDS }, (_, i) => ({
      url: `https://wire.example.com/one/${String(i).padStart(3, "0")}`,
      seen: at,
    }));
    const before = [
      { url: "https://wire.example.com/one/000", seen: at },
      { url: "https://wire.example.com/before/1", seen: at - MINUTE },
      { url: "https://wire.example.com/before/2", seen: at - 2 * MINUTE },
    ];
    const { articles, fetch } = news([
      gdelt(query, { body: artlist(before) }, (url) => url.searchParams.get("enddatetime") === gdeltTime(at)),
      gdelt(query, { body: artlist(single) }, (url) => !url.searchParams.has("enddatetime")),
    ]);
    const first = await articles({ topic: "fed", limit: 10 });
    expect(first.next_cursor).toBe(`gd:${gdeltTime(at)}:10`);
    const last = await articles({ topic: "fed", limit: 10, after: `gd:${gdeltTime(at)}:240` });
    expect(last.articles.map((a) => a.title)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Article one ${240 + i}`),
    );
    expect(last.next_cursor).toBe(`gd:${gdeltTime(at - 1000)}:0`);
    const after = await articles({ topic: "fed", limit: 10, after: last.next_cursor as string });
    expect(after.articles.map((a) => a.title)).toEqual(["Article before 1", "Article before 2"]);
    expect(after.next_cursor).toBeNull();
    expect(asked(fetch)).toEqual([`gdelt ${query}`, `gdelt ${query} to ${gdeltTime(at)}`]);
  });

  test("GDELT answering an earlier window with the same articles ends the list rather than repeat it", async () => {
    const { articles, fetch } = news([gdelt(query, { body: artlist(full) })]);
    const cut = await articles({ topic: "fed", limit: 10, after: `gd:${gdeltTime(oldest)}:0` });
    expect(cut.articles.map((a) => a.title)).toEqual([
      "Article full cut-0",
      "Article full cut-1",
      "Article full cut-2",
    ]);
    expect(cut.next_cursor).toBe(`gd:${gdeltTime(oldest - 1000)}:0`);
    const end = await articles({ topic: "fed", limit: 10, after: cut.next_cursor as string });
    expect(end).toEqual({ articles: [], next_cursor: null });
    expect(asked(fetch)).toEqual([
      `gdelt ${query}`,
      `gdelt ${query} to ${gdeltTime(oldest + 1000)}`,
      `gdelt ${query} to ${gdeltTime(oldest)}`,
    ]);
  });

  test("an answer past a position holds one article a second later than it: the rest, all of one time, are paged whole", async () => {
    // A time before the first answer's oldest, so the answer up to it is asked for.
    const at = oldest - 10 * MINUTE;
    const later = { url: "https://wire.example.com/late/000", seen: at + 1000 };
    const crowded = Array.from({ length: GDELT_MAX_RECORDS - 1 }, (_, i) => ({
      url: `https://wire.example.com/crowd/${String(i).padStart(3, "0")}`,
      seen: at,
    }));
    const { articles } = news([
      gdelt(query, { body: artlist([later, ...crowded]) }, (url) => url.searchParams.has("enddatetime")),
      gdelt(query, { body: artlist(full) }, (url) => !url.searchParams.has("enddatetime")),
    ]);
    const page = await articles({ topic: "fed", limit: 3, after: `gd:${gdeltTime(at)}:2` });
    expect(page.articles.map((a) => a.title)).toEqual([
      "Article crowd 002",
      "Article crowd 003",
      "Article crowd 004",
    ]);
    expect(page.next_cursor).toBe(`gd:${gdeltTime(at)}:5`);
  });

  test("a cursor older than since ends the list", async () => {
    const { articles } = news(routes);
    const page = await articles({
      topic: "fed",
      since: "2026-11-25T18:00:00Z",
      after: `gd:${gdeltTime(Date.parse("2026-11-25T17:00:00Z"))}:0`,
    });
    expect(page).toEqual({ articles: [], next_cursor: null });
  });
});

describe("GDELT's search, as the provider writes it", () => {
  test("each tone through its operator; the app's own words limited to English sources, the caller's not", () => {
    expect(gdeltQuery({ words: "tariffs", tone: "bearish" })).toBe("tariffs tone<-5");
    expect(gdeltQuery({ topic: "oil", tone: "bullish" })).toBe(
      '("oil prices" OR "crude oil" OR OPEC OR Brent) tone>5 sourcelang:english',
    );
    expect(gdeltQuery({ tone: "neutral" })).toBe(
      '("stock market" OR stocks OR "Wall Street" OR equities) toneabs<5 sourcelang:english',
    );
    expect(gdeltQuery({ words: "Nvidia", topic: "earnings" })).toBe(
      'Nvidia (earnings OR "quarterly results" OR "quarterly profit")',
    );
  });

  test("every topic has words GDELT reads: OR'd in parentheses, phrases closed, no bare word under three letters", () => {
    expect(Object.keys(TOPIC_WORDS).sort()).toEqual([...NEWS_TOPICS].sort());
    for (const topic of NEWS_TOPICS) {
      const words = TOPIC_WORDS[topic];
      expect(words, topic).toMatch(/^\(.*\)$/);
      expect((words.match(/"/g) ?? []).length % 2, topic).toBe(0);
      const bare = words
        .replace(/"[^"]*"/g, " ")
        .replace(/[()]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
      for (const word of bare)
        if (word !== "OR") expect(word.length, `${topic}: ${word}`).toBeGreaterThanOrEqual(3);
    }
  });

  test("the caller's words cleaned of what GDELT does not read", () => {
    expect(searchWords("Apple’s “AI” chips, again?!")).toBe('Apple "AI" chips again');
    expect(searchWords('an "unclosed phrase')).toBe("an unclosed phrase");
    expect(searchWords("  rate   cut; odds  ")).toBe("rate cut odds");
  });

  test("its address: the same request always the same address; times as GDELT writes them", () => {
    const url = new URL(
      artListUrl({
        query: "rate cut",
        start: Date.parse("2026-11-01T00:00:00Z"),
        end: Date.parse("2026-11-24T23:59:59.999Z"),
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://api.gdeltproject.org/api/v2/doc/doc");
    expect([...url.searchParams.entries()]).toEqual([
      ["query", "rate cut"],
      ["mode", "artlist"],
      ["format", "json"],
      ["maxrecords", "250"],
      ["sort", "datedesc"],
      ["startdatetime", "20261101000000"],
      ["enddatetime", "20261124235959"],
    ]);
    expect(parseGdeltTime("20261125T141500Z")).toBe(Date.parse("2026-11-25T14:15:00Z"));
    expect(parseGdeltTime("20261125141500")).toBe(Date.parse("2026-11-25T14:15:00Z"));
    for (const off of ["20261131T120000Z", "20261125T250000Z", "2026-11-25T14:15:00Z", ""]) {
      expect(parseGdeltTime(off), off).toBeUndefined();
    }
  });
});

describe("article", () => {
  test("a copy is answered: what a reader does to it leaves the session's article as listed", async () => {
    const { articles, article } = news([AAPL]);
    const page = await articles({ symbol: "AAPL", limit: 1 });
    const id = page.articles[0]?.id as string;
    const read = (await article(id)) as { title: string; topics: string[] };
    read.title = "changed";
    read.topics.push("changed");
    expect(await article(id)).toMatchObject({
      title: "Apple shares close lower as tech stocks slip",
      topics: [],
    });
  });

  test("an unknown id is no_data from the news search itself, with no request", async () => {
    const { article, fetch } = news([]);
    const error = await failure(article("gd:AAAAAAAAAAAAAAAA"));
    expect([error.kind, error.details.source]).toEqual(["no_data", "News search"]);
    expect(fetch.requests).toEqual([]);
  });
});
