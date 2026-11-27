// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Korean statements' failures and edges, offline (src/fork/data/providers/dart-statements.ts): what is not this
 * source's (a fund, a preferred share, a listing elsewhere) answers unsupported so the router asks the next source,
 * never no_data; without DART_API_KEY a Korean listing answers not_configured naming it; a fiscal year ending in
 * another month than December is unsupported with its month; every OpenDART status reaches the tool as the
 * DataError kind the router expects; rows no line matches (member breakdowns, rows without a standard id), the
 * comprehensive income statement read when a report has no income statement, one currency (the newest report's),
 * a line's formula in a quarter, quarters whose reports differ in basis or whose report before them is not
 * listed; the key in no answer, message, cache key or cache file; and the recorder's cases for the fixtures
 * (scripts/fork/fixture-cases/dart-statements.ts), listed and read offline. Answers are fixtures (test/fork/
 * fixtures/dart-statements and dart/) or written here in OpenDART's documented form.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipOf } from "../../../scripts/fork/fixture-cases/dart.js";
import {
  cases as STATEMENT_CASES,
  STATEMENT_FIXTURES,
} from "../../../scripts/fork/fixture-cases/dart-statements.js";
import { record, recordOne, yahooAnswerer } from "../../../scripts/fork/record-fixtures.js";
import type { DataProvider } from "../../../src/data/capabilities.js";
import { DataError } from "../../../src/data/errors.js";
import { type Cache, createCache, type KeepOptions } from "../../../src/fork/data/cache.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import { dartStatements, periodicOf } from "../../../src/fork/data/providers/dart-statements.js";
import { DART_SOURCE, DART_STATUS } from "../../../src/fork/data/sources/dart.js";
import {
  buildTools,
  FIXTURES,
  type FixtureFetch,
  type FixtureRoute,
  fixture,
  fixtureFetch,
  fixtureMeta,
  type TestOptions,
  testDeps,
} from "./harness.js";

// Routes (as dart-statements.test.ts writes them) -----------------------------------------------------------

/** A key in OpenDART's form (40 characters): it must never be said anywhere but in a request's query. */
const KEY = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const DART: PublicDataConfig = { dartKey: KEY };
const SAMSUNG = "00126380";
const JSON_TYPE = { "content-type": "application/json;charset=UTF-8" };

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
const answer = (body: unknown): Omit<FixtureRoute, "match"> => ({
  body: JSON.stringify(body),
  headers: JSON_TYPE,
});
const NONE = answer({ status: "013", message: "조회된 데이타가 없습니다." });

function accounts(
  corp: string,
  year: number,
  code: string,
  basis: "CFS" | "OFS",
  with_?: Omit<FixtureRoute, "match">,
): FixtureRoute {
  return dart(
    "fnlttSinglAcntAll.json",
    { corp_code: corp, bsns_year: String(year), reprt_code: code, fs_div: basis },
    with_ ?? { file: `dart-statements/accounts-${corp}-${year}-${code}-${basis.toLowerCase()}.json` },
  );
}

const CORP_CODES = dart("corpCode.xml", {}, { file: "dart/corp-codes.zip" });
const COMPANY = dart("company.json", { corp_code: SAMSUNG }, { file: "dart/company-00126380.json" });
const PERIODIC = dart(
  "list.json",
  { corp_code: SAMSUNG, bgn_de: "20150101", pblntf_ty: "A", page_no: "1" },
  { file: "dart-statements/list-00126380-periodic-2015.json" },
);
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
const SAMSUNG_ROUTES: FixtureRoute[] = [
  CORP_CODES,
  COMPANY,
  PERIODIC,
  ...REPORTS.map(([year, code]) => accounts(SAMSUNG, year, code, "CFS")),
];

function korea(
  routes: readonly FixtureRoute[] = SAMSUNG_ROUTES,
  config: PublicDataConfig = DART,
  extra: TestOptions = {},
) {
  const { deps, fetch } = testDeps(config, routes, extra);
  const statement = dartStatements(deps);
  const provider: DataProvider = { name: DART_SOURCE, capabilities: { statements: { statement } } };
  return { ...buildTools({ filers: provider }, { check: true }), fetch, deps, statement };
}

function asked(fetch: FixtureFetch): string[] {
  return fetch.requests.map(({ url }) => {
    const address = new URL(url);
    const params = [...address.searchParams.entries()]
      .filter(([name]) => name !== "crtfc_key" && name !== "corp_code" && name !== "page_count")
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    return `${address.pathname.replace("/api/", "")}${params ? `?${params}` : ""}`;
  });
}

const START = [
  "corpCode.xml",
  "company.json",
  "list.json?bgn_de=20150101&pblntf_ty=A&sort=date&sort_mth=asc&page_no=1",
];

/** The DataError a promise rejects with. */
async function failure(promise: Promise<unknown>): Promise<DataError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error("it answered");
}

/** One statement line of fnlttSinglAcntAll, as OpenDART writes it. */
function row(
  fields: { sj_div: string; account_id: string; account_nm: string; thstrm_amount: string } & Record<
    string,
    string
  >,
  rcept = "20260310000812",
  year = "2025",
  code = "11011",
) {
  return {
    rcept_no: rcept,
    reprt_code: code,
    bsns_year: year,
    corp_code: SAMSUNG,
    sj_nm: fields.sj_div,
    account_detail: "-",
    thstrm_nm: "제 57 기",
    ord: "1",
    currency: "KRW",
    ...fields,
  };
}

const STATEMENT = { symbol: "XKRX:005930", statement: "income_statement", period_type: "annual", periods: 1 };

// Listings that are not this source's -----------------------------------------------------------------------

describe("what OpenDART's statements do not serve answers unsupported, so the router asks the next source", () => {
  test("a fund (KODEX 200, 069500) has no row in OpenDART's company list: unsupported, after the list alone", async () => {
    const { runTool, fetch } = korea();
    const run = await runTool("statements", { ...STATEMENT, symbol: "XKRX:069500" });
    expect(run.failure).toBe("data_unsupported");
    expect(run.text).toBe(
      "OpenDART does not cover this request (OpenDART's company list holds no company listed under 069500); this is not a fact about the market.",
    );
    expect(asked(fetch)).toEqual(["corpCode.xml"]);
  });

  test("a preferred share (005935) is listed under its company's common code, not its own: unsupported", async () => {
    const { runTool } = korea();
    const run = await runTool("statements", { ...STATEMENT, symbol: "005935.KS" });
    expect(run.failure).toBe("data_unsupported");
    expect(run.text).toContain("holds no company listed under 005935");
  });

  test("a listing elsewhere, a pair or a series is unsupported, and nothing is asked", async () => {
    for (const symbol of ["AAPL", "XNAS:AAPL", "XLON:VOD", "fx:EURUSD"]) {
      const { runTool, fetch } = korea();
      const run = await runTool("statements", { ...STATEMENT, symbol });
      expect(run.failure, symbol).toBe("data_unsupported");
      expect(run.text, symbol).toContain("OpenDART serves Korean listings' statements");
      expect(fetch.requests, symbol).toEqual([]);
    }
  });
});

describe("without DART_API_KEY", () => {
  test("a Korean listing answers not_configured, naming DART_API_KEY, shown as it is; nothing is asked", async () => {
    const { runTool, fetch } = korea(SAMSUNG_ROUTES, {});
    const run = await runTool("statements", STATEMENT);
    expect(run.failure).toBe("data_not_configured");
    expect(run.text).toBe(
      `Reading XKRX:005930's financial statements needs DART_API_KEY (a free key from OpenDART, https://opendart.fss.or.kr/), set in the environment or under "data" in credentials.json.`,
    );
    expect(fetch.requests).toEqual([]);
  });

  test("a bare code is named as asked; any other listing is not this source's either way", async () => {
    const { runTool } = korea(SAMSUNG_ROUTES, {});
    expect((await runTool("statements", { ...STATEMENT, symbol: "005930" })).text).toStartWith(
      "Reading 005930's financial statements needs DART_API_KEY",
    );
    expect((await runTool("statements", { ...STATEMENT, symbol: "AAPL" })).failure).toBe("data_unsupported");
  });
});

// A fiscal year that does not end in December ------------------------------------------------------------------

describe("a fiscal year ending in another month than December", () => {
  /** OpenDART's company list holding an invented KOSDAQ company whose fiscal year ends in March. */
  const MARCH_CORP = "99000001";
  const MARCH_LIST = dart(
    "corpCode.xml",
    {},
    {
      body: zipOf([
        {
          name: "CORPCODE.xml",
          data: new TextEncoder().encode(
            `<?xml version="1.0" encoding="UTF-8"?>\n<result>\n<list>\n<corp_code>${MARCH_CORP}</corp_code>\n<corp_name>가나다상사</corp_name>\n<corp_eng_name>GANADA TRADING CO.,LTD</corp_eng_name>\n<stock_code>990010</stock_code>\n<modify_date>20250331</modify_date>\n</list>\n</result>\n`,
          ),
        },
      ]),
      headers: { "content-type": "application/zip" },
    },
  );
  const outline = (accMt: string | null) =>
    dart(
      "company.json",
      { corp_code: MARCH_CORP },
      accMt === null
        ? NONE
        : answer({
            status: "000",
            message: "정상",
            corp_code: MARCH_CORP,
            corp_name: "(주)가나다상사",
            stock_code: "990010",
            corp_cls: "K",
            acc_mt: accMt,
          }),
    );
  const REPORTS_OF_MARCH = dart(
    "list.json",
    { corp_code: MARCH_CORP },
    answer({
      status: "000",
      message: "정상",
      page_no: 1,
      page_count: 100,
      total_count: 2,
      total_page: 1,
      list: [
        ["분기보고서 (2025.12)", "20260213000101"],
        ["사업보고서 (2026.03)", "20260625000202"],
      ].map(([report_nm, rcept_no]) => ({
        corp_code: MARCH_CORP,
        corp_name: "가나다상사",
        stock_code: "990010",
        corp_cls: "K",
        report_nm,
        rcept_no,
        flr_nm: "가나다상사",
        rcept_dt: rcept_no?.slice(0, 8),
        rm: "코",
      })),
    }),
  );

  test("is unsupported with its month, from the company outline's acc_mt, before any report is asked for", async () => {
    const { runTool, fetch } = korea([MARCH_LIST, outline("03"), REPORTS_OF_MARCH]);
    const run = await runTool("statements", { ...STATEMENT, symbol: "XKOS:990010" });
    expect(run.failure).toBe("data_unsupported");
    expect(run.text).toBe(
      "OpenDART does not cover this request (가나다상사 (GANADA TRADING CO.,LTD)'s fiscal year ends in March (acc_mt 03 in OpenDART's company outline), and OpenDART's statement lines, asked by business year and report code, are placed in periods for fiscal years ending in December); this is not a fact about the market.",
    );
    expect(asked(fetch)).toEqual(["corpCode.xml", "company.json"]);
  });

  test("is unsupported from its latest annual report's period when the outline has no acc_mt", async () => {
    const { runTool, fetch } = korea([MARCH_LIST, outline(null), REPORTS_OF_MARCH]);
    const run = await runTool("statements", { ...STATEMENT, symbol: "990010" });
    expect(run.failure).toBe("data_unsupported");
    expect(run.text).toContain(
      "fiscal year ends in March (its latest annual report, 사업보고서 (2026.03) 20260625000202)",
    );
    expect(asked(fetch).filter((one) => one.startsWith("fnlttSinglAcntAll"))).toEqual([]);
  });

  test("a report's name places it only in a fiscal year ending in December", () => {
    expect(periodicOf("사업보고서 (2025.12)")).toEqual({
      kind: "사업보고서",
      year: 2025,
      month: 12,
      code: "11011",
    });
    expect(periodicOf("반기보고서 (2025.06)")?.code).toBe("11012");
    expect(periodicOf("분기보고서 (2025.03)")?.code).toBe("11013");
    expect(periodicOf("분기보고서 (2025.09)")?.code).toBe("11014");
    expect(periodicOf("[기재정정]사업보고서 (2024.12)")).toEqual({
      kind: "사업보고서",
      year: 2024,
      month: 12,
      code: "11011",
    });
    // A March year's reports: placed in no December year.
    expect(periodicOf("사업보고서 (2026.03)")?.code).toBeUndefined();
    expect(periodicOf("분기보고서 (2025.06)")?.code).toBeUndefined();
    expect(periodicOf("반기보고서 (2025.09)")?.code).toBeUndefined();
    expect(periodicOf("주요사항보고서(자기주식취득결정)")).toBeUndefined();
  });

  test("older reports of a year ending in another month (before a change of fiscal year) are left out, and said", async () => {
    const list = dart(
      "list.json",
      { corp_code: SAMSUNG },
      answer({
        status: "000",
        message: "정상",
        page_no: 1,
        page_count: 100,
        total_count: 2,
        total_page: 1,
        list: [
          ["사업보고서 (2018.03)", "20180628000111"],
          ["사업보고서 (2025.12)", "20260310000812"],
        ].map(([report_nm, rcept_no]) => ({
          corp_code: SAMSUNG,
          corp_name: "삼성전자",
          stock_code: "005930",
          corp_cls: "Y",
          report_nm,
          rcept_no,
          flr_nm: "삼성전자",
          rcept_dt: rcept_no?.slice(0, 8),
          rm: "연",
        })),
      }),
    );
    const { runTool } = korea([CORP_CODES, COMPANY, list, accounts(SAMSUNG, 2025, "11011", "CFS")]);
    const run = await runTool("statements", STATEMENT);
    expect(run.failure).toBeUndefined();
    expect(run.text).toContain(
      "filer 00126380: coverage incomplete (1 periodic report for a period that does not fall in a fiscal year ending in December is not read (the latest: 사업보고서 (2018.03) 20180628000111))",
    );
  });
});

// OpenDART's statuses ----------------------------------------------------------------------------------------

describe("OpenDART's statuses reach the tool as the kinds the router expects", () => {
  const status = (code: string, message: string) => answer({ status: code, message });
  const KINDS: Record<string, string> = {
    rejected: "data_rejected",
    quota: "data_quota",
    invalid: "data_invalid",
    no_data: "data_no_data",
    unavailable: "data_unavailable",
  };

  test("each status of the guide's table, and one it does not list, answered for a report", async () => {
    const statuses = [
      ...Object.entries(DART_STATUS).filter(([code]) => code !== "000" && code !== "013"),
      ["999", { kind: "unavailable", means: "a status the guide does not list" }] as const,
    ];
    for (const [code, { kind }] of statuses) {
      const { runTool, fetch } = korea([
        CORP_CODES,
        COMPANY,
        PERIODIC,
        dart("fnlttSinglAcntAll.json", {}, status(code, `메시지 ${code}`)),
      ]);
      const run = await runTool("statements", STATEMENT);
      expect(run.failure, code).toBe(KINDS[kind as string] as string);
      expect(run.source, code).toBe(DART_SOURCE);
      expect(run.text, code).not.toContain(KEY);
      // The first report asked for answered it, and nothing after.
      expect(asked(fetch), code).toEqual([
        ...START,
        "fnlttSinglAcntAll.json?bsns_year=2025&reprt_code=11011&fs_div=CFS",
      ]);
    }
  });

  test("the words the model reads for a refused key, a spent quota, a field refused and maintenance", async () => {
    const text = async (code: string, message: string) => {
      const { runTool } = korea([
        CORP_CODES,
        COMPANY,
        PERIODIC,
        dart("fnlttSinglAcntAll.json", {}, status(code, message)),
      ]);
      return (await runTool("statements", STATEMENT)).text;
    };
    expect(await text("010", "등록되지 않은 키입니다.")).toBe(
      "OpenDART refused DART_API_KEY (010: 등록되지 않은 키입니다.). A free key comes from https://opendart.fss.or.kr/.",
    );
    expect(await text("020", "요청 제한을 초과하였습니다.")).toBe(
      "OpenDART is out of quota; this is not a fact about the market.",
    );
    expect(await text("100", "필드의 부적절한 값입니다.")).toBe(
      "OpenDART cannot answer this request as asked: OpenDART did not take the request (100: 필드의 부적절한 값입니다.).",
    );
    expect(await text("800", "시스템 점검으로 인한 서비스가 중지 중입니다.")).toBe(
      "OpenDART could not be reached or answered unreadably; this is not a fact about the market. OpenDART could not answer (800: 시스템 점검으로 인한 서비스가 중지 중입니다.).",
    );
  });

  test("a failure of the company outline, the reports' list or the company list is the call's, as its kind", async () => {
    const cases: [FixtureRoute[], string][] = [
      [[CORP_CODES, dart("company.json", {}, status("800", "점검")), PERIODIC], "data_unavailable"],
      [[CORP_CODES, COMPANY, dart("list.json", {}, status("020", "제한"))], "data_quota"],
      [
        [
          dart(
            "corpCode.xml",
            {},
            {
              body: `<?xml version="1.0" encoding="UTF-8"?>\n<result>\n<status>011</status>\n<message>사용할 수 없는 키입니다.</message>\n</result>\n`,
              headers: { "content-type": "application/xml;charset=UTF-8" },
            },
          ),
        ],
        "data_rejected",
      ],
    ];
    for (const [routes, kind] of cases) {
      const { runTool, fetch } = korea(routes);
      const run = await runTool("statements", STATEMENT);
      expect(run.failure).toBe(kind);
      expect(fetch.unmatched).toEqual([]);
    }
  });

  test("an HTTP failure after the retry, or an answer that is not JSON, is unavailable", async () => {
    for (const reply of [
      { body: "upstream down", status: 500 },
      { body: "<html>maintenance</html>", headers: { "content-type": "text/html" } },
    ]) {
      const { runTool, fetch } = korea([
        CORP_CODES,
        COMPANY,
        PERIODIC,
        dart("fnlttSinglAcntAll.json", {}, reply),
      ]);
      const run = await runTool("statements", STATEMENT);
      expect(run.failure).toBe("data_unavailable");
      expect(fetch.unmatched).toEqual([]);
    }
  });

  test("no report holding lines (status 013 on both bases for each) is no_data, naming the reports", async () => {
    const { runTool, fetch } = korea([
      CORP_CODES,
      COMPANY,
      PERIODIC,
      dart("fnlttSinglAcntAll.json", {}, NONE),
    ]);
    const run = await runTool("statements", STATEMENT);
    expect(run.failure).toBe("data_no_data");
    expect(run.text).toBe(
      "OpenDART has no data for this request: OpenDART's financial statements hold no lines for any of 삼성전자 (SAMSUNG ELECTRONICS CO,.LTD)'s 11 reports from business year 2015 (the latest: A001 사업보고서 (2025.12) 20260310000812, received 2026-03-10).",
    );
    // Every annual report listed, consolidated then separate: 2025 back to 2015, 2014's never.
    const reports = asked(fetch).filter((one) => one.startsWith("fnlttSinglAcntAll"));
    expect(reports).toHaveLength(22);
    expect(reports.at(-1)).toBe("fnlttSinglAcntAll.json?bsns_year=2015&reprt_code=11011&fs_div=OFS");
  });

  test("a company OpenDART lists no periodic report of (status 013) is no_data", async () => {
    const { runTool } = korea([CORP_CODES, COMPANY, dart("list.json", {}, NONE)]);
    const run = await runTool("statements", STATEMENT);
    expect(run.failure).toBe("data_no_data");
    expect(run.text).toBe(
      "OpenDART has no data for this request: OpenDART lists no annual, half-year or quarterly report of 삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) for a business year from 2015, the first its financial statements cover.",
    );
  });

  test("a cursor that is not a period end is a request to change, unasked", async () => {
    const { runTool, fetch } = korea();
    const run = await runTool("statements", { ...STATEMENT, after: "20251231" });
    expect(run.failure).toBe("data_invalid");
    expect(run.text).toBe(
      'OpenDART cannot answer this request as asked: after must be a cursor a previous call returned (a period end, YYYY-MM-DD), not "20251231"',
    );
    expect(fetch.requests).toEqual([]);
  });

  test("a cancelled call ends with the caller's own reason", async () => {
    const { statement } = korea();
    const controller = new AbortController();
    const reason = new Error("stopped by the caller");
    controller.abort(reason);
    await expect(
      statement(
        "XKRX:005930",
        { statement: "income_statement", periodType: "annual", limit: 1 },
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
  });
});

// Rows and bases ---------------------------------------------------------------------------------------------

describe("which rows a line reads", () => {
  const LIST = dart(
    "list.json",
    { corp_code: SAMSUNG },
    answer({
      status: "000",
      message: "정상",
      page_no: 1,
      page_count: 100,
      total_count: 1,
      total_page: 1,
      list: [
        {
          corp_code: SAMSUNG,
          corp_name: "삼성전자",
          stock_code: "005930",
          corp_cls: "Y",
          report_nm: "사업보고서 (2025.12)",
          rcept_no: "20260310000812",
          flr_nm: "삼성전자",
          rcept_dt: "20260310",
          rm: "연",
        },
      ],
    }),
  );
  const annual = (rows: unknown[]) =>
    korea([
      CORP_CODES,
      COMPANY,
      LIST,
      accounts(SAMSUNG, 2025, "11011", "CFS", answer({ status: "000", message: "정상", list: rows })),
    ]);

  test("a member's breakdown and a row without a standard id are matched by no line; an id's first row is read", async () => {
    const { runTool } = annual([
      row({
        sj_div: "IS",
        account_id: "ifrs-full_Revenue",
        account_nm: "매출액",
        thstrm_amount: "111",
        ord: "3",
        account_detail: "반도체 [member]",
      }),
      row({
        sj_div: "IS",
        account_id: "-표준계정코드 미사용-",
        account_nm: "매출액",
        thstrm_amount: "222",
        ord: "2",
      }),
      row({
        sj_div: "IS",
        account_id: "dart_OperatingIncomeLoss",
        account_nm: "영업이익",
        thstrm_amount: "40",
        ord: "5",
      }),
      row({
        sj_div: "IS",
        account_id: "dart_OperatingIncomeLoss",
        account_nm: "영업이익",
        thstrm_amount: "50",
        ord: "4",
      }),
    ]);
    const run = await runTool("statements", STATEMENT);
    expect(run.failure).toBeUndefined();
    const lines = (run.payload as { periods: { lines: { line: string; value: number | null }[] }[] })
      .periods[0]?.lines;
    expect(lines).toEqual([expect.objectContaining({ line: "Operating Income (Loss)", value: 50 })]);
  });

  test("a report without an income statement (IS) is read from its comprehensive income statement (CIS)", async () => {
    const { runTool } = annual([
      row({
        sj_div: "CIS",
        account_id: "ifrs-full_Revenue",
        account_nm: "매출액",
        thstrm_amount: "1000",
        ord: "1",
      }),
      row({
        sj_div: "CIS",
        account_id: "ifrs-full_ProfitLoss",
        account_nm: "당기순이익",
        thstrm_amount: "100",
        ord: "2",
      }),
      row({
        sj_div: "CIS",
        account_id: "ifrs-full_ComprehensiveIncome",
        account_nm: "총포괄손익",
        thstrm_amount: "120",
        ord: "3",
      }),
      row({
        sj_div: "BS",
        account_id: "ifrs-full_Assets",
        account_nm: "자산총계",
        thstrm_amount: "5000",
        ord: "4",
      }),
    ]);
    const run = await runTool("statements", STATEMENT);
    expect(run.failure).toBeUndefined();
    // The comprehensive income statement's lines; its total comprehensive income is no line of the catalog's.
    expect(run.text).toEndWith(
      [
        "  Revenue: 1,000 KRW",
        "  Net Income (Loss): 100 KRW (concept: the whole profit or loss (ifrs-full_ProfitLoss): the statement gives no share attributable to the parent's owners)",
        "  Net Income (Loss) Including Noncontrolling Interests: 100 KRW",
      ].join("\n"),
    );
    expect(run.reads.missing()).toEqual([]);
  });

  /** list.json's answer listing these periodic reports, each [its name, its receipt number]. */
  const listing = (reports: readonly (readonly [string, string])[]) =>
    dart(
      "list.json",
      { corp_code: SAMSUNG },
      answer({
        status: "000",
        message: "정상",
        page_no: 1,
        page_count: 100,
        total_count: reports.length,
        total_page: 1,
        list: reports.map(([report_nm, rcept_no]) => ({
          corp_code: SAMSUNG,
          corp_name: "삼성전자",
          stock_code: "005930",
          corp_cls: "Y",
          report_nm,
          rcept_no,
          flr_nm: "삼성전자",
          rcept_dt: rcept_no.slice(0, 8),
          rm: "연",
        })),
      }),
    );
  /** fnlttSinglAcntAll's answer holding `rows`. */
  const lines = (rows: unknown[]) => answer({ status: "000", message: "정상", list: rows });

  test("one currency, the newest report's: rows in another are not read, and the reports holding them are said", async () => {
    const reports = [
      ["사업보고서 (2023.12)", "20240312000736", "2023"],
      ["사업보고서 (2024.12)", "20250311000870", "2024"],
      ["사업보고서 (2025.12)", "20260310000812", "2025"],
    ] as const;
    const amounts: Record<string, [string, string]> = {
      2023: ["300", "USD"],
      2024: ["400", "USD"],
      2025: ["500000", "KRW"],
    };
    const { runTool } = korea([
      CORP_CODES,
      COMPANY,
      listing(reports.map(([name, rcept]) => [name, rcept])),
      ...reports.map(([, rcept, year]) => {
        const [amount, currency] = amounts[year] as [string, string];
        return accounts(
          SAMSUNG,
          Number(year),
          "11011",
          "CFS",
          lines([
            row(
              {
                sj_div: "IS",
                account_id: "ifrs-full_Revenue",
                account_nm: "매출액",
                thstrm_amount: amount,
                currency,
              },
              rcept,
              year,
            ),
          ]),
        );
      }),
    ]);
    const run = await runTool("statements", { ...STATEMENT, periods: 3 });
    expect(run.failure).toBeUndefined();
    const payload = run.payload as { periods: { end: string; lines: { value: number; unit: string }[] }[] };
    expect(
      payload.periods.map((period) => [period.end, period.lines[0]?.value, period.lines[0]?.unit]),
    ).toEqual([["2025-12-31", 500_000, "KRW"]]);
    expect(run.text).toContain(
      "coverage incomplete (the statement is in KRW, the currency of the newest report with lines; rows in another currency are not read: A001 사업보고서 (2024.12) 20250311000870 (USD); A001 사업보고서 (2023.12) 20240312000736 (USD))",
    );
  });

  test("a quarter whose report before it is not listed is not computed, and said; the others are served", async () => {
    // The first quarter's and the third's reports listed, the half year's not: the third quarter's cash flow,
    // the nine months less the six, cannot be computed.
    const { runTool } = korea([
      CORP_CODES,
      COMPANY,
      listing([
        ["분기보고서 (2025.03)", "20250515000351"],
        ["분기보고서 (2025.09)", "20251114002447"],
      ]),
      accounts(
        SAMSUNG,
        2025,
        "11013",
        "CFS",
        lines([
          row(
            {
              sj_div: "CF",
              account_id: "ifrs-full_CashFlowsFromUsedInOperatingActivities",
              account_nm: "영업활동현금흐름",
              thstrm_amount: "15000",
            },
            "20250515000351",
            "2025",
            "11013",
          ),
        ]),
      ),
      accounts(
        SAMSUNG,
        2025,
        "11014",
        "CFS",
        lines([
          row(
            {
              sj_div: "CF",
              account_id: "ifrs-full_CashFlowsFromUsedInOperatingActivities",
              account_nm: "영업활동현금흐름",
              thstrm_amount: "50000",
            },
            "20251114002447",
            "2025",
            "11014",
          ),
        ]),
      ),
    ]);
    const run = await runTool("statements", {
      ...STATEMENT,
      statement: "cash_flow",
      period_type: "quarterly",
      periods: 3,
    });
    expect(run.failure).toBeUndefined();
    expect(run.text).toContain(
      "coverage incomplete (2025-07-01 to 2025-09-30 is not computed: it needs the half-year report (반기보고서) of 2025 (six months to 2025-06-30), which OpenDART does not list)",
    );
    expect((run.payload as { periods: { end: string }[] }).periods.map((period) => period.end)).toEqual([
      "2025-03-31",
    ]);
  });

  test("a line's formula in a quarter: each account's three months, a year to date less the report before it", async () => {
    // DART's cash-flow template: 감가상각비 and 무형자산상각비 apart, for the first quarter and the half year.
    const depreciation = (amount: string, rcept: string, code: string) =>
      row(
        {
          sj_div: "CF",
          account_id: "dart_AdjustmentsForDepreciationExpense",
          account_nm: "감가상각비",
          thstrm_amount: amount,
        },
        rcept,
        "2025",
        code,
      );
    const amortisation = (amount: string, rcept: string, code: string) =>
      row(
        {
          sj_div: "CF",
          account_id: "dart_AdjustmentsForAmortisationExpense",
          account_nm: "무형자산상각비",
          thstrm_amount: amount,
        },
        rcept,
        "2025",
        code,
      );
    const { runTool } = korea([
      CORP_CODES,
      COMPANY,
      listing([
        ["분기보고서 (2025.03)", "20250515000351"],
        ["반기보고서 (2025.06)", "20250814001215"],
      ]),
      accounts(
        SAMSUNG,
        2025,
        "11013",
        "CFS",
        lines([
          depreciation("100", "20250515000351", "11013"),
          amortisation("20", "20250515000351", "11013"),
        ]),
      ),
      accounts(
        SAMSUNG,
        2025,
        "11012",
        "CFS",
        lines([
          depreciation("210", "20250814001215", "11012"),
          amortisation("45", "20250814001215", "11012"),
        ]),
      ),
    ]);
    const run = await runTool("statements", {
      ...STATEMENT,
      statement: "cash_flow",
      period_type: "quarterly",
      periods: 2,
    });
    expect(run.failure).toBeUndefined();
    expect(run.text).toContain(
      "  Depreciation and Amortization: 135 KRW (value: computed: dart_AdjustmentsForDepreciationExpense + dart_AdjustmentsForAmortisationExpense, A002 반기보고서 (2025.06) 20250814001215 (six months to 2025-06-30) less A003 분기보고서 (2025.03) 20250515000351 (three months to 2025-03-31), settled)",
    );
    expect(run.text).toContain(
      "  Depreciation and Amortization: 120 KRW (value: computed: dart_AdjustmentsForDepreciationExpense + dart_AdjustmentsForAmortisationExpense, as filed in A003 분기보고서 (2025.03) 20250515000351, settled)",
    );
    expect(run.reads.missing()).toEqual([]);
  });

  test("a fourth quarter whose reports differ in basis is not computed, and said", async () => {
    const list = dart(
      "list.json",
      { corp_code: SAMSUNG },
      answer({
        status: "000",
        message: "정상",
        page_no: 1,
        page_count: 100,
        total_count: 2,
        total_page: 1,
        list: [
          ["분기보고서 (2025.09)", "20251114002447"],
          ["사업보고서 (2025.12)", "20260310000812"],
        ].map(([report_nm, rcept_no]) => ({
          corp_code: SAMSUNG,
          corp_name: "삼성전자",
          stock_code: "005930",
          corp_cls: "Y",
          report_nm,
          rcept_no,
          flr_nm: "삼성전자",
          rcept_dt: rcept_no?.slice(0, 8),
          rm: "연",
        })),
      }),
    );
    // The year's report consolidated; the nine months' separate only.
    const separate = answer({
      status: "000",
      message: "정상",
      list: [
        row(
          {
            sj_div: "IS",
            account_id: "ifrs-full_Revenue",
            account_nm: "매출액",
            thstrm_amount: "70000",
            thstrm_add_amount: "200000",
          },
          "20251114002447",
          "2025",
          "11014",
        ),
      ],
    });
    const { runTool } = korea([
      CORP_CODES,
      COMPANY,
      list,
      accounts(SAMSUNG, 2025, "11011", "CFS"),
      accounts(SAMSUNG, 2025, "11014", "CFS", NONE),
      accounts(SAMSUNG, 2025, "11014", "OFS", separate),
    ]);
    const run = await runTool("statements", { ...STATEMENT, period_type: "quarterly", periods: 2 });
    expect(run.failure).toBeUndefined();
    expect(run.text).toContain(
      "coverage incomplete (2025-10-01 to 2025-12-31 is not computed: A001 사업보고서 (2025.12) 20260310000812 is consolidated (CFS) and A003 분기보고서 (2025.09) 20251114002447 separate (OFS))",
    );
    // The third quarter is served from its own report, separate, and said.
    expect(run.text).toContain(
      "  Revenue: 70,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)",
    );
  });
});

// Keys --------------------------------------------------------------------------------------------------------

describe("DART_API_KEY travels only in OpenDART's query", () => {
  test("never in a cache key, a cache file, an answer, a message or a link", async () => {
    const keys: string[] = [];
    const inner = createCache({ secrets: [KEY] });
    const watched: Cache = {
      keep: <T>(key: string, ttlMs: number, load: () => Promise<T>, options?: KeepOptions) => {
        keys.push(key);
        return inner.keep(key, ttlMs, load, options);
      },
      remember: <T>(key: string, ttlMs: number, load: () => Promise<T>, options?: KeepOptions) => {
        keys.push(key);
        return inner.remember(key, ttlMs, load, options);
      },
      forget: (key: string) => inner.forget(key),
    };
    const { runTool, fetch } = korea(SAMSUNG_ROUTES, DART, { cache: watched });
    const said: string[] = [];
    for (const statement of ["income_statement", "balance_sheet", "cash_flow"]) {
      for (const period_type of ["annual", "quarterly"]) {
        const run = await runTool("statements", { ...STATEMENT, statement, period_type, periods: 3 });
        said.push(run.text, JSON.stringify(run.payload), JSON.stringify(run.provenance));
      }
    }
    said.push((await runTool("statements", { ...STATEMENT, symbol: "XKRX:069500" })).text);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).not.toContain(KEY);
    for (const text of said) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("opendart.fss.or.kr/api");
    }
    for (const { url } of fetch.requests) expect(new URL(url).searchParams.get("crtfc_key")).toBe(KEY);

    // On disk: the company list, the outline and the settled reports, none holding the key.
    const dir = await mkdtemp(join(tmpdir(), "fork-dart-statements-"));
    try {
      const { runTool: onDisk } = korea(SAMSUNG_ROUTES, { ...DART, cacheDir: dir });
      expect((await onDisk("statements", { ...STATEMENT, periods: 3 })).failure).toBeUndefined();
      const files = await readdir(dir, { recursive: true });
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const text = await readFile(join(dir, file)).then(
          (bytes) => bytes.toString("utf8"),
          () => "",
        );
        expect(text).not.toContain(KEY);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no fixture holds a key: every OpenDART address in their metas has crtfc_key=***", async () => {
    const dir = join(FIXTURES, STATEMENT_FIXTURES);
    for (const file of await readdir(dir)) {
      expect(await readFile(join(dir, file), "utf8"), file).not.toContain(KEY);
      if (!file.endsWith(".meta.json")) continue;
      const meta = JSON.parse(await readFile(join(dir, file), "utf8")) as { url: string; hand_made: boolean };
      expect(new URL(meta.url).searchParams.get("crtfc_key"), file).toBe("***");
      expect(meta.hand_made, file).toBe(true);
    }
  });
});

// The recorder's cases -----------------------------------------------------------------------------------------

describe("the recorder's cases (scripts/fork/fixture-cases/dart-statements.ts)", () => {
  const dryRun = async (env: Record<string, string>) => {
    const home = await mkdtemp(join(tmpdir(), "fork-dart-statements-cases-"));
    const said: string[] = [];
    const sent: string[] = [];
    try {
      const status = await record({
        argv: ["--dry-run", "--only", "dart-statements"],
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

  test("--dry-run lists each case, its files and its address with the key removed, and sends nothing", async () => {
    const { status, said, sent } = await dryRun({ DART_API_KEY: KEY });
    expect(status).toBe(0);
    expect(sent).toEqual([]);
    expect(said).toHaveLength(STATEMENT_CASES.length);
    for (const [at, one] of STATEMENT_CASES.entries()) {
      const meta = fixtureMeta(`${STATEMENT_FIXTURES}/${one.file}`);
      const line = said[at] as string;
      expect(line).toContain(`/${one.file} and `);
      expect(line).toContain(`/${one.name}.meta.json <- `);
      expect(line.endsWith(` <- ${meta?.url}`)).toBe(true);
    }
    expect(said.join("\n")).not.toContain(KEY);
  });

  test("without DART_API_KEY no case has an address, so none would be sent", async () => {
    const { status, said, sent } = await dryRun({});
    expect(status).toBe(0);
    expect(sent).toEqual([]);
    expect(said.every((line) => line.endsWith("<- DART_API_KEY is not set"))).toBe(true);
  });

  test("each case reads, offline, what its fixture holds: one case a fixture, each fixture a case", async () => {
    const files = (await readdir(join(FIXTURES, STATEMENT_FIXTURES)))
      .filter((name) => !name.endsWith(".meta.json"))
      .sort();
    expect(STATEMENT_CASES.map((one) => one.file).sort()).toEqual(files);
    expect(new Set(STATEMENT_CASES.map((one) => one.folder))).toEqual(new Set([STATEMENT_FIXTURES]));
    const routes = [
      PERIODIC,
      ...REPORTS.map(([year, code]) => accounts(SAMSUNG, year, code, "CFS")),
      accounts("00258689", 2025, "11011", "OFS"),
    ];
    const { deps } = testDeps(DART, routes);
    const tools = { yahoo: deps.yahoo, yahooAnswer: yahooAnswerer(fixtureFetch([])) };
    for (const one of STATEMENT_CASES) {
      const recorded = await recordOne(one, deps.http, tools, [KEY], DART);
      const file = `${STATEMENT_FIXTURES}/${one.file}`;
      expect(recorded.meta.url, file).toBe(fixtureMeta(file)?.url as string);
      expect(new TextDecoder().decode(recorded.body), file).toBe(new TextDecoder().decode(fixture(file)));
    }
  });
});

// A failure is never no_data for a listing OpenDART does not hold -----------------------------------------------

test("the provider's own failures, read directly: kinds the router passes on for listings it does not hold", async () => {
  const { statement } = korea();
  const query = { statement: "income_statement" as const, periodType: "annual" as const, limit: 1 };
  const fund = await failure(statement("XKRX:069500", query));
  const us = await failure(statement("AAPL", query));
  expect([fund.kind, us.kind]).toEqual(["unsupported", "unsupported"]);
  expect([fund.details.source, us.details.source]).toEqual([DART_SOURCE, DART_SOURCE]);
});
