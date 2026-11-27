// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The instrument search with OpenDART's company list (DART_API_KEY), through the real find_instrument tool, the
 * router and the ToolRegistry, on the fork's providers as a setup builds them: OpenDART's list (the hand-made
 * fixture test/fork/fixtures/dart/corp-codes.zip), Yahoo's batched quote placing each listing on its market (the
 * hand-made rows of test/fork/fixtures/instruments/yahoo-quote-kr-listings.json, each batch answered with the
 * rows of the symbols it asks for, as Yahoo leaves out those it does not know) and Yahoo's search where it is
 * asked (in the Latin script). Each text the model reads is compared whole (golden), and the read check shows
 * every field the tool reads was supplied: Korean names in Hangul, with their spacing and legal forms, and in
 * English; a company's common and preferred shares; a KOSPI and a KOSDAQ listing; a fund OpenDART does not list;
 * a company without a listing; then the keys handed out answered by quote; the search without the key (a name in
 * Hangul answered with DART_API_KEY to set, an English one as before); and OpenDART or Yahoo failing.
 * DART_API_KEY reaches OpenDART alone. No request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipOf } from "../../../scripts/fork/fixture-cases/dart.js";
import type { DataProvider, InstrumentMatch } from "../../../src/data/capabilities.js";
import { DataError } from "../../../src/data/errors.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import { canonicalKey, parseListing } from "../../../src/fork/data/listings.js";
import { instrumentsProvider, preferredCodes } from "../../../src/fork/data/providers/instruments.js";
import { SEC_TICKERS_URL } from "../../../src/fork/data/sources/sec-tickers.js";
import {
  buildTools,
  FIXTURES,
  type FixtureFetch,
  type FixtureRoute,
  type ToolRun,
  testDeps,
  testProviders,
  YAHOO_AAPL,
} from "./harness.js";

// Fixture routes --------------------------------------------------------------------------------------------

/** A key in OpenDART's form: it must reach OpenDART's query and nothing else. */
const KEY = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const DART: PublicDataConfig = { dartKey: KEY };
const SEC = { secUserAgent: "Test Agent test@example.com" } satisfies PublicDataConfig;
const JSON_TYPE = { "content-type": "application/json;charset=utf-8" };

const CORP_CODES: FixtureRoute = {
  match: (url) => url.hostname === "opendart.fss.or.kr" && url.pathname === "/api/corpCode.xml",
  file: "dart/corp-codes.zip",
};

/** Yahoo's cookie page and crumb, which its quote asks for first. */
const YAHOO_SESSION: readonly FixtureRoute[] = YAHOO_AAPL.slice(0, 2);

/** The hand-made rows of Yahoo's quote of the Korean listings the tests place, by symbol. */
const ROWS = new Map(
  (
    JSON.parse(readFileSync(join(FIXTURES, "instruments/yahoo-quote-kr-listings.json"), "utf8")) as {
      quoteResponse: { result: { symbol: string }[] };
    }
  ).quoteResponse.result.map((row) => [row.symbol, row]),
);

/** The symbols one batch asks for: each code's KOSPI and KOSDAQ spellings, and, for `named`, its preferred shares'. */
function batchOf(codes: readonly string[], named: readonly string[] = []): string[] {
  const all = [...codes, ...named.flatMap(preferredCodes)];
  return all.flatMap((code) => [`${code}.KS`, `${code}.KQ`]).sort();
}

/** Yahoo's answer to one quote of exactly `symbols` (in any order): the rows it has of them. */
function quotes(symbols: readonly string[], status = 200): FixtureRoute {
  const wanted = [...symbols].sort().join(",");
  return {
    match: (url) =>
      url.pathname === "/v7/finance/quote" &&
      (url.searchParams.get("symbols") ?? "").split(",").sort().join(",") === wanted,
    body:
      status === 200
        ? JSON.stringify({
            quoteResponse: { result: symbols.flatMap((symbol) => ROWS.get(symbol) ?? []), error: null },
          })
        : "",
    headers: JSON_TYPE,
    status,
  };
}

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
    }),
    headers: JSON_TYPE,
  };
}

const SAMSUNG_BATCH = batchOf(["005930"], ["005930"]);

const ROUTES: readonly FixtureRoute[] = [
  CORP_CODES,
  ...YAHOO_SESSION,
  quotes(SAMSUNG_BATCH),
  quotes(batchOf(["005930", "006400", "009150", "028260"])),
  quotes(batchOf(["035720"], ["035720"])),
  quotes(batchOf(["000660"], ["000660"])),
  quotes(batchOf(["035900"])),
  yahooSearch("SAMSUNG ELECTRONICS", "samsung-electronics"),
  yahooSearch("Samsung Electronics", "samsung-electronics"),
  yahooSearch("069500", "069500"),
  yahooSearch("005930.KS", "005930-ks"),
  nothingFor("035900"),
  nothingFor("JYP"),
  nothingFor("035900.KQ"),
  { match: SEC_TICKERS_URL, file: "sec/company-tickers-exchange.json" },
];

/** The fork's providers for `config` over `routes` (before these tests' own), and the tools, read checked. */
function setup(config: PublicDataConfig = DART, routes: readonly FixtureRoute[] = []) {
  const { providers, fetch, clock } = testProviders(config, [...routes, ...ROUTES]);
  return { ...buildTools(providers, { clock, check: true }), providers, fetch };
}

/** The requests made, each by what it asked. */
function asked(fetch: FixtureFetch): string[] {
  return fetch.requests.map(({ url }) => {
    const address = new URL(url);
    if (address.hostname === "opendart.fss.or.kr") return `opendart ${address.pathname.replace("/api/", "")}`;
    if (address.pathname === "/v1/finance/search") return `yahoo search q=${address.searchParams.get("q")}`;
    if (address.pathname === "/v7/finance/quote") return `yahoo quote ${address.searchParams.get("symbols")}`;
    if (url === SEC_TICKERS_URL) return "sec tickers";
    return `yahoo session ${address.pathname}`;
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

/** The keys of a find_instrument payload, best first. */
function keysOf(run: ToolRun): string[] {
  return (run.payload as { matches: { key: string }[] }).matches.map((match) => match.key);
}

/** The text the model reads, compared whole with the golden one. */
function golden(name: string, text: string): void {
  expect(GOLDEN[name]).toBeDefined();
  expect(text).toBe(GOLDEN[name] as string);
}

/** The instrument search alone over `routes` with `config`. */
function search(config: PublicDataConfig, routes: readonly FixtureRoute[]) {
  const { deps, fetch } = testDeps(config, routes);
  const provider = instrumentsProvider(deps);
  const run = provider.capabilities.instruments?.search as (
    query: string,
    kind: string | undefined,
    call?: { signal?: AbortSignal },
  ) => Promise<InstrumentMatch[]>;
  return { run, fetch };
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

// The tests -------------------------------------------------------------------------------------------------

describe("with DART_API_KEY: Korean companies by name, through OpenDART's company list", () => {
  test("instruments.search declared as before, built without a request", () => {
    const { providers, fetch, available } = setup();
    const instruments = providers.instruments as DataProvider;
    expect(Object.keys(instruments.capabilities)).toEqual(["instruments"]);
    expect(available.has("instruments")).toBe(true);
    expect(fetch.requests).toEqual([]);
  });

  test("삼성전자: its common share and its preferred share, placed on KOSPI by one batched quote; OpenDART's statements and filings for the company's own listing", async () => {
    const { runTool, fetch } = setup();
    const run = await found(runTool, { query: "삼성전자" });
    golden("samsung-hangul", run.text);
    expect(run.summary).toBe("2 instruments");
    // The company list, Yahoo's session and one quote: no search in Hangul, no request per match.
    expect(asked(fetch)).toEqual([
      "opendart corpCode.xml",
      "yahoo session /quote/AAPL",
      "yahoo session /v1/test/getcrumb",
      `yahoo quote ${SAMSUNG_BATCH.join(",")}`,
    ]);
  });

  test("spacing, a legal form, full-width letters aside: the same matches, from the list and the quote already read", async () => {
    const { runTool, fetch } = setup();
    const first = keysOf(await found(runTool, { query: "삼성전자" }));
    expect(first).toEqual(["XKRX:005930", "XKRX:005935"]);
    for (const query of ["삼성 전자", "(주)삼성전자", "삼성전자 주식회사", "㈜삼성전자"]) {
      expect(keysOf(await found(runTool, { query })), query).toEqual(first);
    }
    expect(fetch.requests).toHaveLength(4);
  });

  test("SAMSUNG ELECTRONICS: Yahoo's search and OpenDART's English names find the same listings, named as OpenDART names them", async () => {
    const { runTool, fetch } = setup();
    golden("samsung-english", (await found(runTool, { query: "SAMSUNG ELECTRONICS" })).text);
    expect(asked(fetch).filter((line) => !line.startsWith("yahoo session"))).toEqual([
      "yahoo search q=SAMSUNG ELECTRONICS",
      "opendart corpCode.xml",
      `yahoo quote ${SAMSUNG_BATCH.join(",")}`,
    ]);
    // With SEC_USER_AGENT too: SEC's list holds no Korean listing, so nothing changes.
    const { runTool: both } = setup({ ...DART, ...SEC });
    expect(keysOf(await found(both, { query: "Samsung Electronics" }))).toEqual([
      "XKRX:005930",
      "XKRX:005935",
    ]);
  });

  test("삼성: every listed company whose name starts with it, each placed by the same one quote; companies without a listing left out", async () => {
    const { runTool, fetch } = setup();
    golden("samsung-prefix", (await found(runTool, { query: "삼성" })).text);
    expect(asked(fetch).at(-1)).toBe(
      `yahoo quote ${batchOf(["005930", "006400", "009150", "028260"]).join(",")}`,
    );
  });

  test("a KOSDAQ listing on KOSDAQ: JYP Entertainment by its code and by its English name, XKOS:035900", async () => {
    const { runTool } = setup();
    golden("jyp-code", (await found(runTool, { query: "035900" })).text);
    golden("jyp-english", (await found(runTool, { query: "JYP" })).text);
    // Its Yahoo symbol: placed by Yahoo's search where it finds it, by the quote otherwise.
    expect(keysOf(await found(runTool, { query: "035900.KQ" }))).toEqual(["XKOS:035900"]);
  });

  test("Korean names in Hangul and in mixed scripts: 카카오, SK하이닉스", async () => {
    const { runTool } = setup();
    golden("kakao", (await found(runTool, { query: "카카오" })).text);
    expect(keysOf(await found(runTool, { query: "SK하이닉스" }))).toEqual(["XKRX:000660"]);
  });

  test("KODEX 200 (069500), a fund OpenDART's list does not hold: the Yahoo composite's capabilities alone", async () => {
    const { runTool } = setup();
    golden("kodex-200", (await found(runTool, { query: "069500" })).text);
  });

  test("a company without a listing (다코) finds nothing: no key a tool takes names it, and nothing is quoted", async () => {
    const { runTool, fetch } = setup();
    golden("daco", (await found(runTool, { query: "다코" })).text);
    expect(asked(fetch)).toEqual(["opendart corpCode.xml"]);
  });

  test("a Korean key typed: its company from the list, placed by Yahoo's search; the code alone when the market is to be found", async () => {
    const { runTool, fetch } = setup();
    golden("xkrx-005930", (await found(runTool, { query: "XKRX:005930" })).text);
    expect(asked(fetch)).toEqual(["yahoo search q=005930.KS", "opendart corpCode.xml"]);
  });

  test("a Korean code typed with the other market's prefix finds the listing on the market Yahoo quotes it on", async () => {
    const { runTool } = setup(DART, [nothingFor("005930.KQ"), quotes(batchOf(["005930"]))]);
    expect(keysOf(await found(runTool, { query: "XKOS:005930" }))).toEqual(["XKRX:005930"]);
  });

  test("one kind at a time: OpenDART's list is read for securities only", async () => {
    const { runTool, fetch } = setup();
    expect(keysOf(await found(runTool, { query: "삼성전자", kind: "security" }))).toEqual([
      "XKRX:005930",
      "XKRX:005935",
    ]);
    const before = fetch.requests.length;
    golden("samsung-future", (await found(runTool, { query: "삼성전자", kind: "future" })).text);
    expect(fetch.requests).toHaveLength(before);
  });
});

describe("the keys it hands out", () => {
  test("each the canonical key of a listing the tools take, on the market Yahoo quotes it on", async () => {
    const { runTool } = setup();
    for (const query of [
      "삼성전자",
      "삼성",
      "SAMSUNG ELECTRONICS",
      "035900",
      "카카오",
      "SK하이닉스",
      "069500",
    ]) {
      for (const key of keysOf(await found(runTool, { query }))) {
        expect(canonicalKey(key), key).toBe(key);
        const listing = parseListing(key);
        expect(listing.kind, key).toBe("kr");
        if (listing.kind !== "kr" || listing.code === "069500") continue;
        // The listing's Yahoo symbol is one Yahoo's quote answered: its venue is right.
        expect(ROWS.has(listing.yahoo[0] as string), key).toBe(true);
      }
    }
  });

  test("answered by quote: a KOSPI listing, its preferred share and a KOSDAQ listing", async () => {
    const { runTool, fetch } = setup(DART, [
      quotes(["005930.KS"]),
      quotes(["005935.KS"]),
      quotes(["035900.KQ"]),
    ]);
    const keys = [
      ...keysOf(await found(runTool, { query: "삼성전자" })),
      ...keysOf(await found(runTool, { query: "035900" })),
    ];
    expect(keys).toEqual(["XKRX:005930", "XKRX:005935", "XKOS:035900"]);
    for (const key of keys) {
      const answer = await runTool("quote", { symbols: [key] });
      expect(answer.failure, answer.text).toBeUndefined();
      expect(answer.source).toBe("Yahoo");
      const [quoted] = (answer.payload as { quotes: { symbol: string; instrument: string }[] }).quotes;
      expect(quoted?.symbol).toBe(key);
      expect(quoted?.instrument).toContain(`(${key}, ${key.startsWith("XKOS") ? "KOSDAQ" : "KOSPI"}`);
    }
    expect(fetch.unmatched).toEqual([]);
  });
});

describe("without DART_API_KEY: as before", () => {
  test("a company's name in Hangul says DART_API_KEY is needed and asks nothing; its English name is Yahoo's, without OpenDART's capabilities", async () => {
    const { runTool, fetch } = setup({});
    const hangul = await runTool("find_instrument", { query: "삼성전자" });
    expect(hangul.failure).toBe("data_not_configured");
    expect(hangul.text).toBe(
      `Finding Korean companies by their Korean names needs DART_API_KEY (a free key from OpenDART, https://opendart.fss.or.kr/), set in the environment or under "data" in credentials.json.`,
    );
    expect(fetch.requests).toEqual([]);
    golden("samsung-english-keyless", (await found(runTool, { query: "Samsung Electronics" })).text);
    expect(asked(fetch)).toEqual(["yahoo search q=Samsung Electronics"]);
  });
});

describe("OpenDART or Yahoo failing", () => {
  const refused = (body: string): FixtureRoute => ({
    match: CORP_CODES.match,
    body,
    headers: { "content-type": "application/xml" },
  });

  test("OpenDART refusing the key, its limit reached, failing: a name in Hangul fails with OpenDART's reason", async () => {
    const cases: [FixtureRoute, string, string][] = [
      [
        refused("<result><status>010</status><message>등록되지 않은 키입니다.</message></result>"),
        "rejected",
        "OpenDART refused DART_API_KEY (010: 등록되지 않은 키입니다.). A free key comes from https://opendart.fss.or.kr/.",
      ],
      [
        refused("<result><status>020</status><message>요청 제한을 초과하였습니다.</message></result>"),
        "quota",
        "OpenDART's request limit for DART_API_KEY is reached (020: 요청 제한을 초과하였습니다.).",
      ],
      [{ match: CORP_CODES.match, body: "", status: 500 }, "unavailable", "OpenDART answered HTTP 500."],
    ];
    for (const [route, kind, said] of cases) {
      const { run } = search(DART, [route]);
      const error = await failure(run("삼성전자", undefined));
      expect([error.kind, error.details.source, error.message]).toEqual([kind, "OpenDART", said]);
    }
    const { runTool } = setup(DART, [cases[0]?.[0] as FixtureRoute]);
    const run = await runTool("find_instrument", { query: "삼성전자" });
    expect(run.failure).toBe("data_rejected");
    expect(run.text).toContain("OpenDART refused DART_API_KEY (010: 등록되지 않은 키입니다.).");
    expect(run.text).not.toContain(KEY);
  });

  test("OpenDART failing while Yahoo finds the listing: Yahoo's matches, OpenDART's capabilities named for it (OpenDART is asked when a tool needs it)", async () => {
    const { run } = search(DART, [
      { match: CORP_CODES.match, body: "", status: 500 },
      yahooSearch("Samsung Electronics", "samsung-electronics"),
    ]);
    const matches = await run("Samsung Electronics", undefined);
    expect(matches.map((match) => [match.key, match.name, match.serves.includes("statements")])).toEqual([
      ["XKRX:005930", "Samsung Electronics Co., Ltd.", true],
      ["XKRX:005935", "Samsung Electronics Co., Ltd.", true],
    ]);
  });

  test("Yahoo's quote failing: OpenDART's companies are left out, and with nothing else found the search fails with Yahoo's reason", async () => {
    const { run } = search(DART, [CORP_CODES, ...YAHOO_SESSION, quotes(SAMSUNG_BATCH, 500)]);
    const error = await failure(run("삼성전자", undefined));
    expect([error.kind, error.details.source]).toEqual(["unavailable", "Yahoo"]);
    // Found by Yahoo's search as well: those matches stand.
    const { run: latin } = search(DART, [
      CORP_CODES,
      ...YAHOO_SESSION,
      quotes(SAMSUNG_BATCH, 500),
      yahooSearch("Samsung Electronics", "samsung-electronics"),
    ]);
    expect((await latin("Samsung Electronics", undefined)).map((match) => [match.key, match.type])).toEqual([
      ["XKRX:005930", "stock"],
      ["XKRX:005935", "stock"],
    ]);
  });

  test("a listing Yahoo quotes on neither market (delisted, or on KONEX) is left out", async () => {
    const list = `<?xml version="1.0" encoding="UTF-8"?>\n<result>\n    <list>\n        <corp_code>00999001</corp_code>\n        <corp_name>옛한국상사</corp_name>\n        <corp_eng_name>OLD HANKOOK TRADING CO., LTD.</corp_eng_name>\n        <stock_code>123450</stock_code>\n        <modify_date>20090105</modify_date>\n    </list>\n</result>\n`;
    const { run, fetch } = search(DART, [
      {
        match: CORP_CODES.match,
        body: zipOf([{ name: "CORPCODE.xml", data: new TextEncoder().encode(list) }]),
        headers: { "content-type": "application/zip" },
      },
      ...YAHOO_SESSION,
      quotes(batchOf(["123450"], ["123450"])),
    ]);
    expect(await run("옛한국상사", undefined)).toEqual([]);
    expect(fetch.unmatched).toEqual([]);
  });

  test("a code two of the list's rows carry (a company relisted) is one match, named by the row OpenDART changed last", async () => {
    const row = (code: string, english: string, modified: string) =>
      `    <list>\n        <corp_code>${code}</corp_code>\n        <corp_name>한국상사</corp_name>\n        <corp_eng_name>${english}</corp_eng_name>\n        <stock_code>123450</stock_code>\n        <modify_date>${modified}</modify_date>\n    </list>`;
    const list = `<?xml version="1.0" encoding="UTF-8"?>\n<result>\n${row("00999001", "HANKOOK TRADING CO., LTD.", "20090105")}\n${row("00999002", "HANKOOK TRADING HOLDINGS CO., LTD.", "20240611")}\n</result>\n`;
    const listed = {
      ...(ROWS.get("005930.KS") as object),
      symbol: "123450.KS",
      longName: "Hankook Trading Co., Ltd.",
    };
    const batch = batchOf(["123450"], ["123450"]);
    const { run } = search(DART, [
      {
        match: CORP_CODES.match,
        body: zipOf([{ name: "CORPCODE.xml", data: new TextEncoder().encode(list) }]),
        headers: { "content-type": "application/zip" },
      },
      ...YAHOO_SESSION,
      {
        ...quotes(batch),
        body: JSON.stringify({ quoteResponse: { result: [listed], error: null } }),
      },
    ]);
    expect((await run("한국상사", undefined)).map((match) => [match.key, match.name])).toEqual([
      ["XKRX:123450", "한국상사 (HANKOOK TRADING HOLDINGS CO., LTD.)"],
    ]);
  });

  test("a cancelled search ends with the caller's own reason", async () => {
    const { run } = search(DART, ROUTES);
    const controller = new AbortController();
    const reason = new Error("the turn was cancelled");
    controller.abort(reason);
    expect(
      await run("삼성전자", undefined, { signal: controller.signal }).catch((error: unknown) => error),
    ).toBe(reason);
  });

  test("DART_API_KEY reaches OpenDART alone: never Yahoo or SEC, never what the tool says", async () => {
    const { runTool, fetch } = setup({ ...DART, ...SEC });
    const runs: ToolRun[] = [];
    for (const query of ["삼성전자", "Samsung Electronics", "035900"])
      runs.push(await found(runTool, { query }));
    for (const { url, headers } of fetch.requests) {
      const address = new URL(url);
      if (address.hostname === "opendart.fss.or.kr") {
        expect(address.searchParams.get("crtfc_key")).toBe(KEY);
        continue;
      }
      expect(url).not.toContain(KEY);
      expect(JSON.stringify([...headers.entries()])).not.toContain(KEY);
    }
    for (const run of runs) {
      expect(run.text).not.toContain(KEY);
      expect(JSON.stringify(run.payload)).not.toContain(KEY);
      expect(JSON.stringify(run.provenance ?? {})).not.toContain(KEY);
    }
  });
});

// Golden texts ----------------------------------------------------------------------------------------------

const GOLDEN: Readonly<Record<string, string>> = {
  "samsung-hangul": `[e1] find_instrument 삼성전자 (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "삼성전자", best match first:
- XKRX:005930: 삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (stock); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions
- XKRX:005935: 삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (preferred stock); quote, price_history, technicals, profile, ownership, corporate_actions`,
  "samsung-english": `[e1] find_instrument SAMSUNG ELECTRONICS (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "SAMSUNG ELECTRONICS", best match first:
- XKRX:005930: 삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (stock); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions
- XKRX:005935: 삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (preferred stock); quote, price_history, technicals, profile, ownership, corporate_actions`,
  "samsung-prefix": `[e1] find_instrument 삼성 (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "삼성", best match first:
- XKRX:005930: 삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (stock); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions
- XKRX:006400: 삼성SDI (SAMSUNG SDI CO., LTD.) (stock); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions
- XKRX:009150: 삼성전기 (SAMSUNG ELECTRO-MECHANICS CO.,LTD) (stock); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions
- XKRX:028260: 삼성물산 (SAMSUNG C&T CORPORATION) (stock); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions`,
  "jyp-code": `[e1] find_instrument 035900 (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "035900", best match first:
- XKOS:035900: 제이와이피엔터테인먼트 (JYP Entertainment Corporation) (stock); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions`,
  "jyp-english": `[e2] find_instrument JYP (reference its data as {"ref":"e2","path":"<field>"})
source: Instrument search
Instruments for "JYP", best match first:
- XKOS:035900: 제이와이피엔터테인먼트 (JYP Entertainment Corporation) (stock); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions`,
  kakao: `[e1] find_instrument 카카오 (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "카카오", best match first:
- XKRX:035720: 카카오 (Kakao Corp.) (stock); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions`,
  "kodex-200": `[e1] find_instrument 069500 (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "069500", best match first:
- XKRX:069500: Samsung KODEX 200 Securities ETF (etf); quote, price_history, technicals, profile, ownership, corporate_actions`,
  daco: `[e1] find_instrument 다코 (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
No instrument matched "다코".`,
  "xkrx-005930": `[e1] find_instrument XKRX:005930 (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "XKRX:005930", best match first:
- XKRX:005930: 삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (stock); quote, price_history, technicals, profile, statements, filings, ownership, corporate_actions`,
  "samsung-future": `[e2] find_instrument 삼성전자 future (reference its data as {"ref":"e2","path":"<field>"})
source: Instrument search
No instrument matched "삼성전자".`,
  "samsung-english-keyless": `[e1] find_instrument Samsung Electronics (reference its data as {"ref":"e1","path":"<field>"})
source: Instrument search
Instruments for "Samsung Electronics", best match first:
- XKRX:005930: Samsung Electronics Co., Ltd. (stock); quote, price_history, technicals, profile, ownership, corporate_actions
- XKRX:005935: Samsung Electronics Co., Ltd. (stock); quote, price_history, technicals, profile, ownership, corporate_actions`,
};
