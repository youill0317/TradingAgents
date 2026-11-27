// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Korean filings from OpenDART offline, past the goldens of dart-filings.test.ts: a listing OpenDART's list does
 * not hold is unsupported (the router asks on), never no_data; requests that must change are invalid, unsent;
 * OpenDART's statuses arrive as the DataError kinds the router acts on; every page of a window is read;
 * DART_API_KEY stays out of every payload, message, cache key and cache file; the parts of a DART document and
 * the report types are read as documented; and the recorder's cases (scripts/fork/fixture-cases/dart-filings.ts)
 * list their fixtures, send nothing in a dry run and read offline what each fixture holds. Every answer is a
 * fixture or written here in OpenDART's documented form.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_DART_KEY, zipOf } from "../../../scripts/fork/fixture-cases/dart.js";
import {
  cases as FILING_CASES,
  FOLDER,
  LIST_FIXTURES,
  listAnswerFrom,
  readLatestDocument,
  SOURCE,
} from "../../../scripts/fork/fixture-cases/dart-filings.js";
import { record, recordOne, yahooAnswerer } from "../../../scripts/fork/record-fixtures.js";
import { DataError } from "../../../src/data/errors.js";
import { type Cache, createCache } from "../../../src/fork/data/cache.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import {
  DART_FIRST_DAY,
  dartFilings,
  dartFiltersOf,
  detailCodeOf,
  periodEndOf,
  receiptDate,
} from "../../../src/fork/data/providers/dart-filings.js";
import { filersProvider } from "../../../src/fork/data/providers/filers.js";
import {
  dartParts,
  dartXmlText,
  findDartSection,
  sectionsOfDartReport,
} from "../../../src/fork/data/sources/dart-sections.js";
import {
  buildTools,
  FIXTURES,
  type FixtureFetch,
  type FixtureRoute,
  fixture,
  fixtureFetch,
  fixtureMeta,
  testDeps,
} from "./harness.js";

const KEY = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const DART: PublicDataConfig = { dartKey: KEY };
const SAMSUNG = "00126380";
const ANNUAL = "20260310000812";
const QUARTERLY = "20261113001877";
const JSON_TYPE = { "content-type": "application/json;charset=UTF-8" };

const text = (file: string) => new TextDecoder().decode(fixture(file));

/** OpenDART's `service` asked with every one of `params`, answered by `answer`. */
function dart(
  service: string,
  params: Readonly<Record<string, string>>,
  answer: Omit<FixtureRoute, "match">,
): FixtureRoute {
  return {
    match: (url) =>
      url.hostname === "opendart.fss.or.kr" &&
      url.pathname === `/api/${service}` &&
      Object.entries(params).every(([name, value]) => url.searchParams.get(name) === value),
    ...answer,
  };
}

/** OpenDART's status answered as JSON, and as XML (its ZIP services' failures). */
const statusJson = (status: string, message: string) => ({
  body: JSON.stringify({ status, message }),
  headers: JSON_TYPE,
});
const statusXml = (status: string, message: string) => ({
  body: `<?xml version="1.0" encoding="UTF-8"?>\n<result>\n<status>${status}</status>\n<message>${message}</message>\n</result>\n`,
  headers: { "content-type": "application/xml;charset=UTF-8" },
});

const CORP_CODES = dart("corpCode.xml", {}, { file: "dart/corp-codes.zip" });
const ELESTOCK = dart("elestock.json", { corp_code: SAMSUNG }, { file: "dart/elestock-00126380.json" });
const COMPANY = dart("company.json", { corp_code: SAMSUNG }, { file: "dart/company-00126380.json" });
const ANNUAL_DOCUMENT = dart(
  "document.xml",
  { rcept_no: ANNUAL },
  { file: `${FOLDER}/document-00126380-annual.zip` },
);
const QUARTERLY_DOCUMENT = dart(
  "document.xml",
  { rcept_no: QUARTERLY },
  { file: `${FOLDER}/document-00126380-quarterly.zip` },
);

/** A company's filings of a type, as list.json's rows, answered for each window and page (listAnswerFrom). */
type Held = { corp: string; group?: string; detail?: string; rows: readonly Record<string, unknown>[] };

/** The list fixtures' filings. */
const HELD: Held[] = LIST_FIXTURES.map(({ file, ...asked }) => ({
  ...asked,
  rows: (JSON.parse(text(`${FOLDER}/${file}`)) as { list: Record<string, unknown>[] }).list,
}));

/** A fetch answering `routes`, and list.json from `held` as OpenDART answers it (see dart-filings.test.ts). */
function openDart(routes: readonly FixtureRoute[], held: readonly Held[] = HELD): FixtureFetch {
  const inner = fixtureFetch(routes);
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const address = input instanceof Request ? input.url : String(input);
    const url = new URL(address);
    const found =
      url.hostname === "opendart.fss.or.kr" && url.pathname === "/api/list.json"
        ? held.find(
            (one) =>
              one.corp === url.searchParams.get("corp_code") &&
              (one.group ?? null) === url.searchParams.get("pblntf_ty") &&
              (one.detail ?? null) === url.searchParams.get("pblntf_detail_ty"),
          )
        : undefined;
    if (!found) return inner(input, init);
    inner.requests.push({ url: address, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(listAnswerFrom({ list: found.rows }, url)), { headers: JSON_TYPE });
  };
  return Object.assign(answer, { requests: inner.requests, unmatched: inner.unmatched }) as FixtureFetch;
}

const ROUTES = [CORP_CODES, ELESTOCK, COMPANY, ANNUAL_DOCUMENT, QUARTERLY_DOCUMENT];

/** The filers provider with DART_API_KEY (or `config`) over `fetch`, its tools, and OpenDART's part of it. */
function setup(fetch: FixtureFetch = openDart(ROUTES), config: PublicDataConfig = DART, cache?: Cache) {
  const { deps } = testDeps(config, fetch, cache ? { cache } : {});
  const provider = filersProvider(deps);
  return { ...buildTools({ filers: provider }, { check: true }), provider, korean: dartFilings(deps), fetch };
}

/** The DataError a reading rejects with. */
async function failure(promise: Promise<unknown>): Promise<DataError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error("it answered");
}

/** The services asked of OpenDART, in order. */
const services = (fetch: FixtureFetch) => fetch.requests.map(({ url }) => new URL(url).pathname.slice(5));

describe("a listing OpenDART's list does not hold is unsupported, so the router asks on", () => {
  test("a preferred share and a fund, through each tool: unsupported, never no_data", async () => {
    const { runTool, fetch } = setup();
    for (const symbol of ["XKRX:005935", "069500.KS", "XKOS:999999"]) {
      for (const [tool, input] of [
        ["filings", { symbol }],
        ["filing_section", { symbol, accession: ANNUAL, section: "business" }],
        ["ownership", { symbol }],
      ] as const) {
        const run = await runTool(tool, input);
        expect(run.failure).toBe("data_unsupported");
        expect(run.text).toContain("company list holds no company listed under");
      }
    }
    // The company list alone was read, once.
    expect(services(fetch)).toEqual(["corpCode.xml"]);
  });

  test("a key naming no Korean listing, asked of OpenDART's part directly, is unsupported, unsent", async () => {
    const { korean, fetch } = setup();
    for (const symbol of ["AAPL", "XLON:VOD", "fx:EURUSD", "series:us.fred.cpiaucsl"]) {
      expect((await failure(korean.list(symbol, { limit: 5 }))).kind).toBe("unsupported");
      expect((await failure(korean.transactions(symbol, { limit: 5 }))).kind).toBe("unsupported");
      expect(
        (await failure(korean.section({ symbol, accession: ANNUAL, section: "business" }, {}))).kind,
      ).toBe("unsupported");
    }
    expect(fetch.requests).toEqual([]);
  });
});

describe("requests that must change are invalid", () => {
  test("filings: a form OpenDART does not list by, a cursor that is no receipt number; nothing is sent", async () => {
    const { korean, fetch } = setup();
    const form = await failure(korean.list("XKRX:005930", { limit: 5, forms: ["10-K", "DEF 14A"] }));
    expect([form.kind, form.details.retry]).toEqual(["invalid", "change_request"]);
    expect(form.message).toStartWith("DEF 14A is not a form OpenDART lists a Korean listing's filings by");
    for (const after of ["0000320193-26-000026", "2026031000081", "20261340000812"]) {
      const cursor = await failure(korean.list("XKRX:005930", { limit: 5, after }));
      expect(cursor.kind).toBe("invalid");
      expect(cursor.message).toBe(
        `after must be a cursor a previous call returned (an OpenDART receipt number), not "${after}"`,
      );
    }
    expect(fetch.requests).toEqual([]);
  });

  test("filing_section: an SEC accession, a receipt day after today, a page cursor, a filing of another day", async () => {
    const { korean, fetch } = setup();
    const target = { symbol: "XKRX:005930", section: "business" as const };
    for (const accession of ["0000320193-26-000026", "20261332000001"]) {
      const said = await failure(korean.section({ ...target, accession }, {}));
      expect(said.kind).toBe("invalid");
      expect(said.message).toStartWith(`${accession} is not an OpenDART receipt number`);
    }
    // Written as a receipt number, its day after today: the day is what is said.
    const future = await failure(korean.section({ ...target, accession: "20261127000001" }, {}));
    expect([future.kind, future.message]).toEqual([
      "invalid",
      "20261127000001's receipt day, 2026-11-27 (its first eight digits), is after today (2026-11-26 in Seoul)",
    ]);
    const paged = await failure(korean.section({ ...target, accession: ANNUAL }, { after: "x" }));
    expect(paged.message).toBe(
      "this source serves a section whole, with no further pages: continue by character offset",
    );
    expect(fetch.requests).toEqual([]);
    // A receipt number of another company, or none: not among the company's filings of its day.
    const other = await failure(korean.section({ ...target, accession: "20260310000999" }, {}));
    expect(other.kind).toBe("invalid");
    expect(other.message).toBe(
      "20260310000999 is not among 삼성전자's filings received on 2026-03-10; list them with filings",
    );
    expect(services(fetch)).toEqual(["corpCode.xml", "list.json"]);
  });

  test("ownership: transaction codes, a window ending before it starts, a cursor naming no report", async () => {
    const { korean, fetch } = setup();
    const codes = await failure(korean.transactions("XKRX:005930", { limit: 5, codes: ["P", "S"] }));
    expect(codes.kind).toBe("invalid");
    expect(codes.message).toContain("with no transaction codes: ask without codes");
    const window = await failure(
      korean.transactions("XKRX:005930", { limit: 5, start: "2026-11-01", end: "2026-10-01" }),
    );
    expect(window.message).toBe("start (2026-11-01) is after end (2026-10-01)");
    const malformed = await failure(korean.transactions("XKRX:005930", { limit: 5, after: "0001-26-1" }));
    expect(malformed.kind).toBe("invalid");
    expect(fetch.requests).toEqual([]);
    // A cursor of a report outside the dates asked names no report there.
    const outside = await failure(
      korean.transactions("XKRX:005930", { limit: 5, start: "2026-10-01", after: "20260902000215" }),
    );
    expect(outside.message).toBe(
      "after names no insider report of 삼성전자 in the dates asked; ask again without it",
    );
  });
});

describe("OpenDART's statuses arrive as the kinds the router acts on", () => {
  /** list.json answering `status` for every window. */
  const listing = (status: ReturnType<typeof statusJson>) =>
    setup(openDart([CORP_CODES, dart("list.json", { corp_code: SAMSUNG }, status), ...ROUTES], []));

  test("list.json: 020 quota, 010 and 011 rejected (naming DART_API_KEY), 100 invalid, 800 and 900 unavailable", async () => {
    const kinds: Record<string, string> = {};
    for (const [status, words] of [
      ["020", "요청 제한을 초과하였습니다."],
      ["010", "등록되지 않은 키입니다."],
      ["011", "사용할 수 없는 키입니다."],
      ["100", "필드의 부적절한 값입니다."],
      ["800", "시스템 점검으로 인한 서비스가 중지 중입니다."],
      ["900", "정의되지 않은 오류가 발생하였습니다."],
    ] as const) {
      const { runTool } = listing(statusJson(status, words));
      const run = await runTool("filings", { symbol: "XKRX:005930" });
      kinds[status] = run.failure ?? "answered";
      expect(run.text).not.toContain(KEY);
      if (status === "010")
        expect(run.text).toContain("OpenDART refused DART_API_KEY (010: 등록되지 않은 키입니다.)");
    }
    expect(kinds).toEqual({
      "020": "data_quota",
      "010": "data_rejected",
      "011": "data_rejected",
      "100": "data_invalid",
      "800": "data_unavailable",
      "900": "data_unavailable",
    });
  });

  test("013 (no data) in every window is no filing, after the windows back to DART's first day", async () => {
    const { provider, fetch } = listing(statusJson("013", "조회된 데이타가 없습니다."));
    const answer = await provider.capabilities.filings?.list?.("XKRX:005930", { limit: 5 });
    expect(answer?.data).toEqual([]);
    expect(answer?.next_cursor).toBeNull();
    const windows = fetch.requests
      .filter(({ url }) => url.includes("list.json"))
      .map(({ url }) => new URL(url).searchParams.get("bgn_de"));
    expect(windows.at(-1)).toBe(DART_FIRST_DAY.replaceAll("-", ""));
    expect(windows).toHaveLength(7);
  });

  test("elestock.json's 013 is no report: none found, covered from the start asked", async () => {
    const { runTool } = setup(
      openDart([
        CORP_CODES,
        COMPANY,
        dart("elestock.json", { corp_code: SAMSUNG }, statusJson("013", "조회된 데이타가 없습니다.")),
      ]),
    );
    const run = await runTool("ownership", { symbol: "XKRX:005930", start: "2026-01-01" });
    expect(run.failure).toBeUndefined();
    expect(run.reads.missing()).toEqual([]);
    expect(run.text.split("\n").slice(2)).toEqual([
      "삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): insider transactions",
      "covered: 2026-01-01 to 2026-11-26",
      "complete only after 2026-12-03",
      "No transactions found in what is covered.",
    ]);
  });

  test("document.xml: 014 (no such file) is no_data, an archive that cannot be read unavailable", async () => {
    const missing = setup(
      openDart([
        CORP_CODES,
        dart("document.xml", { rcept_no: ANNUAL }, statusXml("014", "파일이 존재하지 않습니다.")),
      ]),
    );
    const none = await missing.runTool("filing_section", {
      symbol: "XKRX:005930",
      accession: ANNUAL,
      section: "business",
    });
    expect(none.failure).toBe("data_no_data");
    expect(none.text).toContain(`document for receipt number ${ANNUAL} (014: 파일이 존재하지 않습니다.)`);
    const damaged = setup(
      openDart([
        CORP_CODES,
        dart("document.xml", { rcept_no: ANNUAL }, { body: new Uint8Array([0x50, 0x4b, 3, 4, 0]) }),
      ]),
    );
    const broken = await damaged.runTool("filing_section", {
      symbol: "XKRX:005930",
      accession: ANNUAL,
      section: "business",
    });
    expect(broken.failure).toBe("data_unavailable");
  });

  test("a report whose main document lacks a chapter answers that section not_found, with why", async () => {
    const main = new TextEncoder().encode(
      `<?xml version="1.0" encoding="utf-8"?><DOCUMENT><BODY><SECTION-1><TITLE>II. 사업의 내용</TITLE><P>사업.</P></SECTION-1></BODY></DOCUMENT>`,
    );
    const { runTool } = setup(
      openDart([
        CORP_CODES,
        dart("document.xml", { rcept_no: ANNUAL }, { body: zipOf([{ name: `${ANNUAL}.xml`, data: main }]) }),
      ]),
    );
    const run = await runTool("filing_section", {
      symbol: "XKRX:005930",
      accession: ANNUAL,
      section: "mdna",
    });
    expect(run.failure).toBeUndefined();
    expect(run.reads.missing()).toEqual([]);
    expect(run.payload).toMatchObject({ state: "not_found", text: "" });
    expect((run.payload as { not_given: string }).not_given).toBe(
      `content: section_not_found: no "이사의 경영진단 및 분석의견" chapter or section found in the filing's main document (${ANNUAL}.xml), settled`,
    );
  });
});

describe("every page of a window is read", () => {
  test("a window holding more than a page: each of its pages asked, its filings served newest first, in pages", async () => {
    // 230 insiders' reports received in the latest quarter's days, three a day from 2026-08-27.
    const rows = Array.from({ length: 230 }, (_, index) => {
      const day = new Date(Date.parse("2026-08-27T00:00:00Z") + Math.floor(index / 3) * 86_400_000)
        .toISOString()
        .slice(0, 10)
        .replaceAll("-", "");
      return {
        corp_code: SAMSUNG,
        corp_name: "삼성전자",
        stock_code: "005930",
        corp_cls: "Y",
        report_nm: "임원ㆍ주요주주특정증권등소유상황보고서",
        rcept_no: `${day}${String(100 + index).padStart(6, "0")}`,
        flr_nm: `보고자${index}`,
        rcept_dt: day,
        rm: "",
      };
    });
    const fetch = openDart([CORP_CODES], [{ corp: SAMSUNG, rows }]);
    const { korean } = setup(fetch);
    const first = await korean.list("XKRX:005930", { limit: 20 });
    expect(
      fetch.requests.slice(1).map(({ url }) => {
        const asked = new URL(url).searchParams;
        return `${asked.get("bgn_de")}-${asked.get("end_de")} page ${asked.get("page_no")} of ${asked.get("page_count")}`;
      }),
    ).toEqual([
      "20260827-20261126 page 1 of 100",
      "20260827-20261126 page 2 of 100",
      "20260827-20261126 page 3 of 100",
    ]);
    const newest = [...rows].reverse();
    expect(first.data.map((one) => one.accession)).toEqual(newest.slice(0, 20).map((one) => one.rcept_no));
    expect(first.next_cursor).toBe(newest[19]?.rcept_no);
    // The next page starts from the cursor's receipt day.
    const second = await korean.list("XKRX:005930", { limit: 20, after: first.next_cursor as string });
    expect(second.data.map((one) => one.accession)).toEqual(newest.slice(20, 40).map((one) => one.rcept_no));
  });
});

describe("DART_API_KEY stays in the request's query", () => {
  test("never in a payload, a text, a message, a cache key, a cache file or a link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fork-dart-filings-"));
    try {
      const inner = createCache({ dir, secrets: [KEY] });
      const keys: string[] = [];
      const cache: Cache = {
        remember: (key, ttl, load, options) => {
          keys.push(key);
          return inner.remember(key, ttl, load, options);
        },
        keep: (key, ttl, load, options) => {
          keys.push(key);
          return inner.keep(key, ttl, load, options);
        },
        forget: (key) => inner.forget(key),
      };
      const JYP = "00258689";
      const fetch = openDart([
        ...ROUTES,
        // OpenDART's own words quoting the key, as a refusal might.
        dart("elestock.json", { corp_code: JYP }, statusJson("013", "조회된 데이타가 없습니다.")),
        dart("company.json", { corp_code: JYP }, statusJson("010", `등록되지 않은 키입니다 (${KEY})`)),
      ]);
      const { runTool } = setup(fetch, { ...DART, cacheDir: dir }, cache);
      const runs = [
        await runTool("filings", { symbol: "XKRX:005930", limit: 3 }),
        await runTool("filings", { symbol: "005930", forms: ["10-K"], limit: 2 }),
        await runTool("filing_section", { symbol: "XKRX:005930", accession: ANNUAL, section: "business" }),
        await runTool("filing_section", { symbol: "005930", accession: QUARTERLY, section: "market_risk" }),
        await runTool("ownership", { symbol: "005930", limit: 2 }),
        await runTool("filings", { symbol: "XKRX:005930", forms: ["S-1"] }),
        await runTool("filing_section", {
          symbol: "XKRX:005930",
          accession: "20260901000999",
          section: "mdna",
        }),
        await runTool("ownership", { symbol: "035900" }),
      ];
      expect(runs.map((run) => run.failure ?? "answered")).toEqual([
        "answered",
        "answered",
        "answered",
        "answered",
        "answered",
        "data_invalid",
        "data_invalid",
        "data_rejected",
      ]);
      expect(runs.at(-1)?.text).toBe(
        "OpenDART refused DART_API_KEY (010: 등록되지 않은 키입니다 (***)). A free key comes from https://opendart.fss.or.kr/.",
      );
      for (const run of runs) {
        expect(run.text).not.toContain(KEY);
        expect(JSON.stringify(run.payload ?? null)).not.toContain(KEY);
        expect(JSON.stringify(run.payload ?? null)).not.toContain("opendart.fss.or.kr");
      }
      expect(keys.length).toBeGreaterThan(5);
      for (const key of keys) expect(key).not.toContain(KEY);
      const files = await readdir(dir, { recursive: true });
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const body = await readFile(join(dir, file)).catch(() => undefined);
        if (body) expect(body.toString("latin1")).not.toContain(KEY);
      }
      for (const { url, headers } of fetch.requests) {
        const address = new URL(url);
        expect(address.searchParams.get("crtfc_key")).toBe(KEY);
        expect(address.pathname).not.toContain(KEY);
        expect(JSON.stringify([...headers.entries()])).not.toContain(KEY);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the parts of a DART document", () => {
  test("sections by level with their titles; a section left unclosed ends where the next of its level starts", () => {
    const xml = [
      "<DOCUMENT><BODY>",
      '<SECTION-1 ACLASS="MANDATORY"><TITLE ATOC="Y">I. <SPAN>회사의</SPAN>&cr;개요 &amp; 연혁</TITLE><P>a</P>',
      "<SECTION-2><TITLE>1. 하나</TITLE><P>b</P>",
      "</SECTION-3>",
      "<SECTION-1><TITLE>II. 사업의 내용</TITLE>",
      "<TABLE-GROUP><TITLE>표 제목</TITLE></TABLE-GROUP>",
      "</SECTION-1>",
      "</BODY></DOCUMENT>",
    ].join("");
    const parts = dartParts(xml);
    expect(parts.map(({ level, title }) => [level, title])).toEqual([
      [1, "I. 회사의 개요 & 연혁"],
      [2, "1. 하나"],
      [1, "II. 사업의 내용"],
    ]);
    const [first, inner, second] = parts as [(typeof parts)[0], (typeof parts)[0], (typeof parts)[0]];
    expect(inner.end).toBe(second.start);
    expect(first.end).toBe(second.start);
    expect(xml.slice(second.start, second.end)).toEndWith("</SECTION-1>");
  });

  test("the outermost section a title names; a pointer is by_reference only with no sections inside it", () => {
    const xml = [
      "<SECTION-1><TITLE>III. 재무에 관한 사항</TITLE><SECTION-2><TITLE>8. 기타 재무에 관한 사항</TITLE><P>없음.</P></SECTION-2></SECTION-1>",
      "<SECTION-1><TITLE>II. 사업의 내용</TITLE><SECTION-2><TITLE>5. 위험관리 및 파생거래</TITLE><P>주석을 참조하시기 바랍니다.</P></SECTION-2></SECTION-1>",
    ].join("");
    expect(findDartSection(xml, "financial_statements")).toEqual({
      state: "available",
      content: "III. 재무에 관한 사항\n\n8. 기타 재무에 관한 사항\n\n없음.",
    });
    expect(findDartSection(xml, "business").state).toBe("available");
    expect(findDartSection(xml, "market_risk")).toEqual({
      state: "by_reference",
      content: "5. 위험관리 및 파생거래\n\n주석을 참조하시기 바랍니다.",
    });
    expect(findDartSection(xml, "mdna")).toEqual({
      state: "not_found",
      reason: `no "이사의 경영진단 및 분석의견" chapter or section found in the filing's main document`,
    });
  });

  test("tables keep their rows, DART's cells included; &cr; breaks a paragraph and stays inside a cell", () => {
    expect(
      dartXmlText(
        '<P>첫줄&cr;둘째줄</P><TABLE><TR><TH>구 분</TH><TU AUNIT="UNIT">단위&cr;백만원</TU></TR><TR><TD>매출액</TD><TE>1,000</TE></TR></TABLE>',
      ),
    ).toBe("첫줄\n둘째줄\n\n구 분\t단위 백만원\n매출액\t1,000");
  });

  test("a document of an annual report's size is split in time proportional to it", () => {
    const paragraph = `<P>${"당사는 반도체와 전자제품을 생산하고 판매합니다. ".repeat(8)}</P>`;
    const chapters = [
      "회사의 개요",
      "사업의 내용",
      "재무에 관한 사항",
      "이사의 경영진단 및 분석의견",
      "감사인의 감사의견",
    ];
    const xml = chapters
      .map(
        (title, at) =>
          `<SECTION-1><TITLE>${at + 1}. ${title}</TITLE>${Array.from({ length: 40 }, (_, section) => `<SECTION-2><TITLE>${section + 1}. 항목</TITLE>${paragraph.repeat(120)}</SECTION-2>`).join("")}</SECTION-1>`,
      )
      .join("");
    // About 5 million characters: some 15 MB of UTF-8.
    expect(xml.length).toBeGreaterThan(5_000_000);
    const started = performance.now();
    const found = findDartSection(xml, "mdna");
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(found.state).toBe("available");
    expect(found.state !== "not_found" && found.content.startsWith("4. 이사의 경영진단 및 분석의견\n")).toBe(
      true,
    );
  });
});

describe("report types, forms and receipt numbers", () => {
  test("a report's type from its name, its corrections and periods aside; others have none", () => {
    expect(
      [
        "사업보고서 (2025.12)",
        "[기재정정]사업보고서 (2024.12)",
        "[첨부정정] 반기보고서 (2026.06)",
        "분기보고서 (2026.09)",
        "주요사항보고서(자기주식취득결정)",
        "주식등의대량보유상황보고서(일반)",
        "임원·주요주주특정증권등소유상황보고서",
        "연결재무제표기준영업(잠정)실적(공정공시)",
        "사업보고서제출기한연장신고서",
      ].map(detailCodeOf),
    ).toEqual(["A001", "A001", "A002", "A003", "B001", "D001", "D002", undefined, undefined]);
  });

  test("a periodic report's period ends on its month's last day; other reports name none", () => {
    expect(periodEndOf("사업보고서 (2025.12)", "A001")).toBe("2025-12-31");
    expect(periodEndOf("반기보고서 (2024.06)", "A002")).toBe("2024-06-30");
    expect(periodEndOf("분기보고서 (2024.02)", "A003")).toBe("2024-02-29");
    expect(periodEndOf("분기보고서 (2026.13)", "A003")).toBeNull();
    expect(periodEndOf("주요사항보고서(자기주식취득결정)", "B001")).toBeNull();
    expect(periodEndOf("사업보고서 (2025.12)", undefined)).toBeNull();
  });

  test("forms: OpenDART's types and groups, and the SEC forms they answer to, each asked for once", () => {
    expect(dartFiltersOf(undefined)).toBeUndefined();
    expect(dartFiltersOf([])).toBeUndefined();
    expect(dartFiltersOf(["10-K", "a001", " 10-q ", "8-K", "I", "D002"])).toEqual([
      { detail: "A001", group: "A" },
      { detail: "A002", group: "A" },
      { detail: "A003", group: "A" },
      { detail: "B001", group: "B" },
      { group: "I" },
      { detail: "D002", group: "D" },
    ]);
    for (const form of ["20-F", "K001", "A01", "4"]) expect(() => dartFiltersOf([form])).toThrow(DataError);
  });

  test("a receipt number's day is its first eight digits, when a day; the sections of each report type", () => {
    expect(receiptDate(ANNUAL)).toBe("2026-03-10");
    for (const other of ["2026031000081", "20260230000812", "0000320193-26-000026", "2026031000081x"]) {
      expect(receiptDate(other)).toBeNull();
    }
    expect(sectionsOfDartReport("A001")).toEqual(["business", "mdna", "market_risk", "financial_statements"]);
    expect(sectionsOfDartReport("A003")).toEqual(["business", "market_risk", "financial_statements"]);
    expect(sectionsOfDartReport("B001")).toEqual([]);
    expect(sectionsOfDartReport(undefined)).toEqual([]);
  });
});

describe("the recorder's cases (scripts/fork/fixture-cases/dart-filings.ts)", () => {
  const dryRun = async (env: Record<string, string>) => {
    const home = await mkdtemp(join(tmpdir(), "fork-dart-filings-cases-"));
    const said: string[] = [];
    const sent: string[] = [];
    try {
      const status = await record({
        argv: ["--dry-run", "--only", SOURCE],
        env: { HOME: home, TRADINGAGENTS_HOME: join(home, "home"), PATH: process.env.PATH ?? "", ...env },
        fetch: (async (input: string | URL | Request): Promise<Response> => {
          sent.push(String(input));
          throw new Error("a dry run sends nothing");
        }) as typeof globalThis.fetch,
        out: (line) => said.push(line),
        err: (line) => said.push(line),
      });
      return { status, said, sent };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };

  const listed = (name: string, filter: string) =>
    `${SOURCE}/${name}.json and ${SOURCE}/${name}.meta.json <- https://opendart.fss.or.kr/api/list.json?crtfc_key=***&corp_code=${name.slice(5, 13)}&bgn_de=20240101&end_de=20261126${filter}&sort=date&sort_mth=desc&page_no=1&page_count=100`;

  test("--dry-run lists each case and its files, the key removed, and sends nothing", async () => {
    const { status, said, sent } = await dryRun({ DART_API_KEY: KEY });
    expect(status).toBe(0);
    expect(sent).toEqual([]);
    expect(said).toEqual([
      listed("list-00126380", ""),
      listed("list-00126380-a001", "&pblntf_ty=A&pblntf_detail_ty=A001"),
      listed("list-00126380-a002", "&pblntf_ty=A&pblntf_detail_ty=A002"),
      listed("list-00126380-a003", "&pblntf_ty=A&pblntf_detail_ty=A003"),
      listed("list-00126380-b001", "&pblntf_ty=B&pblntf_detail_ty=B001"),
      listed("list-00126380-i", "&pblntf_ty=I"),
      listed("list-00258689", ""),
      `${SOURCE}/document-00126380-annual.zip and ${SOURCE}/document-00126380-annual.meta.json <- (its own reading)`,
      `${SOURCE}/document-00126380-quarterly.zip and ${SOURCE}/document-00126380-quarterly.meta.json <- (its own reading)`,
    ]);
    expect(said.join("\n")).not.toContain(KEY);
  });

  test("without DART_API_KEY no case has an address, so none would be sent", async () => {
    const { status, said, sent } = await dryRun({});
    expect(status).toBe(0);
    expect(sent).toEqual([]);
    expect(said.filter((line) => line.endsWith(`<- ${NO_DART_KEY}`))).toHaveLength(7);
    const { deps } = testDeps({}, []);
    expect(
      await readLatestDocument(deps.http, undefined, "A001").catch((error: Error) => error.message),
    ).toBe(NO_DART_KEY);
  });

  test("each case reads, offline, what its fixture holds: one case a fixture, each fixture a case", async () => {
    const files = (await readdir(join(FIXTURES, FOLDER)))
      .filter((name) => !name.endsWith(".meta.json"))
      .sort();
    expect(FILING_CASES.map((one) => one.file).sort()).toEqual(files);
    expect(LIST_FIXTURES.map((one) => one.file).sort()).toEqual(
      files.filter((name) => name.startsWith("list-")),
    );
    const routes = FILING_CASES.filter((one) => one.url).map((one) => ({
      match: (url: URL) =>
        url.searchParams.get("crtfc_key") === KEY &&
        fixtureMeta(`${FOLDER}/${one.file}`)?.url === url.href.replace(KEY, "***"),
      file: `${FOLDER}/${one.file}`,
    }));
    const { deps, fetch } = testDeps(DART, routes);
    const tools = { yahoo: deps.yahoo, yahooAnswer: yahooAnswerer(fixtureFetch([])) };
    for (const one of FILING_CASES.filter((each) => each.url)) {
      const recorded = await recordOne(one, deps.http, tools, [KEY], DART);
      const file = `${FOLDER}/${one.file}`;
      expect(recorded.meta.url, file).toBe(fixtureMeta(file)?.url as string);
      expect(recorded.meta.source).toBe(SOURCE);
      expect(new TextDecoder().decode(recorded.body), file).toBe(text(file));
    }
    expect(fetch.unmatched).toEqual([]);
    // The documents: each report found first by list.json (its final version), then read.
    for (const [detail, receipt, file] of [
      ["A001", ANNUAL, "document-00126380-annual.zip"],
      ["A003", QUARTERLY, "document-00126380-quarterly.zip"],
    ] as const) {
      const read = await readLatestDocument(
        testDeps(DART, [
          dart(
            "list.json",
            { pblntf_detail_ty: detail, last_reprt_at: "Y", sort_mth: "desc" },
            {
              body: JSON.stringify({
                status: "000",
                message: "정상",
                total_count: 1,
                list: [{ rcept_no: receipt }],
              }),
              headers: JSON_TYPE,
            },
          ),
          dart("document.xml", { rcept_no: receipt }, { file: `${FOLDER}/${file}` }),
        ]).deps.http,
        KEY,
        detail,
      );
      expect(read.url?.replace(KEY, "***")).toBe(fixtureMeta(`${FOLDER}/${file}`)?.url as string);
      expect(read.body).toEqual(fixture(`${FOLDER}/${file}`));
    }
  });

  test("every fixture is hand-made, its meta's address without the key", async () => {
    const dir = join(FIXTURES, FOLDER);
    for (const file of (await readdir(dir)).filter((name) => name.endsWith(".meta.json"))) {
      const meta = JSON.parse(await readFile(join(dir, file), "utf8")) as {
        url: string;
        hand_made: boolean;
        source: string;
        note: string;
      };
      expect(new URL(meta.url).searchParams.get("crtfc_key"), file).toBe("***");
      expect([meta.hand_made, meta.source], file).toEqual([true, SOURCE]);
      expect(meta.note, file).toStartWith("Hand-made");
    }
  });
});
