// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The fixture routes a setup with Korea's keys reads Samsung Electronics (XKRX:005930) from, shared by
 * all-tools.test.ts and korea-engine.test.ts; it holds no test of its own. Every answer is a hand-made fixture
 * in the source's documented format, the ones the sources' own tests use: OpenDART's company list, outline,
 * periodic reports and their statement lines, filings lists and documents, insider reports
 * (test/fork/fixtures/dart); Yahoo's quote of the Korean listings the instrument search places, and Yahoo
 * failing for Samsung's own quote and chart, so the FSC's prices answer them (fsc/); ECOS's and KOSIS's series
 * and the Bank of Korea's base rate (statistics-korea-routes.test.ts); GDELT's article list for Korean words
 * (gdelt/). `withKorea` answers as each source pages: OpenDART's list.json by window and page from the filings
 * lists, the FSC's rows by day and page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FOLDER, LIST_FIXTURES, listAnswerFrom } from "../../../scripts/fork/fixture-cases/dart-filings.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import { preferredCodes } from "../../../src/fork/data/providers/instruments.js";
import { FSC_ADDRESSES } from "../../../src/fork/data/sources/fsc.js";
import { gdeltQuery } from "../../../src/fork/data/sources/gdelt.js";
import { FIXTURES, type FixtureFetch, type FixtureRoute, fixture, YAHOO_AAPL } from "./harness.js";
import { BOK_ROUTE, ECOS_KEY, ECOS_ROUTES, KOSIS_KEY, KOSIS_ROUTES } from "./statistics-korea-routes.test.js";

/** OpenDART's key, as its form is (40 characters). */
export const DART_KEY = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";

/** data.go.kr's key in its "Decoding" spelling (invented, base64-like as data.go.kr's are), configured encoded. */
const DATA_GO_KR_DECODED = "Fk3a9Q+Zr7Lw2/Xp5Tn8Vb1=Hc6Jd4Mg0Ks+Ye3Ru9Wq/Ai2Ov7Sl5Nf8Bh1Gx4==";

/** Korea's keys, each set: what a setup reading every Korean source is configured with. */
export const KOREA_KEYS: Required<
  Pick<PublicDataConfig, "dartKey" | "ecosKey" | "kosisKey" | "dataGoKrKey">
> = {
  dartKey: DART_KEY,
  ecosKey: ECOS_KEY,
  kosisKey: KOSIS_KEY,
  // The "Encoding" spelling, as data.go.kr's page offers it first.
  dataGoKrKey: encodeURIComponent(DATA_GO_KR_DECODED),
};

/** Every spelling of every Korean key that must never be said or sent anywhere but to its own source. */
export const KOREA_SECRETS: readonly string[] = [...Object.values(KOREA_KEYS), DATA_GO_KR_DECODED];

/** Samsung Electronics' corp_code, and the receipt numbers of its 2025 annual and 2026 third-quarter reports. */
export const SAMSUNG = "00126380";
export const ANNUAL = "20260310000812";
export const QUARTERLY = "20261113001877";

/** The Korean words news is searched for. */
export const KOREAN_WORDS = "삼성전자 반도체";

const JSON_TYPE = { "content-type": "application/json;charset=UTF-8" };

/** OpenDART's `service` asked with every one of `params` (others may be asked too), answered from `file`. */
function dart(service: string, params: Readonly<Record<string, string>>, file: string): FixtureRoute {
  return {
    match: (url) =>
      url.hostname === "opendart.fss.or.kr" &&
      url.pathname === `/api/${service}` &&
      Object.entries(params).every(([name, value]) => url.searchParams.get(name) === value),
    file,
  };
}

/** Samsung Electronics' reports the statements fixtures hold. */
const REPORTS = [
  [2023, "11011"],
  [2024, "11013"],
  [2024, "11012"],
  [2024, "11014"],
  [2024, "11011"],
  [2025, "11013"],
  [2025, "11012"],
  [2025, "11014"],
  [2025, "11011"],
  [2026, "11013"],
  [2026, "11012"],
  [2026, "11014"],
] as const;

/** OpenDART: the company list, Samsung's outline, insider reports, documents, periodic reports and statement lines. */
const DART_ROUTES: readonly FixtureRoute[] = [
  dart("corpCode.xml", {}, "dart/corp-codes.zip"),
  dart("company.json", { corp_code: SAMSUNG }, "dart/company-00126380.json"),
  dart("elestock.json", { corp_code: SAMSUNG }, "dart/elestock-00126380.json"),
  dart("document.xml", { rcept_no: ANNUAL }, `${FOLDER}/document-00126380-annual.zip`),
  dart("document.xml", { rcept_no: QUARTERLY }, `${FOLDER}/document-00126380-quarterly.zip`),
  // The periodic reports the statements read, from 2015 (the filings' lists answer every other list.json).
  dart(
    "list.json",
    { corp_code: SAMSUNG, bgn_de: "20150101", pblntf_ty: "A", page_no: "1" },
    "dart-statements/list-00126380-periodic-2015.json",
  ),
  ...REPORTS.map(([year, code]) =>
    dart(
      "fnlttSinglAcntAll.json",
      { corp_code: SAMSUNG, bsns_year: String(year), reprt_code: code, fs_div: "CFS" },
      `dart-statements/accounts-${SAMSUNG}-${year}-${code}-cfs.json`,
    ),
  ),
];

/** The hand-made rows of Yahoo's quote of the Korean listings the instrument search places, by symbol. */
const ROWS = new Map(
  (
    JSON.parse(readFileSync(join(FIXTURES, "instruments/yahoo-quote-kr-listings.json"), "utf8")) as {
      quoteResponse: { result: { symbol: string }[] };
    }
  ).quoteResponse.result.map((row) => [row.symbol, row]),
);

/** The symbols the instrument search's one quote asks for Samsung Electronics: its two spellings and its preferred shares'. */
const SAMSUNG_BATCH = ["005930", ...preferredCodes("005930")]
  .flatMap((code) => [`${code}.KS`, `${code}.KQ`])
  .sort();

/** Yahoo's quote of exactly `symbols` (in any order): the rows it has of them. */
function yahooQuote(symbols: readonly string[]): FixtureRoute {
  const wanted = [...symbols].sort().join(",");
  return {
    match: (url) =>
      url.pathname === "/v7/finance/quote" &&
      (url.searchParams.get("symbols") ?? "").split(",").sort().join(",") === wanted,
    body: JSON.stringify({
      quoteResponse: { result: symbols.flatMap((symbol) => ROWS.get(symbol) ?? []), error: null },
    }),
    headers: { "content-type": "application/json;charset=utf-8" },
  };
}

/** Yahoo failing for Samsung's own quote and chart (its 503): the listing passes on to the FSC. */
const YAHOO_DOWN: FixtureRoute = {
  match: (url) =>
    /^query\d\.finance\.yahoo\.com$/.test(url.hostname) &&
    ((url.pathname === "/v7/finance/quote" && url.searchParams.get("symbols") === "005930.KS") ||
      decodeURIComponent(url.pathname) === "/v8/finance/chart/005930.KS"),
  body: "Service Unavailable",
  status: 503,
  headers: { "content-type": "text/html" },
};

/** Yahoo: its cookie page and crumb, the instrument search's quote, and Samsung's own quote and chart failing. */
const YAHOO_ROUTES: readonly FixtureRoute[] = [
  yahooQuote(SAMSUNG_BATCH),
  YAHOO_DOWN,
  ...YAHOO_AAPL.slice(0, 2),
];

/** The FSC's stock prices on data.go.kr: Samsung Electronics' sessions from 2026-10-12 to 2026-11-24. */
const FSC_ROUTES: readonly FixtureRoute[] = [
  {
    match: (url) =>
      url.hostname === "apis.data.go.kr" &&
      url.pathname === new URL(FSC_ADDRESSES[0]).pathname &&
      url.searchParams.get("likeSrtnCd") === "005930",
    file: "fsc/stock-price-005930.json",
  },
];

/** GDELT's article list for the Korean words. */
const NEWS_ROUTES: readonly FixtureRoute[] = [
  {
    match: (url) =>
      url.hostname === "api.gdeltproject.org" &&
      url.searchParams.get("query") === gdeltQuery({ words: KOREAN_WORDS }),
    file: "gdelt/artlist-samsung-semiconductor.json",
  },
];

/** Every route of a setup with Korea's keys, before any other the test adds. */
export const KOREA_ROUTES: readonly FixtureRoute[] = [
  ...DART_ROUTES,
  ...YAHOO_ROUTES,
  ...FSC_ROUTES,
  ...ECOS_ROUTES,
  BOK_ROUTE,
  ...KOSIS_ROUTES,
  ...NEWS_ROUTES,
];

/** OpenDART's answer to a list.json request the filings lists hold (by company and type), else undefined. */
function dartList(url: URL): Record<string, unknown> | undefined {
  if (url.hostname !== "opendart.fss.or.kr" || url.pathname !== "/api/list.json") return undefined;
  const held = LIST_FIXTURES.find(
    (one) =>
      one.corp === url.searchParams.get("corp_code") &&
      (one.group ?? null) === url.searchParams.get("pblntf_ty") &&
      (one.detail ?? null) === url.searchParams.get("pblntf_detail_ty"),
  );
  if (!held) return undefined;
  const list = JSON.parse(new TextDecoder().decode(fixture(`${FOLDER}/${held.file}`))) as {
    list?: Record<string, unknown>[];
  };
  return listAnswerFrom(list, url);
}

type Item = Record<string, string>;

/** The FSC's answer for the days and the page asked (beginBasDt inclusive, endBasDt exclusive), as it pages. */
async function fscPage(url: URL, response: Response): Promise<Response> {
  const text = await response.text();
  let parsed: { response?: { body?: { items?: unknown } } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    // The gateway's XML: as it came.
    return new Response(text, { status: response.status, headers: response.headers });
  }
  const body = parsed.response?.body;
  if (!body) return new Response(text, { status: response.status, headers: response.headers });
  const listed = (body.items as { item?: unknown } | null)?.item;
  const items: Item[] = Array.isArray(listed)
    ? (listed as Item[])
    : listed && typeof listed === "object"
      ? [listed as Item]
      : [];
  const from = url.searchParams.get("beginBasDt");
  const until = url.searchParams.get("endBasDt");
  const kept = items.filter(
    (item) => (!from || (item.basDt as string) >= from) && (!until || (item.basDt as string) < until),
  );
  const rows = Number(url.searchParams.get("numOfRows") ?? "10");
  const page = Number(url.searchParams.get("pageNo") ?? "1");
  const slice = kept.slice((page - 1) * rows, page * rows);
  (parsed.response as { body: unknown }).body = {
    numOfRows: rows,
    pageNo: page,
    totalCount: kept.length,
    items: slice.length ? { item: slice } : "",
  };
  return new Response(JSON.stringify(parsed), { status: response.status, headers: response.headers });
}

/**
 * `inner` answering as the Korean sources page: OpenDART's list.json from the filings lists (each window of
 * receipt days and each page), the FSC's rows by day and page. Every other request is `inner`'s; the
 * requests made are listed in `inner`'s.
 */
export function withKorea(inner: FixtureFetch): FixtureFetch {
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const address = input instanceof Request ? input.url : String(input);
    const url = new URL(address);
    const listed = dartList(url);
    if (listed) {
      inner.requests.push({ url: address, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(listed), { headers: JSON_TYPE });
    }
    const response = await inner(input, init);
    if (!response.ok) return response;
    if (url.hostname === "apis.data.go.kr") return fscPage(url, response);
    return response;
  };
  return Object.assign(answer, { requests: inner.requests, unmatched: inner.unmatched }) as FixtureFetch;
}
