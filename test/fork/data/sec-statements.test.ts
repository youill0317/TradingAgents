// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The filers provider's financial statements, through the real statements and dcf tools in a ToolRegistry (the
 * harness), on SEC's own data.sec.gov answers saved before (test/fork/fixtures/sec, trimmed to what these read)
 * and the hand-made ticker list: the text the model reads, every field the tools read supplied (the read check),
 * and the rules the values follow. Apple (a September fiscal year), Walmart (a January one), TSMC (a 20-F filer
 * reporting in TWD, whose newest 20-F SEC's XBRL data does not hold), Bank of America (an older filing found on
 * an older page of its index) and GE (8-K recasts, filed fourth quarters).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCache } from "../../../src/fork/data/cache.js";
import { findLine, LINES, lineNames, linesOf } from "../../../src/fork/data/catalog/lines.js";
import { buildStatement, filersProvider } from "../../../src/fork/data/providers/filers.js";
import { type CompanyFacts, type Fact, parseCompanyFacts } from "../../../src/fork/data/sources/sec.js";
import { SEC_TICKERS_URL } from "../../../src/fork/data/sources/sec-tickers.js";
import { buildTools, FIXTURES, type FixtureRoute, type TestOptions, testDeps } from "./harness.js";

const UA = "Test Agent test@example.com";

/** A company's filing index and XBRL facts, as data.sec.gov answers them. */
const company = (cik: string, name: string): FixtureRoute[] => [
  { match: `https://data.sec.gov/submissions/CIK${cik}.json`, file: `sec/submissions-${name}.json` },
  {
    match: `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
    file: `sec/companyfacts-${name}.json`,
  },
];

const ROUTES: FixtureRoute[] = [
  { match: SEC_TICKERS_URL, file: "sec/company-tickers-exchange.json" },
  ...company("0000320193", "aapl"),
  ...company("0000104169", "wmt"),
  ...company("0001046179", "tsm"),
  ...company("0000070858", "bac"),
  {
    match: "https://data.sec.gov/submissions/CIK0000070858-submissions-001.json",
    file: "sec/submissions-bac-001.json",
  },
];

/** The filers provider alone (other providers are other tests' business), its tools, and what it asked. */
function sec(routes: readonly FixtureRoute[] = ROUTES, extra: TestOptions = {}) {
  const { deps, fetch } = testDeps({ secUserAgent: UA }, routes, extra);
  const provider = filersProvider(deps);
  return { ...buildTools({ filers: provider }, { check: true }), provider, fetch };
}

/** A company's facts as the provider keeps them, from the fixture. */
function facts(name: string, cik: string) {
  return parseCompanyFacts(
    JSON.parse(readFileSync(join(FIXTURES, `sec/companyfacts-${name}.json`), "utf8")),
    cik,
  );
}

/** One golden call: the text the model reads, every field the tool read supplied, no request unanswered. */
async function golden(input: Record<string, unknown>, expected: string, tool = "statements") {
  const { runTool, fetch } = sec();
  const run = await runTool(tool, input);
  expect(run.failure).toBeUndefined();
  expect(run.text).toBe(expected);
  expect(run.reads.missing()).toEqual([]);
  expect(fetch.unmatched).toEqual([]);
  return { run, fetch };
}

describe("statements as the model reads them", () => {
  test("Apple's latest fiscal year: each line as filed in its 10-K, accepted at its time, with its unit", async () => {
    const { fetch } = await golden(
      { symbol: "AAPL", statement: "income_statement", period_type: "annual", periods: 1 },
      GOLDEN.aaplIncomeAnnual,
    );
    // The ticker list, the filing index and the facts: one request each, the facts kept for the next call.
    expect(fetch.requests.map((request) => request.url)).toEqual([
      SEC_TICKERS_URL,
      "https://data.sec.gov/submissions/CIK0000320193.json",
      "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
    ]);
    expect(fetch.requests.every((request) => request.headers.get("user-agent") === UA)).toBe(true);
  });

  test("a fourth quarter is the year less nine months, naming both filings; per-share figures are not computed", async () => {
    const { run } = await golden(
      { symbol: "AAPL", statement: "income_statement", period_type: "quarterly", periods: 1 },
      GOLDEN.aaplIncomeQ4,
    );
    // Its values come from a 10-K and a 10-Q, so the quarter is not one an annual report gives whole.
    const period = (run.payload as { periods: { from_annual_report: boolean; label: string }[] }).periods[0];
    expect(period?.from_annual_report).toBe(false);
    expect(period?.label).toBe("fiscal Q4 of the year ending around September 2026");
  });

  test("a cash-flow quarter is a difference of year-to-date values; a three-month value filed is used as filed", async () => {
    await golden(
      { symbol: "AAPL", statement: "cash_flow", period_type: "quarterly", periods: 1, after: "2026-09-26" },
      GOLDEN.aaplCashQ3,
    );
  });

  test("a fourth quarter's balance sheet is the annual report's, and short-term debt is summed from its parts", async () => {
    const { run } = await golden(
      { symbol: "AAPL", statement: "balance_sheet", period_type: "quarterly", periods: 1 },
      GOLDEN.aaplBalanceQ4,
    );
    const period = (run.payload as { periods: { from_annual_report: boolean; start: string | null }[] })
      .periods[0];
    expect(period).toMatchObject({ from_annual_report: true, start: null });
  });

  test("Walmart's fiscal year ends in January: its quarters are labelled by it", async () => {
    await golden(
      { symbol: "WMT", statement: "income_statement", period_type: "quarterly", periods: 1 },
      GOLDEN.wmtIncomeQ2,
    );
    await golden(
      {
        symbol: "WMT",
        statement: "income_statement",
        period_type: "quarterly",
        periods: 1,
        after: "2026-04-30",
      },
      GOLDEN.wmtIncomeQ4,
    );
  });

  test("total liabilities computed when not filed; shares outstanding from the cover page, dated as it is", async () => {
    await golden(
      { symbol: "WMT", statement: "balance_sheet", period_type: "annual", periods: 1 },
      GOLDEN.wmtBalanceAnnual,
    );
  });

  test("a 20-F filer in its reporting currency (never the USD translations), its missing latest report said", async () => {
    await golden(
      { symbol: "TSM", statement: "income_statement", period_type: "annual", periods: 1 },
      GOLDEN.tsmIncomeAnnual,
    );
    await golden(
      { symbol: "TSM", statement: "cash_flow", period_type: "annual", periods: 1 },
      GOLDEN.tsmCashAnnual,
    );
    await golden(
      { symbol: "TSM", statement: "balance_sheet", period_type: "annual", periods: 1 },
      GOLDEN.tsmBalanceAnnual,
    );
  });

  test("a 20-F filer files no quarterly statements: asking for them is a request to change", async () => {
    const { runTool, fetch } = sec();
    const run = await runTool("statements", {
      symbol: "TSM",
      statement: "income_statement",
      period_type: "quarterly",
    });
    expect(run.failure).toBe("data_invalid");
    expect(run.text).toBe(
      "SEC EDGAR cannot answer this request as asked: TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD files annual reports with the SEC (such as a 20-F), so its XBRL financial data holds no quarterly statements: ask for annual periods",
    );
    expect(fetch.unmatched).toEqual([]);
  });

  test("a value from a filing on an older page of the index has that filing's acceptance time", async () => {
    const { fetch } = await golden(
      {
        symbol: "BAC",
        statement: "balance_sheet",
        period_type: "quarterly",
        periods: 1,
        after: "2025-12-31",
      },
      GOLDEN.bacBalanceOlder,
    );
    expect(fetch.requests.map((request) => request.url)).toContain(
      "https://data.sec.gov/submissions/CIK0000070858-submissions-001.json",
    );
  });

  test("the annual cash flow feeds dcf: operating cash flow less capital expenditure; a restatement is said", async () => {
    const { runTool, fetch } = sec();
    const statement = await runTool("statements", {
      symbol: "AAPL",
      statement: "cash_flow",
      period_type: "annual",
      periods: 2,
    });
    expect(statement.text).toBe(GOLDEN.aaplCashAnnual);
    expect(statement.reads.missing()).toEqual([]);
    expect(statement.evidence).toBe("e1");
    const dcf = await runTool("dcf", {
      cash_flow: { ref: "e1" },
      stages: [{ years: 5, growth_pct: 6 }],
      terminal_growth_pct: 2.5,
      discount: { rate_pct: 9 },
      net_debt: 0,
      shares: 14_500_000_000,
    });
    expect(dcf.failure).toBeUndefined();
    expect(dcf.text).toBe(GOLDEN.aaplDcf);
    expect((dcf.payload as { inputs: { name: string; value: number }[] }).inputs.slice(0, 2)).toEqual([
      expect.objectContaining({ name: "Net Cash from Operating Activities", value: 145_097_000_000 }),
      expect.objectContaining({ name: "Payments to Acquire PP&E", value: 9_041_000_000 }),
    ]);
    expect(fetch.unmatched).toEqual([]);
  });
});

describe("every statement, annual and quarterly, as the model reads it", () => {
  test("Apple and Walmart: each statement in each period type, every field the tool reads supplied", async () => {
    const { runTool, fetch } = sec();
    const heads: string[] = [];
    for (const symbol of ["AAPL", "WMT"]) {
      for (const statement of ["income_statement", "balance_sheet", "cash_flow"]) {
        for (const period_type of ["annual", "quarterly"]) {
          const run = await runTool("statements", { symbol, statement, period_type, periods: 1 });
          expect(run.failure).toBeUndefined();
          expect(run.reads.missing()).toEqual([]);
          // The period heading: its dates, its fiscal name, and the filings its values come from.
          heads.push(
            `${symbol} ${statement} ${period_type}: ${run.text.split("\n")[4]?.replace(/ \(from .*/, "")}`,
          );
        }
      }
    }
    expect(heads).toEqual([
      "AAPL income_statement annual: 2025-09-28 to 2026-09-26, fiscal year ending 2026-09-26",
      "AAPL income_statement quarterly: 2026-06-28 to 2026-09-26, fiscal Q4 of the year ending around September 2026",
      "AAPL balance_sheet annual: at 2026-09-26, fiscal year ending 2026-09-26",
      "AAPL balance_sheet quarterly: at 2026-09-26",
      "AAPL cash_flow annual: 2025-09-28 to 2026-09-26, fiscal year ending 2026-09-26",
      "AAPL cash_flow quarterly: 2026-06-28 to 2026-09-26, fiscal Q4 of the year ending around September 2026",
      "WMT income_statement annual: 2025-02-01 to 2026-01-31, fiscal year ending 2026-01-31",
      "WMT income_statement quarterly: 2026-05-01 to 2026-07-31, fiscal Q2 of the year ending around January 2027",
      "WMT balance_sheet annual: at 2026-01-31, fiscal year ending 2026-01-31",
      "WMT balance_sheet quarterly: at 2026-07-31",
      "WMT cash_flow annual: 2025-02-01 to 2026-01-31, fiscal year ending 2026-01-31",
      "WMT cash_flow quarterly: 2026-05-01 to 2026-07-31, fiscal Q2 of the year ending around January 2027",
    ]);
    // Each company's facts and index were read once, whatever was asked of them.
    expect(fetch.requests.filter((request) => request.url.includes("/companyfacts/"))).toHaveLength(2);
    expect(fetch.unmatched).toEqual([]);
  });
});

describe("statements as the provider answers them", () => {
  test("pages run back by period end; the last page has no cursor", async () => {
    const { provider } = sec();
    const statement = provider.capabilities.statements?.statement;
    if (!statement) throw new Error("no statements");
    const first = await statement("AAPL", { statement: "income_statement", periodType: "annual", limit: 2 });
    expect(first.periods.map((period) => period.period_end)).toEqual(["2026-09-26", "2025-09-27"]);
    expect(first.next_cursor).toBe("2025-09-27");
    const next = await statement("AAPL", {
      statement: "income_statement",
      periodType: "annual",
      limit: 2,
      after: "2025-09-27",
    });
    expect(next.periods.map((period) => period.period_end)).toEqual(["2024-09-28"]);
    expect(next.next_cursor).toBeNull();
  });

  test("annual lines carry their period's start (statements labels quarters by it); balance-sheet lines none", async () => {
    const { provider } = sec();
    const statement = provider.capabilities.statements?.statement;
    if (!statement) throw new Error("no statements");
    const income = await statement("AAPL", { statement: "income_statement", periodType: "annual", limit: 1 });
    const revenue = income.periods[0]?.lines.find((line) => line.line === "Revenue");
    expect(revenue).toEqual({
      line: "Revenue",
      value: 478_834_000_000,
      unit: "USD",
      period_start: "2025-09-28",
      field_states: null,
      sources: [
        {
          accession: "0000320193-26-000026",
          form: "10-K",
          accepted_at: "2026-11-03T13:05:15Z",
          cik: "0000320193",
          predecessor: false,
        },
      ],
    });
    const balance = await statement("AAPL", { statement: "balance_sheet", periodType: "annual", limit: 1 });
    expect(new Set(balance.periods[0]?.lines.map((line) => line.period_start))).toEqual(new Set([null]));
    // The current filer is not a predecessor: no succeeded_on; SEC links none before it.
    expect(income.succession).toEqual({
      registrants: [{ cik: "0000320193", complete: true }],
      stopsAt: ["0000320193"],
    });
    expect(income.instrument).toEqual({
      key: "AAPL",
      name: "Apple Inc.",
      venue: "Nasdaq",
      currency: "USD",
      price_scale: 1,
      listing: null,
    });
  });

  test("names come from the filing index, not the facts' entity name", async () => {
    const { provider } = sec();
    const answer = await provider.capabilities.statements?.statement?.("BAC", {
      statement: "income_statement",
      periodType: "annual",
      limit: 1,
    });
    // companyfacts names CIK 70858 "BofA Finance LLC".
    expect(answer?.instrument?.name).toBe("BANK OF AMERICA CORP /DE/");
  });

  test("facts kept from before the newest report are read again once; SEC's own gap is then said", async () => {
    const { provider, fetch } = sec(ROUTES, {
      cache: createCache({ now: () => Date.parse("2026-01-01T00:00:00Z") }),
    });
    const answer = await provider.capabilities.statements?.statement?.("TSM", {
      statement: "income_statement",
      periodType: "annual",
      limit: 1,
    });
    expect(
      fetch.requests.filter((request) => request.url.endsWith("/companyfacts/CIK0001046179.json")),
    ).toHaveLength(2);
    expect(answer?.succession.registrants[0]).toEqual({
      cik: "0001046179",
      complete: false,
      complete_reason:
        "SEC's XBRL financial data does not hold its latest report yet (20-F 0001628280-26-025362, filed 2026-04-16 for the period ending 2025-12-31), so that report's figures are not shown",
    });
  });
});

describe("statements built from the facts", () => {
  test("only periodic reports' facts are kept: 8-K recasts and proxy statements never win", () => {
    const ge = facts("ge", "40545");
    const forms = new Set(
      Object.values(ge.facts).flatMap((concepts) =>
        Object.values(concepts).flatMap((units) =>
          Object.values(units).flatMap((list) => list.map((one) => one.form)),
        ),
      ),
    );
    expect([...forms].sort()).toEqual(["10-K", "10-Q"]);
    const wmt = facts("wmt", "104169");
    const income = wmt.facts["us-gaap"]?.NetIncomeLoss?.USD ?? [];
    expect(income.some((one) => one.form === "DEF 14A" || one.form === "PRE 14A")).toBe(false);
    // GE's first quarter of 2021: the 10-K's value (-2.62), not the later 8-K recast's (-2.63), with the
    // restatement since the 10-Q said.
    const built = buildStatement(ge, "income_statement", "quarterly");
    const q1 = built?.periods.find(({ period }) => period.end === "2021-03-31");
    const eps = q1?.cells.get("EPS (Basic)");
    expect(eps?.value).toBe(-2.62);
    expect(eps?.facts.map((one) => one.accn)).toEqual(["0000040545-23-000023"]);
    expect(eps?.states.restated?.reason).toBe("first filed as -0.33 in 10-Q 0000040545-21-000026");
  });

  test("a fourth quarter filed for three months is used as filed, per-share figures included", () => {
    const built = buildStatement(facts("ge", "40545"), "income_statement", "quarterly");
    const filed = built?.periods.find(({ period }) => period.end === "2024-12-31");
    expect(filed?.period).toEqual({ start: "2024-10-01", end: "2024-12-31", yearStart: "2024-01-01" });
    expect(filed?.cells.get("Net Income (Loss)")).toMatchObject({ value: 1_899_000_000, states: {} });
    expect(filed?.cells.get("EPS (Basic)")).toMatchObject({ value: 1.76, states: {} });
    // A year later only the year was filed: the quarter is computed, its per-share figure not given.
    const computed = built?.periods.find(({ period }) => period.end === "2025-12-31");
    expect(computed?.cells.get("Net Income (Loss)")?.states.value?.reason).toBe(
      "computed: 10-K 0000040545-26-000008 (year to 2025-12-31) less 10-Q 0000040545-26-000064 (nine months to 2025-09-30)",
    );
    expect(computed?.cells.get("EPS (Basic)")?.value).toBeNull();
  });

  test("an IFRS filer's values are in its reporting currency only", () => {
    const built = buildStatement(facts("tsm", "1046179"), "income_statement", "annual");
    expect(built?.taxonomy).toBe("ifrs-full");
    expect(built?.currency).toBe("TWD");
    const revenue = built?.periods[0]?.cells.get("Revenue");
    // 2,894,307,700,000 TWD; the 20-F's USD translation (88,268,000,000) is never taken.
    expect(revenue?.value).toBe(2_894_307_700_000);
    expect(built?.periods.map(({ period }) => period.end)).toEqual([
      "2024-12-31",
      "2023-12-31",
      "2022-12-31",
    ]);
  });

  test("the reporting currency is the one most facts are in: a few in another never change it", () => {
    const year = (end: string, val: number): Fact => ({
      start: `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`,
      end,
      val,
      accn: "0000000001-26-000001",
      form: "10-K",
      filed: "2026-02-01",
    });
    const company = (units: Record<string, Fact[]>): CompanyFacts => ({
      cik: "0000000001",
      facts: { "us-gaap": { Revenues: units } },
      financialAccessions: ["0000000001-26-000001"],
    });
    const usd = [year("2025-12-31", 300), year("2024-12-31", 200), year("2023-12-31", 100)];
    const mostlyUsd = buildStatement(
      company({ USD: usd, EUR: [year("2025-12-31", 280)] }),
      "income_statement",
      "annual",
    );
    expect(mostlyUsd?.currency).toBe("USD");
    expect(mostlyUsd?.periods[0]?.cells.get("Revenue")?.value).toBe(300);
    // An IFRS-style filer: its own currency for every year, USD for the latest only.
    const local = buildStatement(
      company({ EUR: usd, USD: [year("2025-12-31", 330)] }),
      "income_statement",
      "annual",
    );
    expect(local?.currency).toBe("EUR");
    expect(local?.periods.map(({ cells }) => cells.get("Revenue")?.value)).toEqual([300, 200, 100]);
  });

  test("Walmart's fiscal quarters: three months filed, a fourth from the year less nine months", () => {
    const built = buildStatement(facts("wmt", "104169"), "income_statement", "quarterly");
    expect(built?.periods.slice(0, 4).map(({ period }) => period)).toEqual([
      { start: "2026-05-01", end: "2026-07-31", yearStart: "2026-02-01" },
      { start: "2026-02-01", end: "2026-04-30", yearStart: "2026-02-01" },
      { start: "2025-11-01", end: "2026-01-31", yearStart: "2025-02-01" },
      { start: "2025-08-01", end: "2025-10-31", yearStart: "2025-02-01" },
    ]);
  });
});

describe("the line catalog", () => {
  test("the names the dcf tool reads are lines of the cash flow, as written", () => {
    const cash = new Set(lineNames("cash_flow"));
    for (const name of [
      "Net Cash from Operating Activities",
      "Payments to Acquire PP&E",
      "Payments to Acquire Productive Assets",
      "Interest Paid, Excluding Capitalized Interest, Operating Activities",
      "Share-Based Compensation",
    ]) {
      expect(cash.has(name)).toBe(true);
    }
  });

  test("a screen's line is found in any case, with or without (Loss), or by a common name", () => {
    expect(findLine("Revenue")?.label).toBe("Revenue");
    expect(findLine("revenues")?.label).toBe("Revenue");
    expect(findLine("Net Income")?.label).toBe("Net Income (Loss)");
    expect(findLine("net income (loss)")?.label).toBe("Net Income (Loss)");
    expect(findLine("operating income")?.label).toBe("Operating Income (Loss)");
    expect(findLine("TOTAL ASSETS")?.label).toBe("Total Assets");
    expect(findLine("capex")?.label).toBe("Payments to Acquire PP&E");
    expect(findLine("price to earnings")).toBeUndefined();
  });

  test("every line has a concept to read in some taxonomy, and its names are distinct", () => {
    for (const line of LINES) {
      expect(line.usGaap.length + line.ifrs.length + (line.dei ? 1 : 0), line.label).toBeGreaterThan(0);
    }
    expect(new Set(LINES.map((line) => line.label)).size).toBe(LINES.length);
    expect(linesOf("balance_sheet").every((line) => line.period === "instant")).toBe(true);
    expect(linesOf("income_statement").every((line) => line.period === "duration")).toBe(true);
    // Per-share figures and share counts are never computed from other periods.
    for (const line of LINES) if (line.unit !== "currency") expect(line.additive, line.label).toBe(false);
  });
});

/** The texts the model reads, from the fixtures as saved. */
const GOLDEN = {
  aaplIncomeAnnual: `[e1] statements AAPL income statement, annual (as of Saturday 2026-09-26; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): income statement, annual, 1 periods
history before CIK 0000320193 is not linked by the source, so any earlier predecessor's filings are not included
2025-09-28 to 2026-09-26, fiscal year ending 2026-09-26 (from 10-K 0000320193-26-000026 accepted 2026-11-03T13:05:15Z)
  Revenue: 478,834,000,000 USD
  Cost of Revenue: 245,232,000,000 USD
  Gross Profit: 233,602,000,000 USD
  Research and Development: 45,765,000,000 USD
  Selling, General and Administrative: 29,774,000,000 USD
  Operating Income (Loss): 158,063,000,000 USD
  Income (Loss) Before Income Taxes: 159,237,000,000 USD
  Income Tax Expense (Benefit): 27,062,000,000 USD
  Net Income (Loss): 132,175,000,000 USD
  EPS (Basic): 9.01 USD/shares
  EPS (Diluted): 8.98 USD/shares
  Weighted Average Shares (Diluted): 14,720,306,000 shares
next periods: statements with after=2026-09-26, periods=1`,
  aaplIncomeQ4: `[e1] statements AAPL income statement, quarterly (as of Saturday 2026-09-26; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): income statement, quarterly, 1 periods
history before CIK 0000320193 is not linked by the source, so any earlier predecessor's filings are not included
2026-06-28 to 2026-09-26, fiscal Q4 of the year ending around September 2026 (from 10-K 0000320193-26-000026 accepted 2026-11-03T13:05:15Z; 10-Q 0000320193-26-000020 accepted 2026-07-31T10:01:02Z)
  Revenue: 114,477,000,000 USD (value: computed: 10-K 0000320193-26-000026 (year to 2026-09-26) less 10-Q 0000320193-26-000020 (nine months to 2026-06-27), settled)
  Cost of Revenue: 59,657,000,000 USD (value: computed: 10-K 0000320193-26-000026 (year to 2026-09-26) less 10-Q 0000320193-26-000020 (nine months to 2026-06-27), settled)
  Gross Profit: 54,820,000,000 USD (value: computed: 10-K 0000320193-26-000026 (year to 2026-09-26) less 10-Q 0000320193-26-000020 (nine months to 2026-06-27), settled)
  Research and Development: 11,730,000,000 USD (value: computed: 10-K 0000320193-26-000026 (year to 2026-09-26) less 10-Q 0000320193-26-000020 (nine months to 2026-06-27), settled)
  Selling, General and Administrative: 7,459,000,000 USD (value: computed: 10-K 0000320193-26-000026 (year to 2026-09-26) less 10-Q 0000320193-26-000020 (nine months to 2026-06-27), settled)
  Operating Income (Loss): 35,631,000,000 USD (value: computed: 10-K 0000320193-26-000026 (year to 2026-09-26) less 10-Q 0000320193-26-000020 (nine months to 2026-06-27), settled)
  Income (Loss) Before Income Taxes: 36,135,000,000 USD (value: computed: 10-K 0000320193-26-000026 (year to 2026-09-26) less 10-Q 0000320193-26-000020 (nine months to 2026-06-27), settled)
  Income Tax Expense (Benefit): 5,424,000,000 USD (value: computed: 10-K 0000320193-26-000026 (year to 2026-09-26) less 10-Q 0000320193-26-000020 (nine months to 2026-06-27), settled)
  Net Income (Loss): 30,711,000,000 USD (value: computed: 10-K 0000320193-26-000026 (year to 2026-09-26) less 10-Q 0000320193-26-000020 (nine months to 2026-06-27), settled)
  EPS (Basic): no value (value: no three-month value filed; per-share figures and share counts are not computed from year-to-date or annual values, settled)
  EPS (Diluted): no value (value: no three-month value filed; per-share figures and share counts are not computed from year-to-date or annual values, settled)
  Weighted Average Shares (Diluted): no value (value: no three-month value filed; per-share figures and share counts are not computed from year-to-date or annual values, settled)
next periods: statements with after=2026-09-26, periods=1`,
  aaplCashQ3: `[e1] statements AAPL cash flow, quarterly, more (as of Saturday 2026-06-27; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): cash flow, quarterly, 1 periods
history before CIK 0000320193 is not linked by the source, so any earlier predecessor's filings are not included
2026-03-29 to 2026-06-27, fiscal Q3 of the year ending around September 2026 (from 10-Q 0000320193-26-000020 accepted 2026-07-31T10:01:02Z; 10-Q 0000320193-26-000013 accepted 2026-05-01T10:01:00Z)
  Net Cash from Operating Activities: 34,369,000,000 USD (value: computed: 10-Q 0000320193-26-000020 (nine months to 2026-06-27) less 10-Q 0000320193-26-000013 (six months to 2026-03-28), settled)
  Depreciation and Amortization: 3,320,000,000 USD (value: computed: 10-Q 0000320193-26-000020 (nine months to 2026-06-27) less 10-Q 0000320193-26-000013 (six months to 2026-03-28), settled)
  Share-Based Compensation: 3,401,000,000 USD
  Payments to Acquire PP&E: 2,455,000,000 USD (value: computed: 10-Q 0000320193-26-000020 (nine months to 2026-06-27) less 10-Q 0000320193-26-000013 (six months to 2026-03-28), settled)
  Net Cash from Investing Activities: -7,757,000,000 USD (value: computed: 10-Q 0000320193-26-000020 (nine months to 2026-06-27) less 10-Q 0000320193-26-000013 (six months to 2026-03-28), settled)
  Net Cash from Financing Activities: -32,640,000,000 USD (value: computed: 10-Q 0000320193-26-000020 (nine months to 2026-06-27) less 10-Q 0000320193-26-000013 (six months to 2026-03-28), settled)
  Dividends Paid: 4,035,000,000 USD (value: computed: 10-Q 0000320193-26-000020 (nine months to 2026-06-27) less 10-Q 0000320193-26-000013 (six months to 2026-03-28), settled)
  Repurchase of Common Stock: 25,105,000,000 USD (value: computed: 10-Q 0000320193-26-000020 (nine months to 2026-06-27) less 10-Q 0000320193-26-000013 (six months to 2026-03-28), settled)
  Income Taxes Paid: 6,158,000,000 USD (value: computed: 10-Q 0000320193-26-000020 (nine months to 2026-06-27) less 10-Q 0000320193-26-000013 (six months to 2026-03-28), settled)
next periods: statements with after=2026-06-27, periods=1`,
  aaplBalanceQ4: `[e1] statements AAPL balance sheet, quarterly (as of Saturday 2026-09-26; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): balance sheet, quarterly, 1 periods
history before CIK 0000320193 is not linked by the source, so any earlier predecessor's filings are not included
at 2026-09-26 (from 10-K 0000320193-26-000026 accepted 2026-11-03T13:05:15Z); this quarter's values come from the annual report (10-K), as a fourth quarter is not filed on its own: say so when you cite them
  Cash and Cash Equivalents: 36,305,000,000 USD
  Short-Term Investments: 20,417,000,000 USD
  Accounts Receivable: 43,817,000,000 USD
  Inventory: 14,541,000,000 USD
  Total Current Assets: 173,857,000,000 USD
  Property, Plant and Equipment, Net: 52,084,000,000 USD
  Total Assets: 404,548,000,000 USD
  Accounts Payable: 82,252,000,000 USD
  Short-Term Debt: 11,903,000,000 USD (value: computed: LongTermDebtCurrent + CommercialPaper, as filed in 10-K 0000320193-26-000026, settled)
  Total Current Liabilities: 169,915,000,000 USD
  Long-Term Debt: 68,208,000,000 USD
  Total Liabilities: 292,455,000,000 USD
  Stockholders' Equity: 112,093,000,000 USD
  Total Liabilities and Equity: 404,548,000,000 USD
  Shares Outstanding: 14,532,259,000 shares
next periods: statements with after=2026-09-26, periods=1`,
  aaplCashAnnual: `[e1] statements AAPL cash flow, annual (as of Saturday 2026-09-26; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): cash flow, annual, 2 periods
history before CIK 0000320193 is not linked by the source, so any earlier predecessor's filings are not included
2025-09-28 to 2026-09-26, fiscal year ending 2026-09-26 (from 10-K 0000320193-26-000026 accepted 2026-11-03T13:05:15Z)
  Net Cash from Operating Activities: 145,097,000,000 USD
  Depreciation and Amortization: 13,423,000,000 USD
  Share-Based Compensation: 13,789,000,000 USD
  Payments to Acquire PP&E: 9,041,000,000 USD
  Net Cash from Investing Activities: -17,280,000,000 USD
  Net Cash from Financing Activities: -127,446,000,000 USD
  Dividends Paid: 15,721,000,000 USD
  Repurchase of Common Stock: 86,390,000,000 USD
  Income Taxes Paid: 34,588,000,000 USD
2024-09-29 to 2025-09-27, fiscal year ending 2025-09-27 (from 10-K 0000320193-26-000026 accepted 2026-11-03T13:05:15Z)
  Net Cash from Operating Activities: 111,482,000,000 USD
  Depreciation and Amortization: 11,698,000,000 USD
  Share-Based Compensation: 12,863,000,000 USD
  Payments to Acquire PP&E: 12,715,000,000 USD
  Net Cash from Investing Activities: 15,195,000,000 USD
  Net Cash from Financing Activities: -120,686,000,000 USD
  Dividends Paid: 15,421,000,000 USD
  Repurchase of Common Stock: 90,711,000,000 USD
  Income Taxes Paid: 43,400,000,000 USD (restated: first filed as 43,369,000,000 in 10-K 0000320193-25-000079)
next periods: statements with after=2025-09-27, periods=2`,
  aaplDcf: `[e2] dcf AAPL, terminal growth 2.5% (reference its data as {"ref":"e2","path":"<field>"})
source: computed
inputs: Net Cash from Operating Activities 145,097,000,000 (annual cash flow 2025-09-28 to 2026-09-26); Payments to Acquire PP&E 9,041,000,000 (annual cash flow 2025-09-28 to 2026-09-26); net debt 0 (given); shares 14,500,000,000 (given)
discount rate: 9% (given)
flows (discounted at each year's end): year 1 144,219,360,000 (present value 132,311,339,450); year 2 152,872,521,600 (present value 128,669,742,951); year 3 162,044,872,896 (present value 125,128,373,879); year 4 171,767,565,270 (present value 121,684,473,680); year 5 182,073,619,186 (present value 118,335,359,726)
terminal value at 2.5% growth: 2,871,160,917,932, present value 1,866,057,595,677 (74.9% of the enterprise value)
enterprise value 2,492,186,885,363; equity value 2,492,186,885,363; 171.87 per share
equity value by discount rate (rows) and terminal growth (columns 2%, 2.5%, 3%):
  8%: 2,749,983,149,721, 2,952,755,188,370, 3,196,081,634,749
  9%: 2,350,444,531,406, 2,492,186,885,363, 2,657,552,964,980
  10%: 2,050,999,852,862, 2,154,632,129,338, 2,273,069,016,739
note: share-based compensation (13,789,000,000) is not deducted from the free cash flow
note: the flow is after interest (levered) while it is discounted as the firm's: it understates the value somewhat`,
  wmtIncomeQ2: `[e1] statements WMT income statement, quarterly (as of Friday 2026-07-31; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Walmart Inc. (WMT, Nasdaq, USD): income statement, quarterly, 1 periods
history before CIK 0000104169 is not linked by the source, so any earlier predecessor's filings are not included
2026-05-01 to 2026-07-31, fiscal Q2 of the year ending around January 2027 (from 10-Q 0000104169-26-000154 accepted 2026-08-28T20:11:28Z)
  Revenue: 187,937,000,000 USD
  Cost of Revenue: 138,804,000,000 USD
  Selling, General and Administrative: 39,750,000,000 USD
  Operating Income (Loss): 9,383,000,000 USD
  Interest Expense: 137,000,000 USD (concept: interest on debt (InterestExpenseDebt))
  Income (Loss) Before Income Taxes: 8,012,000,000 USD
  Income Tax Expense (Benefit): 1,483,000,000 USD
  Net Income (Loss): 6,366,000,000 USD
  Net Income (Loss) Including Noncontrolling Interests: 6,529,000,000 USD
  EPS (Basic): 0.8 USD/shares
  EPS (Diluted): 0.8 USD/shares
  Weighted Average Shares (Diluted): 7,978,000,000 shares
next periods: statements with after=2026-07-31, periods=1`,
  wmtIncomeQ4: `[e1] statements WMT income statement, quarterly, more (as of Saturday 2026-01-31; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Walmart Inc. (WMT, Nasdaq, USD): income statement, quarterly, 1 periods
history before CIK 0000104169 is not linked by the source, so any earlier predecessor's filings are not included
2025-11-01 to 2026-01-31, fiscal Q4 of the year ending around January 2026 (from 10-K 0000104169-26-000055 accepted 2026-03-13T20:06:24Z; 10-Q 0000104169-25-000191 accepted 2025-12-03T21:45:34Z)
  Revenue: 190,656,000,000 USD (value: computed: 10-K 0000104169-26-000055 (year to 2026-01-31) less 10-Q 0000104169-25-000191 (nine months to 2025-10-31), settled)
  Cost of Revenue: 143,615,000,000 USD (value: computed: 10-K 0000104169-26-000055 (year to 2026-01-31) less 10-Q 0000104169-25-000191 (nine months to 2025-10-31), settled)
  Selling, General and Administrative: 38,333,000,000 USD (value: computed: 10-K 0000104169-26-000055 (year to 2026-01-31) less 10-Q 0000104169-25-000191 (nine months to 2025-10-31), settled)
  Operating Income (Loss): 8,708,000,000 USD (value: computed: 10-K 0000104169-26-000055 (year to 2026-01-31) less 10-Q 0000104169-25-000191 (nine months to 2025-10-31), settled)
  Interest Expense: 585,000,000 USD (value: computed: 10-K 0000104169-26-000055 (year to 2026-01-31) less 10-Q 0000104169-25-000191 (nine months to 2025-10-31), settled; concept: interest on debt (InterestExpenseDebt))
  Income (Loss) Before Income Taxes: 5,970,000,000 USD (value: computed: 10-K 0000104169-26-000055 (year to 2026-01-31) less 10-Q 0000104169-25-000191 (nine months to 2025-10-31), settled)
  Income Tax Expense (Benefit): 1,578,000,000 USD (value: computed: 10-K 0000104169-26-000055 (year to 2026-01-31) less 10-Q 0000104169-25-000191 (nine months to 2025-10-31), settled)
  Net Income (Loss): 4,237,000,000 USD (value: computed: 10-K 0000104169-26-000055 (year to 2026-01-31) less 10-Q 0000104169-25-000191 (nine months to 2025-10-31), settled)
  Net Income (Loss) Including Noncontrolling Interests: 4,392,000,000 USD (value: computed: 10-K 0000104169-26-000055 (year to 2026-01-31) less 10-Q 0000104169-25-000191 (nine months to 2025-10-31), settled)
  EPS (Basic): no value (value: no three-month value filed; per-share figures and share counts are not computed from year-to-date or annual values, settled)
  EPS (Diluted): no value (value: no three-month value filed; per-share figures and share counts are not computed from year-to-date or annual values, settled)
  Weighted Average Shares (Diluted): no value (value: no three-month value filed; per-share figures and share counts are not computed from year-to-date or annual values, settled)
next periods: statements with after=2026-01-31, periods=1`,
  wmtBalanceAnnual: `[e1] statements WMT balance sheet, annual (as of Saturday 2026-01-31; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Walmart Inc. (WMT, Nasdaq, USD): balance sheet, annual, 1 periods
history before CIK 0000104169 is not linked by the source, so any earlier predecessor's filings are not included
at 2026-01-31, fiscal year ending 2026-01-31 (from 10-Q 0000104169-26-000154 accepted 2026-08-28T20:11:28Z; 10-K 0000104169-26-000055 accepted 2026-03-13T20:06:24Z)
  Cash and Cash Equivalents: 10,727,000,000 USD
  Inventory: 58,851,000,000 USD
  Total Current Assets: 84,874,000,000 USD
  Property, Plant and Equipment, Net: 136,083,000,000 USD
  Goodwill: 28,735,000,000 USD
  Total Assets: 284,668,000,000 USD
  Accounts Payable: 63,061,000,000 USD
  Short-Term Debt: 10,138,000,000 USD (value: computed: LongTermDebtCurrent + ShortTermBorrowings, as filed in 10-Q 0000104169-26-000154, settled)
  Total Current Liabilities: 107,469,000,000 USD
  Long-Term Debt: 34,624,000,000 USD
  Total Liabilities: 178,781,000,000 USD (value: computed: LiabilitiesAndStockholdersEquity less StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest, as filed in 10-Q 0000104169-26-000154, settled)
  Stockholders' Equity: 99,617,000,000 USD
  Total Equity: 105,887,000,000 USD
  Total Liabilities and Equity: 284,668,000,000 USD
  Shares Outstanding: 7,972,402,501 shares (value: the cover page's count at 2026-03-11 (dei EntityCommonStockSharesOutstanding, 10-K 0000104169-26-000055), not at the balance-sheet date, settled)
next periods: statements with after=2026-01-31, periods=1`,
  tsmIncomeAnnual: `[e1] statements TSM income statement, annual (as of Tuesday 2024-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD (TSM, NYSE, USD): income statement, annual, 1 periods
filer 0001046179: coverage incomplete (SEC's XBRL financial data does not hold its latest report yet (20-F 0001628280-26-025362, filed 2026-04-16 for the period ending 2025-12-31), so that report's figures are not shown)
history before CIK 0001046179 is not linked by the source, so any earlier predecessor's filings are not included
2024-01-01 to 2024-12-31, fiscal year ending 2024-12-31 (from 20-F 0001193125-25-083423 accepted 2025-04-17T10:16:18Z)
  Revenue: 2,894,307,700,000 TWD
  Cost of Revenue: 1,269,954,100,000 TWD
  Gross Profit: 1,624,353,600,000 TWD
  Research and Development: 204,181,800,000 TWD
  Operating Income (Loss): 1,322,053,000,000 TWD
  Interest Expense: 10,495,400,000 TWD (concept: finance costs (ifrs-full FinanceCosts), interest and other costs of borrowing)
  Income (Loss) Before Income Taxes: 1,405,840,000,000 TWD
  Income Tax Expense (Benefit): 248,316,100,000 TWD
  Net Income (Loss): 1,158,380,200,000 TWD
  Net Income (Loss) Including Noncontrolling Interests: 1,157,523,900,000 TWD
  EPS (Basic): 44.68 TWD/shares
  EPS (Diluted): 44.67 TWD/shares
next periods: statements with after=2024-12-31, periods=1`,
  tsmCashAnnual: `[e1] statements TSM cash flow, annual (as of Tuesday 2024-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD (TSM, NYSE, USD): cash flow, annual, 1 periods
filer 0001046179: coverage incomplete (SEC's XBRL financial data does not hold its latest report yet (20-F 0001628280-26-025362, filed 2026-04-16 for the period ending 2025-12-31), so that report's figures are not shown)
history before CIK 0001046179 is not linked by the source, so any earlier predecessor's filings are not included
2024-01-01 to 2024-12-31, fiscal year ending 2024-12-31 (from 20-F 0001193125-25-083423 accepted 2025-04-17T10:16:18Z)
  Net Cash from Operating Activities: 1,826,177,100,000 TWD
  Depreciation and Amortization: 653,610,500,000 TWD (concept: depreciation alone (ifrs-full DepreciationExpense))
  Share-Based Compensation: 1,242,700,000 TWD
  Payments to Acquire PP&E: 956,006,500,000 TWD
  Net Cash from Investing Activities: -864,842,800,000 TWD
  Net Cash from Financing Activities: -346,301,000,000 TWD
  Dividends Paid: 363,055,200,000 TWD
  Interest Paid, Financing Activities: 18,751,200,000 TWD
  Income Taxes Paid: 183,640,100,000 TWD
next periods: statements with after=2024-12-31, periods=1`,
  tsmBalanceAnnual: `[e1] statements TSM balance sheet, annual (as of Tuesday 2024-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD (TSM, NYSE, USD): balance sheet, annual, 1 periods
filer 0001046179: coverage incomplete (SEC's XBRL financial data does not hold its latest report yet (20-F 0001628280-26-025362, filed 2026-04-16 for the period ending 2025-12-31), so that report's figures are not shown)
history before CIK 0001046179 is not linked by the source, so any earlier predecessor's filings are not included
at 2024-12-31, fiscal year ending 2024-12-31 (from 20-F 0001193125-25-083423 accepted 2025-04-17T10:16:18Z)
  Cash and Cash Equivalents: 2,127,627,000,000 TWD
  Accounts Receivable: 270,683,200,000 TWD (concept: trade receivables only (CurrentTradeReceivables))
  Inventory: 287,868,800,000 TWD
  Total Current Assets: 3,088,352,100,000 TWD
  Property, Plant and Equipment, Net: 3,234,980,100,000 TWD
  Total Assets: 6,691,764,700,000 TWD
  Accounts Payable: 72,800,600,000 TWD (concept: payables to trade suppliers only (TradeAndOtherCurrentPayablesToTradeSuppliers))
  Short-Term Debt: 117,005,900,000 TWD (value: computed: CurrentPortionOfLongtermBorrowings + CurrentBondsIssuedAndCurrentPortionOfNoncurrentBondsIssued, as filed in 20-F 0001193125-25-083423, settled)
  Total Current Liabilities: 1,308,655,900,000 TWD
  Long-Term Debt: 958,428,900,000 TWD (value: computed: LongtermBorrowings + NoncurrentPortionOfNoncurrentBondsIssued, as filed in 20-F 0001193125-25-083423, settled)
  Total Liabilities: 2,412,493,100,000 TWD
  Stockholders' Equity: 4,244,266,500,000 TWD
  Total Equity: 4,279,271,600,000 TWD
  Total Liabilities and Equity: 6,691,764,700,000 TWD
  Shares Outstanding: 25,932,733,242 shares (value: the cover page's count (dei EntityCommonStockSharesOutstanding, 20-F 0001193125-25-083423), settled)
next periods: statements with after=2024-12-31, periods=1`,
  bacBalanceOlder: `[e1] statements BAC balance sheet, quarterly, more (as of Tuesday 2025-09-30; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
BANK OF AMERICA CORP /DE/ (BAC, NYSE, USD): balance sheet, quarterly, 1 periods
history before CIK 0000070858 is not linked by the source, so any earlier predecessor's filings are not included
at 2025-09-30 (from 10-Q 0000070858-26-000548 accepted 2026-10-30T21:04:27Z; 10-Q 0000070858-25-000405 accepted 2025-10-31T20:36:23Z)
  Cash and Cash Equivalents: 246,507,000,000 USD (concept: includes restricted cash (CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents))
  Property, Plant and Equipment, Net: 12,348,000,000 USD
  Goodwill: 69,021,000,000 USD
  Total Assets: 3,403,149,000,000 USD (restated: first filed as 3,403,716,000,000 in 10-Q 0000070858-25-000405)
  Short-Term Debt: no value (value: not filed for this date, settled)
  Total Liabilities: 3,099,564,000,000 USD
  Stockholders' Equity: 302,437,000,000 USD (restated: first filed as 304,152,000,000 in 10-Q 0000070858-25-000405)
  Total Liabilities and Equity: 3,403,716,000,000 USD
  Shares Outstanding: 7,329,421,929 shares
next periods: statements with after=2025-09-30, periods=1`,
};
