// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * How the instrument search fails, offline. Yahoo's search failing, limiting, refusing, answering at no
 * address or in a form it does not read, and SEC's ticker list refused or failing, each give the DataError
 * kind the router acts on when nothing was found (an outage never answered as no match), and leave the other
 * sources' matches standing when something was; Yahoo refusing the words themselves (HTTP 400) finds nothing.
 * A cancelled search ends with the caller's reason. Yahoo's answer to one search is kept and shared; an answer
 * holding as many matches as asked is asked again for more. Rows of
 * Yahoo's answer no tool here takes are left out, and what each match is served with follows its source (a
 * fund is no filer of statements; a pair the ECB does not set has no price history). Every answer is a
 * fixture or written inline in the source's documented form.
 */
import { describe, expect, test } from "bun:test";
import type { InstrumentMatch } from "../../../src/data/capabilities.js";
import { DataError } from "../../../src/data/errors.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import { instrumentsProvider } from "../../../src/fork/data/providers/instruments.js";
import { SEC_TICKERS_URL } from "../../../src/fork/data/sources/sec-tickers.js";
import { buildTools, type FixtureRoute, testDeps } from "./harness.js";

// Fixture routes --------------------------------------------------------------------------------------------

const SEC = { secUserAgent: "Test Agent test@example.com" } satisfies PublicDataConfig;
const SEC_LIST: FixtureRoute = { match: SEC_TICKERS_URL, file: "sec/company-tickers-exchange.json" };
const JSON_TYPE = { "content-type": "application/json;charset=utf-8" };

/** Yahoo's answer to its search for `q` (any search unless given): a fixture, or a body written inline. */
function yahooSearch(
  q: string | undefined,
  answer: { file?: string; body?: string; status?: number; headers?: Record<string, string> },
): FixtureRoute {
  return {
    match: (url) =>
      url.pathname === "/v1/finance/search" && (q === undefined || url.searchParams.get("q") === q),
    ...(answer.file ? { file: answer.file } : {}),
    ...(answer.body !== undefined ? { body: answer.body, headers: answer.headers ?? JSON_TYPE } : {}),
    ...(answer.status ? { status: answer.status } : {}),
  };
}

/** Yahoo's search answer with these quote rows (the library's SearchResult, newsCount 0). */
function searchAnswer(quotes: unknown[]): string {
  return JSON.stringify({
    explains: [],
    count: quotes.length,
    quotes,
    news: [],
    nav: [],
    lists: [],
    researchReports: [],
    totalTime: 18,
    timeTakenForQuotes: 400,
    timeTakenForNews: 0,
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

/** One of Yahoo's quote rows. */
function row(symbol: string, exchange: string, quoteType: string, longname: string): Record<string, unknown> {
  return {
    exchange,
    shortname: longname,
    quoteType,
    symbol,
    index: "quotes",
    score: 20000,
    typeDisp: quoteType,
    longname,
    exchDisp: exchange,
    isYahooFinance: true,
  };
}

/** Yahoo's error body for a search it refuses, as its query hosts answer it. */
const REFUSED = JSON.stringify({
  finance: { result: null, error: { code: "Bad Request", description: "Invalid Search Query" } },
});

/** The instrument search alone over `routes`, its find_instrument tool, and what it asked. */
function instruments(config: PublicDataConfig, routes: readonly FixtureRoute[]) {
  const { deps, fetch, clock } = testDeps(config, routes);
  const provider = instrumentsProvider(deps);
  const search = provider.capabilities.instruments?.search as (
    query: string,
    kind: string | undefined,
    call?: { signal?: AbortSignal },
  ) => Promise<InstrumentMatch[]>;
  return { ...buildTools({ instruments: provider }, { clock, check: true }), search, fetch };
}

/** The DataError a search rejects with. */
async function failure(promise: Promise<unknown>): Promise<DataError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error("it answered");
}

/** The requests made: Yahoo's searches by what they asked, and SEC's ticker list. */
function asked(fetch: { requests: { url: string }[] }): string[] {
  return fetch.requests.map(({ url }) =>
    url === SEC_TICKERS_URL ? "sec tickers" : `yahoo search q=${new URL(url).searchParams.get("q")}`,
  );
}

// The tests -------------------------------------------------------------------------------------------------

describe("Yahoo failing, with nothing else found: the failure is the answer", () => {
  test("HTTP 500: unavailable, naming Yahoo; the tool says it is not a fact about the market", async () => {
    const { search, runTool } = instruments({}, [
      yahooSearch("Apple", { body: "Internal error", status: 500 }),
    ]);
    const error = await failure(search("Apple", undefined));
    expect([error.kind, error.details.source, error.details.status]).toEqual(["unavailable", "Yahoo", 500]);
    const run = await runTool("find_instrument", { query: "Apple" });
    expect(run.failure).toBe("data_unavailable");
    expect(run.text).toContain(
      "Yahoo could not be reached or answered unreadably; this is not a fact about the market",
    );
  });

  test("HTTP 429: rate_limited; 401 and 403: rejected; 404: unavailable, Yahoo's search not at its address", async () => {
    const cases: [number, string, string][] = [
      [429, "rate_limited", "Yahoo is limiting requests (HTTP 429)."],
      [401, "rejected", "Yahoo refused the request (HTTP 401)."],
      [403, "rejected", "Yahoo refused the request (HTTP 403)."],
      [404, "unavailable", "Yahoo's search is not at its address (HTTP 404)."],
    ];
    for (const [status, kind, said] of cases) {
      const { search } = instruments({}, [yahooSearch("Apple", { body: "{}", status })]);
      const error = await failure(search("Apple", undefined));
      expect([error.kind, error.message], String(status)).toEqual([kind, said]);
    }
  });

  test("an answer it does not read: JSON without Yahoo's list of quotes, or a page that is not JSON", async () => {
    const unread = [
      yahooSearch("Apple", { body: JSON.stringify({ explains: [], count: 0 }) }),
      yahooSearch("Apple", {
        body: "<html>Will be right back</html>",
        headers: { "content-type": "text/html" },
      }),
    ];
    const kinds: string[] = [];
    for (const route of unread) {
      const { search } = instruments({}, [route]);
      kinds.push((await failure(search("Apple", undefined))).kind);
    }
    expect(kinds).toEqual(["unavailable", "unavailable"]);
    const { search } = instruments({}, [unread[0] as FixtureRoute]);
    expect((await failure(search("Apple", undefined))).message).toBe(
      "Yahoo answered its search in a form this app does not read.",
    );
  });

  test("Yahoo refusing the words themselves (HTTP 400, Invalid Search Query) finds nothing: no match, not a failure", async () => {
    const { runTool, search } = instruments({}, [
      yahooSearch("Apple", { body: REFUSED, status: 400, headers: JSON_TYPE }),
    ]);
    expect(await search("Apple", undefined)).toEqual([]);
    const run = await runTool("find_instrument", { query: "Apple" });
    expect(run.failure).toBeUndefined();
    expect(run.text).toEndWith('No instrument matched "Apple".');
  });
});

describe("Yahoo's search answering as many matches as asked", () => {
  /** Yahoo's answer to its search for "Acme" asking `count` matches: `rows` listings of invented companies. */
  const acme = (count: number, rows: number, status = 200): FixtureRoute => ({
    match: (url) =>
      url.pathname === "/v1/finance/search" &&
      url.searchParams.get("q") === "Acme" &&
      url.searchParams.get("quotesCount") === String(count),
    body:
      status === 200
        ? searchAnswer(
            Array.from({ length: rows }, (_, index) =>
              row(`ACM${index + 1}`, "NMS", "EQUITY", `Acme Holdings ${index + 1} Inc.`),
            ),
          )
        : "",
    headers: JSON_TYPE,
    status,
  });
  const counts = (fetch: { requests: { url: string }[] }) =>
    fetch.requests.map(({ url }) => new URL(url).searchParams.get("quotesCount"));

  test("a full answer is asked again for ten times as many, until Yahoo answers fewer than asked", async () => {
    const { search, fetch } = instruments({}, [acme(100, 100), acme(1000, 120)]);
    expect(await search("Acme", undefined)).toHaveLength(120);
    expect(counts(fetch)).toEqual(["100", "1000"]);
  });

  test("Yahoo answering no more than its first answer to the larger request: that answer, two requests", async () => {
    const { search, fetch } = instruments({}, [acme(100, 100), acme(1000, 100)]);
    expect(await search("Acme", undefined)).toHaveLength(100);
    expect(counts(fetch)).toEqual(["100", "1000"]);
  });

  test("the larger request failing: the full answer already read stands", async () => {
    const { search, fetch } = instruments({}, [acme(100, 100), acme(1000, 0, 500)]);
    expect(await search("Acme", undefined)).toHaveLength(100);
    expect(counts(fetch)).toEqual(["100", "1000"]);
  });
});

describe("a source failing while another finds the instrument: what was found stands", () => {
  test("Yahoo failing, the catalogs naming gold: the catalogs' matches", async () => {
    const { search } = instruments({}, [yahooSearch("gold", { body: "", status: 503 })]);
    expect((await search("gold", undefined)).map((match) => match.key)).toEqual([
      "future:XCEC:GC",
      "series:us.volatility.gold",
    ]);
  });

  test("Yahoo failing, SEC's list naming the company: SEC's match, its name as SEC writes it", async () => {
    const { search } = instruments(SEC, [SEC_LIST, yahooSearch("Apple", { body: "", status: 500 })]);
    expect(await search("Apple", undefined)).toEqual([
      {
        key: "AAPL",
        name: "Apple Inc.",
        type: "security",
        listing_state: "listed",
        serves: [
          "quotes",
          "priceHistory",
          "technicals",
          "profiles",
          "statements",
          "filings",
          "ownership",
          "corporateActions",
          "news",
        ],
      },
    ]);
  });

  test("SEC's list failing, Yahoo naming the listing: Yahoo's match, SEC's capabilities still named for a US listing", async () => {
    const { search, fetch } = instruments(SEC, [
      { match: SEC_TICKERS_URL, body: "unavailable", status: 500 },
      yahooSearch("AAPL", { file: "instruments/yahoo-search-aapl.json" }),
    ]);
    const [first] = await search("AAPL", undefined);
    expect(first?.key).toBe("AAPL");
    // SEC's list could not be read, so whether it holds the ticker is not known: SEC is asked when a tool
    // needs it.
    expect(first?.serves).toContain("statements");
    expect(first?.serves).toContain("filings");
    // One request to SEC and one retry of it (http.ts), and Yahoo's search.
    expect(asked(fetch).sort()).toEqual(["sec tickers", "sec tickers", "yahoo search q=AAPL"]);
  });

  test("SEC's list refused and Yahoo failing: both failures, every source named", async () => {
    const { search, runTool } = instruments(SEC, [
      {
        match: SEC_TICKERS_URL,
        body: "Your request has been identified as part of a network of automated tools",
        status: 403,
      },
      yahooSearch("Apple", { body: "", status: 500 }),
    ]);
    const error = await failure(search("Apple", undefined));
    expect(error.kind).toBe("unavailable");
    expect(error.details.source).toBe("SEC EDGAR and Yahoo");
    expect(error.details.code).toBe("every_source_failed");
    expect(error.message).toStartWith("SEC EDGAR refused the key (");
    expect(error.message).toContain("; Yahoo could not be reached (Yahoo answered HTTP 500.)");
    const run = await runTool("find_instrument", { query: "Apple" });
    expect(run.failure).toBe("data_unavailable");
    expect(run.text).toEndWith("None of this is a fact about the market.");
  });
});

describe("cancelling, keeping, and what is left out", () => {
  test("a cancelled search ends with the caller's own reason", async () => {
    const { search } = instruments(SEC, [
      SEC_LIST,
      yahooSearch("Apple", { file: "instruments/yahoo-search-apple.json" }),
    ]);
    const controller = new AbortController();
    const reason = new Error("the turn was cancelled");
    controller.abort(reason);
    expect(
      await search("Apple", undefined, { signal: controller.signal }).catch((error: unknown) => error),
    ).toBe(reason);
  });

  test("Yahoo's answer to one search is kept and shared: again, in other letter cases, and from calls made together", async () => {
    const { search, fetch } = instruments({}, [
      yahooSearch(undefined, { file: "instruments/yahoo-search-apple.json" }),
    ]);
    const together = await Promise.all([search("Apple", undefined), search("Apple", undefined)]);
    expect(together[0]).toEqual(together[1]);
    await search("apple", undefined);
    await search("APPLE", "security");
    expect(asked(fetch)).toEqual(["yahoo search q=Apple"]);
  });

  test("rows no tool here takes are left out: a venue listings.ts does not read, an exchange not the venue's, OTC, options, an index outside the catalog, a contract month, a Crunchbase entry", async () => {
    const { search } = instruments({}, [
      yahooSearch("vodafone", {
        body: searchAnswer([
          row("VOD.L", "LSE", "EQUITY", "Vodafone Group Public Limited Company"),
          row("VOD", "NMS", "EQUITY", "Vodafone Group Public Limited Company"),
          row("VOD.MX", "MEX", "EQUITY", "Vodafone Group Public Limited Company"),
          row("VODI.L", "IOB", "EQUITY", "Vodafone Group Public Limited Company"),
          row("VDFNF", "PNK", "EQUITY", "Vodafone Group Public Limited Company"),
          row("VOD261218C00010000", "OPR", "OPTION", "VOD Dec 2026 10.000 call"),
          row("^FTAS", "FGI", "INDEX", "FTSE All-Share"),
          row("NGZ26.NYM", "NYM", "FUTURE", "Natural Gas Dec 26"),
          { index: "4c47a1fcd2a8", name: "Vodafone", permalink: "vodafone", isYahooFinance: false },
        ]),
      }),
    ]);
    expect((await search("vodafone", undefined)).map((match) => [match.key, match.type])).toEqual([
      ["XLON:VOD", "stock"],
      ["VOD", "stock"],
    ]);
  });

  test("what each match is served with follows its source: a fund is no filer of statements, a pair the ECB does not set has no price history", async () => {
    const { search } = instruments(SEC, [
      {
        match: SEC_TICKERS_URL,
        body: JSON.stringify({
          fields: ["cik", "name", "ticker", "exchange"],
          data: [[1222333, "SPDR GOLD TRUST", "GLD", "NYSE"]],
        }),
        headers: { "content-type": "application/json" },
      },
      yahooSearch("gold", {
        body: searchAnswer([
          row("GLD", "PCX", "ETF", "SPDR Gold Shares"),
          row("XAUUSD=X", "CCY", "CURRENCY", "XAU/USD"),
        ]),
      }),
    ]);
    const matches = await search("gold", undefined);
    const served = Object.fromEntries(matches.map((match) => [match.key, match.serves]));
    // SEC's list holds the trust: its filings, but no statements (Yahoo says it is an ETF).
    expect(served.GLD).toEqual([
      "quotes",
      "priceHistory",
      "technicals",
      "profiles",
      "filings",
      "ownership",
      "corporateActions",
      "news",
    ]);
    // Gold against the dollar: quoted by Yahoo; the ECB sets no reference rate for gold.
    expect(served["fx:XAUUSD"]).toEqual(["quotes", "technicals", "news"]);
    expect(matches.find((match) => match.key === "fx:XAUUSD")?.name).toBe("XAU/USD");
  });

  test("a search of no letter or digit asks nothing and finds nothing", async () => {
    const { search, fetch } = instruments(SEC, [SEC_LIST]);
    expect(await search("&/", undefined)).toEqual([]);
    expect(fetch.requests).toEqual([]);
  });
});
