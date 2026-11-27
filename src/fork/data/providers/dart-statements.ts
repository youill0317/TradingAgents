// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Korean companies' financial statements from OpenDART (fnlttSinglAcntAll.json, read with DART_API_KEY): the
 * statements capability's statement method for a Korean listing (XKRX:005930, XKOS:035900, 005930.KS, a bare
 * code), answered in the shape the SEC filers' statements take (providers/filers.ts), for the filers provider to
 * route Korean listings to. Any other key is unsupported; without DART_API_KEY a Korean listing answers
 * not_configured, naming DART_API_KEY.
 *
 * - The company: OpenDART's company list gives the listing's corp_code (sources/dart.ts: a code the list does not
 *   hold, a fund's, is unsupported, so the router moves on), and its outline (company.json) the month its fiscal
 *   year ends (acc_mt) and its market (corp_cls). Reports are asked by business year (bsns_year) and report code
 *   (reprt_code), which place a fiscal year ending in December exactly: 11013 the first quarter to Y-03-31, 11012
 *   the half year to Y-06-30, 11014 the nine months to Y-09-30, 11011 the year to Y-12-31. A fiscal year ending
 *   in another month is unsupported, with the month (the outline's, else the latest annual report's).
 * - The reports: list.json's periodic reports (pblntf_ty A) received from 2015-01-01, each placed by its name and
 *   period ("사업보고서 (2025.12)", "분기보고서 (2025.09)"); business years from 2015 are read, the first
 *   fnlttSinglAcntAll serves. Each report is read consolidated (fs_div CFS) and, when OpenDART answers it has
 *   none (status 013), separate (OFS), which each value read from it says.
 * - Lines: catalog/lines.ts's `dart` account ids, each line's in order, among the statement's rows (IS, or CIS
 *   when a report has no IS; BS; CF), the first in OpenDART's order (ord) for an id, else the line's formula
 *   over them (`compute.dart`). A member breakdown (account_detail) and a row without a standard id
 *   ("-표준계정코드 미사용-") are matched by no line. A line is shown when the reports read hold it.
 * - One currency, as the SEC filers' statements read one reporting currency: the one the newest report with lines
 *   writes most. Rows in another currency are not read, and the reports holding them are said in the coverage.
 * - Periods, newest first, `limit` a page and the period end as the cursor, as the SEC filers' are: a year is the
 *   annual report's (11011, thstrm_amount); a balance sheet is the report's at its period end. A quarter's income
 *   statement is the report's three months (thstrm_amount of 11013, 11012 and 11014); its cash flow, which the
 *   reports give from the year's start (thstrm_amount), is computed as the difference of two reports' year to
 *   date; a fourth quarter is computed as the year (11011) less the nine months (11014's year to date). Each
 *   computed value names both reports and their receipt numbers in `field_states`; per-share figures and share
 *   counts are never computed. A report OpenDART holds no lines for is passed over, and said in the coverage, as
 *   is a quarter that cannot be computed (the report before it not listed, holding no lines, or on another basis).
 * - The basis of each value: the one filed in its own period's report (or that report's correction). A later
 *   report's restated figures for an earlier period (frmtrm_amount, the prior year's column) are not read: a
 *   period a later report restates keeps the value its own report filed.
 * - Each value names its report (`sources`: accession the 14-digit receipt number, form the detail type and the
 *   report's name as list.json lists it, "A001 사업보고서 (2025.12)", accepted_at its receipt date, cik the
 *   corp_code). OpenDART links no predecessor, so the succession names the company's corp_code alone.
 *
 * Amounts are OpenDART's, in the currency their rows name (KRW for Korean filers), with the signs the statements
 * present (an outflow of cash is negative).
 */
import type {
  Call,
  FieldStates,
  Instrument,
  Statement,
  Statements,
  Succession,
} from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import {
  type CatalogLine,
  evaluateFormula,
  formulaConcepts,
  formulaWords,
  linesOf,
  type StatementKind,
} from "../catalog/lines.js";
import type { ForkDeps } from "../deps.js";
import { KOREAN_MARKETS, parseListing } from "../listings.js";
import {
  DART_REPORTS,
  DART_SOURCE,
  type DartAccount,
  type DartCompany,
  type DartFiling,
  type DartReportCode,
  type DartSource,
  type DartStatementBasis,
  dartDate,
  dartKeyNeeded,
  dartMarketOf,
  dartSource,
} from "../sources/dart.js";

type StatementQuery = Parameters<Statements["statement"]>[1];
type StatementLine = Statement["periods"][number]["lines"][number];
type State = { reason: string; retry: "never" | null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The first business year fnlttSinglAcntAll serves, and so the first whose reports are read. */
export const DART_FIRST_YEAR = 2015;

/**
 * Each report of a fiscal year ending in December: its detail type (pblntf_detail_ty), its name as list.json
 * writes it, what it covers from the year's start, where its quarter starts (month-day), and the report before it
 * in the year (whose year to date a computed quarter subtracts).
 */
export const DART_REPORT_KINDS: Readonly<
  Record<
    DartReportCode,
    { detail: string; name: string; span: string; quarterStart: string; previous?: DartReportCode }
  >
> = {
  "11013": { detail: "A003", name: "분기보고서", span: "three months", quarterStart: "01-01" },
  "11012": {
    detail: "A002",
    name: "반기보고서",
    span: "six months",
    quarterStart: "04-01",
    previous: "11013",
  },
  "11014": {
    detail: "A003",
    name: "분기보고서",
    span: "nine months",
    quarterStart: "07-01",
    previous: "11012",
  },
  "11011": { detail: "A001", name: "사업보고서", span: "year", quarterStart: "10-01", previous: "11014" },
};

/** Each report as a reader names it in English. */
const REPORT_WORDS: Readonly<Record<DartReportCode, string>> = {
  "11013": "first-quarter report (분기보고서)",
  "11012": "half-year report (반기보고서)",
  "11014": "third-quarter report (분기보고서)",
  "11011": "annual report (사업보고서)",
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Why a quarter's per-share figure or share count has no value: they are never computed (as the SEC filers'). */
const NOT_COMPUTED =
  "no three-month value filed; per-share figures and share counts are not computed from year-to-date or annual values";

// Reports ----------------------------------------------------------------------------------------------

/** A periodic report's name read: its kind, the year and month its period ends, and its report code when placed. */
export type Periodic = {
  kind: "사업보고서" | "반기보고서" | "분기보고서";
  year: number;
  month: number;
  /** Its reprt_code in a fiscal year ending in December; undefined when its month does not fall in one. */
  code: DartReportCode | undefined;
};

const PERIODIC = /(사업보고서|반기보고서|분기보고서)\s*\((\d{4})\.(\d{2})\)/;

/**
 * Where a periodic report's name ("사업보고서 (2025.12)", "[기재정정]분기보고서 (2025.09)") places it: an annual
 * report ending in December is 11011, a half-year report ending in June 11012, quarterly reports ending in March
 * and September 11013 and 11014. Undefined for a name that is not a periodic report's.
 */
export function periodicOf(reportName: string): Periodic | undefined {
  const match = PERIODIC.exec(reportName);
  if (!match) return undefined;
  const kind = match[1] as Periodic["kind"];
  const year = Number(match[2]);
  const month = Number(match[3]);
  const code: DartReportCode | undefined =
    kind === "사업보고서"
      ? month === 12
        ? "11011"
        : undefined
      : kind === "반기보고서"
        ? month === 6
          ? "11012"
          : undefined
        : month === 3
          ? "11013"
          : month === 9
            ? "11014"
            : undefined;
  return { kind, year, month, code };
}

/** A periodic report placed in a fiscal year ending in December, with its filings (an original and its corrections). */
type Placed = { year: number; code: DartReportCode; end: string; filings: DartFiling[] };

/** A report's statement rows for one statement, by account id (the first in OpenDART's order). */
type Sheet = { report: Placed; basis: DartStatementBasis; byId: Map<string, DartAccount> };

/** The row a value comes from, and the report's rows it is among. */
type Used = { row: DartAccount; sheet: Sheet };

/** A line's value in a period, the rows it comes from, and what a reader should know about it. */
type Cell = { value: number | null; used: Used[]; states: Record<string, State> };

/** A period of the statement: its dates, and the report that gives it. */
type Period = { start: string | null; end: string; report: Placed };

const missingCell = (reason: string): Cell => ({
  value: null,
  used: [],
  states: { value: { reason, retry: "never" } },
});

/** Whether a row is a line's total, not a member's breakdown: its account_detail empty, "-" or "total". */
function isTotal(row: DartAccount): boolean {
  const detail = row.account_detail?.trim().toLowerCase();
  return !detail || detail === "total";
}

/** A report's rows of one statement: IS (CIS when the report has no IS), BS or CF, with a standard id. */
function statementRows(rows: readonly DartAccount[], statement: StatementKind): DartAccount[] {
  const of = (division: string) => rows.filter((row) => row.sj_div === division);
  const chosen =
    statement === "balance_sheet"
      ? of("BS")
      : statement === "cash_flow"
        ? of("CF")
        : of("IS").length
          ? of("IS")
          : of("CIS");
  return chosen
    .filter((row) => row.account_id !== null && isTotal(row))
    .map((row, at) => ({ row, at }))
    .sort(
      (a, b) =>
        (a.row.ord ?? Number.POSITIVE_INFINITY) - (b.row.ord ?? Number.POSITIVE_INFINITY) || a.at - b.at,
    )
    .map(({ row }) => row);
}

/** Whether a row holds an amount of its own period. */
const holdsAmount = (row: DartAccount) => row.thstrm_amount !== null || row.thstrm_add_amount !== null;

/** A line's year to date in a report: the income statement's thstrm_add_amount (the year's in 11011), the cash flow's thstrm_amount. */
function yearToDate(row: DartAccount, code: DartReportCode, income: boolean): number | null {
  if (!income || code === "11011") return row.thstrm_amount;
  return code === "11013" ? (row.thstrm_add_amount ?? row.thstrm_amount) : row.thstrm_add_amount;
}

/** A line's three months as a report files them: the income statement's thstrm_amount, the first quarter's cash flow. */
function threeMonths(row: DartAccount, code: DartReportCode, income: boolean): number | null {
  if (code === "11011") return null;
  if (income) return code === "11013" ? (row.thstrm_amount ?? row.thstrm_add_amount) : row.thstrm_amount;
  return code === "11013" ? row.thstrm_amount : null;
}

// The provider ---------------------------------------------------------------------------------------

/**
 * The statements capability's statement method for Korean listings, from OpenDART (see the top of this file):
 * the same request and answer as the SEC filers' (providers/filers.ts), unsupported for any other key.
 */
export function dartStatements(
  deps: ForkDeps,
  dart: DartSource = dartSource(deps),
): (symbol: string, query: StatementQuery, call?: Call) => Promise<Statement> {
  return (symbol, query, call) => readStatement(deps, dart, symbol, query, call);
}

const invalid = (message: string) =>
  new DataError("invalid", message, { source: DART_SOURCE, retry: "change_request" });

/** A company of OpenDART's list as answers name it: its Korean name, with its English one when given. */
function nameOf(company: DartCompany): string {
  return company.corp_eng_name ? `${company.corp_name} (${company.corp_eng_name})` : company.corp_name;
}

/** The answer for a company whose fiscal year ends in another month than December. */
function notDecember(name: string, month: number, from: string): DataError {
  return new DataError(
    "unsupported",
    `${name}'s fiscal year ends in ${MONTHS[month - 1]} (${from}), and ${DART_SOURCE}'s statement lines, asked by business year and report code, are placed in periods for fiscal years ending in December`,
    { source: DART_SOURCE },
  );
}

async function readStatement(
  deps: ForkDeps,
  dart: DartSource,
  symbol: string,
  query: StatementQuery,
  call: Call | undefined,
): Promise<Statement> {
  if (query.after !== undefined && !DATE.test(query.after)) {
    throw invalid(
      `after must be a cursor a previous call returned (a period end, YYYY-MM-DD), not "${query.after}"`,
    );
  }
  const listing = parseListing(symbol);
  if (listing.kind !== "kr") {
    throw new DataError(
      "unsupported",
      `${DART_SOURCE} serves Korean listings' statements, and ${symbol.trim()} is not one`,
      { source: DART_SOURCE },
    );
  }
  if (!deps.config.dartKey) {
    throw dartKeyNeeded(`Reading ${listing.key ?? listing.code}'s financial statements`);
  }
  const company = await dart.company(symbol, call);
  const corp = company.corp_code;
  const name = nameOf(company);
  const outline = await dart.outline(corp, call);
  const month = outline?.acc_mt ?? null;
  if (month !== null && month !== 12) {
    throw notDecember(
      name,
      month,
      `acc_mt ${String(month).padStart(2, "0")} in ${DART_SOURCE}'s company outline`,
    );
  }
  // Every periodic report, newest first: originals and corrections alike, so each receipt number is found.
  const filings = await dart.filings(
    { corp_code: corp, bgn_de: `${DART_FIRST_YEAR}-01-01`, pblntf_ty: "A" },
    call,
  );
  const listed = new Map(filings.map((filing) => [filing.rcept_no, filing]));
  const placed = new Map<string, Placed>();
  const misplaced: DartFiling[] = [];
  const earlier: DartFiling[] = [];
  let latestAnnual: { month: number; filing: DartFiling } | undefined;
  for (const filing of filings) {
    const periodic = periodicOf(filing.report_nm);
    if (!periodic) continue;
    if (periodic.kind === "사업보고서" && !latestAnnual) latestAnnual = { month: periodic.month, filing };
    if (!periodic.code) {
      misplaced.push(filing);
      continue;
    }
    if (periodic.year < DART_FIRST_YEAR) {
      earlier.push(filing);
      continue;
    }
    const key = `${periodic.year}:${periodic.code}`;
    const known = placed.get(key);
    if (known) known.filings.push(filing);
    else {
      placed.set(key, {
        year: periodic.year,
        code: periodic.code,
        end: `${periodic.year}-${DART_REPORTS[periodic.code].end}`,
        filings: [filing],
      });
    }
  }
  if (month === null && latestAnnual && latestAnnual.month !== 12) {
    throw notDecember(
      name,
      latestAnnual.month,
      `its latest annual report, ${latestAnnual.filing.report_nm} ${latestAnnual.filing.rcept_no}`,
    );
  }

  /** The form a value's report is named by: its detail type and its name as listed ("A001 사업보고서 (2025.12)"). */
  const formOf = (rcept: string, report: Placed): string => {
    const kind = DART_REPORT_KINDS[report.code];
    const filing = listed.get(rcept);
    const named = filing?.report_nm ?? `${kind.name} (${report.end.slice(0, 7).replace("-", ".")})`;
    return `${kind.detail} ${named}`;
  };
  const filingWords = (rcept: string, report: Placed) => `${formOf(rcept, report)} ${rcept}`;

  // Each report read once: consolidated, else separate; null when OpenDART holds neither (status 013).
  const reads = new Map<Placed, Promise<{ basis: DartStatementBasis; rows: DartAccount[] } | null>>();
  const read = (report: Placed) => {
    let reading = reads.get(report);
    if (!reading) {
      reading = (async () => {
        const consolidated = await dart.accounts(corp, report.year, report.code, "CFS", call);
        if (consolidated !== null) return { basis: "CFS" as const, rows: consolidated };
        const separate = await dart.accounts(corp, report.year, report.code, "OFS", call);
        return separate === null ? null : { basis: "OFS" as const, rows: separate };
      })();
      reads.set(report, reading);
    }
    return reading;
  };
  const empty = new Set<Placed>();
  const seen = new Set<string>();
  // Reports whose rows were left out for their currency, with the currency they write.
  const foreign = new Map<Placed, string>();
  // The reports the periods asked for come from (the annual ones alone for annual periods), newest first.
  const newestFirst = [...placed.values()]
    .filter((report) => query.periodType === "quarterly" || report.code === "11011")
    .sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0));
  let reporting: Promise<string | null> | undefined;
  /**
   * The reporting currency, as the SEC filers' statements read one: the one the newest of those reports with
   * lines writes most (null when its rows name none). Whatever page is asked for, the same report decides it.
   */
  const reportingCurrency = (): Promise<string | null> => {
    reporting ??= (async () => {
      for (const report of newestFirst) {
        const answer = await read(report);
        if (!answer) continue;
        const counts = new Map<string, number>();
        for (const row of statementRows(answer.rows, query.statement)) {
          if (row.currency) counts.set(row.currency, (counts.get(row.currency) ?? 0) + 1);
        }
        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
        if (ranked.length) return ranked[0]?.[0] ?? null;
      }
      return null;
    })();
    return reporting;
  };
  const sheets = new Map<Placed, Sheet | undefined>();
  const sheetOf = async (report: Placed): Promise<Sheet | undefined> => {
    if (sheets.has(report)) return sheets.get(report);
    const answer = await read(report);
    let sheet: Sheet | undefined;
    if (!answer) empty.add(report);
    else {
      const currency = await reportingCurrency();
      const byId = new Map<string, DartAccount>();
      for (const row of statementRows(answer.rows, query.statement)) {
        // A row in another currency than the statement's is not read.
        if (currency && row.currency && row.currency !== currency) {
          if (!foreign.has(report)) foreign.set(report, row.currency);
          continue;
        }
        const id = row.account_id as string;
        if (!byId.has(id)) byId.set(id, row);
        if (holdsAmount(row)) seen.add(id);
      }
      sheet = { report, basis: answer.basis, byId };
    }
    sheets.set(report, sheet);
    return sheet;
  };

  const lines = linesOf(query.statement).filter((line) => line.dart?.length || line.compute?.dart);
  const income = query.statement === "income_statement";

  /** What a reader should know of the basis: separate statements, when OpenDART has no consolidated ones. */
  const basisState = (states: Record<string, State>, used: readonly Sheet[]) => {
    const separate = used.filter((sheet) => sheet.basis === "OFS");
    if (!separate.length) return;
    states.basis = {
      reason: `separate statements (OFS): ${DART_SOURCE} has no consolidated statements (CFS) for ${separate.length > 1 ? "these reports" : "this report"}`,
      retry: null,
    };
  };

  const filed = (line: CatalogLine, id: string, used: Used, value: number): Cell => {
    const states: Record<string, State> = {};
    const note = line.notes?.[id];
    if (note) states.concept = { reason: note, retry: null };
    basisState(states, [used.sheet]);
    return { value, used: [used], states };
  };

  /**
   * A line's value from its formula over one report's own amounts (thstrm_amount: a balance at the period end,
   * or the year's flow in an annual report), or undefined when what it needs is not filed.
   */
  const formulaCell = (line: CatalogLine, sheet: Sheet): Cell | undefined => {
    const formula = line.compute?.dart;
    const derived = formula
      ? evaluateFormula(
          formula,
          (id) => {
            const row = sheet.byId.get(id);
            return row && row.thstrm_amount !== null ? row : undefined;
          },
          (row) => row.thstrm_amount as number,
        )
      : undefined;
    if (!derived) return undefined;
    const rows = [...derived.added, ...derived.subtracted].map(([, row]) => row);
    const forms = [...new Set(rows.map((row) => filingWords(row.rcept_no, sheet.report)))].join(", ");
    const states: Record<string, State> = {
      value: { reason: `computed: ${formulaWords(derived)}, as filed in ${forms}`, retry: "never" },
    };
    basisState(states, [sheet]);
    return { value: derived.value, used: rows.map((row) => ({ row, sheet })), states };
  };

  /** A duration line's value in a fiscal year: the annual report's, filed or from its formula. */
  const annualCell = (line: CatalogLine, sheet: Sheet): Cell => {
    for (const id of line.dart ?? []) {
      const row = sheet.byId.get(id);
      if (row && row.thstrm_amount !== null) return filed(line, id, { row, sheet }, row.thstrm_amount);
    }
    return formulaCell(line, sheet) ?? missingCell("not filed for this fiscal year");
  };

  /** A balance-sheet line's value at a report's period end: filed, or computed from its formula. */
  const instantCell = (line: CatalogLine, sheet: Sheet): Cell => {
    for (const id of line.dart ?? []) {
      const row = sheet.byId.get(id);
      if (row && row.thstrm_amount !== null) return filed(line, id, { row, sheet }, row.thstrm_amount);
    }
    return formulaCell(line, sheet) ?? missingCell("not filed for this date");
  };

  /** One account's three months in a quarter: filed, or computed (`derived` says how); why it cannot be. */
  type Quarter = { value: number; used: Used[]; sheets: Sheet[]; derived: string | null } | { why: string };

  /**
   * Account `id`'s three months in the quarter of `sheet`'s report: filed for the three months, or, for an
   * additive flow, its year to date in this report less the report before it; undefined when the report files
   * none of it; why not, when the report before it is not listed, holds no lines, files none of it to subtract
   * or is on another basis.
   */
  const quarterOf = async (id: string, sheet: Sheet, additive: boolean): Promise<Quarter | undefined> => {
    const { code, year } = sheet.report;
    const previous = DART_REPORT_KINDS[code].previous;
    const row = sheet.byId.get(id);
    if (!row) return undefined;
    const three = threeMonths(row, code, income);
    if (three !== null) return { value: three, used: [{ row, sheet }], sheets: [sheet], derived: null };
    if (!additive || !previous) return undefined;
    const through = yearToDate(row, code, income);
    if (through === null) return undefined;
    const before = placed.get(`${year}:${previous}`);
    if (!before) {
      return {
        why: `not computed: it needs the ${REPORT_WORDS[previous]} of ${year} (${DART_REPORT_KINDS[previous].span} to ${year}-${DART_REPORTS[previous].end}), which ${DART_SOURCE} does not list`,
      };
    }
    const earlierSheet = await sheetOf(before);
    if (!earlierSheet) {
      const filing = before.filings[0] as DartFiling;
      return {
        why: `not computed: it needs ${filingWords(filing.rcept_no, before)}, for which ${DART_SOURCE}'s financial statements hold no lines`,
      };
    }
    const earlierRow = earlierSheet.byId.get(id);
    const less = earlierRow ? yearToDate(earlierRow, previous, income) : null;
    if (!earlierRow || less === null) {
      const filing = before.filings[0] as DartFiling;
      return {
        why: `not computed: ${filingWords(filing.rcept_no, before)} files no year to date of ${id} to subtract`,
      };
    }
    if (earlierSheet.basis !== sheet.basis) {
      return {
        why: `not computed: ${filingWords(row.rcept_no, sheet.report)} is ${sheet.basis === "CFS" ? "consolidated (CFS)" : "separate (OFS)"} and ${filingWords(earlierRow.rcept_no, before)} ${earlierSheet.basis === "CFS" ? "consolidated (CFS)" : "separate (OFS)"}`,
      };
    }
    return {
      value: through - less,
      used: [
        { row, sheet },
        { row: earlierRow, sheet: earlierSheet },
      ],
      sheets: [sheet, earlierSheet],
      derived: `${filingWords(row.rcept_no, sheet.report)} (${DART_REPORT_KINDS[code].span} to ${sheet.report.end}) less ${filingWords(earlierRow.rcept_no, before)} (${DART_REPORT_KINDS[previous].span} to ${before.end})`,
    };
  };

  /**
   * A duration line's value in a quarter: each id in order (quarterOf), else its formula over its accounts'
   * quarters, every account the report files given for the quarter (or none computed).
   */
  const quarterCell = async (line: CatalogLine, sheet: Sheet): Promise<Cell> => {
    let why: string | undefined;
    for (const id of line.dart ?? []) {
      const got = await quarterOf(id, sheet, line.additive);
      if (!got) continue;
      if ("why" in got) {
        why ??= got.why;
        continue;
      }
      const states: Record<string, State> = {};
      if (got.derived) states.value = { reason: `computed: ${got.derived}`, retry: "never" };
      const note = line.notes?.[id];
      if (note) states.concept = { reason: note, retry: null };
      basisState(states, got.sheets);
      return { value: got.value, used: got.used, states };
    }
    const formula = line.additive ? line.compute?.dart : undefined;
    if (formula) {
      const quarters = new Map<string, Exclude<Quarter, { why: string }>>();
      let blocked: string | undefined;
      for (const id of formulaConcepts(formula)) {
        const got = await quarterOf(id, sheet, true);
        if (!got) continue;
        if ("why" in got) blocked ??= got.why;
        else quarters.set(id, got);
      }
      // An account the report files whose quarter cannot be given leaves the sum without it: none is computed.
      const derived = blocked
        ? undefined
        : evaluateFormula(
            formula,
            (id) => quarters.get(id),
            (got) => got.value,
          );
      if (derived) {
        const parts = [...derived.added, ...derived.subtracted].map(([, got]) => got);
        const how = [
          ...new Set(
            parts.map(
              (got) =>
                got.derived ??
                `as filed in ${filingWords(got.used[0]?.row.rcept_no as string, sheet.report)}`,
            ),
          ),
        ];
        const states: Record<string, State> = {
          value: { reason: `computed: ${formulaWords(derived)}, ${how.join("; ")}`, retry: "never" },
        };
        basisState(states, [...new Set(parts.flatMap((got) => got.sheets))]);
        return { value: derived.value, used: parts.flatMap((got) => got.used), states };
      }
      why ??= blocked;
    }
    if (!line.additive) return missingCell(NOT_COMPUTED);
    return missingCell(why ?? "not filed for this quarter");
  };

  const cellOf = (line: CatalogLine, sheet: Sheet): Cell | Promise<Cell> =>
    line.period === "instant"
      ? instantCell(line, sheet)
      : query.periodType === "annual"
        ? annualCell(line, sheet)
        : quarterCell(line, sheet);

  // The periods asked for, newest first: each placed report's (the annual reports' alone for annual periods).
  const periodOf = (report: Placed): Period => {
    if (query.statement === "balance_sheet") return { start: null, end: report.end, report };
    if (query.periodType === "annual") return { start: `${report.year}-01-01`, end: report.end, report };
    return {
      start: `${report.year}-${DART_REPORT_KINDS[report.code].quarterStart}`,
      end: report.end,
      report,
    };
  };
  const after = query.after;
  const candidates = [...placed.values()]
    .filter((report) => query.periodType === "quarterly" || report.code === "11011")
    .map(periodOf)
    .filter((period) => after === undefined || period.end < after)
    .sort((a, b) => (a.end < b.end ? 1 : -1));
  const limit = Math.max(1, query.limit);
  const built: { period: Period; cells: Map<string, Cell> }[] = [];
  // Quarters their two reports cannot give, being on different bases.
  const uncomputed: string[] = [];
  let more = false;
  for (const period of candidates) {
    if (built.length === limit) {
      more = true;
      break;
    }
    const sheet = await sheetOf(period.report);
    if (!sheet) continue;
    const cells = new Map<string, Cell>();
    for (const line of lines) cells.set(line.label, await cellOf(line, sheet));
    // A period of which no line has a value is not a period of this statement.
    if ([...cells.values()].some((cell) => cell.value !== null)) built.push({ period, cells });
    else {
      const why = [...cells.values()]
        .map((cell) => cell.states.value?.reason)
        .find((reason) => reason?.startsWith("not computed:"));
      if (why) uncomputed.push(`${period.start} to ${period.end} is ${why}`);
    }
  }

  const words = query.statement.replaceAll("_", " ");
  if (after === undefined && !built.length) {
    const noData = (message: string) =>
      new DataError("no_data", message, { source: DART_SOURCE, retry: "never" });
    const latest = candidates[0]?.report;
    if (!latest) {
      throw noData(
        `${DART_SOURCE} lists no annual, half-year or quarterly report of ${name} for a business year from ${DART_FIRST_YEAR}, the first its financial statements cover.`,
      );
    }
    if (candidates.every((period) => empty.has(period.report))) {
      const filing = latest.filings[0] as DartFiling;
      throw noData(
        `${DART_SOURCE}'s financial statements hold no lines for any of ${name}'s ${candidates.length} report${candidates.length > 1 ? "s" : ""} from business year ${DART_FIRST_YEAR} (the latest: ${filingWords(filing.rcept_no, latest)}, received ${filing.rcept_dt}).`,
      );
    }
    throw noData(
      `${DART_SOURCE}'s financial statements for ${name} hold none of the ${words} lines this app reads${uncomputed.length ? ` (${uncomputed.join("; ")})` : ""}.`,
    );
  }

  // The lines the reports read hold (their own ids, or every id a formula needs), in the statement's order.
  const shown = lines.filter((line) =>
    [...(line.dart ?? []), ...formulaConcepts(line.compute?.dart, true)].some((id) => seen.has(id)),
  );
  // A page without periods states no unit: no report is read for it.
  const currency = built.length ? await reportingCurrency() : null;
  const unitOf = (line: CatalogLine): string | null =>
    line.unit === "shares"
      ? "shares"
      : !currency
        ? null
        : line.unit === "per_share"
          ? `${currency}/shares`
          : currency;

  /** The day a report was received: list.json's, else the date its receipt number begins with. */
  const receivedOf = (rcept: string, report: Placed): { day: string; listed: boolean } => {
    const filing = listed.get(rcept);
    if (filing) return { day: filing.rcept_dt, listed: true };
    const day = dartDate(rcept.slice(0, 8)) ?? (report.filings[0] as DartFiling).rcept_dt;
    return { day, listed: false };
  };

  const periods = built.map(({ period, cells }) => ({
    period_end: period.end,
    lines: shown.map((line): StatementLine => {
      const cell = cells.get(line.label) as Cell;
      const states: Record<string, State> = { ...cell.states };
      const rows = [...new Map(cell.used.map((used) => [used.row.rcept_no, used])).values()];
      const sources = rows.map(({ row, sheet }) => {
        const received = receivedOf(row.rcept_no, sheet.report);
        if (!received.listed) {
          states.accepted_at = {
            reason: `${row.rcept_no} is not among the filings ${DART_SOURCE} lists, so the day its receipt number begins with is given for when it was received`,
            retry: null,
          };
        }
        return {
          accession: row.rcept_no,
          form: formOf(row.rcept_no, sheet.report),
          accepted_at: received.day,
          cik: corp,
          predecessor: false,
        };
      });
      return {
        line: line.label,
        value: cell.value,
        unit: unitOf(line),
        period_start: line.period === "duration" ? period.start : null,
        field_states: Object.keys(states).length ? (states as FieldStates) : null,
        sources,
      };
    }),
  }));

  // What the reports read leave out, said in the company's coverage.
  const coverage: string[] = [];
  const passed = [...empty].sort((a, b) => (a.end < b.end ? 1 : -1));
  if (passed.length) {
    coverage.push(
      `${DART_SOURCE}'s financial statements hold no lines for ${passed
        .map((report) => {
          const filing = report.filings[0] as DartFiling;
          return `${filingWords(filing.rcept_no, report)} (received ${filing.rcept_dt})`;
        })
        .join("; ")}`,
    );
  }
  coverage.push(...uncomputed);
  if (foreign.size) {
    const left = [...foreign].sort((a, b) => (a[0].end < b[0].end ? 1 : -1));
    coverage.push(
      `the statement is in ${currency}, the currency of the newest report with lines; rows in another currency are not read: ${left
        .map(([report, other]) => {
          const filing = report.filings[0] as DartFiling;
          return `${filingWords(filing.rcept_no, report)} (${other})`;
        })
        .join("; ")}`,
    );
  }
  const latestMisplaced = misplaced[0];
  if (latestMisplaced) {
    coverage.push(
      `${misplaced.length} periodic report${misplaced.length > 1 ? "s" : ""} for a period that does not fall in a fiscal year ending in December ${misplaced.length > 1 ? "are" : "is"} not read (the latest: ${latestMisplaced.report_nm} ${latestMisplaced.rcept_no})`,
    );
  }
  const latestEarlier = earlier[0];
  if (latestEarlier && !more) {
    coverage.push(
      `${DART_SOURCE}'s financial statements begin with business year ${DART_FIRST_YEAR}, so earlier reports (the latest: ${latestEarlier.report_nm} ${latestEarlier.rcept_no}) are not read`,
    );
  }

  const corpCls = outline?.corp_cls ?? filings[0]?.corp_cls ?? null;
  const market = dartMarketOf(corpCls, listing.market);
  const code = company.stock_code ?? listing.code;
  const instrument: Instrument = {
    key: market ? `${market}:${code}` : code,
    name,
    venue: market ? KOREAN_MARKETS[market].venue : corpCls === "N" ? "KONEX" : null,
    currency: "KRW",
    price_scale: 1,
    // OpenDART's list names a listed company's current code; it says nothing more of the listing's state.
    listing: null,
  };
  const succession: Succession = {
    registrants: [
      {
        cik: corp,
        complete: coverage.length === 0,
        ...(coverage.length ? { complete_reason: coverage.join("; ") } : {}),
      },
    ],
    stopsAt: [corp],
  };
  return {
    instrument,
    periods,
    succession,
    next_cursor: more ? (built.at(-1)?.period.end ?? null) : null,
  };
}
