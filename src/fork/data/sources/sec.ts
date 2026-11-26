// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * SEC EDGAR's JSON APIs on data.sec.gov, read for the filers provider: a company's filing index
 * (submissions) and its XBRL facts (companyfacts), and the company a US listing files as (through SEC's ticker
 * list, sources/sec-tickers.ts). Every request goes through the fork's HTTP client, which sends SEC_USER_AGENT
 * and keeps to SEC's 10 requests a second.
 *
 * What the answers are like (measured on SEC's own answers, saved in the SEC area's facts):
 * - submissions/CIK##########.json: the filer's name, tickers and exchanges, and `filings.recent`, parallel
 *   column arrays of at least a year or about 1,000 filings, whichever is more; older filings are on pages
 *   listed in `filings.files` (the same columns at the page's top level), numbered newest first, whose
 *   filingFrom/filingTo are hints only (one day off was seen). Rows are sorted by filing date, not by
 *   acceptance time; acceptanceDateTime is UTC ("2026-11-03T13:05:15.000Z").
 * - api/xbrl/companyfacts/CIK##########.json: every fact by taxonomy, concept and unit; up to 9.3 MB decoded for
 *   the largest filers measured (the HTTP client's 16 MiB bound fits it). A fact's fy and fp describe the filing,
 *   not the fact; 8-K recasts, 424B2 and proxy statements carry facts too. Only facts from periodic reports
 *   (10-K, 10-Q, 20-F, 40-F, 10-KT, 10-QT and their amendments) are kept, and of those only the concepts the line
 *   catalog reads (catalog/lines.ts): a smaller form than SEC's answer, kept on disk too.
 * - A CIK or path SEC does not have answers 404 with an XML error page, mapped before any body is read.
 *
 * The names come from submissions, never from companyfacts' entityName (CIK 70858, Bank of America, is named
 * "BofA Finance LLC" there).
 */
import { DataError } from "../../../data/errors.js";
import { CATALOG_CONCEPTS } from "../catalog/lines.js";
import type { ForkDeps } from "../deps.js";
import { canonicalKey } from "../listings.js";
import { paddedCik, type SecCompany, secTicker, secTickers } from "./sec-tickers.js";

/** The source as answers and errors name it. */
export const SEC_SOURCE = "SEC EDGAR";

export const SEC_DATA_URL = "https://data.sec.gov";
export const SEC_ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data";

/** How long a filing index is kept: new filings arrive through the day. */
export const SUBMISSIONS_TTL_MS = 10 * 60_000;
/** How long an older page of the index is kept: it changes only as pages are added. */
export const SUBMISSIONS_PAGE_TTL_MS = 86_400_000;
/** How long a company's facts are kept; reread when a periodic report newer than them is in the index. */
export const FACTS_TTL_MS = 60 * 60_000;

/** The reports whose facts statements are read from. */
export const PERIODIC_FORMS: ReadonlySet<string> = new Set([
  "10-K",
  "10-K/A",
  "10-Q",
  "10-Q/A",
  "20-F",
  "20-F/A",
  "40-F",
  "40-F/A",
  "10-KT",
  "10-KT/A",
  "10-QT",
  "10-QT/A",
]);

/** The annual reports among them: their year-long facts give the fiscal years. */
export const ANNUAL_FORMS: ReadonlySet<string> = new Set([
  "10-K",
  "10-K/A",
  "20-F",
  "20-F/A",
  "40-F",
  "40-F/A",
  "10-KT",
  "10-KT/A",
]);

/** A filing index's URL. */
export const submissionsUrl = (cik: string | number) =>
  `${SEC_DATA_URL}/submissions/CIK${paddedCik(cik)}.json`;

/** An older page of a filing index, by the name the index gives it. */
export const submissionsPageUrl = (name: string) => `${SEC_DATA_URL}/submissions/${name}`;

/** A company's XBRL facts. */
export const companyFactsUrl = (cik: string | number) =>
  `${SEC_DATA_URL}/api/xbrl/companyfacts/CIK${paddedCik(cik)}.json`;

/**
 * A filing's folder in EDGAR's archives, or a document in it: the CIK as a number, the accession without its
 * dashes ("https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm").
 */
export function archiveUrl(cik: string | number, accession: string, document = ""): string {
  const folder = `${SEC_ARCHIVES_URL}/${Number(paddedCik(cik))}/${accession.replaceAll("-", "")}/`;
  return document ? `${folder}${document.split("/").map(encodeURIComponent).join("/")}` : folder;
}

/** One filing of a company's index. */
export type FilingRow = {
  accession: string;
  form: string;
  /** The filing date, YYYY-MM-DD. */
  filed: string;
  /** The period it reports on (a periodic report's period end; a Form 4's earliest transaction), when given. */
  reportDate: string | null;
  /** When EDGAR accepted it, UTC ("2026-11-03T13:05:15Z"). */
  acceptedAt: string;
  /** The primary document's name in the filing's folder ("" when the index names none). */
  primaryDocument: string;
  description: string;
  /** Whether it carries XBRL. */
  xbrl: boolean;
};

/** An older page of a filing index, as the index lists it. */
export type FilingPage = { name: string; filingCount: number; filingFrom: string; filingTo: string };

/** A company's filing index: who it is, its recent filings (newest accepted first) and its older pages. */
export type Submissions = {
  cik: string;
  name: string;
  tickers: string[];
  exchanges: string[];
  /** MMDD, the month and day its fiscal year ends ("0925"). */
  fiscalYearEnd: string | null;
  entityType: string | null;
  recent: FilingRow[];
  pages: FilingPage[];
};

/** One fact, as kept: its period (no start for an instant), value and the filing it is from. */
export type Fact = {
  start: string | null;
  end: string;
  val: number;
  accn: string;
  form: string;
  filed: string;
};

/** A company's facts from periodic reports, of the catalog's concepts: by taxonomy, concept and unit. */
export type CompanyFacts = {
  cik: string;
  facts: Record<string, Record<string, Record<string, Fact[]>>>;
  /** Every periodic report that gave us-gaap or ifrs-full facts of any concept (not only the catalog's). */
  financialAccessions: string[];
};

/** The company a US listing files as, and the listing's key and exchange. */
export type SecFiler = SecCompany & { key: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;

/** Text a source wrote, with runs of whitespace as one space ("WELLS        FARGO" reads "WELLS FARGO"). */
export function normalizeName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** An acceptance time as answers state it: SEC's UTC time without its zero milliseconds. */
function acceptance(value: unknown, filed: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return filed;
  return value.replace(/\.0+Z$/, "Z");
}

const malformed = (what: string) =>
  new DataError("unavailable", `${SEC_SOURCE} answered ${what} in a form this app does not read.`, {
    source: SEC_SOURCE,
  });

/** The rows of a filing index's column arrays (`recent`, or an older page), newest accepted first. */
export function filingRows(columns: unknown, what = "a filing index"): FilingRow[] {
  const table = columns as Record<string, unknown> | null;
  if (!table || typeof table !== "object") throw malformed(what);
  const column = (name: string): unknown[] | undefined =>
    Array.isArray(table[name]) ? (table[name] as unknown[]) : undefined;
  const accessions = column("accessionNumber");
  const forms = column("form");
  const filed = column("filingDate");
  if (!accessions || !forms || !filed) throw malformed(what);
  const reports = column("reportDate") ?? [];
  const accepted = column("acceptanceDateTime") ?? [];
  const documents = column("primaryDocument") ?? [];
  const descriptions = column("primaryDocDescription") ?? [];
  const xbrl = column("isXBRL") ?? [];
  const rows: FilingRow[] = [];
  const count = Math.min(accessions.length, forms.length, filed.length);
  for (let i = 0; i < count; i++) {
    const accession = accessions[i];
    const form = forms[i];
    const date = filed[i];
    if (typeof accession !== "string" || !ACCESSION.test(accession)) continue;
    if (typeof form !== "string" || !form.trim() || typeof date !== "string" || !DATE.test(date)) continue;
    const report = reports[i];
    const document = documents[i];
    const description = descriptions[i];
    rows.push({
      accession,
      form: form.trim(),
      filed: date,
      reportDate: typeof report === "string" && DATE.test(report) ? report : null,
      acceptedAt: acceptance(accepted[i], date),
      primaryDocument: typeof document === "string" ? document.trim() : "",
      description: typeof description === "string" ? description.trim() : "",
      xbrl: xbrl[i] === 1 || xbrl[i] === true,
    });
  }
  return rows.sort(newestFirst);
}

/** Newest accepted first; the later accession first between two accepted at the same second. */
export function newestFirst(a: FilingRow, b: FilingRow): number {
  if (a.acceptedAt !== b.acceptedAt) return a.acceptedAt < b.acceptedAt ? 1 : -1;
  return a.accession === b.accession ? 0 : a.accession < b.accession ? 1 : -1;
}

/** A filing index as SEC answers it, read. */
export function parseSubmissions(body: unknown, cik: string): Submissions {
  const index = body as Record<string, unknown> | null;
  const filings = index?.filings as Record<string, unknown> | undefined;
  if (!index || typeof index !== "object" || !filings || typeof filings !== "object") {
    throw malformed(`the filing index of CIK ${cik}`);
  }
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const pages: FilingPage[] = [];
  for (const page of Array.isArray(filings.files) ? filings.files : []) {
    const entry = page as Record<string, unknown> | null;
    const name = entry?.name;
    // A page's name becomes part of a URL: only a plain file name is followed.
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name)) continue;
    pages.push({
      name,
      filingCount: typeof entry?.filingCount === "number" ? entry.filingCount : 0,
      filingFrom: typeof entry?.filingFrom === "string" ? entry.filingFrom : "",
      filingTo: typeof entry?.filingTo === "string" ? entry.filingTo : "",
    });
  }
  return {
    cik: paddedCik(typeof index.cik === "string" || typeof index.cik === "number" ? index.cik : cik),
    name: typeof index.name === "string" ? normalizeName(index.name) : "",
    tickers: strings(index.tickers),
    exchanges: strings(index.exchanges),
    fiscalYearEnd:
      typeof index.fiscalYearEnd === "string" && /^\d{4}$/.test(index.fiscalYearEnd)
        ? index.fiscalYearEnd
        : null,
    entityType: typeof index.entityType === "string" ? index.entityType : null,
    recent: filingRows(filings.recent, `the filing index of CIK ${cik}`),
    pages,
  };
}

/** A company's facts as SEC answers them, read down to the periodic reports' facts of the catalog's concepts. */
export function parseCompanyFacts(body: unknown, cik: string): CompanyFacts {
  const answer = body as Record<string, unknown> | null;
  const taxonomies = answer?.facts;
  if (
    !answer ||
    typeof answer !== "object" ||
    !taxonomies ||
    typeof taxonomies !== "object" ||
    Array.isArray(taxonomies)
  ) {
    throw malformed(`the XBRL facts of CIK ${cik}`);
  }
  const facts: CompanyFacts["facts"] = {};
  const financial = new Set<string>();
  for (const [taxonomy, concepts] of Object.entries(taxonomies as Record<string, unknown>)) {
    if (!concepts || typeof concepts !== "object") continue;
    const kept = CATALOG_CONCEPTS[taxonomy as keyof typeof CATALOG_CONCEPTS];
    const statements = taxonomy === "us-gaap" || taxonomy === "ifrs-full";
    for (const [concept, entry] of Object.entries(concepts as Record<string, unknown>)) {
      const units = (entry as { units?: unknown } | null)?.units;
      if (!units || typeof units !== "object") continue;
      const wanted = kept?.has(concept) ?? false;
      if (!wanted && !statements) continue;
      for (const [unit, list] of Object.entries(units as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const fact = item as Record<string, unknown> | null;
          const form = fact?.form;
          if (typeof form !== "string" || !PERIODIC_FORMS.has(form)) continue;
          const { start, end, val, accn, filed } = fact as Record<string, unknown>;
          if (typeof end !== "string" || !DATE.test(end) || typeof val !== "number" || !Number.isFinite(val))
            continue;
          if (
            typeof accn !== "string" ||
            !ACCESSION.test(accn) ||
            typeof filed !== "string" ||
            !DATE.test(filed)
          )
            continue;
          if (start !== undefined && (typeof start !== "string" || !DATE.test(start))) continue;
          if (statements) financial.add(accn);
          if (!wanted) continue;
          const concepts = facts[taxonomy] ?? {};
          facts[taxonomy] = concepts;
          const byUnit = concepts[concept] ?? {};
          concepts[concept] = byUnit;
          const list = byUnit[unit] ?? [];
          byUnit[unit] = list;
          list.push({ start: (start as string | undefined) ?? null, end, val, accn, form, filed });
        }
      }
    }
  }
  return { cik: paddedCik(cik), facts, financialAccessions: [...financial].sort() };
}

/** What the filers provider reads from SEC EDGAR, kept in the cache as it says. */
export type SecSource = {
  /** The company a US listing files as; unsupported for a listing elsewhere, no_data for a ticker SEC lacks. */
  filer(symbol: string, call?: { signal?: AbortSignal }): Promise<SecFiler>;
  /** The company's filing index. */
  submissions(cik: string, call?: { signal?: AbortSignal }): Promise<Submissions>;
  /** One older page of the index, newest accepted first. */
  page(cik: string, page: FilingPage, call?: { signal?: AbortSignal }): Promise<FilingRow[]>;
  /** The filings with these accessions, from recent and as many older pages as it takes. */
  filings(
    cik: string,
    accessions: Iterable<string>,
    call?: { signal?: AbortSignal },
  ): Promise<Map<string, FilingRow>>;
  /**
   * The company's facts, and when they were stored; `fresh` rereads them (their kept copy is older than a
   * filing that should be in them).
   */
  facts(
    cik: string,
    call?: { signal?: AbortSignal; fresh?: boolean },
  ): Promise<{ facts: CompanyFacts; storedAt: number }>;
};

/** The year an accession was made in ("0000320193-26-000026": 2026), to look for it on the right page first. */
function accessionYear(accession: string): number {
  const yy = Number(accession.slice(11, 13));
  return yy >= 90 ? 1900 + yy : 2000 + yy;
}

/** Pages in the order to look for filings of `years`: those whose dates cover one of them first. */
function pagesFor(pages: readonly FilingPage[], years: ReadonlySet<number>): FilingPage[] {
  const covers = (page: FilingPage) => {
    const from = Number(page.filingFrom.slice(0, 4)) || 0;
    const to = Number(page.filingTo.slice(0, 4)) || 9999;
    // The dates are hints (one day off was seen): a year either side counts.
    for (const year of years) if (year >= from - 1 && year <= to + 1) return true;
    return false;
  };
  return [...pages.filter(covers), ...pages.filter((page) => !covers(page))];
}

export function secSource(deps: ForkDeps): SecSource {
  const tickers = secTickers(deps);
  const json = (url: string, call: { signal?: AbortSignal } | undefined, notFoundMessage: string) =>
    deps.http.json(url, { source: SEC_SOURCE, signal: call?.signal, notFound: "no_data", notFoundMessage });

  const submissions: SecSource["submissions"] = (cik, call) =>
    deps.cache.remember(
      `sec:submissions:${paddedCik(cik)}`,
      SUBMISSIONS_TTL_MS,
      async () =>
        parseSubmissions(
          await json(
            submissionsUrl(cik),
            call,
            `${SEC_SOURCE} has no filing index for CIK ${paddedCik(cik)}.`,
          ),
          paddedCik(cik),
        ),
      { disk: "json", signal: call?.signal },
    );

  const page: SecSource["page"] = (cik, listed, call) =>
    deps.cache.remember(
      `sec:submissions:${paddedCik(cik)}:${listed.name}:${listed.filingFrom}:${listed.filingTo}`,
      SUBMISSIONS_PAGE_TTL_MS,
      async () =>
        filingRows(
          await json(
            submissionsPageUrl(listed.name),
            call,
            `${SEC_SOURCE} has no page ${listed.name} of the filing index for CIK ${paddedCik(cik)}.`,
          ),
          `page ${listed.name} of the filing index of CIK ${paddedCik(cik)}`,
        ),
      { disk: "json", signal: call?.signal },
    );

  return {
    async filer(symbol, call) {
      const ticker = secTicker(symbol);
      if (ticker === undefined) {
        throw new DataError(
          "unsupported",
          `${SEC_SOURCE} holds the filings of companies listed in the US, and ${symbol} is not a US listing`,
          { source: SEC_SOURCE },
        );
      }
      const company = await tickers.bySymbol(symbol, call);
      if (!company) {
        throw new DataError(
          "no_data",
          `${SEC_SOURCE} lists no company that files under the ticker ${ticker}.`,
          {
            source: SEC_SOURCE,
            retry: "never",
          },
        );
      }
      return { ...company, key: canonicalKey(symbol) ?? company.ticker };
    },
    submissions,
    page,
    async filings(cik, accessions, call) {
      const wanted = new Set(accessions);
      const found = new Map<string, FilingRow>();
      const take = (rows: readonly FilingRow[]) => {
        for (const row of rows) {
          if (wanted.delete(row.accession)) found.set(row.accession, row);
        }
      };
      const index = await submissions(cik, call);
      take(index.recent);
      if (wanted.size) {
        const years = new Set([...wanted].map(accessionYear));
        for (const listed of pagesFor(index.pages, years)) {
          take(await page(cik, listed, call));
          if (!wanted.size) break;
        }
      }
      return found;
    },
    async facts(cik, call) {
      const key = `sec:companyfacts:${paddedCik(cik)}`;
      if (call?.fresh) await deps.cache.forget(key);
      const kept = await deps.cache.keep(
        key,
        FACTS_TTL_MS,
        async () =>
          parseCompanyFacts(
            await json(
              companyFactsUrl(cik),
              call,
              `${SEC_SOURCE} holds no XBRL financial data for CIK ${paddedCik(cik)}.`,
            ),
            paddedCik(cik),
          ),
        { disk: "json", signal: call?.signal },
      );
      return { facts: kept.value, storedAt: kept.storedAt };
    },
  };
}
