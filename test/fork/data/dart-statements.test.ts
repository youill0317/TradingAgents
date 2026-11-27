// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Korean companies' statements from OpenDART (src/fork/data/providers/dart-statements.ts), through the real
 * statements and dcf tools in a ToolRegistry (the harness), on hand-made fixtures in OpenDART's documented format
 * (test/fork/fixtures/dart-statements, and the DART client's company list and Samsung Electronics' outline in
 * test/fork/fixtures/dart): the text the model reads, every field the tools read supplied (the read check), the
 * requests made, and the rules the values follow. Samsung Electronics (XKRX:005930): its 2023 annual report and
 * every report of 2024, 2025 and 2026's first three, whose numbers add up across the reports (a fourth quarter is
 * the year less nine months, a cash-flow quarter the difference of two years to date); JYP Entertainment
 * (XKOS:035900), whose consolidated statements OpenDART answers it has none of, read separate; a year OpenDART
 * holds no lines for, passed over and said.
 */
import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../../../src/data/capabilities.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import { dartStatements } from "../../../src/fork/data/providers/dart-statements.js";
import {
  FILERS_WITH_DART,
  filersProvider,
  statementsNeedSec,
} from "../../../src/fork/data/providers/filers.js";
import { DART_SOURCE } from "../../../src/fork/data/sources/dart.js";
import { SEC_TICKERS_URL } from "../../../src/fork/data/sources/sec-tickers.js";
import { buildTools, type FixtureFetch, type FixtureRoute, type TestOptions, testDeps } from "./harness.js";

/** A key in OpenDART's form (40 characters): it must never be said anywhere but in a request's query. */
const KEY = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const DART: PublicDataConfig = { dartKey: KEY };
const SAMSUNG = "00126380";
const JYP = "00258689";
const JSON_TYPE = { "content-type": "application/json;charset=UTF-8" };

/** OpenDART's `service` asked with every one of `params` (others may be asked too), answered by `answer`. */
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

/** An answer of OpenDART's written here, as JSON. */
const answer = (body: unknown): Omit<FixtureRoute, "match"> => ({
  body: JSON.stringify(body),
  headers: JSON_TYPE,
});

/** OpenDART's status 013: no data for the request. */
const NONE = answer({ status: "013", message: "조회된 데이타가 없습니다." });

/** One report's lines on one basis, answered by `with` (its fixture unless given). */
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

/** Samsung Electronics' reports the fixtures hold. */
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

/**
 * The statements method as the filers provider serves it for Korean listings, the only provider (other providers
 * are other tests' business), its tools with the read check, and what was asked.
 */
function korea(
  routes: readonly FixtureRoute[] = SAMSUNG_ROUTES,
  config: PublicDataConfig = DART,
  extra: TestOptions = {},
) {
  const { deps, fetch } = testDeps(config, routes, extra);
  const provider: DataProvider = {
    name: DART_SOURCE,
    capabilities: { statements: { statement: dartStatements(deps) } },
  };
  return { ...buildTools({ filers: provider }, { check: true }), fetch, deps };
}

/** The requests made: OpenDART's by service and the parameters that tell them apart (the key left out). */
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

/** A report's request as `asked` writes it. */
const report = (year: number, code: string, basis = "CFS") =>
  `fnlttSinglAcntAll.json?bsns_year=${year}&reprt_code=${code}&fs_div=${basis}`;

const START = [
  "corpCode.xml",
  "company.json",
  "list.json?bgn_de=20150101&pblntf_ty=A&sort=date&sort_mth=asc&page_no=1",
];

/** One golden call: the text the model reads, every field the tool read supplied, no request unanswered. */
async function golden(input: Record<string, unknown>, expected: string, routes = SAMSUNG_ROUTES) {
  const { runTool, fetch } = korea(routes);
  const run = await runTool("statements", input);
  expect(run.failure).toBeUndefined();
  expect(run.text).toBe(expected);
  expect(run.reads.missing()).toEqual([]);
  expect(fetch.unmatched).toEqual([]);
  expect(run.text).not.toContain(KEY);
  expect(JSON.stringify(run.payload)).not.toContain(KEY);
  return { run, fetch };
}

type Payload = {
  periods: {
    start: string | null;
    end: string;
    label: string;
    filings: string[];
    from_annual_report: boolean;
    lines: { line: string; value: number | null; unit: string | null; notes?: string }[];
  }[];
  next_cursor: string | null;
};

describe("Samsung Electronics' statements as the model reads them", () => {
  test("its latest three years: each line as its annual report files it, the report and its receipt named", async () => {
    const { run, fetch } = await golden(
      { symbol: "XKRX:005930", statement: "income_statement", period_type: "annual", periods: 3 },
      GOLDEN.incomeAnnual,
    );
    // The company list, the outline, the reports listed, and one annual report a year.
    expect(asked(fetch)).toEqual([
      ...START,
      report(2025, "11011"),
      report(2024, "11011"),
      report(2023, "11011"),
    ]);
    expect(run.source).toBe(DART_SOURCE);
    const periods = (run.payload as Payload).periods;
    expect(periods.map((period) => [period.start, period.end])).toEqual([
      ["2025-01-01", "2025-12-31"],
      ["2024-01-01", "2024-12-31"],
      ["2023-01-01", "2023-12-31"],
    ]);
  });

  test("a quarter's income statement is its report's three months, labelled by the year it falls in", async () => {
    const { run, fetch } = await golden(
      { symbol: "XKRX:005930", statement: "income_statement", period_type: "quarterly", periods: 3 },
      GOLDEN.incomeQuarters2026,
    );
    // The three reports, then the annual ones the tool labels fiscal quarters by.
    expect(asked(fetch)).toEqual([
      ...START,
      report(2026, "11014"),
      report(2026, "11012"),
      report(2026, "11013"),
      report(2025, "11011"),
      report(2024, "11011"),
      report(2023, "11011"),
    ]);
    expect((run.payload as Payload).periods.map((period) => period.label)).toEqual([
      "fiscal Q3 of the year ending around December 2026",
      "fiscal Q2 of the year ending around December 2026",
      "fiscal Q1 of the year ending around December 2026",
    ]);
  });

  test("a fourth quarter is the year less the nine months, naming both reports; per-share figures are not computed", async () => {
    const { run, fetch } = await golden(
      {
        symbol: "XKRX:005930",
        statement: "income_statement",
        period_type: "quarterly",
        periods: 1,
        after: "2026-03-31",
      },
      GOLDEN.incomeQ4of2025,
    );
    const period = (run.payload as Payload).periods[0];
    // Its values come from an annual and a quarterly report: not a quarter an annual report gives whole.
    expect(period?.from_annual_report).toBe(false);
    expect(period?.filings).toEqual([
      "A001 사업보고서 (2025.12) 20260310000812 accepted 2026-03-10",
      "A003 분기보고서 (2025.09) 20251114002447 accepted 2025-11-14",
    ]);
    // The fixtures' quarters add up: 2025's fourth quarter as made, the year less its first three.
    const value = (name: string) => period?.lines.find((line) => line.line === name)?.value;
    expect(value("Revenue")).toBe(
      314_512_893_000_000 - 79_140_502_000_000 - 74_566_211_000_000 - 86_061_307_000_000,
    );
    expect(value("Operating Income (Loss)")).toBe(14_072_741_000_000);
    expect(value("EPS (Basic)")).toBeNull();
    // The two reports the quarter needs, and the newest report, whose currency the statement is in whatever the
    // page.
    expect(asked(fetch).slice(3, 6)).toEqual([
      report(2025, "11011"),
      report(2026, "11014"),
      report(2025, "11014"),
    ]);
  });

  test("2024, read whole: its fourth quarter computed from its annual and third-quarter reports, its others filed", async () => {
    const { run } = await golden(
      {
        symbol: "005930",
        statement: "income_statement",
        period_type: "quarterly",
        periods: 3,
        after: "2025-03-31",
      },
      GOLDEN.incomeQuarters2024,
    );
    const revenue = (run.payload as Payload).periods.map(
      (period) => period.lines.find((line) => line.line === "Revenue")?.value,
    );
    // Samsung Electronics' 2024 revenue by quarter, which add up to its year (300,870,903 million won).
    expect(revenue).toEqual([75_788_274_000_000, 79_098_726_000_000, 74_068_302_000_000]);
  });

  test("a cash-flow quarter is the difference of two reports' year to date; the first quarter is filed as it is", async () => {
    const { fetch } = await golden(
      { symbol: "XKRX:005930", statement: "cash_flow", period_type: "quarterly", periods: 3 },
      GOLDEN.cashQuarters2026,
    );
    expect(asked(fetch).slice(3, 6)).toEqual([
      report(2026, "11014"),
      report(2026, "11012"),
      report(2026, "11013"),
    ]);
  });

  test("a fourth quarter's cash flow is the year less the nine months", async () => {
    await golden(
      {
        symbol: "XKRX:005930",
        statement: "cash_flow",
        period_type: "quarterly",
        periods: 1,
        after: "2026-03-31",
      },
      GOLDEN.cashQ4of2025,
    );
  });

  test("a balance sheet is a report's at its period end; short- and long-term debt are summed from their parts", async () => {
    await golden(
      { symbol: "XKRX:005930", statement: "balance_sheet", period_type: "quarterly", periods: 1 },
      GOLDEN.balanceQ3of2026,
    );
    const { run } = await golden(
      {
        symbol: "XKRX:005930",
        statement: "balance_sheet",
        period_type: "quarterly",
        periods: 1,
        after: "2026-03-31",
      },
      GOLDEN.balanceYearEnd2025,
    );
    expect((run.payload as Payload).periods[0]).toMatchObject({ start: null, end: "2025-12-31" });
  });

  test("the annual balance sheet and cash flow", async () => {
    await golden(
      { symbol: "XKRX:005930", statement: "balance_sheet", period_type: "annual", periods: 1 },
      GOLDEN.balanceAnnual,
    );
    await golden(
      { symbol: "XKRX:005930", statement: "cash_flow", period_type: "annual", periods: 2 },
      GOLDEN.cashAnnual,
    );
  });

  test("the annual cash flow feeds dcf: operating cash flow less capital expenditure, whatever its sign", async () => {
    const { runTool, fetch } = korea();
    const statement = await runTool("statements", {
      symbol: "XKRX:005930",
      statement: "cash_flow",
      period_type: "annual",
      periods: 1,
    });
    expect(statement.failure).toBeUndefined();
    expect(statement.reads.missing()).toEqual([]);
    const dcf = await runTool("dcf", {
      cash_flow: { ref: statement.evidence },
      stages: [{ years: 5, growth_pct: 5 }],
      terminal_growth_pct: 2,
      discount: { rate_pct: 9 },
      net_debt: -100_000_000_000_000,
      shares: 6_735_000_000,
    });
    expect(dcf.failure).toBeUndefined();
    expect((dcf.payload as { inputs: { name: string; value: number }[] }).inputs.slice(0, 2)).toEqual([
      expect.objectContaining({ name: "Net Cash from Operating Activities", value: 71_832_516_000_000 }),
      expect.objectContaining({ name: "Payments to Acquire PP&E", value: -52_290_000_000_000 }),
    ]);
    expect(dcf.text).toContain("71,832,516,000,000");
    expect(fetch.unmatched).toEqual([]);
  });

  test("XKRX:005930, 005930 and 005930.KS name the same company, answered as XKRX:005930 on KOSPI", async () => {
    for (const symbol of ["XKRX:005930", "005930", "005930.KS", "security:XKRX:005930"]) {
      const { runTool, fetch } = korea();
      const run = await runTool("statements", {
        symbol,
        statement: "income_statement",
        period_type: "annual",
        periods: 1,
      });
      expect(run.failure).toBeUndefined();
      expect(run.text).toContain("삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW)");
      expect(fetch.unmatched).toEqual([]);
    }
  });
});

describe("every statement in each period type, as the model reads it", () => {
  test("each answers from its reports, with every field the tool reads supplied and no key anywhere", async () => {
    const { runTool, fetch } = korea();
    // Each page the fixtures answer whole: the latest years, and the quarters of each year from 2024.
    const pages = [
      { period_type: "annual", periods: 3 },
      { period_type: "annual", periods: 2, after: "2025-12-31" },
      { period_type: "quarterly", periods: 3 },
      { period_type: "quarterly", periods: 3, after: "2026-01-01" },
      { period_type: "quarterly", periods: 3, after: "2025-03-31" },
      { period_type: "quarterly", periods: 3, after: "2024-12-31" },
    ];
    for (const statement of ["income_statement", "balance_sheet", "cash_flow"]) {
      for (const { period_type, periods, after } of pages) {
        const run = await runTool("statements", {
          symbol: "XKRX:005930",
          statement,
          period_type,
          periods,
          ...(after ? { after } : {}),
        });
        expect(run.failure, `${statement} ${period_type} ${after}`).toBeUndefined();
        expect(run.reads.missing(), `${statement} ${period_type} ${after}`).toEqual([]);
        const payload = run.payload as Payload;
        expect(payload.periods.length, `${statement} ${period_type} ${after}`).toBeGreaterThan(0);
        for (const period of payload.periods) {
          expect(period.filings.length).toBeGreaterThan(0);
          expect(period.start === null).toBe(statement === "balance_sheet");
        }
        expect(`${run.text}${JSON.stringify(run.payload)}${JSON.stringify(run.provenance)}`).not.toContain(
          KEY,
        );
      }
    }
    expect(fetch.unmatched).toEqual([]);
    // Each report read once, however many calls read it.
    const reports = asked(fetch).filter((one) => one.startsWith("fnlttSinglAcntAll"));
    expect(new Set(reports).size).toBe(reports.length);
  });
});

describe("what OpenDART holds of a company's reports", () => {
  /** JYP Entertainment's outline and reports, as OpenDART answers them. */
  const JYP_ROUTES: FixtureRoute[] = [
    CORP_CODES,
    dart(
      "company.json",
      { corp_code: JYP },
      answer({
        status: "000",
        message: "정상",
        corp_code: JYP,
        corp_name: "(주)제이와이피엔터테인먼트",
        corp_name_eng: "JYP Entertainment Corporation",
        stock_name: "JYP Ent.",
        stock_code: "035900",
        corp_cls: "K",
        acc_mt: "12",
      }),
    ),
    dart(
      "list.json",
      { corp_code: JYP, bgn_de: "20150101", pblntf_ty: "A" },
      answer({
        status: "000",
        message: "정상",
        page_no: 1,
        page_count: 100,
        total_count: 2,
        total_page: 1,
        list: [
          ["사업보고서 (2024.12)", "20250318000538"],
          ["사업보고서 (2025.12)", "20260317000412"],
        ].map(([report_nm, rcept_no]) => ({
          corp_code: JYP,
          corp_name: "제이와이피엔터테인먼트",
          stock_code: "035900",
          corp_cls: "K",
          report_nm,
          rcept_no,
          flr_nm: "제이와이피엔터테인먼트",
          rcept_dt: rcept_no?.slice(0, 8),
          rm: "코연",
        })),
      }),
    ),
    // Consolidated statements OpenDART answers it has none of: the separate ones are read.
    accounts(JYP, 2025, "11011", "CFS", NONE),
    accounts(JYP, 2025, "11011", "OFS"),
  ];

  test("separate statements when OpenDART has no consolidated ones (status 013), said on each value", async () => {
    const { fetch } = await golden(
      { symbol: "XKOS:035900", statement: "income_statement", period_type: "annual", periods: 1 },
      GOLDEN.jypSeparate,
      JYP_ROUTES,
    );
    expect(asked(fetch).slice(3)).toEqual([report(2025, "11011", "CFS"), report(2025, "11011", "OFS")]);
  });

  test("DART's own template ids: depreciation and amortisation added up, treasury shares bought, trade payables", async () => {
    const { run } = await golden(
      { symbol: "XKOS:035900", statement: "cash_flow", period_type: "annual", periods: 1 },
      GOLDEN.jypSeparateCashFlow,
      JYP_ROUTES,
    );
    const lines = (run.payload as Payload).periods[0]?.lines ?? [];
    const value = (name: string) => lines.find((line) => line.line === name)?.value;
    // 감가상각비 and 무형자산상각비 as the fixture files them.
    expect(value("Depreciation and Amortization")).toBe(8_512_000_000 + 3_204_000_000);
    expect(value("Repurchase of Common Stock")).toBe(-434_000_000);
  });

  test("a separate balance sheet's equity is the whole equity, said; its market is OpenDART's (KOSDAQ)", async () => {
    const { run } = await golden(
      { symbol: "035900", statement: "balance_sheet", period_type: "annual", periods: 1 },
      GOLDEN.jypSeparateBalance,
      JYP_ROUTES,
    );
    expect(run.text).toContain("(XKOS:035900, KOSDAQ, KRW)");
  });

  test("a year OpenDART holds no lines for is passed over and said; the years around it are served", async () => {
    // 2022's annual report answers 013 on both bases; 2021's holds three lines.
    const routes: FixtureRoute[] = [
      ...SAMSUNG_ROUTES,
      accounts(SAMSUNG, 2022, "11011", "CFS", NONE),
      accounts(SAMSUNG, 2022, "11011", "OFS", NONE),
      accounts(
        SAMSUNG,
        2021,
        "11011",
        "CFS",
        answer({
          status: "000",
          message: "정상",
          list: [
            ["ifrs-full_Revenue", "수익(매출액)", "279604799000000"],
            ["dart_OperatingIncomeLoss", "영업이익", "51633856000000"],
            ["ifrs-full_ProfitLoss", "당기순이익(손실)", "39907450000000"],
          ].map(([account_id, account_nm, thstrm_amount], at) => ({
            rcept_no: "20220308000798",
            reprt_code: "11011",
            bsns_year: "2021",
            corp_code: SAMSUNG,
            sj_div: "IS",
            sj_nm: "손익계산서",
            account_id,
            account_nm,
            account_detail: "-",
            thstrm_nm: "제 53 기",
            thstrm_amount,
            ord: String(at + 1),
            currency: "KRW",
          })),
        }),
      ),
    ];
    const { fetch } = await golden(
      {
        symbol: "XKRX:005930",
        statement: "income_statement",
        period_type: "annual",
        periods: 2,
        after: "2024-12-31",
      },
      GOLDEN.missingYear,
      routes,
    );
    // The newest annual report too, whose currency the statement is in whatever the page.
    expect(asked(fetch).slice(3)).toEqual([
      report(2023, "11011"),
      report(2025, "11011"),
      report(2022, "11011", "CFS"),
      report(2022, "11011", "OFS"),
      report(2021, "11011"),
    ]);
  });

  test("the first business year OpenDART's statements serve is 2015: earlier reports are not asked for, and said", async () => {
    const routes: FixtureRoute[] = [
      ...SAMSUNG_ROUTES,
      accounts(
        SAMSUNG,
        2015,
        "11011",
        "CFS",
        answer({
          status: "000",
          message: "정상",
          list: [
            {
              rcept_no: "20160330001132",
              reprt_code: "11011",
              bsns_year: "2015",
              corp_code: SAMSUNG,
              sj_div: "IS",
              sj_nm: "손익계산서",
              account_id: "ifrs-full_Revenue",
              account_nm: "수익(매출액)",
              account_detail: "-",
              thstrm_nm: "제 47 기",
              thstrm_amount: "200653482000000",
              ord: "1",
              currency: "KRW",
            },
          ],
        }),
      ),
    ];
    const { fetch } = await golden(
      {
        symbol: "XKRX:005930",
        statement: "income_statement",
        period_type: "annual",
        periods: 3,
        after: "2016-12-31",
      },
      GOLDEN.firstYear,
      routes,
    );
    // The newest annual report too, whose currency the statement is in whatever the page.
    expect(asked(fetch).slice(3)).toEqual([report(2015, "11011"), report(2025, "11011")]);
  });

  test("a page past the last report OpenDART lists has no periods", async () => {
    const { runTool, fetch } = korea();
    const run = await runTool("statements", {
      symbol: "XKRX:005930",
      statement: "income_statement",
      period_type: "annual",
      after: "2015-12-31",
    });
    expect(run.failure).toBeUndefined();
    expect(run.text).toContain("No periods in this range.");
    expect((run.payload as Payload).next_cursor).toBeNull();
    // 2014's annual report is listed (received in 2015) and not asked for.
    expect(asked(fetch)).toEqual(START);
  });
});

/** The texts the model reads, from the fixtures as made. */
/** SEC EDGAR's ticker list (hand-made), Apple's filing index and XBRL facts (saved). */
const SEC_ROUTES: FixtureRoute[] = [
  { match: SEC_TICKERS_URL, file: "sec/company-tickers-exchange.json" },
  { match: "https://data.sec.gov/submissions/CIK0000320193.json", file: "sec/submissions-aapl.json" },
  {
    match: "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
    file: "sec/companyfacts-aapl.json",
  },
];

/** The filers provider as a setup with `config` builds it, its tools with the read check, and what was asked. */
function filers(config: PublicDataConfig) {
  const { deps, fetch } = testDeps(config, [...SAMSUNG_ROUTES, ...SEC_ROUTES]);
  const provider = filersProvider(deps);
  return { ...buildTools({ filers: provider }, { check: true }), provider, fetch };
}

describe("through the filers provider, beside SEC EDGAR", () => {
  const UA = "Test Agent test@example.com";
  const annual = { symbol: "XKRX:005930", statement: "income_statement", period_type: "annual", periods: 3 };

  test("with DART_API_KEY alone, a Korean listing's statements are OpenDART's, as the method answers them", async () => {
    const { runTool, provider, fetch } = filers(DART);
    expect(provider.name).toBe(FILERS_WITH_DART);
    const run = await runTool("statements", annual);
    expect(run.failure).toBeUndefined();
    expect(run.text).toBe(GOLDEN.incomeAnnual.replace("source: OpenDART", `source: ${FILERS_WITH_DART}`));
    expect(run.reads.missing()).toEqual([]);
    expect(fetch.unmatched).toEqual([]);
  });

  test("with DART_API_KEY alone, a US listing's statements say what to set, and one elsewhere is no filer's", async () => {
    const { runTool, fetch } = filers(DART);
    const us = await runTool("statements", { symbol: "AAPL", statement: "income_statement" });
    expect(us.failure).toBe("data_not_configured");
    expect(us.text).toBe(statementsNeedSec("AAPL").message);
    expect(us.text).toStartWith(
      "A US company's financial statements come from SEC EDGAR, which is read only with SEC_USER_AGENT set",
    );
    expect(us.text).toEndWith("Statements of Korean listings are served from OpenDART.");
    const london = await runTool("statements", { symbol: "XLON:VOD", statement: "income_statement" });
    expect(london.failure).toBe("data_unsupported");
    expect(london.text).toContain("XLON:VOD is not a US listing");
    // Neither asked anyone anything.
    expect(fetch.requests).toEqual([]);
  });

  test("with both, a US listing takes SEC EDGAR's path as without DART_API_KEY, and a Korean one OpenDART's", async () => {
    const sec = filers({ secUserAgent: UA });
    const both = filers({ ...DART, secUserAgent: UA });
    const input = { symbol: "AAPL", statement: "cash_flow", period_type: "annual", periods: 1 };
    const alone = await sec.runTool("statements", input);
    const beside = await both.runTool("statements", input);
    expect(alone.failure).toBeUndefined();
    expect(beside.text.replace(`source: ${FILERS_WITH_DART}`, "source: SEC EDGAR")).toBe(alone.text);
    expect(both.fetch.requests.some((request) => request.url.includes("opendart"))).toBe(false);
    // The second call of the setup: its record is e2.
    const korean = await both.runTool("statements", annual);
    expect(korean.text).toBe(
      GOLDEN.incomeAnnual
        .replaceAll('"e1"', '"e2"')
        .replace("[e1]", "[e2]")
        .replace("source: OpenDART", `source: ${FILERS_WITH_DART}`),
    );
    expect(both.fetch.unmatched).toEqual([]);
  });

  test("without DART_API_KEY a Korean listing's statements say to set it; nothing is asked of anyone", async () => {
    const { runTool, provider, fetch } = filers({ secUserAgent: UA });
    expect(provider.name).toBe("SEC EDGAR");
    const run = await runTool("statements", annual);
    expect(run.failure).toBe("data_not_configured");
    expect(run.text).toBe(
      `Reading XKRX:005930's financial statements needs DART_API_KEY (a free key from OpenDART, https://opendart.fss.or.kr/), set in the environment or under "data" in credentials.json.`,
    );
    expect(fetch.requests).toEqual([]);
  });
});

const GOLDEN = {
  incomeAnnual: `[e1] statements XKRX:005930 income statement, annual (as of Wednesday 2025-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): income statement, annual, 3 periods
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
2025-01-01 to 2025-12-31, fiscal year ending 2025-12-31 (from A001 사업보고서 (2025.12) 20260310000812 accepted 2026-03-10)
  Revenue: 314,512,893,000,000 KRW
  Cost of Revenue: 184,071,842,000,000 KRW
  Gross Profit: 130,441,051,000,000 KRW
  Selling, General and Administrative: 86,840,000,000,000 KRW
  Operating Income (Loss): 43,601,051,000,000 KRW
  Interest Expense: 17,730,000,000,000 KRW (concept: finance costs (ifrs-full_FinanceCosts): what the statement classifies as finance costs, interest among them)
  Income (Loss) Before Income Taxes: 45,380,000,000,000 KRW
  Income Tax Expense (Benefit): 7,465,615,000,000 KRW
  Net Income (Loss): 36,966,525,000,000 KRW
  Net Income (Loss) Including Noncontrolling Interests: 37,914,385,000,000 KRW
  EPS (Basic): 5,489 KRW/shares
  EPS (Diluted): 5,489 KRW/shares
2024-01-01 to 2024-12-31, fiscal year ending 2024-12-31 (from A001 사업보고서 (2024.12) 20250311001085 accepted 2025-03-11)
  Revenue: 300,870,903,000,000 KRW
  Cost of Revenue: 185,614,942,000,000 KRW
  Gross Profit: 115,255,961,000,000 KRW
  Selling, General and Administrative: 82,530,000,000,000 KRW
  Operating Income (Loss): 32,725,961,000,000 KRW
  Interest Expense: 13,250,000,000,000 KRW (concept: finance costs (ifrs-full_FinanceCosts): what the statement classifies as finance costs, interest among them)
  Income (Loss) Before Income Taxes: 39,700,000,000,000 KRW
  Income Tax Expense (Benefit): 5,248,649,000,000 KRW
  Net Income (Loss): 33,621,074,000,000 KRW
  Net Income (Loss) Including Noncontrolling Interests: 34,451,351,000,000 KRW
  EPS (Basic): 4,950 KRW/shares
  EPS (Diluted): 4,950 KRW/shares
2023-01-01 to 2023-12-31, fiscal year ending 2023-12-31 (from A001 사업보고서 (2023.12) 20240312000736 accepted 2024-03-12)
  Revenue: 258,935,494,000,000 KRW
  Cost of Revenue: 174,218,518,000,000 KRW
  Gross Profit: 84,716,976,000,000 KRW
  Selling, General and Administrative: 78,150,000,000,000 KRW
  Operating Income (Loss): 6,566,976,000,000 KRW
  Interest Expense: 11,570,000,000,000 KRW (concept: finance costs (ifrs-full_FinanceCosts): what the statement classifies as finance costs, interest among them)
  Income (Loss) Before Income Taxes: 11,006,277,000,000 KRW
  Income Tax Expense (Benefit): -4,480,823,000,000 KRW
  Net Income (Loss): 14,472,695,000,000 KRW
  Net Income (Loss) Including Noncontrolling Interests: 15,487,100,000,000 KRW
  EPS (Basic): 2,131 KRW/shares
  EPS (Diluted): 2,131 KRW/shares
next periods: statements with after=2023-12-31, periods=3`,
  incomeQuarters2026: `[e1] statements XKRX:005930 income statement, quarterly (as of Wednesday 2026-09-30; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): income statement, quarterly, 3 periods
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
2026-07-01 to 2026-09-30, fiscal Q3 of the year ending around December 2026 (from A003 분기보고서 (2026.09) 20261113001877 accepted 2026-11-13)
  Revenue: 91,744,208,000,000 KRW
  Cost of Revenue: 54,680,246,000,000 KRW
  Gross Profit: 37,063,962,000,000 KRW
  Selling, General and Administrative: 23,050,000,000,000 KRW
  Operating Income (Loss): 14,013,962,000,000 KRW
  Interest Expense: 4,540,000,000,000 KRW (concept: finance costs (ifrs-full_FinanceCosts): what the statement classifies as finance costs, interest among them)
  Income (Loss) Before Income Taxes: 14,620,000,000,000 KRW
  Income Tax Expense (Benefit): 2,289,519,000,000 KRW
  Net Income (Loss): 12,022,219,000,000 KRW
  Net Income (Loss) Including Noncontrolling Interests: 12,330,481,000,000 KRW
  EPS (Basic): 1,785 KRW/shares
  EPS (Diluted): 1,785 KRW/shares
2026-04-01 to 2026-06-30, fiscal Q2 of the year ending around December 2026 (from A002 반기보고서 (2026.06) 20260814002213 accepted 2026-08-14)
  Revenue: 85,190,664,000,000 KRW
  Cost of Revenue: 51,029,831,000,000 KRW
  Gross Profit: 34,160,833,000,000 KRW
  Selling, General and Administrative: 22,640,000,000,000 KRW
  Operating Income (Loss): 11,520,833,000,000 KRW
  Interest Expense: 3,610,000,000,000 KRW (concept: finance costs (ifrs-full_FinanceCosts): what the statement classifies as finance costs, interest among them)
  Income (Loss) Before Income Taxes: 12,640,000,000,000 KRW
  Income Tax Expense (Benefit): 1,997,823,000,000 KRW
  Net Income (Loss): 10,376,123,000,000 KRW
  Net Income (Loss) Including Noncontrolling Interests: 10,642,177,000,000 KRW
  EPS (Basic): 1,541 KRW/shares
  EPS (Diluted): 1,541 KRW/shares
2026-01-01 to 2026-03-31, fiscal Q1 of the year ending around December 2026 (from A003 분기보고서 (2026.03) 20260515001740 accepted 2026-05-15)
  Revenue: 82,413,077,000,000 KRW
  Cost of Revenue: 51,204,533,000,000 KRW
  Gross Profit: 31,208,544,000,000 KRW
  Selling, General and Administrative: 22,100,000,000,000 KRW
  Operating Income (Loss): 9,108,544,000,000 KRW
  Interest Expense: 2,840,000,000,000 KRW (concept: finance costs (ifrs-full_FinanceCosts): what the statement classifies as finance costs, interest among them)
  Income (Loss) Before Income Taxes: 11,050,000,000,000 KRW
  Income Tax Expense (Benefit): 1,733,945,000,000 KRW
  Net Income (Loss): 9,083,154,000,000 KRW
  Net Income (Loss) Including Noncontrolling Interests: 9,316,055,000,000 KRW
  EPS (Basic): 1,349 KRW/shares
  EPS (Diluted): 1,349 KRW/shares
next periods: statements with after=2026-03-31, periods=3`,
  incomeQ4of2025: `[e1] statements XKRX:005930 income statement, quarterly, more (as of Wednesday 2025-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): income statement, quarterly, 1 periods
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
2025-10-01 to 2025-12-31, fiscal Q4 of the year ending around December 2025 (from A001 사업보고서 (2025.12) 20260310000812 accepted 2026-03-10; A003 분기보고서 (2025.09) 20251114002447 accepted 2025-11-14)
  Revenue: 74,744,873,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Cost of Revenue: 39,482,132,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Gross Profit: 35,262,741,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Selling, General and Administrative: 21,190,000,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Operating Income (Loss): 14,072,741,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Interest Expense: 5,340,000,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled; concept: finance costs (ifrs-full_FinanceCosts): what the statement classifies as finance costs, interest among them)
  Income (Loss) Before Income Taxes: 12,520,000,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Income Tax Expense (Benefit): 2,072,389,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Net Income (Loss): 10,186,421,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Net Income (Loss) Including Noncontrolling Interests: 10,447,611,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  EPS (Basic): no value (value: no three-month value filed; per-share figures and share counts are not computed from year-to-date or annual values, settled)
  EPS (Diluted): no value (value: no three-month value filed; per-share figures and share counts are not computed from year-to-date or annual values, settled)
next periods: statements with after=2025-12-31, periods=1`,
  incomeQuarters2024: `[e1] statements 005930 income statement, quarterly, more (as of Tuesday 2024-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): income statement, quarterly, 3 periods
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
2024-10-01 to 2024-12-31, fiscal Q4 of the year ending around December 2024 (from A001 사업보고서 (2024.12) 20250311001085 accepted 2025-03-11; A003 분기보고서 (2024.09) 20241114001852 accepted 2024-11-14)
  Revenue: 75,788,274,000,000 KRW (value: computed: A001 사업보고서 (2024.12) 20250311001085 (year to 2024-12-31) less A003 분기보고서 (2024.09) 20241114001852 (nine months to 2024-09-30), settled)
  Cost of Revenue: 49,415,662,000,000 KRW (value: computed: A001 사업보고서 (2024.12) 20250311001085 (year to 2024-12-31) less A003 분기보고서 (2024.09) 20241114001852 (nine months to 2024-09-30), settled)
  Gross Profit: 26,372,612,000,000 KRW (value: computed: A001 사업보고서 (2024.12) 20250311001085 (year to 2024-12-31) less A003 분기보고서 (2024.09) 20241114001852 (nine months to 2024-09-30), settled)
  Selling, General and Administrative: 19,880,000,000,000 KRW (value: computed: A001 사업보고서 (2024.12) 20250311001085 (year to 2024-12-31) less A003 분기보고서 (2024.09) 20241114001852 (nine months to 2024-09-30), settled)
  Operating Income (Loss): 6,492,612,000,000 KRW (value: computed: A001 사업보고서 (2024.12) 20250311001085 (year to 2024-12-31) less A003 분기보고서 (2024.09) 20241114001852 (nine months to 2024-09-30), settled)
  Interest Expense: 3,250,000,000,000 KRW (value: computed: A001 사업보고서 (2024.12) 20250311001085 (year to 2024-12-31) less A003 분기보고서 (2024.09) 20241114001852 (nine months to 2024-09-30), settled; concept: finance costs (ifrs-full_FinanceCosts): what the statement classifies as finance costs, interest among them)
  Income (Loss) Before Income Taxes: 8,520,000,000,000 KRW (value: computed: A001 사업보고서 (2024.12) 20250311001085 (year to 2024-12-31) less A003 분기보고서 (2024.09) 20241114001852 (nine months to 2024-09-30), settled)
  Income Tax Expense (Benefit): 765,547,000,000 KRW (value: computed: A001 사업보고서 (2024.12) 20250311001085 (year to 2024-12-31) less A003 분기보고서 (2024.09) 20241114001852 (nine months to 2024-09-30), settled)
  Net Income (Loss): 7,567,571,000,000 KRW (value: computed: A001 사업보고서 (2024.12) 20250311001085 (year to 2024-12-31) less A003 분기보고서 (2024.09) 20241114001852 (nine months to 2024-09-30), settled)
  Net Income (Loss) Including Noncontrolling Interests: 7,754,453,000,000 KRW (value: computed: A001 사업보고서 (2024.12) 20250311001085 (year to 2024-12-31) less A003 분기보고서 (2024.09) 20241114001852 (nine months to 2024-09-30), settled)
  EPS (Basic): no value (value: no three-month value filed; per-share figures and share counts are not computed from year-to-date or annual values, settled)
  EPS (Diluted): no value (value: no three-month value filed; per-share figures and share counts are not computed from year-to-date or annual values, settled)
2024-07-01 to 2024-09-30, fiscal Q3 of the year ending around December 2024 (from A003 분기보고서 (2024.09) 20241114001852 accepted 2024-11-14)
  Revenue: 79,098,726,000,000 KRW
  Cost of Revenue: 48,515,295,000,000 KRW
  Gross Profit: 30,583,431,000,000 KRW
  Selling, General and Administrative: 21,400,000,000,000 KRW
  Operating Income (Loss): 9,183,431,000,000 KRW
  Interest Expense: 3,310,000,000,000 KRW (concept: finance costs (ifrs-full_FinanceCosts): what the statement classifies as finance costs, interest among them)
  Income (Loss) Before Income Taxes: 12,070,000,000,000 KRW
  Income Tax Expense (Benefit): 1,969,161,000,000 KRW
  Net Income (Loss): 9,857,409,000,000 KRW
  Net Income (Loss) Including Noncontrolling Interests: 10,100,839,000,000 KRW
  EPS (Basic): 1,451 KRW/shares
  EPS (Diluted): 1,451 KRW/shares
2024-04-01 to 2024-06-30, fiscal Q2 of the year ending around December 2024 (from A002 반기보고서 (2024.06) 20240814002395 accepted 2024-08-14)
  Revenue: 74,068,302,000,000 KRW
  Cost of Revenue: 42,674,424,000,000 KRW
  Gross Profit: 31,393,878,000,000 KRW
  Selling, General and Administrative: 20,950,000,000,000 KRW
  Operating Income (Loss): 10,443,878,000,000 KRW
  Interest Expense: 3,640,000,000,000 KRW (concept: finance costs (ifrs-full_FinanceCosts): what the statement classifies as finance costs, interest among them)
  Income (Loss) Before Income Taxes: 11,220,000,000,000 KRW
  Income Tax Expense (Benefit): 1,378,655,000,000 KRW
  Net Income (Loss): 9,604,169,000,000 KRW
  Net Income (Loss) Including Noncontrolling Interests: 9,841,345,000,000 KRW
  EPS (Basic): 1,414 KRW/shares
  EPS (Diluted): 1,414 KRW/shares
next periods: statements with after=2024-06-30, periods=3`,
  cashQuarters2026: `[e1] statements XKRX:005930 cash flow, quarterly (as of Wednesday 2026-09-30; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): cash flow, quarterly, 3 periods
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
2026-07-01 to 2026-09-30, fiscal Q3 of the year ending around December 2026 (from A003 분기보고서 (2026.09) 20261113001877 accepted 2026-11-13; A002 반기보고서 (2026.06) 20260814002213 accepted 2026-08-14)
  Net Cash from Operating Activities: 24,170,000,000,000 KRW (value: computed: A003 분기보고서 (2026.09) 20261113001877 (nine months to 2026-09-30) less A002 반기보고서 (2026.06) 20260814002213 (six months to 2026-06-30), settled)
  Payments to Acquire PP&E: -15,240,000,000,000 KRW (value: computed: A003 분기보고서 (2026.09) 20261113001877 (nine months to 2026-09-30) less A002 반기보고서 (2026.06) 20260814002213 (six months to 2026-06-30), settled)
  Net Cash from Investing Activities: -18,600,000,000,000 KRW (value: computed: A003 분기보고서 (2026.09) 20261113001877 (nine months to 2026-09-30) less A002 반기보고서 (2026.06) 20260814002213 (six months to 2026-06-30), settled)
  Net Cash from Financing Activities: -1,950,000,000,000 KRW (value: computed: A003 분기보고서 (2026.09) 20261113001877 (nine months to 2026-09-30) less A002 반기보고서 (2026.06) 20260814002213 (six months to 2026-06-30), settled)
  Dividends Paid: -2,452,000,000,000 KRW (value: computed: A003 분기보고서 (2026.09) 20261113001877 (nine months to 2026-09-30) less A002 반기보고서 (2026.06) 20260814002213 (six months to 2026-06-30), settled)
  Interest Paid, Excluding Capitalized Interest, Operating Activities: -260,000,000,000 KRW (value: computed: A003 분기보고서 (2026.09) 20261113001877 (nine months to 2026-09-30) less A002 반기보고서 (2026.06) 20260814002213 (six months to 2026-06-30), settled)
  Income Taxes Paid: -1,150,000,000,000 KRW (value: computed: A003 분기보고서 (2026.09) 20261113001877 (nine months to 2026-09-30) less A002 반기보고서 (2026.06) 20260814002213 (six months to 2026-06-30), settled)
2026-04-01 to 2026-06-30, fiscal Q2 of the year ending around December 2026 (from A002 반기보고서 (2026.06) 20260814002213 accepted 2026-08-14; A003 분기보고서 (2026.03) 20260515001740 accepted 2026-05-15)
  Net Cash from Operating Activities: 19,830,000,000,000 KRW (value: computed: A002 반기보고서 (2026.06) 20260814002213 (six months to 2026-06-30) less A003 분기보고서 (2026.03) 20260515001740 (three months to 2026-03-31), settled)
  Payments to Acquire PP&E: -13,950,000,000,000 KRW (value: computed: A002 반기보고서 (2026.06) 20260814002213 (six months to 2026-06-30) less A003 분기보고서 (2026.03) 20260515001740 (three months to 2026-03-31), settled)
  Net Cash from Investing Activities: -16,250,000,000,000 KRW (value: computed: A002 반기보고서 (2026.06) 20260814002213 (six months to 2026-06-30) less A003 분기보고서 (2026.03) 20260515001740 (three months to 2026-03-31), settled)
  Net Cash from Financing Activities: -3,100,000,000,000 KRW (value: computed: A002 반기보고서 (2026.06) 20260814002213 (six months to 2026-06-30) less A003 분기보고서 (2026.03) 20260515001740 (three months to 2026-03-31), settled)
  Dividends Paid: -2,452,000,000,000 KRW (value: computed: A002 반기보고서 (2026.06) 20260814002213 (six months to 2026-06-30) less A003 분기보고서 (2026.03) 20260515001740 (three months to 2026-03-31), settled)
  Interest Paid, Excluding Capitalized Interest, Operating Activities: -250,000,000,000 KRW (value: computed: A002 반기보고서 (2026.06) 20260814002213 (six months to 2026-06-30) less A003 분기보고서 (2026.03) 20260515001740 (three months to 2026-03-31), settled)
  Income Taxes Paid: -1,900,000,000,000 KRW (value: computed: A002 반기보고서 (2026.06) 20260814002213 (six months to 2026-06-30) less A003 분기보고서 (2026.03) 20260515001740 (three months to 2026-03-31), settled)
2026-01-01 to 2026-03-31, fiscal Q1 of the year ending around December 2026 (from A003 분기보고서 (2026.03) 20260515001740 accepted 2026-05-15)
  Net Cash from Operating Activities: 17,560,000,000,000 KRW
  Payments to Acquire PP&E: -12,870,000,000,000 KRW
  Net Cash from Investing Activities: -13,900,000,000,000 KRW
  Net Cash from Financing Activities: -2,700,000,000,000 KRW
  Dividends Paid: -2,452,000,000,000 KRW
  Interest Paid, Excluding Capitalized Interest, Operating Activities: -240,000,000,000 KRW
  Income Taxes Paid: -2,600,000,000,000 KRW
next periods: statements with after=2026-03-31, periods=3`,
  cashQ4of2025: `[e1] statements XKRX:005930 cash flow, quarterly, more (as of Wednesday 2025-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): cash flow, quarterly, 1 periods
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
2025-10-01 to 2025-12-31, fiscal Q4 of the year ending around December 2025 (from A001 사업보고서 (2025.12) 20260310000812 accepted 2026-03-10; A003 분기보고서 (2025.09) 20251114002447 accepted 2025-11-14)
  Net Cash from Operating Activities: 25,662,516,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Payments to Acquire PP&E: -14,330,000,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Net Cash from Investing Activities: -14,460,446,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Net Cash from Financing Activities: -2,800,000,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Dividends Paid: -2,453,000,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Repurchase of Common Stock: -400,000,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Interest Paid, Excluding Capitalized Interest, Operating Activities: -250,000,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
  Income Taxes Paid: -700,000,000,000 KRW (value: computed: A001 사업보고서 (2025.12) 20260310000812 (year to 2025-12-31) less A003 분기보고서 (2025.09) 20251114002447 (nine months to 2025-09-30), settled)
next periods: statements with after=2025-12-31, periods=1`,
  balanceQ3of2026: `[e1] statements XKRX:005930 balance sheet, quarterly (as of Wednesday 2026-09-30; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): balance sheet, quarterly, 1 periods
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
at 2026-09-30 (from A003 분기보고서 (2026.09) 20261113001877 accepted 2026-11-13)
  Cash and Cash Equivalents: 59,499,331,000,000 KRW
  Short-Term Investments: 77,300,000,000,000 KRW (concept: short-term financial instruments, deposits among them, not classified as cash equivalents (dart_ShortTermDepositsNotClassifiedAsCashEquivalents))
  Accounts Receivable: 47,000,000,000,000 KRW (concept: trade receivables only (dart_ShortTermTradeReceivable))
  Inventory: 56,000,000,000,000 KRW
  Total Current Assets: 262,930,000,000,000 KRW
  Property, Plant and Equipment, Net: 226,500,000,000,000 KRW
  Total Assets: 579,450,000,000,000 KRW
  Short-Term Debt: 10,240,000,000,000 KRW (value: computed: ifrs-full_ShorttermBorrowings, as filed in A003 분기보고서 (2026.09) 20261113001877, settled)
  Total Current Liabilities: 95,280,000,000,000 KRW
  Long-Term Debt: 3,784,100,000,000 KRW (value: computed: dart_LongTermBorrowingsGross + dart_BondsIssued, as filed in A003 분기보고서 (2026.09) 20261113001877, settled)
  Total Liabilities: 117,580,000,000,000 KRW
  Stockholders' Equity: 449,820,000,000,000 KRW
  Total Equity: 461,870,000,000,000 KRW
  Total Liabilities and Equity: 579,450,000,000,000 KRW
next periods: statements with after=2026-09-30, periods=1`,
  balanceYearEnd2025: `[e1] statements XKRX:005930 balance sheet, quarterly, more (as of Wednesday 2025-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): balance sheet, quarterly, 1 periods
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
at 2025-12-31 (from A001 사업보고서 (2025.12) 20260310000812 accepted 2026-03-10)
  Cash and Cash Equivalents: 54,129,331,000,000 KRW
  Short-Term Investments: 68,400,000,000,000 KRW (concept: short-term financial instruments, deposits among them, not classified as cash equivalents (dart_ShortTermDepositsNotClassifiedAsCashEquivalents))
  Accounts Receivable: 43,280,000,000,000 KRW (concept: trade receivables only (dart_ShortTermTradeReceivable))
  Inventory: 51,330,000,000,000 KRW
  Total Current Assets: 238,562,514,000,000 KRW
  Property, Plant and Equipment, Net: 215,300,000,000,000 KRW
  Total Assets: 538,416,725,000,000 KRW
  Short-Term Debt: 9,310,000,000,000 KRW (value: computed: ifrs-full_ShorttermBorrowings, as filed in A001 사업보고서 (2025.12) 20260310000812, settled)
  Total Current Liabilities: 87,420,000,000,000 KRW
  Long-Term Debt: 3,972,900,000,000 KRW (value: computed: dart_LongTermBorrowingsGross + dart_BondsIssued, as filed in A001 사업보고서 (2025.12) 20260310000812, settled)
  Total Liabilities: 108,291,377,000,000 KRW
  Stockholders' Equity: 418,627,013,000,000 KRW
  Total Equity: 430,125,348,000,000 KRW
  Total Liabilities and Equity: 538,416,725,000,000 KRW
next periods: statements with after=2025-12-31, periods=1`,
  balanceAnnual: `[e1] statements XKRX:005930 balance sheet, annual (as of Wednesday 2025-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): balance sheet, annual, 1 periods
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
at 2025-12-31, fiscal year ending 2025-12-31 (from A001 사업보고서 (2025.12) 20260310000812 accepted 2026-03-10)
  Cash and Cash Equivalents: 54,129,331,000,000 KRW
  Short-Term Investments: 68,400,000,000,000 KRW (concept: short-term financial instruments, deposits among them, not classified as cash equivalents (dart_ShortTermDepositsNotClassifiedAsCashEquivalents))
  Accounts Receivable: 43,280,000,000,000 KRW (concept: trade receivables only (dart_ShortTermTradeReceivable))
  Inventory: 51,330,000,000,000 KRW
  Total Current Assets: 238,562,514,000,000 KRW
  Property, Plant and Equipment, Net: 215,300,000,000,000 KRW
  Total Assets: 538,416,725,000,000 KRW
  Short-Term Debt: 9,310,000,000,000 KRW (value: computed: ifrs-full_ShorttermBorrowings, as filed in A001 사업보고서 (2025.12) 20260310000812, settled)
  Total Current Liabilities: 87,420,000,000,000 KRW
  Long-Term Debt: 3,972,900,000,000 KRW (value: computed: dart_LongTermBorrowingsGross + dart_BondsIssued, as filed in A001 사업보고서 (2025.12) 20260310000812, settled)
  Total Liabilities: 108,291,377,000,000 KRW
  Stockholders' Equity: 418,627,013,000,000 KRW
  Total Equity: 430,125,348,000,000 KRW
  Total Liabilities and Equity: 538,416,725,000,000 KRW
next periods: statements with after=2025-12-31, periods=1`,
  cashAnnual: `[e1] statements XKRX:005930 cash flow, annual (as of Wednesday 2025-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): cash flow, annual, 2 periods
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
2025-01-01 to 2025-12-31, fiscal year ending 2025-12-31 (from A001 사업보고서 (2025.12) 20260310000812 accepted 2026-03-10)
  Net Cash from Operating Activities: 71,832,516,000,000 KRW
  Payments to Acquire PP&E: -52,290,000,000,000 KRW
  Net Cash from Investing Activities: -55,210,446,000,000 KRW
  Net Cash from Financing Activities: -15,400,000,000,000 KRW
  Dividends Paid: -9,809,000,000,000 KRW
  Repurchase of Common Stock: -5,300,000,000,000 KRW
  Interest Paid, Excluding Capitalized Interest, Operating Activities: -940,000,000,000 KRW
  Income Taxes Paid: -6,470,000,000,000 KRW
2024-01-01 to 2024-12-31, fiscal year ending 2024-12-31 (from A001 사업보고서 (2024.12) 20250311001085 accepted 2025-03-11)
  Net Cash from Operating Activities: 72,982,621,000,000 KRW
  Payments to Acquire PP&E: -53,636,000,000,000 KRW
  Net Cash from Investing Activities: -85,315,170,000,000 KRW
  Net Cash from Financing Activities: -7,797,812,000,000 KRW
  Dividends Paid: -9,809,000,000,000 KRW
  Repurchase of Common Stock: -3,000,000,000,000 KRW
  Interest Paid, Excluding Capitalized Interest, Operating Activities: -860,000,000,000 KRW
  Income Taxes Paid: -5,870,000,000,000 KRW
next periods: statements with after=2024-12-31, periods=2`,
  jypSeparate: `[e1] statements XKOS:035900 income statement, annual (as of Wednesday 2025-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
제이와이피엔터테인먼트 (JYP Entertainment Corporation) (XKOS:035900, KOSDAQ, KRW): income statement, annual, 1 periods
history before CIK 00258689 is not linked by the source, so any earlier predecessor's filings are not included
2025-01-01 to 2025-12-31, fiscal year ending 2025-12-31 (from A001 사업보고서 (2025.12) 20260317000412 accepted 2026-03-17)
  Revenue: 498,213,456,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Cost of Revenue: 246,108,772,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Gross Profit: 252,104,684,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Selling, General and Administrative: 125,347,190,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Operating Income (Loss): 126,757,494,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Interest Expense: 2,914,605,000 KRW (concept: finance costs (ifrs-full_FinanceCosts): what the statement classifies as finance costs, interest among them; basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Income (Loss) Before Income Taxes: 136,258,765,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Income Tax Expense (Benefit): 30,187,201,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Net Income (Loss): 106,071,564,000 KRW (concept: the whole profit or loss (ifrs-full_ProfitLoss): the statement gives no share attributable to the parent's owners; basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Net Income (Loss) Including Noncontrolling Interests: 106,071,564,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  EPS (Basic): 3,170 KRW/shares (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  EPS (Diluted): 3,166 KRW/shares (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
next periods: statements with after=2025-12-31, periods=1`,
  jypSeparateCashFlow: `[e1] statements XKOS:035900 cash flow, annual (as of Wednesday 2025-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
제이와이피엔터테인먼트 (JYP Entertainment Corporation) (XKOS:035900, KOSDAQ, KRW): cash flow, annual, 1 periods
history before CIK 00258689 is not linked by the source, so any earlier predecessor's filings are not included
2025-01-01 to 2025-12-31, fiscal year ending 2025-12-31 (from A001 사업보고서 (2025.12) 20260317000412 accepted 2026-03-17)
  Net Cash from Operating Activities: 118,440,000,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Depreciation and Amortization: 11,716,000,000 KRW (value: computed: dart_AdjustmentsForDepreciationExpense + dart_AdjustmentsForAmortisationExpense, as filed in A001 사업보고서 (2025.12) 20260317000412, settled; basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Payments to Acquire PP&E: -9,815,000,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Net Cash from Investing Activities: -64,220,000,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Net Cash from Financing Activities: -33,915,000,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Dividends Paid: -33,481,000,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Repurchase of Common Stock: -434,000,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
next periods: statements with after=2025-12-31, periods=1`,
  jypSeparateBalance: `[e1] statements 035900 balance sheet, annual (as of Wednesday 2025-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
제이와이피엔터테인먼트 (JYP Entertainment Corporation) (XKOS:035900, KOSDAQ, KRW): balance sheet, annual, 1 periods
history before CIK 00258689 is not linked by the source, so any earlier predecessor's filings are not included
at 2025-12-31, fiscal year ending 2025-12-31 (from A001 사업보고서 (2025.12) 20260317000412 accepted 2026-03-17)
  Cash and Cash Equivalents: 102,846,000,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Total Current Assets: 412,557,000,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Total Assets: 1,128,904,000,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Accounts Payable: 21,436,000,000 KRW (concept: trade payables only (dart_ShortTermTradePayables); basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Short-Term Debt: 14,980,000,000 KRW (value: computed: ifrs-full_ShorttermBorrowings + dart_CurrentPortionOfBonds, as filed in A001 사업보고서 (2025.12) 20260317000412, settled; basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Total Current Liabilities: 188,233,000,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Total Liabilities: 236,519,000,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Stockholders' Equity: 892,385,000,000 KRW (concept: the whole equity (ifrs-full_Equity): the statement gives no share attributable to the parent's owners; basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Total Equity: 892,385,000,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
  Total Liabilities and Equity: 1,128,904,000,000 KRW (basis: separate statements (OFS): OpenDART has no consolidated statements (CFS) for this report)
next periods: statements with after=2025-12-31, periods=1`,
  missingYear: `[e1] statements XKRX:005930 income statement, annual, more (as of Sunday 2023-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): income statement, annual, 2 periods
filer 00126380: coverage incomplete (OpenDART's financial statements hold no lines for A001 사업보고서 (2022.12) 20230307000542 (received 2023-03-07))
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
2023-01-01 to 2023-12-31, fiscal year ending 2023-12-31 (from A001 사업보고서 (2023.12) 20240312000736 accepted 2024-03-12)
  Revenue: 258,935,494,000,000 KRW
  Cost of Revenue: 174,218,518,000,000 KRW
  Gross Profit: 84,716,976,000,000 KRW
  Selling, General and Administrative: 78,150,000,000,000 KRW
  Operating Income (Loss): 6,566,976,000,000 KRW
  Interest Expense: 11,570,000,000,000 KRW (concept: finance costs (ifrs-full_FinanceCosts): what the statement classifies as finance costs, interest among them)
  Income (Loss) Before Income Taxes: 11,006,277,000,000 KRW
  Income Tax Expense (Benefit): -4,480,823,000,000 KRW
  Net Income (Loss): 14,472,695,000,000 KRW
  Net Income (Loss) Including Noncontrolling Interests: 15,487,100,000,000 KRW
  EPS (Basic): 2,131 KRW/shares
  EPS (Diluted): 2,131 KRW/shares
2021-01-01 to 2021-12-31, fiscal year ending 2021-12-31 (from A001 사업보고서 (2021.12) 20220308000798 accepted 2022-03-08)
  Revenue: 279,604,799,000,000 KRW
  Cost of Revenue: no value (value: not filed for this fiscal year, settled)
  Gross Profit: no value (value: not filed for this fiscal year, settled)
  Selling, General and Administrative: no value (value: not filed for this fiscal year, settled)
  Operating Income (Loss): 51,633,856,000,000 KRW
  Interest Expense: no value (value: not filed for this fiscal year, settled)
  Income (Loss) Before Income Taxes: no value (value: not filed for this fiscal year, settled)
  Income Tax Expense (Benefit): no value (value: not filed for this fiscal year, settled)
  Net Income (Loss): 39,907,450,000,000 KRW (concept: the whole profit or loss (ifrs-full_ProfitLoss): the statement gives no share attributable to the parent's owners)
  Net Income (Loss) Including Noncontrolling Interests: 39,907,450,000,000 KRW
  EPS (Basic): no value (value: not filed for this fiscal year, settled)
  EPS (Diluted): no value (value: not filed for this fiscal year, settled)
next periods: statements with after=2021-12-31, periods=2`,
  firstYear: `[e1] statements XKRX:005930 income statement, annual, more (as of Thursday 2015-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): income statement, annual, 1 periods
filer 00126380: coverage incomplete (OpenDART's financial statements begin with business year 2015, so earlier reports (the latest: 사업보고서 (2014.12) 20150331001241) are not read)
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
2015-01-01 to 2015-12-31, fiscal year ending 2015-12-31 (from A001 사업보고서 (2015.12) 20160330001132 accepted 2016-03-30)
  Revenue: 200,653,482,000,000 KRW`,
};
