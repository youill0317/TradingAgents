// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * What Korean listings file with OpenDART (DART_API_KEY), in the filings and insider-transaction contracts: the
 * filers provider (providers/filers.ts) sends a Korean listing's filings.list, filings.section and
 * ownership.transactions here when the key is set. Every request goes through sources/dart.ts; the listing is
 * its company in OpenDART's company list (a code the list does not hold, such as a preferred share or a fund,
 * is unsupported, so the router passes the call on).
 *
 * - filings.list (list.json): the company's filings, newest first (by receipt day, then receipt number). The
 *   receipt days are read in windows going back from today (or from the cursor's day), a quarter first and each
 *   older window twice as long, back to 1999 when DART's electronic filings begin, every page of each window,
 *   until the page is full and one more filing shows there are more. Each filing: accession = its receipt
 *   number (rcept_no, 14 digits, its receipt day first), cik = the company's corp_code, form = its report type
 *   (pblntf_detail_ty) with the report's name ("A001 사업보고서 (2025.12)"; the name alone where its type is
 *   not known), filed and accepted_at = its receipt day (OpenDART dates a filing by its day, YYYY-MM-DD, with no
 *   time), report_date = the last day of the period a periodic report names ("(2025.12)"), url = DART's
 *   public page of the filing, and the sections filing_section reads for its type. The forms filter takes
 *   OpenDART's report types (A001...), a type's group letter (A to J), and the SEC forms they answer to: 10-K
 *   the annual report (A001); 10-Q the half-year and quarterly reports (A002, A003); 8-K the major events
 *   report (B001) and the exchange's disclosures (group I). The cursor is the last receipt number served.
 * - filings.section (document.xml): a periodic report's section from its main document
 *   (sources/dart-sections.ts); the filing is found among the company's filings of its receipt day, so a receipt
 *   number of another company is invalid.
 * - ownership.transactions (elestock.json): the reports of the company's officers and major shareholders
 *   (임원ㆍ주요주주특정증권등소유상황보고서, D002), one row per report, newest first: the reporter and their
 *   role (position, registered officer or not, relation as a major shareholder) as the report states them, the
 *   specified securities (특정증권등: the shares and securities linked to them) held after the report and the
 *   change since the last one (acquired when they rose, disposed when they fell), and the percent held and its
 *   change in the security's title. The reports carry no transaction date, transaction code or price: those are
 *   null, start and end are read as receipt days, and transaction codes are invalid for a Korean listing. A
 *   change is reported within five business days, so the coverage is complete five weekdays after its last day;
 *   it begins no earlier than DART's electronic filings (1999), and dates asked before them are said to be.
 *
 * The listing is placed on its market as the statements place it: by OpenDART's class of the company, else by
 * the key's market.
 */
import type {
  Call,
  FilingSectionName,
  Filings,
  Implementation,
  Instrument,
  Ownership,
  Succession,
} from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import type { ForkDeps } from "../deps.js";
import { KOREAN_MARKETS, type Listing, parseListing } from "../listings.js";
import {
  DART_SOURCE,
  type DartCompany,
  type DartFiling,
  type DartInsiderReport,
  type DartSource,
  dartDate,
  dartMarketOf,
  dartSource,
} from "../sources/dart.js";
import {
  DART_PERIODIC,
  dartDocumentSections,
  interimMdna,
  isDartSection,
  sectionsOfDartReport,
} from "../sources/dart-sections.js";

type Data<M> = M extends (...args: never[]) => Promise<infer D> ? D : never;
type FilingList = Data<NonNullable<Implementation<Filings>["list"]>>;
type SectionText = Data<NonNullable<Implementation<Filings>["section"]>>;
type InsiderTransactions = Data<NonNullable<Implementation<Ownership>["transactions"]>>;
type ListQuery = Parameters<Filings["list"]>[1];
type TransactionsQuery = Parameters<Ownership["transactions"]>[1];
type KoreanListing = Extract<Listing, { kind: "kr" }>;

/** The Korean filings and insider reports the filers provider serves from OpenDART. */
export type DartFilings = {
  list(symbol: string, query: ListQuery, call?: Call): Promise<FilingList>;
  section(
    target: { symbol: string; accession: string; section: FilingSectionName },
    query: { after?: string },
    call?: Call,
  ): Promise<SectionText>;
  transactions(symbol: string, query: TransactionsQuery, call?: Call): Promise<InsiderTransactions>;
};

/** The earliest receipt day a list searches: DART's electronic filings begin in 1999. */
export const DART_FIRST_DAY = "1999-01-01";

/** The first window of receipt days a list reads (a quarter); each older window is twice as long. */
export const DART_FIRST_WINDOW_DAYS = 92;

/** The report elestock.json's rows are, as filings names it. */
export const DART_INSIDER_FORM = "D002 임원ㆍ주요주주특정증권등소유상황보고서";

/** Business days an officer or major shareholder has to report a change (자본시장법 제173조). */
export const DART_INSIDER_REPORT_DAYS = 5;

const DAY_MS = 86_400_000;
const RECEIPT = /^\d{14}$/;

const invalid = (message: string) =>
  new DataError("invalid", message, { source: DART_SOURCE, retry: "change_request" });

// Days ------------------------------------------------------------------------------------------------

/** The calendar day in Seoul at `instant`, YYYY-MM-DD: the day OpenDART dates receipts by. */
function seoulDay(instant: Date): string {
  return new Date(instant.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** `date` (YYYY-MM-DD) moved by `days`. */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** `count` weekdays after `date`. */
function weekdaysAfter(date: string, count: number): string {
  let day = date;
  let left = count;
  while (left > 0) {
    day = addDays(day, 1);
    const weekday = new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left--;
  }
  return day;
}

/** The day a receipt number was received on: its first eight digits (YYYYMMDD) as YYYY-MM-DD, when a day. */
export function receiptDate(rceptNo: string): string | null {
  return RECEIPT.test(rceptNo) ? dartDate(rceptNo.slice(0, 8)) : null;
}

// Report types ----------------------------------------------------------------------------------------

/** What a filter asks list.json for: one report type (with its group), or a whole group. */
export type DartFilter = { detail: string; group: string } | { detail?: undefined; group: string };

/** The SEC forms a Korean listing's filings are asked by, and OpenDART's report types each answers to. */
export const SEC_FORMS_IN_DART: Readonly<Record<string, readonly DartFilter[]>> = {
  "10-K": [{ detail: "A001", group: "A" }],
  "10-Q": [
    { detail: "A002", group: "A" },
    { detail: "A003", group: "A" },
  ],
  "8-K": [{ detail: "B001", group: "B" }, { group: "I" }],
};

/**
 * The filters `forms` asks for (none: every filing): OpenDART's report types (A001), their groups (A to J), and
 * the SEC forms SEC_FORMS_IN_DART maps; invalid for any other form.
 */
export function dartFiltersOf(forms: readonly string[] | undefined): DartFilter[] | undefined {
  if (!forms?.length) return undefined;
  const filters = new Map<string, DartFilter>();
  for (const form of forms) {
    const written = form.trim().toUpperCase().replace(/\s+/g, " ");
    const mapped: readonly DartFilter[] | undefined = /^[A-J]\d{3}$/.test(written)
      ? [{ detail: written, group: written.slice(0, 1) }]
      : /^[A-J]$/.test(written)
        ? [{ group: written }]
        : SEC_FORMS_IN_DART[written];
    if (!mapped) {
      throw invalid(
        `${form} is not a form OpenDART lists a Korean listing's filings by: give OpenDART's report types (A001 annual, A002 half-year and A003 quarterly report, B001 major events report, D001 5% holders' report, D002 insiders' holdings report, I001 the exchange's disclosures, and the like), a group's letter (A to J), or 10-K, 10-Q or 8-K`,
      );
    }
    for (const one of mapped) filters.set(one.detail ?? one.group, one);
  }
  return [...filters.values()];
}

/**
 * Report types known by their names (spacing and what OpenDART adds before a name or after it aside): the
 * periodic reports, the major events report and the holdings reports. Other names are left without a type.
 */
const TYPES_BY_NAME: readonly { code: string; name: string; whole: boolean }[] = [
  { code: "A001", name: "사업보고서", whole: true },
  { code: "A002", name: "반기보고서", whole: true },
  { code: "A003", name: "분기보고서", whole: true },
  { code: "B001", name: "주요사항보고서", whole: false },
  { code: "D001", name: "주식등의대량보유상황보고서", whole: false },
  { code: "D002", name: "임원ㆍ주요주주특정증권등소유상황보고서", whole: false },
];

/** A report's name without what OpenDART adds before it ("[기재정정]") or after it ("(2025.12)"), unspaced. */
function bareName(reportName: string): string {
  return reportName
    .replace(/^(?:\s*\[[^\]]*\])+/, "")
    .replace(/\s*\(\d{4}\.\d{2}\)\s*$/, "")
    .replace(/[·・•‧]/g, "ㆍ")
    .replace(/\s+/g, "");
}

/** The report type (pblntf_detail_ty) a report's name says, when TYPES_BY_NAME knows it. */
export function detailCodeOf(reportName: string): string | undefined {
  const name = bareName(reportName);
  return TYPES_BY_NAME.find((one) => (one.whole ? name === one.name : name.startsWith(one.name)))?.code;
}

/** A filing's form: its report type and name ("A001 사업보고서 (2025.12)"), the name alone without a type. */
function formOf(reportName: string, code: string | undefined): string {
  return code ? `${code} ${reportName}` : reportName;
}

/** The last day of the period a periodic report's name ends with ("(2025.12)" is 2025-12-31); null otherwise. */
export function periodEndOf(reportName: string, code: string | undefined): string | null {
  if (!code || !DART_PERIODIC.has(code)) return null;
  const period = /\((\d{4})\.(\d{2})\)\s*$/.exec(reportName);
  const month = Number(period?.[2]);
  if (!period || month < 1 || month > 12) return null;
  return new Date(Date.UTC(Number(period[1]), month, 0)).toISOString().slice(0, 10);
}

// The company ---------------------------------------------------------------------------------------------

/** A company as answers name it: its Korean name, with its English one when given. */
function nameOf(company: DartCompany): string {
  return company.corp_eng_name ? `${company.corp_name} (${company.corp_eng_name})` : company.corp_name;
}

/** OpenDART keeps one corp_code per company and links no predecessor, so history before it is not linked. */
function successionOf(corpCode: string): Succession {
  return { registrants: [{ cik: corpCode, complete: true }], stopsAt: [corpCode] };
}

/** OpenDART's class of a company (corp_cls) as a Korean market: Y KOSPI, K KOSDAQ (N is KONEX). */
// The provider -------------------------------------------------------------------------------------------

/** A filing listed, with its report type when known. */
type Listed = { filing: DartFiling; code: string | undefined };

/** Newest first: by receipt day, then receipt number. */
function newestFirst(a: Listed, b: Listed): number {
  const left = `${a.filing.rcept_dt}|${a.filing.rcept_no}`;
  const right = `${b.filing.rcept_dt}|${b.filing.rcept_no}`;
  return left < right ? 1 : left > right ? -1 : 0;
}

export function dartFilings(deps: ForkDeps): DartFilings {
  const dart: DartSource = dartSource(deps);

  /** The Korean listing `symbol` names, and its company in OpenDART's list. */
  const companyOf = async (symbol: string, call: Call | undefined) => {
    const company = await dart.company(symbol, call);
    return { company, listing: parseListing(symbol) as KoreanListing };
  };

  /**
   * The listing as answers describe it, placed as the statements place it (dartMarketOf): by OpenDART's class of
   * the company (`corpClass`, from its filings, else the company's outline), else by the key's market.
   */
  const instrumentOf = async (
    company: DartCompany,
    listing: KoreanListing,
    corpClass: string | null,
    call: Call | undefined,
  ): Promise<Instrument> => {
    // The outline is read only for its class here: when OpenDART fails to answer it, the key's market places the
    // listing (a refusal of the key, or its limit reached, is the answer).
    const outline = corpClass
      ? undefined
      : await dart.outline(company.corp_code, call).catch((error: unknown) => {
          if (call?.signal?.aborted || !(error instanceof DataError) || error.kind !== "unavailable")
            throw error;
          return undefined;
        });
    const cls = corpClass ?? outline?.corp_cls ?? null;
    const market = dartMarketOf(cls, listing.market);
    const code = company.stock_code ?? listing.code;
    return {
      key: market ? `${market}:${code}` : code,
      name: nameOf(company),
      venue: market ? KOREAN_MARKETS[market].venue : cls === "N" ? "KONEX" : null,
      currency: "KRW",
      price_scale: 1,
      // OpenDART's list says a company is listed; it says nothing more of the listing's state.
      listing: null,
    };
  };

  /** The filings of one window of receipt days, every filter's (each read to its total), newest first. */
  const windowOf = async (
    corpCode: string,
    from: string,
    through: string,
    filters: readonly DartFilter[] | undefined,
    call: Call | undefined,
  ): Promise<Listed[]> => {
    const found = new Map<string, Listed>();
    for (const filter of filters ?? [undefined]) {
      const filings = await dart.filings(
        {
          corp_code: corpCode,
          bgn_de: from,
          end_de: through,
          ...(filter ? { pblntf_ty: filter.group } : {}),
          ...(filter?.detail ? { pblntf_detail_ty: filter.detail } : {}),
        },
        call,
      );
      for (const filing of filings) {
        // A report type asked for names its filings' type; a name says it where none was asked for.
        const code = filter?.detail ?? found.get(filing.rcept_no)?.code ?? detailCodeOf(filing.report_nm);
        found.set(filing.rcept_no, { filing, code });
      }
    }
    return [...found.values()].sort(newestFirst);
  };

  const list = async (symbol: string, query: ListQuery, call?: Call): Promise<FilingList> => {
    const today = seoulDay(deps.clock());
    let resume: { day: string; key: string } | undefined;
    if (query.after !== undefined) {
      const day = receiptDate(query.after);
      if (!day) {
        throw invalid(
          `after must be a cursor a previous call returned (an OpenDART receipt number), not "${query.after}"`,
        );
      }
      resume = { day, key: `${day}|${query.after}` };
    }
    const filters = dartFiltersOf(query.forms);
    const { company, listing } = await companyOf(symbol, call);
    const limit = Math.max(1, query.limit);
    const listed: Listed[] = [];
    let corpClass: string | null = null;
    let more = false;
    let through = resume && resume.day < today ? resume.day : today;
    let span = DART_FIRST_WINDOW_DAYS;
    while (!more && through >= DART_FIRST_DAY) {
      const candidate = addDays(through, 1 - span);
      const from = candidate < DART_FIRST_DAY ? DART_FIRST_DAY : candidate;
      for (const one of await windowOf(company.corp_code, from, through, filters, call)) {
        corpClass ??= one.filing.corp_cls;
        if (resume && `${one.filing.rcept_dt}|${one.filing.rcept_no}` >= resume.key) continue;
        if (listed.length === limit) {
          more = true;
          break;
        }
        listed.push(one);
      }
      through = addDays(from, -1);
      span *= 2;
    }
    return {
      instrument: await instrumentOf(company, listing, corpClass, call),
      succession: successionOf(company.corp_code),
      data: listed.map(({ filing, code }) => ({
        form: formOf(filing.report_nm, code),
        accession: filing.rcept_no,
        cik: company.corp_code,
        predecessor: false,
        filed: filing.rcept_dt,
        accepted_at: filing.rcept_dt,
        report_date: periodEndOf(filing.report_nm, code),
        url: filing.url,
        sections: sectionsOfDartReport(code).map((section) => ({ section, state: "available" })),
      })),
      next_cursor: more ? (listed.at(-1)?.filing.rcept_no ?? null) : null,
    };
  };

  const section = async (
    target: { symbol: string; accession: string; section: FilingSectionName },
    query: { after?: string },
    call?: Call,
  ): Promise<SectionText> => {
    const day = receiptDate(target.accession);
    if (!day) {
      throw invalid(
        `${target.accession} is not an OpenDART receipt number (14 digits, its receipt day first, such as 20260310000812)`,
      );
    }
    const today = seoulDay(deps.clock());
    if (day > today) {
      throw invalid(
        `${target.accession}'s receipt day, ${day} (its first eight digits), is after today (${today} in Seoul)`,
      );
    }
    if (query.after !== undefined) {
      throw invalid(
        "this source serves a section whole, with no further pages: continue by character offset",
      );
    }
    const { company } = await companyOf(target.symbol, call);
    const filing = (
      await dart.filings({ corp_code: company.corp_code, bgn_de: day, end_de: day }, call)
    ).find((one) => one.rcept_no === target.accession);
    if (!filing) {
      throw invalid(
        `${target.accession} is not among ${company.corp_name}'s filings received on ${day}; list them with filings`,
      );
    }
    const code = detailCodeOf(filing.report_nm);
    const base = {
      form: formOf(filing.report_nm, code),
      accession: filing.rcept_no,
      accepted_at: filing.rcept_dt,
      section: target.section,
    };
    const none = (reason: string): SectionText => ({
      ...base,
      state: "not_found",
      content: null,
      chars: null,
      field_states: { content: { reason, retry: "never" } },
      next_cursor: null,
    });
    if (!code || !DART_PERIODIC.has(code) || !isDartSection(target.section)) {
      return none(
        `section_not_found: a ${filing.report_nm} has no ${target.section} section that this source reads`,
      );
    }
    const sections = (await dartDocumentSections(deps, dart, filing.rcept_no, call)).sections;
    // A half-year or quarterly report leaves the directors' discussion out, as filings lists its sections.
    const found =
      target.section === "mdna" && code !== "A001" ? interimMdna(sections.mdna) : sections[target.section];
    if (found.state === "not_found") return none(`section_not_found: ${found.reason}`);
    return {
      ...base,
      state: found.state,
      content: found.content,
      chars: found.content.length,
      field_states: null,
      next_cursor: null,
    };
  };

  const transactions = async (
    symbol: string,
    query: TransactionsQuery,
    call?: Call,
  ): Promise<InsiderTransactions> => {
    if (query.codes?.length) {
      throw invalid(
        `transaction codes are those of SEC Form 4, and ${symbol} is a Korean listing, whose insiders' reports to OpenDART (임원ㆍ주요주주특정증권등소유상황보고서) state holdings and their change with no transaction codes: ask without codes`,
      );
    }
    const { start, end } = query;
    if (start && end && start > end) throw invalid(`start (${start}) is after end (${end})`);
    if (query.after !== undefined && !RECEIPT.test(query.after)) {
      throw invalid(
        `after must be a cursor a previous call returned (an OpenDART receipt number), not "${query.after}"`,
      );
    }
    const { company, listing } = await companyOf(symbol, call);
    const reports = await dart.insiders(company.corp_code, call);
    const today = seoulDay(deps.clock());
    const through = end && end < today ? end : today;
    // Each report once, newest first.
    const sorted = [...new Map(reports.map((report) => [report.rcept_no, report])).values()].sort((a, b) => {
      const left = `${a.rcept_dt}|${a.rcept_no}`;
      const right = `${b.rcept_dt}|${b.rcept_no}`;
      return left < right ? 1 : left > right ? -1 : 0;
    });
    const inWindow = sorted.filter(
      (report) => (!start || report.rcept_dt >= start) && (!end || report.rcept_dt <= end),
    );
    let first = 0;
    if (query.after !== undefined) {
      const at = inWindow.findIndex((report) => report.rcept_no === query.after);
      if (at < 0) {
        throw invalid(
          `after names no insider report of ${company.corp_name} in the dates asked; ask again without it`,
        );
      }
      first = at + 1;
    }
    const limit = Math.max(1, query.limit);
    const page = inWindow.slice(first, first + limit);
    const unread = inWindow[first + limit];
    // Every report received after the newest one left unread is on this page or a page before it. The reports
    // OpenDART holds begin with DART's electronic filings: dates asked before that are not covered.
    let from = unread ? addDays(unread.rcept_dt, 1) : (start ?? sorted.at(-1)?.rcept_dt ?? null);
    let before = false;
    if (from !== null && from < DART_FIRST_DAY) {
      before = start !== undefined && start < DART_FIRST_DAY;
      from = DART_FIRST_DAY;
    }
    const settled = weekdaysAfter(through, DART_INSIDER_REPORT_DAYS);
    return {
      instrument: await instrumentOf(company, listing, null, call),
      filings: Object.fromEntries(
        page.map((report) => [
          report.rcept_no,
          {
            form: DART_INSIDER_FORM,
            accepted_at: report.rcept_dt,
            owners: [
              {
                name: report.repror,
                officer_title: roleOf(report),
                // The report names a registered officer, not a board seat or a 10% holding as such.
                is_director: null,
                is_ten_percent_owner: null,
              },
            ],
          },
        ]),
      ),
      coverage: {
        from,
        through,
        complete: true,
        requested_before_window: before,
        not_yet_served: null,
        complete_after: settled > today ? settled : null,
      },
      data: page.map((report) => {
        const change = report.sp_stock_lmp_irds_cnt;
        return {
          accession: report.rcept_no,
          transaction_date: null,
          code: null,
          shares: change === null ? null : Math.abs(change),
          security_title: holdingTitle(report),
          derivative: null,
          conversion_or_exercise_price: null,
          underlying_shares: null,
          underlying_title: null,
          price: null,
          acquired_disposed: change === null || change === 0 ? null : change > 0 ? "A" : "D",
          owned_following: report.sp_stock_lmp_cnt,
        };
      }),
      next_cursor: unread ? (page.at(-1)?.rcept_no ?? null) : null,
    };
  };

  return { list, section, transactions };
}

/** A reporter's role as the report states it: position, registered officer or not, major-shareholder relation. */
function roleOf(report: DartInsiderReport): string | null {
  const said = [report.isu_exctv_ofcps, report.isu_exctv_rgist_at, report.isu_main_shrholdr].filter(
    (one): one is string => one !== null,
  );
  return said.length ? said.join(", ") : null;
}

/** A percent as OpenDART gives one: two decimals at least, as many as it gives. */
function percent(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

/** The specified securities held after a report: the percent held and its change, when the report gives them. */
function holdingTitle(report: DartInsiderReport): string {
  const title = "특정증권등 (specified securities)";
  const held = report.sp_stock_lmp_rate;
  if (held === null) return title;
  const change = report.sp_stock_lmp_irds_rate;
  const changed =
    change === null
      ? ""
      : `, a change of ${change > 0 ? "+" : change < 0 ? "-" : ""}${percent(Math.abs(change))} points`;
  return `${title}, ${percent(held)}% held after the report${changed}`;
}
