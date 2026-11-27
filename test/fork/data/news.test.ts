// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The news provider (src/fork/data/providers/news.ts) through the real news and article tools, the router and
 * the ToolRegistry: a listing's news from Yahoo's search (hand-made answers read by yahoo-finance2 itself,
 * test/fork/fixtures/yahoo-news), words, a topic, the market's latest and a tone from GDELT's DOC API
 * (hand-made ArtList answers, test/fork/fixtures/gdelt), then the article tool on what was listed. Each text the
 * model reads is compared whole (golden), and the read check shows every field the tools read was supplied.
 * No request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../../../src/data/capabilities.js";
import { gdeltQuery } from "../../../src/fork/data/sources/gdelt.js";
import {
  buildTools,
  type FixtureFetch,
  type FixtureRoute,
  fixtureFetch,
  type TestOptions,
  testProviders,
} from "./harness.js";

// Fixture routes ---------------------------------------------------------------------------------------

/** GDELT's answer to the search `query`, any window, any count (or those `when` accepts). */
function gdelt(query: string, file: string, when?: (url: URL) => boolean): FixtureRoute {
  return {
    match: (url) =>
      url.hostname === "api.gdeltproject.org" &&
      url.searchParams.get("query") === query &&
      (!when || when(url)),
    file,
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
 * A fixture fetch over `routes` whose Yahoo news search answers as Yahoo does: at most `newsCount` of the
 * fixture's articles, the newest first.
 */
function newsFetch(routes: readonly FixtureRoute[]): FixtureFetch {
  const base = fixtureFetch(routes);
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await base(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== "/v1/finance/search" || !response.ok) return response;
    const body = (await response.json()) as { news?: unknown[] };
    if (Array.isArray(body.news)) body.news = body.news.slice(0, Number(url.searchParams.get("newsCount")));
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  };
  return Object.assign(answer, { requests: base.requests, unmatched: base.unmatched }) as FixtureFetch;
}

const FED = gdeltQuery({ topic: "fed" });
const MARKET = gdeltQuery({});
const CHIPS = gdeltQuery({ words: "chip export controls" });
const TARIFFS_BEARISH = gdeltQuery({ words: "tariffs", tone: "bearish" });

const ROUTES: readonly FixtureRoute[] = [
  yahooSearch("AAPL", "yahoo-news/search-aapl.json"),
  yahooSearch("005930.KS", "yahoo-news/search-005930-ks.json"),
  gdelt(FED, "gdelt/artlist-fed.json"),
  gdelt(MARKET, "gdelt/artlist-market.json"),
  gdelt(CHIPS, "gdelt/artlist-chip-export-controls.json"),
  gdelt(TARIFFS_BEARISH, "gdelt/artlist-tariffs-bearish.json"),
];

/** The fork's providers over `routes` (before these tests' own), and the tools over them with the read check. */
function setup(routes: readonly FixtureRoute[] = [], extra: TestOptions = {}) {
  const fetch = newsFetch([...routes, ...ROUTES]);
  const { providers, clock, timer } = testProviders({}, fetch, extra);
  return { ...buildTools(providers, { clock, check: true }), providers, fetch, timer };
}

/** The requests made to GDELT (their search and window) and to Yahoo's search (its symbol and count). */
function asked(fetch: FixtureFetch): string[] {
  return fetch.requests.map(({ url }) => {
    const address = new URL(url);
    const params = address.searchParams;
    if (address.hostname === "api.gdeltproject.org") {
      const window = ["startdatetime", "enddatetime"]
        .filter((name) => params.has(name))
        .map((name) => ` ${name}=${params.get(name)}`)
        .join("");
      return `gdelt ${params.get("query")} (${params.get("mode")}, ${params.get("format")}, ${params.get("maxrecords")}, ${params.get("sort")})${window}`;
    }
    return `yahoo search q=${params.get("q")} newsCount=${params.get("newsCount")} quotesCount=${params.get("quotesCount")}`;
  });
}

/** The text the model reads, compared whole with the golden one. */
function golden(name: string, text: string): void {
  expect(GOLDEN[name]).toBeDefined();
  expect(text).toBe(GOLDEN[name] as string);
}

// The tests --------------------------------------------------------------------------------------------

describe("what the news provider declares", () => {
  test("news.articles and news.article, keyless, from the first setup, without a request", () => {
    const { providers, fetch, available } = setup();
    const news = providers.news as DataProvider;
    expect(news.name).toBe("News search");
    expect(
      Object.fromEntries(
        Object.entries(news.capabilities).map(([name, methods]) => [name, Object.keys(methods ?? {}).sort()]),
      ),
    ).toEqual({ news: ["article", "articles"] });
    expect(available.has("news")).toBe(true);
    expect(fetch.requests).toEqual([]);
  });
});

describe("news by symbol, from Yahoo's search", () => {
  test("a US listing: the newest eight, every field the tool reads, one request for one more than the page", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("news", { symbol: "AAPL" });
    expect(run.failure).toBeUndefined();
    golden("news-aapl", run.text);
    expect(run.summary).toBe("8 articles (more exist)");
    expect(run.source).toBe("News search");
    expect(run.reads.missing()).toEqual([]);
    expect(asked(fetch)).toEqual(["yahoo search q=AAPL newsCount=9 quotesCount=0"]);
    expect(fetch.unmatched).toEqual([]);
  });

  test("the next page, by the cursor the first gave", async () => {
    const { runTool, fetch } = setup();
    await runTool("news", { symbol: "AAPL" });
    const run = await runTool("news", { symbol: "AAPL", after: "yh:8" });
    expect(run.failure).toBeUndefined();
    golden("news-aapl-page-2", run.text);
    expect(run.reads.missing()).toEqual([]);
    expect(asked(fetch)).toEqual([
      "yahoo search q=AAPL newsCount=9 quotesCount=0",
      "yahoo search q=AAPL newsCount=17 quotesCount=0",
    ]);
  });

  test("since keeps the articles published from then on, from the same one request", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("news", { symbol: "AAPL", since: "2026-11-24" });
    expect(run.failure).toBeUndefined();
    expect(
      (run.payload as { articles: { published_at: string }[] }).articles.map((a) => a.published_at),
    ).toEqual([
      "2026-11-25T20:45:00Z",
      "2026-11-25T18:10:00Z",
      "2026-11-25T14:30:00Z",
      "2026-11-24T21:05:00Z",
      "2026-11-24T16:20:00Z",
      "2026-11-24T12:00:00Z",
    ]);
    expect((run.payload as { next_cursor: string | null }).next_cursor).toBeNull();
    expect(asked(fetch)).toEqual(["yahoo search q=AAPL newsCount=9 quotesCount=0"]);
  });

  test("a Korean listing by its canonical key is asked under Yahoo's symbol, its related tickers kept", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("news", { symbol: "XKRX:005930", limit: 2 });
    expect(run.failure).toBeUndefined();
    golden("news-samsung", run.text);
    expect(run.reads.missing()).toEqual([]);
    expect(asked(fetch)).toEqual(["yahoo search q=005930.KS newsCount=3 quotesCount=0"]);
    const article = await runTool("article", { id: "yh:54f3b33e-662f-556a-8361-bfb2c33936f9" });
    expect((article.payload as { instruments: string[] }).instruments).toEqual(["005930.KS", "000660.KS"]);
  });
});

describe("news from GDELT", () => {
  test("by words: newest first, GDELT's domain as publisher, its seen time, one request for GDELT's 250", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("news", { query: "chip export controls" });
    expect(run.failure).toBeUndefined();
    golden("news-chips", run.text);
    expect(run.summary).toBe("4 articles");
    expect(run.reads.missing()).toEqual([]);
    expect(asked(fetch)).toEqual(["gdelt chip export controls (artlist, json, 250, datedesc)"]);
  });

  test("by topic (macro-outlook's fed): the topic's words in English sources, paged by time, a tie kept in order", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("news", { topic: "fed" });
    expect(run.failure).toBeUndefined();
    golden("news-fed", run.text);
    expect(run.reads.missing()).toEqual([]);
    const next = await runTool("news", { topic: "fed", after: "gd:20261124150000:1" });
    expect(next.failure).toBeUndefined();
    golden("news-fed-page-2", next.text);
    // The second page is read from the first answer, kept: one request in all.
    expect(asked(fetch)).toEqual([
      'gdelt ("Federal Reserve" OR FOMC OR "Fed chair" OR "Fed officials") sourcelang:english (artlist, json, 250, datedesc)',
    ]);
  });

  test("the market's latest (market-brief: neither symbol nor query)", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("news", { limit: 3 });
    expect(run.failure).toBeUndefined();
    golden("news-market", run.text);
    expect(run.reads.missing()).toEqual([]);
    expect(asked(fetch)).toEqual([
      'gdelt ("stock market" OR stocks OR "Wall Street" OR equities) sourcelang:english (artlist, json, 250, datedesc)',
    ]);
  });

  test("a tone through GDELT's tone operator, its basis said with each article", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("news", { query: "tariffs", sentiment: "bearish" });
    expect(run.failure).toBeUndefined();
    golden("news-tariffs-bearish", run.text);
    expect(run.reads.missing()).toEqual([]);
    expect(asked(fetch)).toEqual(["gdelt tariffs tone<-5 (artlist, json, 250, datedesc)"]);
  });

  test("a topic with words, and a window: GDELT is asked both, from since to until", async () => {
    const query = gdeltQuery({ words: "Nvidia", topic: "earnings" });
    const { runTool, fetch } = setup([gdelt(query, "gdelt/artlist-chip-export-controls.json")]);
    const run = await runTool("news", {
      query: "Nvidia",
      topic: "earnings",
      since: "2026-11-24",
      until: "2026-11-24",
    });
    expect(run.failure).toBeUndefined();
    // Only the article seen within the window is listed.
    expect((run.payload as { articles: { title: string }[] }).articles.map((a) => a.title)).toEqual([
      "Equipment makers seek clarity on chip export rules",
    ]);
    expect(asked(fetch)).toEqual([
      'gdelt Nvidia (earnings OR "quarterly results" OR "quarterly profit") (artlist, json, 250, datedesc) startdatetime=20261124000000 enddatetime=20261124235959',
    ]);
  });

  test("an until at or after now asks for the latest, sharing the open window's answer", async () => {
    const { runTool, fetch } = setup();
    await runTool("news", { query: "chip export controls", until: "2026-11-25" });
    await runTool("news", { query: "chip export controls" });
    expect(asked(fetch)).toEqual(["gdelt chip export controls (artlist, json, 250, datedesc)"]);
  });
});

describe("filters no source here honours", () => {
  test("impact (market-brief's and macro-outlook's 'impact high') is refused, never ignored, and nothing is asked", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("news", { impact: "high" });
    expect(run.failure).toBe("data_invalid");
    golden("news-impact-refused", run.text);
    const topic = await runTool("news", { topic: "fed", impact: "high" });
    expect(topic.failure).toBe("data_invalid");
    expect(fetch.requests).toEqual([]);
  });

  test("event type, and a mixed tone, are refused too", async () => {
    const { runTool, fetch } = setup();
    const event = await runTool("news", { query: "chip export controls", event_type: "m_and_a" });
    expect(event.failure).toBe("data_invalid");
    golden("news-event-refused", event.text);
    const mixed = await runTool("news", { query: "tariffs", sentiment: "mixed" });
    expect(mixed.failure).toBe("data_invalid");
    golden("news-mixed-refused", mixed.text);
    expect(fetch.requests).toEqual([]);
  });

  test("a symbol with a topic, words or a tone is refused, pointing to a search by the company's name", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("news", { symbol: "AAPL", topic: "lawsuit" });
    expect(run.failure).toBe("data_invalid");
    golden("news-symbol-topic-refused", run.text);
    for (const narrowed of [{ query: "iPhone sales" }, { sentiment: "bullish" }]) {
      const again = await runTool("news", { symbol: "AAPL", ...narrowed });
      expect(again.failure, JSON.stringify(narrowed)).toBe("data_invalid");
    }
    expect(fetch.requests).toEqual([]);
  });
});

describe("article", () => {
  test("a Yahoo article listed this session: its metadata, every field the tool reads, no request", async () => {
    const { runTool, fetch } = setup();
    await runTool("news", { symbol: "AAPL" });
    const run = await runTool("article", { id: "yh:e87242ba-c1f3-5755-bbea-c65b81a14809" });
    expect(run.failure).toBeUndefined();
    golden("article-yahoo", run.text);
    expect(run.reads.missing()).toEqual([]);
    expect(run.payload).toMatchObject({
      time_kind: "published",
      available_at: "2026-11-24T21:05:00Z",
      topics: [],
      instruments: ["AAPL", "MSFT", "GOOGL"],
      events: [],
      figures: [],
      quotations: [],
    });
    expect(fetch.requests).toHaveLength(1);
  });

  test("a GDELT article listed under a tone: its seen time said as such, and the tone's basis", async () => {
    const { runTool } = setup();
    const list = await runTool("news", { query: "tariffs", sentiment: "bearish" });
    const id = (list.payload as { articles: { id: string }[] }).articles[1]?.id as string;
    expect(id).toMatch(/^gd:[A-Za-z0-9_-]{16}$/);
    const run = await runTool("article", { id });
    expect(run.failure).toBeUndefined();
    golden("article-gdelt", run.text.replace(id, "<id>"));
    expect(run.reads.missing()).toEqual([]);
  });

  test("an id not listed this session answers no_data, saying to list news again", async () => {
    const { runTool } = setup();
    const run = await runTool("article", { id: "yh:2d2e8284-9078-5da7-a3d8-26c60e2727f7" });
    expect(run.failure).toBe("data_no_data");
    golden("article-unknown", run.text);
  });
});

// Golden texts -------------------------------------------------------------------------------------------

const GOLDEN: Readonly<Record<string, string>> = {
  "news-aapl": `[e1] news AAPL (reference its data as {"ref":"e1","path":"<field>"})
source: News search
8 articles on this page about AAPL
2026-11-25T20:45:00Z Example Newswire: Apple shares close lower as tech stocks slip [article yh:2d2e8284-9078-5da7-a3d8-26c60e2727f7]
  https://finance.yahoo.com/news/apple-shares-close-lower-tech-795639500.html
2026-11-25T18:10:00Z Sample Markets Daily: Apple supplier outlook points to steady iPhone demand [article yh:99afe3b8-3f35-525e-8e5f-82e55a76647f]
  https://finance.yahoo.com/news/apple-supplier-outlook-steady-iphone-795630200.html
2026-11-25T14:30:00Z Example Investor: What to watch in Apple's services business [article yh:4d91cafe-78a8-5ec5-a866-70d3fe9c4076]
  https://finance.yahoo.com/news/what-watch-apple-services-795617000.html
2026-11-24T21:05:00Z Example Newswire: Big tech stocks mixed after the close [article yh:e87242ba-c1f3-5755-bbea-c65b81a14809]
  https://finance.yahoo.com/news/big-tech-stocks-mixed-close-795554300.html
2026-11-24T16:20:00Z Sample Business Review: Apple expands retail presence in India [article yh:ca78c19a-b353-5be8-871b-5a6c085094c6]
  https://finance.yahoo.com/news/apple-expands-retail-india-795537200.html
2026-11-24T12:00:00Z Example Markets: Analysts raise Apple price targets ahead of holiday quarter [article yh:979ba9af-55ff-5f5e-aae5-b83fcf053bbb]
  https://finance.yahoo.com/news/analysts-raise-apple-targets-holiday-795521600.html
2026-11-23T19:40:00Z Example Newswire: Apple and Microsoft lead megacap gains [article yh:9ed7b808-46b4-5523-9c6f-0ce322880fbe]
  https://finance.yahoo.com/news/apple-microsoft-lead-megacap-gains-795462800.html
2026-11-23T13:15:00Z Sample Tech Journal: Apple's App Store policy changes take effect in Europe [article yh:b25a6acd-9e9b-542c-b9d7-e85b6e6daf95]
  https://finance.yahoo.com/news/apple-app-store-changes-europe-795439700.html
more: news with after=yh:8 and the same filters`,
  "news-aapl-page-2": `[e2] news AAPL (reference its data as {"ref":"e2","path":"<field>"})
source: News search
4 articles on this page about AAPL
2026-11-22T15:00:00Z Example Investor: Weekend read: how Apple sets its product calendar [article yh:33abb04f-381a-543d-bb55-f18a506d82a2]
  https://finance.yahoo.com/news/how-apple-sets-product-calendar-795359600.html
2026-11-21T20:30:00Z Sample Markets Daily: Apple stock ends week higher [article yh:04182cd7-ee57-509f-b99d-d1f44758dbb3]
  https://finance.yahoo.com/news/apple-stock-ends-week-higher-795293000.html
2026-11-20T17:45:00Z Sample Tech Journal: Apple chip unit hires for modem program [article yh:d6058f9a-01f4-50d3-920d-22feda8513dd]
  https://finance.yahoo.com/news/apple-chip-unit-modem-hiring-795196700.html
2026-11-19T22:10:00Z Example Newswire: Apple holds annual developer grants event [article yh:fc87f846-86af-5cb9-afc3-9964a05228e6]
  https://finance.yahoo.com/news/apple-developer-grants-event-795126200.html`,
  "news-samsung": `[e1] news XKRX:005930 (reference its data as {"ref":"e1","path":"<field>"})
source: News search
2 articles on this page about XKRX:005930
2026-11-25T07:20:00Z Example Asia Wire: Samsung Electronics shares rise on memory chip pricing [article yh:63ceedb2-c36a-5007-b6f0-a2469d7b5493]
  https://finance.yahoo.com/news/samsung-electronics-shares-rise-memory-795591200.html
2026-11-24T23:05:00Z Sample Markets Daily: KOSPI opens higher as chip stocks gain [article yh:54f3b33e-662f-556a-8361-bfb2c33936f9]
  https://finance.yahoo.com/news/kospi-opens-higher-chip-stocks-795561500.html
more: news with after=yh:2 and the same filters`,
  "news-chips": `[e1] news chip export controls (reference its data as {"ref":"e1","path":"<field>"})
source: News search
4 articles on this page on "chip export controls"
2026-11-25T19:30:00Z economy.example.net: Chipmakers weigh impact of new export controls [article gd:Car0cWLbvZR-BqQx]
  https://economy.example.net/trade/chipmakers-weigh-export-controls
2026-11-25T13:00:00Z nachrichten.example.net: Exportkontrollen für Chips: Hersteller prüfen die Folgen [article gd:D6HRylusYzH2iLI5]
  https://nachrichten.example.net/wirtschaft/exportkontrollen-chips
2026-11-24T17:15:00Z wire.example.com: Equipment makers seek clarity on chip export rules [article gd:lVHd8OEe8DOMuKBY]
  https://wire.example.com/tech/2026/11/24/equipment-makers-chip-export-rules
2026-11-23T09:15:00Z global.example.net: Asia chip stocks fall after export control update [article gd:QVPDZ5QpBYZVjkvO]
  https://global.example.net/asia/asia-chip-stocks-export-control-update`,
  "news-fed": `[e1] news fed (reference its data as {"ref":"e1","path":"<field>"})
source: News search
8 articles on this page
2026-11-25T21:45:00Z wire.example.com: Fed officials signal patience on further rate cuts [article gd:C_C6eM1zkfTaAMkD]
  https://wire.example.com/markets/2026/11/25/fed-officials-signal-patience
2026-11-25T20:30:00Z markets.example.org: Treasury yields slip as traders weigh Federal Reserve outlook [article gd:eg9vIse4G02eqrl0]
  https://markets.example.org/rates/treasury-yields-slip-fed-outlook
2026-11-25T18:30:00Z economy.example.net: FOMC minutes show debate over balance sheet runoff [article gd:UfWQ3GfbU0JBMapC]
  https://economy.example.net/policy/fomc-minutes-balance-sheet
2026-11-25T16:15:00Z daily.example.com: Fed chair says labor market is cooling gradually [article gd:wEa1NZt2_nilskLD]
  https://daily.example.com/economy/fed-chair-labor-market-cooling
2026-11-25T12:00:00Z business.example.org: What the Federal Reserve's next move means for mortgage rates [article gd:e2RlUVkU0crbSAl1]
  https://business.example.org/personal-finance/fed-next-move-mortgage-rates
2026-11-24T22:45:00Z global.example.net: Fed officials differ on the timing of a December cut [article gd:OrFORhhPa_HiwQ47]
  https://global.example.net/world/fed-officials-differ-december
2026-11-24T19:30:00Z wire.example.com: Federal Reserve governor outlines view on inflation path [article gd:zoz8ggEp7DRAnuJe]
  https://wire.example.com/markets/2026/11/24/fed-governor-inflation-path
2026-11-24T15:00:00Z economy.example.net: Federal Reserve bank surveys point to slower growth [article gd:vRPTP_hykmY0WC8l]
  https://economy.example.net/surveys/fed-bank-surveys-slower-growth
more: news with after=gd:20261124150000:1 and the same filters`,
  "news-market": `[e1] news (reference its data as {"ref":"e1","path":"<field>"})
source: News search
3 articles on this page
2026-11-25T21:45:00Z markets.example.org: Wall Street ends mixed as megacap tech lags [article gd:fa9ozMZzqy6pkKfx]
  https://markets.example.org/stocks/wall-street-ends-mixed
2026-11-25T21:15:00Z wire.example.com: Stocks close off highs; small caps outperform [article gd:ORJClV7qrETuYWfe]
  https://wire.example.com/markets/2026/11/25/stocks-close-off-highs
2026-11-25T20:00:00Z daily.example.com: Equities hold gains as bond yields ease [article gd:7hx1ADjW8m8rQABC]
  https://daily.example.com/markets/equities-hold-gains-yields-ease
more: news with after=gd:20261125200000:1 and the same filters`,
  "news-tariffs-bearish": `[e1] news tariffs bearish (reference its data as {"ref":"e1","path":"<field>"})
source: News search
3 articles on this page on "tariffs"
2026-11-25T19:00:00Z wire.example.com: Importers warn tariffs will squeeze holiday margins (bearish: GDELT tone below -5) [article gd:yJ1ik_nu6BrLKu72]
  https://wire.example.com/business/2026/11/25/importers-warn-tariffs-margins
2026-11-25T08:15:00Z business.example.org: Retailers cut forecasts as tariff costs mount (bearish: GDELT tone below -5) [article gd:h8TiIICiPTErUzX6]
  https://business.example.org/retail/retailers-cut-forecasts-tariff-costs
2026-11-24T20:30:00Z economy.example.net: Factory orders slump amid tariff uncertainty (bearish: GDELT tone below -5) [article gd:MI4xHrh8f_Si8XtO]
  https://economy.example.net/industry/factory-orders-slump-tariffs`,
  "news-impact-refused": `News search cannot answer this request as asked: impact high: neither news source here (Yahoo's news search, GDELT) rates an article's expected impact; ask without impact`,
  "news-event-refused": `News search cannot answer this request as asked: event_type m_and_a: neither news source here classifies articles by the event they report; ask without event_type (a topic or words narrow the subject)`,
  "news-symbol-topic-refused": `News search cannot answer this request as asked: Yahoo's news for a listing (AAPL) cannot be narrowed by a topic; ask by symbol alone, or search GDELT's articles with the company's name in query (with a topic or sentiment)`,
  "article-yahoo": `[e2] article Big tech stocks mixed after the close (reference its data as {"ref":"e2","path":"<field>"})
source: News search
2026-11-24T21:05:00Z Example Newswire: Big tech stocks mixed after the close
https://finance.yahoo.com/news/big-tech-stocks-mixed-close-795554300.html
tone not stated, expected impact not stated; about AAPL, MSFT, GOOGL`,
  "article-gdelt": `[e2] article Retailers cut forecasts as tariff costs mount (reference its data as {"ref":"e2","path":"<field>"})
source: News search
2026-11-25T08:15:00Z (seen, no publication time stated) business.example.org: Retailers cut forecasts as tariff costs mount
https://business.example.org/retail/retailers-cut-forecasts-tariff-costs
tone bearish: GDELT tone below -5, expected impact not stated`,
  "article-unknown": `News search has no data for this request: no article with id yh:2d2e8284-9078-5da7-a3d8-26c60e2727f7 was listed in this session: list news again and read an id it gives`,
  "news-fed-page-2": `[e2] news fed (reference its data as {"ref":"e2","path":"<field>"})
source: News search
2 articles on this page
2026-11-24T15:00:00Z markets.example.org: Stocks steady ahead of remarks from Fed officials [article gd:_NePHP8MA8Vh9OvZ]
  https://markets.example.org/stocks/steady-ahead-of-fed-remarks
2026-11-24T11:30:00Z daily.example.com: Fed's Beige Book notes softer consumer spending [article gd:HfBAnUwEWGtQ1xpa]
  https://daily.example.com/economy/beige-book-softer-spending`,
  "news-mixed-refused": `News search cannot answer this request as asked: sentiment mixed: GDELT's tone is one score per article, which cannot show mixed tone; ask for bearish, bullish or neutral, or without sentiment`,
};
