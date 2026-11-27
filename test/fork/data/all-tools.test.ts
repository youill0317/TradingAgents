// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Every data tool once, through the fork's providers together as a setup with SEC_USER_AGENT builds them (and
 * Polymarket, as the engine adds it), the router and the ToolRegistry, on the fixtures the providers' own tests
 * use (test/fork/fixtures: real answers saved earlier, and hand-made ones in the sources' documented formats).
 * Every answer is behind the read check, so a change that drops a field a tool reads fails here: each call is
 * pinned to answer, to name the source the router chose, and to leave out no field the tool reads by name
 * (upstream Yahoo's own quote aside). Of a record a tool passes on whole, the check sees only the keys named
 * for it: SPREAD_KEYS (technicals, estimates, institutional holders) and each market view's row and summary
 * keys (VIEW_KEYS); the other fields of such records (a quote's day and 52-week range, the analyst record's
 * other targets) are the providers' own tests' business. A tool reading more than one method runs once per
 * method; dcf reads a statement from SEC EDGAR and a profile from Yahoo together; statements runs annual and
 * quarterly, news by symbol (Yahoo) and by topic (GDELT); markets runs each of its 22 views. Then, in a setup
 * with Korea's keys too (DART_API_KEY, ECOS_API_KEY, KOSIS_API_KEY, DATA_GO_KR_API_KEY, NAVER_CLIENT_ID and
 * NAVER_CLIENT_SECRET), Samsung Electronics (XKRX:005930) through every Korean source the same way: its
 * statements, filings, a filing's section and its insider reports from OpenDART, its quote and daily prices
 * from the FSC when Yahoo fails, an ECOS and a KOSIS series, the Bank of Korea's row of the central banks'
 * view, news for Korean words from Naver's news search and GDELT, and the instrument search finding it by its
 * Korean name (korea-routes.test.ts). The providers' own tests hold the golden texts. No request reaches the
 * network.
 */
import { describe, expect, test } from "bun:test";
import { MARKET_VIEWS } from "../../../src/data/capabilities.js";
import { PolymarketClient } from "../../../src/data/polymarket/client.js";
import { polymarketProvider } from "../../../src/data/polymarket/provider.js";
import { gdeltQuery } from "../../../src/fork/data/sources/gdelt.js";
import { frameUrl } from "../../../src/fork/data/sources/sec-frames.js";
import { SEC_TICKERS_URL } from "../../../src/fork/data/sources/sec-tickers.js";
import { SP_LISTS, wikitextUrl } from "../../../src/fork/data/sources/wikipedia.js";
import { MODULES } from "../../../src/fork/data/sources/yahoo.js";
import { DATA_TOOLS } from "../../../src/tools/catalog.js";
import {
  buildTools,
  expectKeys,
  type FixtureFetch,
  type FixtureRoute,
  fixtureFetch,
  readLog,
  type ToolRun,
  testProviders,
  YAHOO_AAPL,
} from "./harness.js";
import {
  ANNUAL,
  KOREA_KEYS,
  KOREA_ROUTES,
  KOREA_SECRETS,
  KOREAN_WORDS,
  QUARTERLY,
  withKorea,
} from "./korea-routes.test.js";
import { ROUTES as MARKET_ROUTES, POOL, VIEW_KEYS, yahooPath } from "./markets-routes.test.js";

// Fixture routes, by source ------------------------------------------------------------------------------

/** Yahoo's chart of `symbol` at `interval`, for requests whose start `when` accepts (any, unless given). */
const chart = (symbol: string, file: string, interval = "1d", when?: (period1: number) => boolean) =>
  ({
    match: (url) =>
      decodeURIComponent(url.pathname) === `/v8/finance/chart/${symbol}` &&
      url.searchParams.get("interval") === interval &&
      (!when || when(Number(url.searchParams.get("period1")))),
    file,
  }) satisfies FixtureRoute;

/** Yahoo's quoteSummary of `symbol` with one use's modules. */
const summary = (symbol: string, use: keyof typeof MODULES, file: string) =>
  ({
    match: (url) =>
      decodeURIComponent(url.pathname) === `/v10/finance/quoteSummary/${symbol}` &&
      url.searchParams.get("modules") === MODULES[use].join(","),
    file,
  }) satisfies FixtureRoute;

/** Yahoo (hand-made answers read by yahoo-finance2 itself), before YAHOO_AAPL's cookie page, crumb, quote and chart. */
const YAHOO: FixtureRoute[] = [
  {
    match: (url) => url.pathname === "/v7/finance/quote" && url.searchParams.get("symbols") === "005930.KS",
    file: "yahoo/quote-005930-ks.json",
  },
  // A whole history's events start before 1970; the indicators read the 600 days from 2025 on.
  chart("AAPL", "yahoo/chart-aapl-events.json", "1d", (period1) => period1 < 0),
  chart(
    "AAPL",
    "yahoo/chart-aapl-1d-600.json",
    "1d",
    (period1) => period1 > 0 && period1 < Date.parse("2026-01-01") / 1000,
  ),
  chart("AAPL", "yahoo/chart-aapl-15m.json", "15m"),
  summary("AAPL", "profile", "yahoo/quotesummary-aapl-profile.json"),
  summary("AAPL", "analyst", "yahoo/quotesummary-aapl-analyst.json"),
  summary("AAPL", "calendar", "yahoo/quotesummary-aapl-calendar.json"),
  summary("AAPL", "holders", "yahoo/quotesummary-aapl-holders.json"),
  summary("MSFT", "profile", "yahoo/quotesummary-msft-profile.json"),
  summary("GOOGL", "profile", "yahoo/quotesummary-googl-profile.json"),
  summary("META", "profile", "yahoo/quotesummary-meta-profile.json"),
  {
    match: (url) => url.pathname === "/v1/finance/search" && url.searchParams.get("q") === "AAPL",
    file: "yahoo-news/search-aapl.json",
  },
  // The instrument search's (listings only, no news).
  {
    match: (url) => url.pathname === "/v1/finance/search" && url.searchParams.get("q") === "Apple",
    file: "instruments/yahoo-search-apple.json",
  },
];

/** An insider report's raw XML in an AAPL filing's folder. */
const report = (accession: string, document: string): FixtureRoute => ({
  match: `https://www.sec.gov/Archives/edgar/data/320193/${accession.replaceAll("-", "")}/${document}`,
  file: `sec/form4-aapl-${accession}.xml`,
});

/** SEC EDGAR: its ticker list (hand-made), Apple's filing index and XBRL facts (saved), its 10-K and insider reports (hand-made). */
const SEC: FixtureRoute[] = [
  { match: SEC_TICKERS_URL, file: "sec/company-tickers-exchange.json" },
  { match: "https://data.sec.gov/submissions/CIK0000320193.json", file: "sec/submissions-aapl.json" },
  {
    match: "https://data.sec.gov/submissions/CIK0000320193-submissions-001.json",
    file: "sec/submissions-aapl-001.json",
  },
  {
    match: "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
    file: "sec/companyfacts-aapl.json",
  },
  {
    match: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm",
    file: "sec/document-aapl-0000320193-26-000026.html",
  },
  report("0001140361-26-044952", "form4.xml"),
  report("0001140361-26-044773", "form4.xml"),
  report("0001140361-26-043484", "form4.xml"),
  report("0001140361-26-042149", "form4.xml"),
  report("0001140361-26-041201", "form4.xml"),
  report("0000320193-24-000102", "wk-form5_1727822122.xml"),
  report("0000320193-22-000078", "wf-form4a_166120817922787.xml"),
];

/** The frames' fixture names, by concept. */
const FRAME_FILES: Readonly<Record<string, string>> = {
  Revenues: "revenues",
  RevenueFromContractWithCustomerExcludingAssessedTax: "rfcceat",
  NetIncomeLoss: "netincomeloss",
};

/** Sector screens: Wikipedia's three lists (excerpts), SEC's frames (saved or assembled), SEC's 404 for any other frame. */
const SCREENS: FixtureRoute[] = [
  ...SP_LISTS.map((list) => ({ match: wikitextUrl(list.page), file: `wikipedia/${list.key}-wikitext.json` })),
  ...Object.entries(FRAME_FILES).flatMap(([concept, file]) =>
    ["CY2024", "CY2025"].map((period) => ({
      match: frameUrl(concept, "USD", period),
      file: `frames/${file}-${period.toLowerCase()}.json`,
    })),
  ),
  { match: /^https:\/\/data\.sec\.gov\/api\/xbrl\/frames\//, file: "frames/no-such-frame.xml" },
];

/** The agencies (saved answers; FRED's keyless download hand-made), and the ECB's reference rates (saved). */
const AGENCIES: FixtureRoute[] = [
  {
    match: (url) =>
      url.hostname === "home.treasury.gov" &&
      url.pathname.endsWith("/daily-treasury-rates.csv/2026/all") &&
      url.searchParams.get("type") === "daily_treasury_yield_curve",
    file: "treasury/par-2026.csv",
  },
  {
    match: "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/5.json",
    file: "nyfed/effr-last5.json",
  },
  {
    match: /\/FM\/D\.U2\.EUR\.4F\.KR\.DFR\.LEV\?format=csvdata&detail=dataonly&startPeriod=2024-01-01$/,
    file: "ecb/fm-dfr-since2024.csv",
  },
  {
    match: (url) => url.hostname === "fred.stlouisfed.org" && url.searchParams.get("id") === "CPIAUCSL",
    file: "fred/graph-cpiaucsl.csv",
  },
  // The saved five days of USD per EUR are the 5-day window ending on the harness's day.
  {
    match: (url) =>
      url.pathname === "/service/data/EXR/D.USD.EUR.SP00.A" &&
      url.searchParams.get("startPeriod") === "2026-11-19",
    file: "ecb/exr-usd-last5.csv",
  },
];

/** The header of a quote answer made from the market views' pool of quote rows. */
const POOLED = "x-fixture-pooled";

/**
 * The market views' routes (markets-routes.test.ts: Yahoo's screens and charts, the agencies' series), and
 * Yahoo's batched quote requests no route above answers, answered from its pool of quote rows (see allFetch).
 */
const MARKETS: FixtureRoute[] = [
  {
    match: yahooPath("/v7/finance/quote"),
    body: "{}",
    headers: { "content-type": "application/json;charset=utf-8", [POOLED]: "1" },
  },
  ...MARKET_ROUTES,
];

/** GDELT's article list for the topic fed (hand-made in its documented ArtList form). */
const GDELT: FixtureRoute = {
  match: (url) =>
    url.hostname === "api.gdeltproject.org" && url.searchParams.get("query") === gdeltQuery({ topic: "fed" }),
  file: "gdelt/artlist-fed.json",
};

/** Polymarket's search (an excerpt of a saved answer). */
const POLYMARKET: FixtureRoute = {
  match: (url) => url.hostname === "gamma-api.polymarket.com" && url.pathname === "/public-search",
  file: "polymarket/public-search-fed-rate.json",
};

/**
 * A fixture fetch over every route (`first` before them) whose Yahoo news search answers as Yahoo does: at
 * most `newsCount` of the fixture's articles, the newest first; whose pooled quote route answers the rows of
 * the symbols asked that the pool holds, as Yahoo leaves out the symbols it does not know; and whose Korean
 * sources page as they do (withKorea).
 */
function allFetch(first: readonly FixtureRoute[] = []): FixtureFetch {
  const base = withKorea(
    fixtureFetch([
      ...first,
      ...YAHOO,
      ...SEC,
      ...SCREENS,
      ...AGENCIES,
      GDELT,
      POLYMARKET,
      ...YAHOO_AAPL,
      ...MARKETS,
    ]),
  );
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await base(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (response.headers.has(POOLED)) {
      const asked = (url.searchParams.get("symbols") ?? "").split(",");
      const result = asked.flatMap((symbol) => POOL.get(symbol) ?? []);
      return new Response(JSON.stringify({ quoteResponse: { result, error: null } }), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    }
    if (url.pathname !== "/v1/finance/search" || !response.ok) return response;
    const body = (await response.json()) as { news?: unknown[] };
    if (Array.isArray(body.news)) body.news = body.news.slice(0, Number(url.searchParams.get("newsCount")));
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  };
  return Object.assign(answer, { requests: base.requests, unmatched: base.unmatched }) as FixtureFetch;
}

// One setup for every call, as one session's ----------------------------------------------------------------

const fetch = allFetch();
const { providers, clock } = testProviders({ secUserAgent: "Test Agent test@example.com" }, fetch);
const { runTool, available } = buildTools(
  { ...providers, polymarket: polymarketProvider(new PolymarketClient(fetch)) },
  { clock, check: true },
);

/** The tools run here, each once or more. */
const ran = new Set<string>();

/**
 * What upstream's Yahoo answers for a US listing (src/data/yahoo/provider.ts, unchanged) leave out that the quote
 * and price_history tools read: optional fields it never sets.
 */
const UPSTREAM_QUOTE_LEFT_OUT = [
  "change_basis",
  "field_states",
  "instrument.listing",
  "instrument.price_scale",
  "stale",
];
const UPSTREAM_DAILY_LEFT_OUT = [
  "bars[].field_states",
  "coverage.complete_reason",
  "instrument.classification",
  "instrument.continuous",
  "instrument.listing",
  "instrument.price_scale",
];

/** A setup's way of running a tool, as buildTools gives it. */
type Runner = (tool: string, input: Record<string, unknown>) => Promise<ToolRun>;

/**
 * Runs `tool` with `input` in a setup (`runner`) and checks it as the model reads it: it answers, from `source`,
 * and every field the tool read of the answer was there (but those `leftOut` names). The read check must have
 * seen fields read.
 */
async function checkIn(
  runner: Runner,
  tool: string,
  input: Record<string, unknown>,
  source: string,
  leftOut: readonly string[] = [],
): Promise<ToolRun> {
  ran.add(tool);
  const run = await runner(tool, input);
  expect(run.failure, run.text).toBeUndefined();
  expect(run.source).toBe(source);
  expect(run.reads.paths().length).toBeGreaterThan(0);
  expect(run.reads.missing()).toEqual([...leftOut].sort());
  return run;
}

/** checkIn in the setup with SEC_USER_AGENT. */
const check = (
  tool: string,
  input: Record<string, unknown>,
  source: string,
  leftOut: readonly string[] = [],
) => checkIn(runTool, tool, input, source, leftOut);

// The calls ---------------------------------------------------------------------------------------------------

describe("every data tool, through every provider together, every field it reads supplied", () => {
  test("what the setup serves: every capability", () => {
    expect([...available].sort()).toEqual([
      "corporateActions",
      "crossSections",
      "filings",
      "instruments",
      "macroSeries",
      "markets",
      "news",
      "ownership",
      "predictionMarkets",
      "priceHistory",
      "profiles",
      "quotes",
      "statements",
      "technicals",
    ]);
  });

  test("quote: one listing (quotes.quote), and a batch (quotes.many) with a US listing upstream's Yahoo answers", async () => {
    await check("quote", { symbols: ["XKRX:005930"] }, "Yahoo");
    await check(
      "quote",
      { symbols: ["XKRX:005930", "AAPL"] },
      "Yahoo",
      // The router's source on each row is absent when every row is from one provider.
      [...UPSTREAM_QUOTE_LEFT_OUT.map((field) => `quotes[].quote.${field}`), "quotes[].source"],
    );
  });

  test("price_history: daily bars (Yahoo), intraday bars (Yahoo), a pair's reference rates (the ECB)", async () => {
    await check("price_history", { symbol: "AAPL", period: "1mo" }, "Yahoo", UPSTREAM_DAILY_LEFT_OUT);
    await check("price_history", { symbol: "AAPL", interval: "15m", period: "5d" }, "Yahoo");
    await check("price_history", { symbol: "fx:EURUSD", period: "5d" }, "ECB");
  });

  test("statements, annual and quarterly, then dcf on the annual statement and Yahoo's profile", async () => {
    await check(
      "statements",
      { symbol: "AAPL", statement: "income_statement", period_type: "quarterly", periods: 1 },
      "SEC EDGAR",
    );
    const statement = await check(
      "statements",
      { symbol: "AAPL", statement: "cash_flow", period_type: "annual", periods: 1 },
      "SEC EDGAR",
    );
    const profile = await check("profile", { symbol: "AAPL" }, "Yahoo");
    const dcf = await runTool("dcf", {
      profile: { ref: profile.evidence },
      cash_flow: { ref: statement.evidence },
      stages: [{ years: 5, growth_pct: 6 }],
      terminal_growth_pct: 2.5,
      discount: { rate_pct: 9 },
    });
    expect(dcf.failure, dcf.text).toBeUndefined();
    // The statement's lines carry the names dcf reads; the profile's currency is the statement's.
    const inputs = (dcf.payload as { inputs: { name: string }[]; currency: string | null }).inputs.map(
      (input) => input.name,
    );
    expect(inputs).toContain("Net Cash from Operating Activities");
    expect(inputs).toContain("Payments to Acquire PP&E");
    expect((dcf.payload as { currency: string | null }).currency).toBe("USD");
  });

  test("filings and filing_section", async () => {
    await check("filings", { symbol: "AAPL", forms: ["10-K"], limit: 2 }, "SEC EDGAR");
    await check(
      "filing_section",
      { symbol: "AAPL", accession: "0000320193-26-000026", section: "risk_factors" },
      "SEC EDGAR",
    );
  });

  test("news by symbol (Yahoo) and by topic (GDELT), then article on what each listed", async () => {
    const news = await check("news", { symbol: "AAPL" }, "News search");
    const id = (news.payload as { articles: { id: string }[] }).articles[0]?.id;
    expect(id).toStartWith("yh:");
    await check("article", { id }, "News search");
    const topic = await check("news", { topic: "fed" }, "News search");
    const listed = (topic.payload as { articles: { id: string }[] }).articles[0]?.id;
    expect(listed).toStartWith("gd:");
    await check("article", { id: listed }, "News search");
  });

  test("estimates and comps", async () => {
    await check("estimates", { symbol: "AAPL" }, "Yahoo");
    await check("comps", { symbol: "AAPL", peers: ["MSFT", "GOOGL", "META"] }, "Yahoo");
  });

  test("ownership: insider transactions (SEC EDGAR) and institutional holders (Yahoo), split by method", async () => {
    await check("ownership", { symbol: "AAPL", limit: 4 }, "SEC EDGAR");
    await check("ownership", { symbol: "AAPL", view: "institutional" }, "Yahoo");
  });

  test("corporate_actions and technicals", async () => {
    await check("corporate_actions", { symbol: "AAPL" }, "Yahoo");
    await check("technicals", { symbol: "AAPL" }, "Yahoo");
  });

  test("macro_series: one series of each publisher (the Treasury, the New York Fed, the ECB, FRED)", async () => {
    for (const series of [
      "10-year Treasury yield",
      "effective federal funds rate",
      "ECB deposit facility rate",
      "CPI",
    ]) {
      await check("macro_series", { series, periods: 5 }, "Public statistics");
    }
  });

  test("screen", async () => {
    await check(
      "screen",
      { sector: "information_technology", line: "revenue", fiscal_year: 2025 },
      "SEC EDGAR",
    );
  });

  test("prediction_markets", async () => {
    await check("prediction_markets", { topic: "fed rate" }, "Polymarket");
  });

  test("find_instrument: a company's name, from SEC's ticker list, Yahoo's search and the catalogs", async () => {
    const run = await check("find_instrument", { query: "Apple" }, "Instrument search");
    const [first] = (run.payload as { matches: { key: string; tools: string[] }[] }).matches;
    expect(first?.key).toBe("AAPL");
    expect(first?.tools).toContain("statements");
  });

  test("markets: every view, from Yahoo, the Treasury, the New York Fed, the ECB and FRED, its rows' keys too", async () => {
    for (const view of MARKET_VIEWS) {
      const run = await check("markets", { view }, "Market overview");
      // The rows and the summary are passed on whole: the keys the previews and the specs read, on each.
      const log = readLog();
      expectKeys(JSON.parse(JSON.stringify(run.payload)), VIEW_KEYS[view], log);
      expect(log.missing(), view).toEqual([]);
      expect(log.paths().length, view).toBeGreaterThan(0);
    }
  });

  test("every data tool ran, and every request was answered by a fixture", () => {
    expect([...ran].sort()).toEqual(DATA_TOOLS.map((entry) => entry.name).sort());
    expect(fetch.unmatched).toEqual([]);
  });
});

// The same setup with Korea's keys too -------------------------------------------------------------------------

const koreaFetch = allFetch(KOREA_ROUTES);
const korea = testProviders({ secUserAgent: "Test Agent test@example.com", ...KOREA_KEYS }, koreaFetch);
const koreaTools = buildTools(
  { ...korea.providers, polymarket: polymarketProvider(new PolymarketClient(koreaFetch)) },
  { clock: korea.clock, check: true },
);

/** The runs of the Korean calls, for the keys check after them. */
const koreaRuns: ToolRun[] = [];

/** checkIn in the setup with Korea's keys, its run kept. */
async function checkKorea(
  tool: string,
  input: Record<string, unknown>,
  source: string,
  leftOut: readonly string[] = [],
): Promise<ToolRun> {
  const run = await checkIn(koreaTools.runTool, tool, input, source, leftOut);
  koreaRuns.push(run);
  return run;
}

/** The filers provider's name with OpenDART beside SEC EDGAR. */
const FILERS = "SEC EDGAR / OpenDART";

describe("with Korea's keys too, Samsung Electronics through every Korean source, every field read supplied", () => {
  test("statements, annual and quarterly (OpenDART)", async () => {
    for (const [statement, period_type] of [
      ["income_statement", "annual"],
      ["cash_flow", "quarterly"],
      ["balance_sheet", "quarterly"],
    ] as const) {
      await checkKorea("statements", { symbol: "XKRX:005930", statement, period_type, periods: 2 }, FILERS);
    }
  });

  test("filings, and a section of the annual and the quarterly report they list (OpenDART)", async () => {
    const run = await checkKorea(
      "filings",
      { symbol: "XKRX:005930", forms: ["10-K", "10-Q"], limit: 4 },
      FILERS,
    );
    const listed = (run.payload as { filings: { accession: string }[] }).filings.map((one) => one.accession);
    expect(listed).toContain(QUARTERLY);
    await checkKorea(
      "filing_section",
      { symbol: "XKRX:005930", accession: ANNUAL, section: "business" },
      FILERS,
    );
    await checkKorea(
      "filing_section",
      { symbol: "XKRX:005930", accession: QUARTERLY, section: "financial_statements" },
      FILERS,
    );
  });

  test("ownership: the insider reports (OpenDART)", async () => {
    await checkKorea("ownership", { symbol: "XKRX:005930", limit: 5 }, FILERS);
  });

  test("quote and daily prices from the FSC when Yahoo fails", async () => {
    const quote = await checkKorea("quote", { symbols: ["XKRX:005930"] }, "FSC, after Yahoo failed");
    expect(quote.provenance).toMatchObject({ source: "FSC", after: ["Yahoo"] });
    const daily = await checkKorea(
      "price_history",
      { symbol: "XKRX:005930", period: "1mo" },
      "FSC, after Yahoo failed",
    );
    expect(daily.provenance).toMatchObject({ source: "FSC", after: ["Yahoo"] });
  });

  test("macro_series: an ECOS series and a KOSIS series, by key", async () => {
    for (const series of ["kr.ecos.722y001.0101000", "kr.kosis.dt_1f02011.t10.e"]) {
      const run = await checkKorea("macro_series", { series }, "Public statistics");
      expect((run.payload as { key: string }).key).toBe(series);
    }
  });

  test("markets: the central banks' view with the Bank of Korea's base rate", async () => {
    const run = await checkKorea("markets", { view: "central_banks" }, "Market overview");
    const log = readLog();
    expectKeys(JSON.parse(JSON.stringify(run.payload)), VIEW_KEYS.central_banks, log);
    expect(log.missing()).toEqual([]);
    const rows = (run.payload as { rows: { bank: string; key: string }[] }).rows;
    expect(rows.at(-1)).toMatchObject({ bank: "Bank of Korea", key: "series:kr.ecos.722y001.0101000" });
  });

  test("news for Korean words, from Naver's news search and GDELT, and article on a Naver article", async () => {
    const run = await checkKorea("news", { query: KOREAN_WORDS }, "News search");
    const ids = (run.payload as { articles: { id: string }[] }).articles.map((article) => article.id);
    expect(ids.some((id) => id.startsWith("gd:"))).toBe(true);
    const naver = ids.find((id) => id.startsWith("nv:"));
    expect(naver).toBeDefined();
    await checkKorea("article", { id: naver }, "News search");
  });

  test("find_instrument: the company's Korean name, from OpenDART's company list", async () => {
    const run = await checkKorea("find_instrument", { query: "삼성전자" }, "Instrument search");
    const [first] = (run.payload as { matches: { key: string; tools: string[] }[] }).matches;
    expect(first?.key).toBe("XKRX:005930");
    expect(first?.tools).toEqual(expect.arrayContaining(["statements", "filings", "ownership"]));
  });

  test("every request was answered by a fixture, and no key was said", () => {
    expect(koreaFetch.unmatched).toEqual([]);
    const said = JSON.stringify(koreaRuns.map((run) => [run.text, run.summary, run.payload, run.provenance]));
    for (const secret of KOREA_SECRETS) expect(said).not.toContain(secret);
  });
});
