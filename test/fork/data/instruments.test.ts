// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The instrument search (src/fork/data/providers/instruments.ts) through the real find_instrument tool, the
 * router and the ToolRegistry, on the fork's providers as a setup builds them: SEC's ticker list (the shared
 * hand-made fixture, test/fork/fixtures/sec/company-tickers-exchange.json), Yahoo's search answers (hand-made
 * in yahoo-finance2's schema, test/fork/fixtures/instruments) and the catalogs. Each text the model reads is
 * compared whole (golden) and the read check shows every field the tool reads was supplied: a US ticker, a
 * company's name, a Korean code in each form and a Korean company's name, names in Hangul, futures, a
 * currency pair, crypto, an index and economic series by name, typed keys, one kind at a time, with
 * SEC_USER_AGENT and without it; then keys it hands out answered by quote. No request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadCases, recordOne, yahooAnswerer } from "../../../scripts/fork/record-fixtures.js";
import type { DataProvider } from "../../../src/data/capabilities.js";
import { DataError } from "../../../src/data/errors.js";
import { isInstrumentKey } from "../../../src/data/instrument-key.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import { canonicalKey } from "../../../src/fork/data/listings.js";
import { instrumentsProvider } from "../../../src/fork/data/providers/instruments.js";
import { SEC_TICKERS_URL } from "../../../src/fork/data/sources/sec-tickers.js";
import {
  buildTools,
  FIXTURES,
  type FixtureFetch,
  type FixtureRoute,
  fixture,
  fixtureFetch,
  fixtureMeta,
  type ToolRun,
  testDeps,
  testProviders,
  YAHOO_AAPL,
} from "./harness.js";

// Fixture routes --------------------------------------------------------------------------------------------

const SEC = { secUserAgent: "Test Agent test@example.com" } satisfies PublicDataConfig;

/** Yahoo's search for `q`, answered by the fixture `instruments/yahoo-search-<name>.json`. */
function yahooSearch(q: string, name: string): FixtureRoute {
  return {
    match: (url) => url.pathname === "/v1/finance/search" && url.searchParams.get("q") === q,
    file: `instruments/yahoo-search-${name}.json`,
  };
}

/** Yahoo's search answer listing nothing, for `q`. */
function nothingFor(q: string): FixtureRoute {
  return {
    match: (url) => url.pathname === "/v1/finance/search" && url.searchParams.get("q") === q,
    body: JSON.stringify({
      explains: [],
      count: 0,
      quotes: [],
      news: [],
      nav: [],
      lists: [],
      researchReports: [],
      totalTime: 12,
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
    }),
    headers: { "content-type": "application/json;charset=utf-8" },
  };
}

const ROUTES: readonly FixtureRoute[] = [
  { match: SEC_TICKERS_URL, file: "sec/company-tickers-exchange.json" },
  yahooSearch("AAPL", "aapl"),
  yahooSearch("Apple", "apple"),
  yahooSearch("Berkshire Hathaway", "berkshire-hathaway"),
  yahooSearch("Samsung Electronics", "samsung-electronics"),
  yahooSearch("005930", "005930"),
  yahooSearch("005930.KS", "005930-ks"),
  yahooSearch("gold", "gold"),
  yahooSearch("crude oil", "crude-oil"),
  yahooSearch("S&P 500", "s-and-p-500"),
  yahooSearch("euro dollar", "euro-dollar"),
  yahooSearch("bitcoin", "bitcoin"),
  yahooSearch("CPI", "cpi"),
  yahooSearch("10-year Treasury yield", "10-year-treasury-yield"),
  nothingFor("Bank of America"),
];

/** The fork's providers for `config` over `routes` (before these tests' own), and the tools, read checked. */
function setup(config: PublicDataConfig = {}, routes: readonly FixtureRoute[] = []) {
  const { providers, fetch, clock } = testProviders(config, [...routes, ...ROUTES]);
  return { ...buildTools(providers, { clock, check: true }), providers, fetch };
}

/** The requests made: Yahoo's searches by what they asked, SEC's ticker list, Yahoo's quotes by symbol. */
function asked(fetch: FixtureFetch): string[] {
  return fetch.requests.map(({ url }) => {
    const address = new URL(url);
    if (address.pathname === "/v1/finance/search") {
      const params = address.searchParams;
      return `yahoo search q=${params.get("q")} quotesCount=${params.get("quotesCount")} newsCount=${params.get("newsCount")}`;
    }
    if (url === SEC_TICKERS_URL) return "sec tickers";
    if (address.pathname === "/v7/finance/quote") return `yahoo quote ${address.searchParams.get("symbols")}`;
    return `${address.hostname}${address.pathname}`;
  });
}

/** One find_instrument call that answered, every field the tool read supplied. */
async function found(
  runTool: (name: string, input: Record<string, unknown>) => Promise<ToolRun>,
  input: Record<string, unknown>,
): Promise<ToolRun> {
  const run = await runTool("find_instrument", input);
  expect(run.failure, run.text).toBeUndefined();
  expect(run.source).toBe("Instrument search");
  expect(run.reads.missing()).toEqual([]);
  return run;
}

/** What a name in Hangul is answered with when DART_API_KEY is not set. */
const DART_NEEDED = `Finding Korean companies by their Korean names needs DART_API_KEY (a free key from OpenDART, https://opendart.fss.or.kr/), set in the environment or under "data" in credentials.json.`;

/** The keys of a find_instrument payload, best first. */
function keysOf(run: ToolRun): string[] {
  return (run.payload as { matches: { key: string }[] }).matches.map((match) => match.key);
}

/** The text the model reads, compared whole with the golden one. */
function golden(name: string, text: string): void {
  expect(GOLDEN[name]).toBeDefined();
  expect(text).toBe(GOLDEN[name] as string);
}

// The tests -------------------------------------------------------------------------------------------------

describe("what the instrument search declares", () => {
  test("instruments.search in every setup, with SEC_USER_AGENT or without it, built without a request", () => {
    for (const config of [{}, SEC, { fredKey: "fred-0123456789" }]) {
      const { providers, fetch, available } = setup(config);
      const instruments = providers.instruments as DataProvider;
      expect(instruments.name).toBe("Instrument search");
      expect(
        Object.fromEntries(
          Object.entries(instruments.capabilities).map(([name, methods]) => [
            name,
            Object.keys(methods ?? {}).sort(),
          ]),
        ),
      ).toEqual({ instruments: ["search"] });
      expect(available.has("instruments")).toBe(true);
      expect(fetch.requests).toEqual([]);
    }
  });
});

describe("a US listing by its ticker, a company by its name", () => {
  test("AAPL with SEC_USER_AGENT: SEC's ticker list and Yahoo's search; the filer's statements and filings too", async () => {
    const { runTool, fetch } = setup(SEC);
    const run = await found(runTool, { query: "AAPL" });
    golden("aapl-sec", run.text);
    expect(run.summary).toBe("3 instruments");
    // The tool reads each match's key, name, type, listing state and capabilities.
    expect(run.reads.paths()).toEqual([
      "[]",
      "[].key",
      "[].listing_state",
      "[].name",
      "[].serves",
      "[].serves[]",
      "[].type",
    ]);
    expect(asked(fetch)).toEqual(["yahoo search q=AAPL quotesCount=100 newsCount=0", "sec tickers"]);
    expect(fetch.unmatched).toEqual([]);
  });

  test("AAPL without SEC_USER_AGENT: Yahoo's search alone, and nothing SEC serves", async () => {
    const { runTool, fetch } = setup();
    const run = await found(runTool, { query: "AAPL" });
    golden("aapl", run.text);
    expect(asked(fetch)).toEqual(["yahoo search q=AAPL quotesCount=100 newsCount=0"]);
  });

  test("Apple, a company's name: both of its listings first, then the others Yahoo finds", async () => {
    const { runTool } = setup(SEC);
    golden("apple-sec", (await found(runTool, { query: "Apple" })).text);
  });

  test("Berkshire Hathaway: both share classes SEC lists, then its listing on Xetra", async () => {
    const { runTool } = setup(SEC);
    golden("berkshire-sec", (await found(runTool, { query: "Berkshire Hathaway" })).text);
    // Without SEC_USER_AGENT the same listings, from Yahoo, without statements and filings.
    const { runTool: keyless } = setup();
    golden("berkshire", (await found(keyless, { query: "Berkshire Hathaway" })).text);
  });

  test("Bank of America from SEC's list when Yahoo finds nothing: a ticker SEC lists over the counter is SEC's alone", async () => {
    const { runTool } = setup(SEC);
    golden("bank-of-america-sec", (await found(runTool, { query: "Bank of America" })).text);
  });
});

describe("Korean listings", () => {
  test("a code alone, the canonical key and Yahoo's spelling: Yahoo asked by the code or by its symbol, once each", async () => {
    const { runTool, fetch } = setup(SEC);
    golden("005930", (await found(runTool, { query: "005930" })).text);
    golden("xkrx-005930", (await found(runTool, { query: "XKRX:005930" })).text);
    golden("005930-ks", (await found(runTool, { query: "005930.KS" })).text);
    // XKRX:005930 and 005930.KS are both asked as 005930.KS: the second is the kept answer. SEC holds no
    // Korean listing, so its list is not read.
    expect(asked(fetch)).toEqual([
      "yahoo search q=005930 quotesCount=100 newsCount=0",
      "yahoo search q=005930.KS quotesCount=100 newsCount=0",
    ]);
  });

  test("a Korean company's name in English, through Yahoo's search", async () => {
    const { runTool } = setup(SEC);
    golden("samsung-electronics", (await found(runTool, { query: "Samsung Electronics" })).text);
  });

  test("names in Hangul: the catalogs' Korean names, and nothing asked of Yahoo or SEC", async () => {
    const { runTool, fetch } = setup(SEC);
    golden("kospi-hangul", (await found(runTool, { query: "코스피" })).text);
    golden("won-dollar-hangul", (await found(runTool, { query: "원달러" })).text);
    golden("bitcoin-hangul", (await found(runTool, { query: "비트코인" })).text);
    // A company's name in Hangul: no catalog holds it, Yahoo is not asked in Hangul, and only OpenDART's company
    // list reads Korean names: the answer is what to set.
    const run = await runTool("find_instrument", { query: "삼성전자" });
    expect(run.failure).toBe("data_not_configured");
    expect(run.text).toBe(DART_NEEDED);
    expect(fetch.requests).toEqual([]);
  });

  test("a Korean series named exactly without its source's key says which key; other words find no match", async () => {
    const { runTool, fetch } = setup(SEC);
    for (const [query, needs, kind] of [
      ["기준금리", "ECOS_API_KEY", undefined],
      // Asked for series only, so neither Yahoo nor SEC is asked for the Latin words.
      ["Korea CPI", "ECOS_API_KEY", "series"],
      ["반도체 생산지수", "KOSIS_API_KEY", undefined],
    ] as const) {
      const run = await runTool("find_instrument", { query, ...(kind ? { kind } : {}) });
      expect(run.failure, query).toBe("data_not_configured");
      expect(run.text, query).toContain(`needs ${needs}`);
    }
    // Asked for series only, a name in Hangul that names none is no match; asked for securities, what to set.
    const series = await found(runTool, { query: "삼성전자", kind: "series" });
    expect(series.summary).toBe("0 instruments");
    const securities = await runTool("find_instrument", { query: "삼성전자", kind: "security" });
    expect(securities.text).toBe(DART_NEEDED);
    expect(fetch.requests).toEqual([]);
  });
});

describe("instruments the catalogs name", () => {
  test("gold: the futures front month by its name first, then what else holds the word and Yahoo's other matches", async () => {
    const { runTool } = setup(SEC);
    golden("gold", (await found(runTool, { query: "gold" })).text);
  });

  test("crude oil: WTI by its name, Brent and the oil volatility index holding both words, Yahoo's fund", async () => {
    const { runTool } = setup(SEC);
    golden("crude-oil", (await found(runTool, { query: "crude oil" })).text);
  });

  test("S&P 500: the index by its name, the E-mini front month holding both words, Yahoo's ETFs", async () => {
    const { runTool } = setup(SEC);
    golden("s-and-p-500", (await found(runTool, { query: "S&P 500" })).text);
  });

  test("euro dollar: the pair as markets quote it, with the ECB's reference rates for price history", async () => {
    const { runTool } = setup(SEC);
    golden("euro-dollar", (await found(runTool, { query: "euro dollar" })).text);
  });

  test("bitcoin: its pair against the dollar by the coin's name, then Yahoo's other matches", async () => {
    const { runTool } = setup(SEC);
    golden("bitcoin", (await found(runTool, { query: "bitcoin" })).text);
  });

  test("economic series by the names the skills ask for, first, under keys macro_series takes as they are", async () => {
    const { runTool } = setup(SEC);
    const cpi = await found(runTool, { query: "CPI" });
    golden("cpi", cpi.text);
    const tenYear = await found(runTool, { query: "10-year Treasury yield" });
    golden("10-year-treasury-yield", tenYear.text);
    // macro_series reads a key in this form without searching (src/tools/macro.ts).
    for (const run of [cpi, tenYear]) {
      const [first] = (run.payload as { matches: { key: string; name: string; tools: string[] }[] }).matches;
      expect(first?.key).toMatch(/^(series:)?[a-z0-9_]+(\.[a-z0-9_]+)+$/);
      expect(first?.tools).toEqual(["macro_series"]);
    }
    expect(keysOf(cpi)[0]).toBe("series:us.fred.cpiaucsl");
    expect(keysOf(tenYear)[0]).toBe("series:us.treasury.par_10y");
  });

  test("the tool's own examples, best first: gold, crude oil, S&P 500, euro dollar, bitcoin, CPI", async () => {
    const { runTool } = setup(SEC);
    const first: string[] = [];
    for (const query of ["gold", "crude oil", "S&P 500", "euro dollar", "bitcoin", "CPI"]) {
      first.push(keysOf(await found(runTool, { query }))[0] as string);
    }
    expect(first).toEqual([
      "future:XCEC:GC",
      "future:XNYM:CL",
      "series:us.equity_index.sp500",
      "fx:EURUSD",
      "crypto:BTC-USD",
      "series:us.fred.cpiaucsl",
    ]);
  });

  test("typed keys the catalogs resolve are answered without a request; crypto:BTC-USDT is read as BTC-USD", async () => {
    const { runTool, fetch } = setup(SEC);
    golden("future-key", (await found(runTool, { query: "future:XNYM:CL" })).text);
    golden("fx-key", (await found(runTool, { query: "fx:USDKRW" })).text);
    golden("series-key", (await found(runTool, { query: "series:kr.equity_index.kospi" })).text);
    golden("value-series-key", (await found(runTool, { query: "series:us.fred.unrate" })).text);
    golden("crypto-usdt-key", (await found(runTool, { query: "crypto:BTC-USDT" })).text);
    // A price series key the catalog does not hold names nothing (the price tools refuse it too).
    golden("unknown-series-key", (await found(runTool, { query: "series:us.equity_index.kospi" })).text);
    expect(fetch.requests).toEqual([]);
  });

  test("Yahoo's symbols for catalog instruments name them, after any listing with the same letters", async () => {
    const { runTool } = setup(SEC, [nothingFor("^GSPC"), nothingFor("CL=F"), nothingFor("EURUSD=X")]);
    const keys: string[][] = [];
    for (const query of ["^GSPC", "CL=F", "EURUSD=X"]) keys.push(keysOf(await found(runTool, { query })));
    expect(keys).toEqual([["series:us.equity_index.sp500"], ["future:XNYM:CL"], ["fx:EURUSD"]]);
  });
});

describe("one kind at a time", () => {
  test("gold among futures: the catalog's front month, then Yahoo's", async () => {
    const { runTool } = setup(SEC);
    golden("gold-future", (await found(runTool, { query: "gold", kind: "future" })).text);
  });

  test("gold among securities: Yahoo's ETFs; SEC's list holds no company with the word here", async () => {
    const { runTool, fetch } = setup(SEC);
    golden("gold-security", (await found(runTool, { query: "gold", kind: "security" })).text);
    expect(asked(fetch)).toEqual(["yahoo search q=gold quotesCount=100 newsCount=0", "sec tickers"]);
  });

  test("gold among series: the catalogs alone, nothing asked", async () => {
    const { runTool, fetch } = setup(SEC);
    golden("gold-series", (await found(runTool, { query: "gold", kind: "series" })).text);
    expect(fetch.requests).toEqual([]);
  });

  test("a kind the tools do not name is invalid", async () => {
    const { deps } = testDeps(SEC, ROUTES);
    const search = instrumentsProvider(deps).capabilities.instruments?.search as (
      query: string,
      kind: string | undefined,
    ) => Promise<unknown>;
    const error = await search("gold", "bond").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(DataError);
    expect((error as DataError).kind).toBe("invalid");
    expect((error as DataError).message).toBe("kind bond is not one of security, future, fx, crypto, series");
  });
});

describe("the keys it hands out", () => {
  test("every key is the canonical key of a listing or instrument the tools take", async () => {
    const { runTool } = setup(SEC);
    const keys = new Set<string>();
    for (const query of [
      "AAPL",
      "Apple",
      "Berkshire Hathaway",
      "Samsung Electronics",
      "gold",
      "crude oil",
      "S&P 500",
      "euro dollar",
      "bitcoin",
      "CPI",
      "10-year Treasury yield",
      "코스피",
      "원달러",
    ]) {
      for (const key of keysOf(await found(runTool, { query }))) keys.add(key);
    }
    for (const key of keys) {
      expect(isInstrumentKey(key), key).toBe(true);
      expect(canonicalKey(key), key).toBe(key);
    }
  });

  test("keys it hands out are answered by quote: a Korean listing, a futures front month, an index", async () => {
    const quote = (symbol: string, file: string): FixtureRoute => ({
      match: (url) => url.pathname === "/v7/finance/quote" && url.searchParams.get("symbols") === symbol,
      file,
    });
    const { runTool, fetch } = setup(SEC, [
      quote("005930.KS", "yahoo/quote-005930-ks.json"),
      quote("CL=F", "yahoo/quote-cl-f.json"),
      quote("^GSPC", "yahoo/quote-gspc.json"),
      ...YAHOO_AAPL,
    ]);
    for (const [query, wanted] of [
      ["Samsung Electronics", "XKRX:005930"],
      ["crude oil", "future:XNYM:CL"],
      ["S&P 500", "series:us.equity_index.sp500"],
    ] as const) {
      const key = keysOf(await found(runTool, { query }))[0] as string;
      expect(key).toBe(wanted);
      const answer = await runTool("quote", { symbols: [key] });
      expect(answer.failure, answer.text).toBeUndefined();
      expect(answer.source).toBe("Yahoo");
      // The quote names the instrument by the key asked (the tool writes it as one line: name, key, venue).
      const [quoted] = (answer.payload as { quotes: { symbol: string; instrument: string }[] }).quotes;
      expect(quoted?.symbol).toBe(key);
      expect(quoted?.instrument).toContain(`(${key}`);
    }
    expect(fetch.unmatched).toEqual([]);
  });
});

describe("the recorder's cases (scripts/fork/fixture-cases/instruments.ts)", () => {
  test("one case for each fixture, each asking Yahoo exactly as the instrument search asks, recorded offline", async () => {
    const cases = (await loadCases()).filter((one) => one.source === "instruments");
    const files = readdirSync(join(FIXTURES, "instruments"))
      .filter((file) => file.endsWith(".json") && !file.endsWith(".meta.json"))
      .map((file) => file.replace(/\.json$/, ""))
      .sort();
    expect(cases.map((one) => one.name).sort()).toEqual(files);
    const { deps } = testDeps();
    for (const one of cases) {
      const file = `instruments/${one.name}.json`;
      const meta = fixtureMeta(file);
      // A search by its words, a quote by its symbols (with Yahoo's cookie and crumb, which a quote needs).
      const address = new URL(meta?.url ?? "");
      const asked = (url: URL) =>
        url.pathname === address.pathname &&
        ["q", "symbols"].every((name) => url.searchParams.get(name) === address.searchParams.get(name));
      // Yahoo's address answered by the fixture itself; nothing is sent anywhere.
      const yahooAnswer = yahooAnswerer(
        fixtureFetch([...YAHOO_AAPL.slice(0, 2), { match: (url) => asked(url), file }]),
      );
      const recorded = await recordOne(one, deps.http, { yahoo: deps.yahoo, yahooAnswer }, []);
      expect(recorded.file).toBe(`${one.name}.json`);
      expect(recorded.meta.url).toBe(meta?.url as string);
      expect(new TextDecoder().decode(recorded.body)).toBe(new TextDecoder().decode(fixture(file)));
    }
  });
});

// Golden texts ----------------------------------------------------------------------------------------------

const GOLDEN: Readonly<Record<string, string>> = {
  "aapl-sec": `[e1] find_instrument AAPL (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "AAPL", best match first:
- AAPL: Apple Inc. (stock); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions
- XETR:APC: Apple Inc. (stock); quote, price_history, technicals, profile, ownership, corporate_actions
- AAPU: Direxion Daily AAPL Bull 2X Shares (etf); quote, price_history, technicals, profile, ownership, corporate_actions`,
  aapl: `[e1] find_instrument AAPL (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "AAPL", best match first:
- AAPL: Apple Inc. (stock); quote, price_history, technicals, profile, ownership, corporate_actions
- XETR:APC: Apple Inc. (stock); quote, price_history, technicals, profile, ownership, corporate_actions
- AAPU: Direxion Daily AAPL Bull 2X Shares (etf); quote, price_history, technicals, profile, ownership, corporate_actions`,
  "apple-sec": `[e1] find_instrument Apple (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "Apple", best match first:
- AAPL: Apple Inc. (stock); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions
- XETR:APC: Apple Inc. (stock); quote, price_history, technicals, profile, ownership, corporate_actions
- APLE: Apple Hospitality REIT, Inc. (stock); quote, price_history, technicals, profile, ownership, corporate_actions
- AAPU: Direxion Daily AAPL Bull 2X Shares (etf); quote, price_history, technicals, profile, ownership, corporate_actions`,
  "berkshire-sec": `[e1] find_instrument Berkshire Hathaway (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "Berkshire Hathaway", best match first:
- BRK-B: Berkshire Hathaway Inc. (stock); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions
- BRK-A: Berkshire Hathaway Inc. (stock); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions
- XETR:BRYN: Berkshire Hathaway Inc. (stock); quote, price_history, technicals, profile, ownership, corporate_actions`,
  berkshire: `[e1] find_instrument Berkshire Hathaway (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "Berkshire Hathaway", best match first:
- BRK-B: Berkshire Hathaway Inc. (stock); quote, price_history, technicals, profile, ownership, corporate_actions
- BRK-A: Berkshire Hathaway Inc. (stock); quote, price_history, technicals, profile, ownership, corporate_actions
- XETR:BRYN: Berkshire Hathaway Inc. (stock); quote, price_history, technicals, profile, ownership, corporate_actions`,
  "bank-of-america-sec": `[e1] find_instrument Bank of America (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "Bank of America", best match first:
- BAC: BANK OF AMERICA CORP /DE/ (security); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions
- BAC-PB: BANK OF AMERICA CORP /DE/ (security); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions
- BACRP: BANK OF AMERICA CORP /DE/ (security); statements, filings, ownership`,
  "005930": `[e1] find_instrument 005930 (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "005930", best match first:
- XKRX:005930: Samsung Electronics Co., Ltd. (stock); quote, price_history, technicals, profile, ownership, corporate_actions`,
  "xkrx-005930": `[e2] find_instrument XKRX:005930 (reference its data as {"ref":"e2","path":"<field>"})
source: Instrument search
Instruments for "XKRX:005930", best match first:
- XKRX:005930: Samsung Electronics Co., Ltd. (stock); quote, price_history, technicals, profile, ownership, corporate_actions`,
  "005930-ks": `[e3] find_instrument 005930.KS (reference its data as {"ref":"e3","path":"<field>"})
source: Instrument search
Instruments for "005930.KS", best match first:
- XKRX:005930: Samsung Electronics Co., Ltd. (stock); quote, price_history, technicals, profile, ownership, corporate_actions`,
  "samsung-electronics": `[e1] find_instrument Samsung Electronics (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "Samsung Electronics", best match first:
- XKRX:005930: Samsung Electronics Co., Ltd. (stock); quote, price_history, technicals, profile, ownership, corporate_actions
- XKRX:005935: Samsung Electronics Co., Ltd. (stock); quote, price_history, technicals, profile, ownership, corporate_actions`,
  "kospi-hangul": `[e1] find_instrument 코스피 (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "코스피", best match first:
- series:kr.equity_index.kospi: KOSPI Composite (index); quote, price_history, technicals
- series:kr.equity_index.kospi200: KOSPI 200 (index); quote, price_history, technicals`,
  "won-dollar-hangul": `[e2] find_instrument 원달러 (reference its data as {"ref":"e2","path":"<field>"})
source: Instrument search
Instruments for "원달러", best match first:
- fx:USDKRW: US dollar / South Korean won (USD/KRW) (currency_pair); quote, price_history, technicals
- fx:KRWUSD: South Korean won / US dollar (KRW/USD) (currency_pair); quote, price_history, technicals`,
  "bitcoin-hangul": `[e3] find_instrument 비트코인 (reference its data as {"ref":"e3","path":"<field>"})
source: Instrument search
Instruments for "비트코인", best match first:
- crypto:BTC-USD: Bitcoin (BTC) in US dollars (crypto); quote, price_history, technicals`,
  gold: `[e1] find_instrument gold (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "gold", best match first:
- future:XCEC:GC: Gold futures, continuous front month (future); quote, price_history, technicals
- series:us.volatility.gold: Cboe Gold Volatility Index (GVZ) (index); quote, price_history, technicals
- GLD: SPDR Gold Shares (etf); quote, price_history, technicals, profile, ownership, corporate_actions
- IAU: iShares Gold Trust (etf); quote, price_history, technicals, profile, ownership, corporate_actions
- future:MGC: MGC futures, continuous front month (Micro Gold Futures,Feb-2027) (future); quote, price_history, technicals`,
  "crude-oil": `[e1] find_instrument crude oil (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "crude oil", best match first:
- future:XNYM:CL: WTI crude oil futures, continuous front month (future); quote, price_history, technicals
- future:XNYM:BZ: Brent crude oil futures, continuous front month (future); quote, price_history, technicals
- series:us.volatility.oil: Cboe Crude Oil Volatility Index (OVX) (index); quote, price_history, technicals
- USO: United States Oil Fund, LP (etf); quote, price_history, technicals, profile, ownership, corporate_actions`,
  "s-and-p-500": `[e1] find_instrument S&P 500 (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "S&P 500", best match first:
- series:us.equity_index.sp500: S&P 500 (index); quote, price_history, technicals
- future:XCME:ES: E-mini S&P 500 futures, continuous front month (future); quote, price_history, technicals
- SPY: SPDR S&P 500 ETF Trust (etf); quote, price_history, technicals, profile, ownership, corporate_actions
- VOO: Vanguard S&P 500 ETF (etf); quote, price_history, technicals, profile, ownership, corporate_actions`,
  "euro-dollar": `[e1] find_instrument euro dollar (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "euro dollar", best match first:
- fx:EURUSD: Euro / US dollar (EUR/USD) (currency_pair); quote, price_history, technicals
- future:6E: 6E futures, continuous front month (Euro FX Dec 26) (future); quote, price_history, technicals
- series:us.currency_index.dollar: US Dollar Index (DXY) (index); quote, price_history, technicals`,
  bitcoin: `[e1] find_instrument bitcoin (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "bitcoin", best match first:
- crypto:BTC-USD: Bitcoin (BTC) in US dollars (crypto); quote, price_history, technicals
- crypto:BCH-USD: Bitcoin Cash (BCH) in US dollars (crypto); quote, price_history, technicals
- IBIT: iShares Bitcoin Trust ETF (etf); quote, price_history, technicals, profile, ownership, corporate_actions
- future:BTC: BTC futures, continuous front month (Bitcoin Futures,Dec-2026) (future); quote, price_history, technicals
- crypto:BTC-EUR: Bitcoin EUR (crypto); quote, price_history, technicals`,
  cpi: `[e1] find_instrument CPI (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "CPI", best match first:
- series:us.fred.cpiaucsl: CPI (economic); macro_series
- series:us.fred.cpilfesl: core CPI (economic); macro_series
- PMTS: CPI Card Group Inc. (stock); quote, price_history, technicals, profile, ownership, corporate_actions`,
  "10-year-treasury-yield": `[e2] find_instrument 10-year Treasury yield (reference its data as {"ref":"e2","path":"<field>"})
source: Instrument search
Instruments for "10-year Treasury yield", best match first:
- series:us.treasury.par_10y: 10-year Treasury yield (economic); macro_series
- series:us.treasury.real_10y: 10-year real Treasury yield (economic); macro_series
- series:us.treasury.spread_10y_2y: 10-year minus 2-year Treasury spread (economic); macro_series
- series:us.treasury.spread_10y_3m: 10-year minus 3-month Treasury spread (economic); macro_series
- future:XCBT:ZN: 10-year U.S. Treasury note futures, continuous front month (future); quote, price_history, technicals
- IEF: iShares 7-10 Year Treasury Bond ETF (etf); quote, price_history, technicals, profile, ownership, corporate_actions`,
  "future-key": `[e1] find_instrument future:XNYM:CL (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "future:XNYM:CL", best match first:
- future:XNYM:CL: WTI crude oil futures, continuous front month (future); quote, price_history, technicals`,
  "fx-key": `[e2] find_instrument fx:USDKRW (reference its data as {"ref":"e2","path":"<field>"})
source: Instrument search
Instruments for "fx:USDKRW", best match first:
- fx:USDKRW: US dollar / South Korean won (USD/KRW) (currency_pair); quote, price_history, technicals`,
  "series-key": `[e3] find_instrument series:kr.equity_index.kospi (reference its data as {"ref":"e3","path":"<field>"})
source: Instrument search
Instruments for "series:kr.equity_index.kospi", best match first:
- series:kr.equity_index.kospi: KOSPI Composite (index); quote, price_history, technicals`,
  "value-series-key": `[e4] find_instrument series:us.fred.unrate (reference its data as {"ref":"e4","path":"<field>"})
source: Instrument search
Instruments for "series:us.fred.unrate", best match first:
- series:us.fred.unrate: unemployment rate (economic); macro_series`,
  "crypto-usdt-key": `[e5] find_instrument crypto:BTC-USDT (reference its data as {"ref":"e5","path":"<field>"})
source: Instrument search
Instruments for "crypto:BTC-USDT", best match first:
- crypto:BTC-USD: Bitcoin (BTC) in US dollars; crypto:BTC-USDT is read as BTC-USD: Yahoo lists crypto pairs against USD, not against USDT (crypto); quote, price_history, technicals`,
  "unknown-series-key": `[e6] find_instrument series:us.equity_index.kospi (reference its data as {"ref":"e6","path":"<field>"})
source: Instrument search
No instrument matched "series:us.equity_index.kospi".`,
  "gold-future": `[e1] find_instrument gold future (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "gold", best match first:
- future:XCEC:GC: Gold futures, continuous front month (future); quote, price_history, technicals
- future:MGC: MGC futures, continuous front month (Micro Gold Futures,Feb-2027) (future); quote, price_history, technicals`,
  "gold-security": `[e1] find_instrument gold security (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "gold", best match first:
- GLD: SPDR Gold Shares (etf); quote, price_history, technicals, profile, ownership, corporate_actions
- IAU: iShares Gold Trust (etf); quote, price_history, technicals, profile, ownership, corporate_actions`,
  "gold-series": `[e1] find_instrument gold series (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "gold", best match first:
- series:us.volatility.gold: Cboe Gold Volatility Index (GVZ) (index); quote, price_history, technicals`,
};
