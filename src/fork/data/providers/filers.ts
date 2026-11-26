// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "SEC EDGAR", routes.ts key `filers`: what companies file with the SEC. Served only when SEC_USER_AGENT is set
 * (SEC's fair-access rule asks every program to name its sender); without it nothing is declared, so these
 * capabilities show as not available and the start-up note says what to set.
 *
 * - statements.statement: SEC's XBRL facts (companyfacts), us-gaap or, for 20-F filers, ifrs-full in the
 *   reporting currency (never mixed with the USD convenience translations those filers add), each value the
 *   latest filed for its period from a periodic report (10-K, 10-Q, 20-F, 40-F, 10-KT, 10-QT and amendments; an
 *   8-K recast, a prospectus or a proxy statement never wins), with its filing and acceptance time. Facts are
 *   classified by the length of their period, not by the filing's fy/fp. Quarters are three-month values;
 *   additive flows not filed for a quarter alone are computed (a cash-flow quarter as year-to-date differences,
 *   a fourth quarter as the year less nine months), each computed value naming both filings; per-share
 *   figures and share counts are never computed. A newest periodic report that SEC's XBRL data does not hold yet
 *   is said in the filer's coverage.
 * - filings.list: the filing index (submissions), its recent filings and as many older pages as the page and
 *   the cursor need, newest accepted first, filtered by exact form ("/A" amendments when asked for), each with
 *   the sections filing_section reads for its form.
 * - filings.section: the filing's primary document from EDGAR's archives, split by Item (sec-sections.ts).
 * - ownership.transactions: Forms 4 and 5 found in the issuer's own index, read from their raw XML
 *   (sec-form4.ts), reports in which the company is not the issuer left out; the coverage says which dates the
 *   reports read cover.
 *
 * SEC links no predecessor filers, so each answer's succession names the company's own CIK and says that history
 * before it is not linked. In Phase 4 the provider adds OpenDART for Korean filers.
 */
import type {
  DataProvider,
  FieldStates,
  FilingSectionName,
  Filings,
  Implementation,
  Instrument,
  Ownership,
  Statement,
  Statements,
  Succession,
} from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import { type CatalogLine, type LineFormula, linesOf, type StatementKind } from "../catalog/lines.js";
import type { ForkDeps } from "../deps.js";
import {
  ANNUAL_FORMS,
  archiveUrl,
  type CompanyFacts,
  type Fact,
  type FilingPage,
  type FilingRow,
  SEC_SOURCE,
  type SecFiler,
  type SecSource,
  type Submissions,
  secSource,
} from "../sources/sec.js";
import { readOwnership, TRANSACTION_FORMS } from "../sources/sec-form4.js";
import { documentText, findSection, sectionsOfForm } from "../sources/sec-sections.js";
import { secTicker } from "../sources/sec-tickers.js";

type Call = { signal?: AbortSignal };
type Data<M> = M extends (...args: never[]) => Promise<infer D> ? D : never;
type FilingList = Data<NonNullable<Implementation<Filings>["list"]>>;
type SectionText = Data<NonNullable<Implementation<Filings>["section"]>>;
type InsiderTransactions = Data<NonNullable<Implementation<Ownership>["transactions"]>>;
type StatementLine = Statement["periods"][number]["lines"][number];

const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const invalid = (message: string) =>
  new DataError("invalid", message, { source: SEC_SOURCE, retry: "change_request" });

export function filersProvider(deps: ForkDeps): DataProvider {
  if (!deps.config.secUserAgent) return { name: SEC_SOURCE, capabilities: {} };
  const sec = secSource(deps);
  return {
    name: SEC_SOURCE,
    capabilities: {
      statements: { statement: (symbol, query, call) => readStatement(sec, symbol, query, call) },
      filings: {
        list: (symbol, query, call) => listFilings(sec, symbol, query, call),
        section: (target, query, call) => readSection(deps, sec, target, query, call),
      },
      ownership: {
        transactions: (symbol, query, call) => readTransactions(deps, sec, symbol, query, call),
      },
    },
  };
}

// The company ------------------------------------------------------------------------------------------

type Company = { filer: SecFiler; index: Submissions; instrument: Instrument };

/** The company a symbol files as, its filing index, and the listing as answers describe it. */
async function companyOf(sec: SecSource, symbol: string, call: Call | undefined): Promise<Company> {
  const filer = await sec.filer(symbol, call);
  const index = await sec.submissions(filer.cik, call);
  return {
    filer,
    index,
    // Every listing SEC's ticker list names is on a US venue (or OTC), quoted in dollars.
    instrument: {
      key: filer.key,
      name: index.name || filer.name,
      venue: filer.exchange,
      currency: "USD",
      price_scale: 1,
      // SEC's ticker list names current listings only; it says nothing more of the listing's state.
      listing: null,
    },
  };
}

/** The company's filers: SEC links no predecessor, so history before its own CIK is not linked. */
function successionOf(cik: string, incomplete?: string): Succession {
  return {
    registrants: [
      { cik, complete: incomplete === undefined, ...(incomplete ? { complete_reason: incomplete } : {}) },
    ],
    stopsAt: [cik],
  };
}

// Dates ------------------------------------------------------------------------------------------------

const time = (date: string) => Date.parse(`${date}T00:00:00Z`);
const addDays = (date: string, count: number) =>
  new Date(time(date) + count * DAY_MS).toISOString().slice(0, 10);
/** Days from `a` to `b` (negative when `b` is earlier). */
const daysBetween = (a: string, b: string) => Math.round((time(b) - time(a)) / DAY_MS);

type Length = "quarter" | "half" | "nine" | "year" | "other";

/** A period's length class, by days counted inclusively (52/53-week years run 364 to 371 days). */
function lengthOf(start: string, end: string): Length {
  const days = daysBetween(start, end) + 1;
  if (days >= 60 && days <= 110) return "quarter";
  if (days >= 150 && days <= 210) return "half";
  if (days >= 240 && days <= 310) return "nine";
  if (days >= 330 && days <= 400) return "year";
  return "other";
}

/** `count` weekdays after `date`. */
function weekdaysAfter(date: string, count: number): string {
  let day = date;
  let left = count;
  while (left > 0) {
    day = addDays(day, 1);
    const weekday = new Date(time(day)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left--;
  }
  return day;
}

// Statements ------------------------------------------------------------------------------------------

type Taxonomy = "us-gaap" | "ifrs-full";

/** A fact chosen for its period: the latest filed, and the first filed (a restatement when they differ). */
type Chosen = { fact: Fact; first: Fact };

/** One concept's facts in one unit, the latest filed per period: by period, and by period end. */
type Series = { byPeriod: Map<string, Chosen>; byEnd: Map<string, Chosen[]> };

/** A period of a statement: its dates, and for a quarter the start of its fiscal year (for year-to-date values). */
type Period = { start: string | null; end: string; yearStart?: string };

/** A value of a line in a period, before the filings' acceptance times are looked up. */
type Cell = {
  value: number | null;
  facts: Fact[];
  states: Record<string, { reason: string; retry: "never" | null }>;
};

/** Whether `a` was filed after `b`: a later filing date, an amendment over its original, a later accession. */
function filedAfter(a: Fact, b: Fact): boolean {
  if (a.filed !== b.filed) return a.filed > b.filed;
  const amended = (fact: Fact) => fact.form.endsWith("/A");
  if (amended(a) !== amended(b)) return amended(a);
  return a.accn > b.accn;
}

function seriesOf(facts: readonly Fact[]): Series {
  const byPeriod = new Map<string, Chosen>();
  for (const fact of facts) {
    const key = fact.start ? `${fact.start}/${fact.end}` : fact.end;
    const held = byPeriod.get(key);
    if (!held) byPeriod.set(key, { fact, first: fact });
    else {
      if (filedAfter(fact, held.fact)) held.fact = fact;
      if (filedAfter(held.first, fact)) held.first = fact;
    }
  }
  const byEnd = new Map<string, Chosen[]>();
  for (const chosen of byPeriod.values()) {
    const list = byEnd.get(chosen.fact.end);
    if (list) list.push(chosen);
    else byEnd.set(chosen.fact.end, [chosen]);
  }
  return { byPeriod, byEnd };
}

/** The forms that file a quarter's report. */
const QUARTERLY_FORMS: ReadonlySet<string> = new Set(["10-Q", "10-Q/A", "10-QT", "10-QT/A"]);

/** What a statement is built from: the facts of one taxonomy, in one reporting currency. */
class Book {
  private readonly cache = new Map<string, Series>();
  readonly currency: string;

  constructor(
    readonly facts: CompanyFacts,
    readonly taxonomy: Taxonomy,
  ) {
    this.currency = reportingCurrency(facts, taxonomy);
  }

  /** The unit a line's values are in. */
  unitOf(line: CatalogLine): string {
    return line.unit === "currency"
      ? this.currency
      : line.unit === "per_share"
        ? `${this.currency}/shares`
        : "shares";
  }

  series(concept: string, unit: string, taxonomy: string = this.taxonomy): Series {
    const key = `${taxonomy}|${concept}|${unit}`;
    let found = this.cache.get(key);
    if (!found) {
      found = seriesOf(this.facts.facts[taxonomy]?.[concept]?.[unit] ?? []);
      this.cache.set(key, found);
    }
    return found;
  }

  /** The line's own concepts in this taxonomy. */
  tags(line: CatalogLine): readonly string[] {
    return this.taxonomy === "us-gaap" ? line.usGaap : line.ifrs;
  }

  formula(line: CatalogLine): LineFormula | undefined {
    return this.taxonomy === "us-gaap" ? line.compute?.usGaap : line.compute?.ifrs;
  }

  /** Whether the filer ever filed a value of the line (its concepts, its formula's, its cover-page count). */
  knows(line: CatalogLine): boolean {
    const unit = this.unitOf(line);
    const formula = this.formula(line);
    const concepts = [...this.tags(line), ...(formula?.add ?? []), ...(formula?.subtract ?? [])];
    if (concepts.some((concept) => this.series(concept, unit).byPeriod.size > 0)) return true;
    return line.dei !== undefined && this.series(line.dei, "shares", "dei").byPeriod.size > 0;
  }

  /** Every fact of the taxonomy's duration concepts, in any unit (for the fiscal calendar). */
  *durations(): Generator<Fact> {
    const concepts = new Set(
      [...linesOf("income_statement"), ...linesOf("cash_flow")].flatMap((line) => [...this.tags(line)]),
    );
    for (const [concept, units] of Object.entries(this.facts.facts[this.taxonomy] ?? {})) {
      if (!concepts.has(concept)) continue;
      for (const list of Object.values(units)) for (const fact of list) if (fact.start) yield fact;
    }
  }

  /** Whether the filer files quarterly reports (20-F and 40-F filers file annual ones only). */
  quarterly(): boolean {
    for (const units of Object.values(this.facts.facts[this.taxonomy] ?? {})) {
      for (const list of Object.values(units))
        if (list.some((fact) => QUARTERLY_FORMS.has(fact.form))) return true;
    }
    return false;
  }
}

/**
 * The currency a filer reports in: the one its facts use most. An IFRS filer's USD figures are a convenience
 * translation of its latest year only (TSMC's TWD facts outnumber its USD ones two to one), so they never win;
 * a tie goes to the currency other than USD.
 */
function reportingCurrency(facts: CompanyFacts, taxonomy: Taxonomy): string {
  const counts = new Map<string, number>();
  for (const units of Object.values(facts.facts[taxonomy] ?? {})) {
    for (const [unit, list] of Object.entries(units)) {
      if (/^[A-Z]{3}$/.test(unit)) counts.set(unit, (counts.get(unit) ?? 0) + list.length);
    }
  }
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || Number(a[0] === "USD") - Number(b[0] === "USD") || (a[0] < b[0] ? -1 : 1),
  );
  return ranked[0]?.[0] ?? "USD";
}

/** The taxonomy whose facts reach the latest period: us-gaap, or ifrs-full for a filer reporting under IFRS. */
function taxonomyOf(facts: CompanyFacts): Taxonomy | undefined {
  let chosen: Taxonomy | undefined;
  let latest = "";
  for (const taxonomy of ["us-gaap", "ifrs-full"] as const) {
    for (const units of Object.values(facts.facts[taxonomy] ?? {})) {
      for (const list of Object.values(units)) {
        for (const fact of list) {
          if (fact.end > latest) {
            latest = fact.end;
            chosen = taxonomy;
          }
        }
      }
    }
  }
  return chosen;
}

/** The fiscal years: the year-long periods annual reports give, each end with its most filed start. */
function fiscalYearsOf(book: Book): { start: string; end: string }[] {
  const starts = new Map<string, Map<string, number>>();
  for (const fact of book.durations()) {
    if (!ANNUAL_FORMS.has(fact.form) || !fact.start || lengthOf(fact.start, fact.end) !== "year") continue;
    const counted = starts.get(fact.end) ?? new Map<string, number>();
    counted.set(fact.start, (counted.get(fact.start) ?? 0) + 1);
    starts.set(fact.end, counted);
  }
  return [...starts.entries()]
    .map(([end, counted]) => ({
      end,
      start: [...counted.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] as string,
    }))
    .sort((a, b) => (a.end < b.end ? -1 : 1));
}

/**
 * The quarters: the three-month periods filed, and the quarters the year-to-date and annual periods mark out
 * (the second quarter ends where the first half does, the fourth where the year does), each with the start of
 * its fiscal year.
 */
function quartersOf(book: Book, years: readonly { start: string; end: string }[]): Period[] {
  const latest = years.at(-1);
  const yearStarts = [...years.map((year) => year.start), ...(latest ? [addDays(latest.end, 1)] : [])];
  const yearOf = (start: string) => yearStarts.find((one) => Math.abs(daysBetween(one, start)) <= 3);
  const threeMonth = new Map<string, Map<string, number>>();
  const marks = new Map<string, string>();
  for (const fact of book.durations()) {
    const start = fact.start as string;
    const length = lengthOf(start, fact.end);
    if (length === "quarter") {
      const counted = threeMonth.get(fact.end) ?? new Map<string, number>();
      counted.set(start, (counted.get(start) ?? 0) + 1);
      threeMonth.set(fact.end, counted);
    }
    if (length === "quarter" || length === "half" || length === "nine" || length === "year") {
      const yearStart = yearOf(start);
      if (yearStart && (length !== "year" || years.some((year) => year.end === fact.end))) {
        marks.set(fact.end, yearStart);
      }
    }
  }
  // A year's end marks a fourth quarter only where its nine months, or a filed fourth quarter, mark its start.
  const ends = new Set<string>(threeMonth.keys());
  for (const [end, yearStart] of marks) {
    const nine = [...marks.entries()].some(
      ([other, start]) => start === yearStart && other < end && lengthOf(start, other) === "nine",
    );
    if (lengthOf(yearStart, end) !== "year" || nine) ends.add(end);
  }
  const sorted = [...ends].sort();
  const periods: Period[] = [];
  for (const [index, end] of sorted.entries()) {
    const yearStart =
      years.find((year) => year.start <= end && end <= year.end)?.start ??
      (latest && end > latest.end ? addDays(latest.end, 1) : undefined);
    const filed = threeMonth.get(end);
    const previous = sorted[index - 1];
    const start = filed
      ? ([...filed.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] as string)
      : yearStart && previous && previous >= yearStart
        ? addDays(previous, 1)
        : yearStart;
    if (!start || lengthOf(start, end) !== "quarter") continue;
    periods.push({ start, end, ...(yearStart ? { yearStart } : {}) });
  }
  return periods;
}

/** The dates of the balance sheets filed: those of total assets, else of any balance-sheet line. */
function balanceDatesOf(book: Book, lines: readonly CatalogLine[]): string[] {
  const dates = new Set<string>();
  const add = (concepts: readonly string[]) => {
    for (const concept of concepts) {
      for (const list of Object.values(book.facts.facts[book.taxonomy]?.[concept] ?? {})) {
        for (const fact of list) if (!fact.start) dates.add(fact.end);
      }
    }
  };
  add(book.tags(lines.find((line) => line.label === "Total Assets") as CatalogLine));
  if (!dates.size) for (const line of lines) add(book.tags(line));
  return [...dates].sort();
}

/** The fact of `series` ending `end` with a length among `lengths`, whose start is nearest `start` within `tolerance` days. */
function nearest(
  series: Series,
  end: string,
  lengths: readonly Length[],
  start: string,
  tolerance: number,
): Chosen | undefined {
  let best: Chosen | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const chosen of series.byEnd.get(end) ?? []) {
    const from = chosen.fact.start;
    if (!from || !lengths.includes(lengthOf(from, end))) continue;
    const off = Math.abs(daysBetween(start, from));
    if (off <= tolerance && off < distance) {
      best = chosen;
      distance = off;
    }
  }
  return best;
}

const amount = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 20 });
const filing = (fact: Fact) => `${fact.form} ${fact.accn}`;
const span = (fact: Fact) => {
  const length = fact.start ? lengthOf(fact.start, fact.end) : "other";
  const words = {
    quarter: "three months",
    half: "six months",
    nine: "nine months",
    year: "year",
    other: "period",
  };
  return `${words[length]} to ${fact.end}`;
};

/** A cell of one filed value, with what the reader should know about its concept and any restatement. */
function filedCell(line: CatalogLine, concept: string, chosen: Chosen): Cell {
  const states: Cell["states"] = {};
  const note = line.notes?.[concept];
  if (note) states.concept = { reason: note, retry: null };
  if (chosen.first.val !== chosen.fact.val && chosen.first.accn !== chosen.fact.accn) {
    states.restated = {
      reason: `first filed as ${amount(chosen.first.val)} in ${filing(chosen.first)}`,
      retry: null,
    };
  }
  return { value: chosen.fact.val, facts: [chosen.fact], states };
}

const missing = (reason: string): Cell => ({
  value: null,
  facts: [],
  states: { value: { reason, retry: "never" } },
});

/** The value of a duration line in a fiscal year. */
function annualCell(book: Book, line: CatalogLine, period: Period): Cell {
  const unit = book.unitOf(line);
  for (const concept of book.tags(line)) {
    const found = nearest(book.series(concept, unit), period.end, ["year"], period.start as string, 7);
    if (found) return filedCell(line, concept, found);
  }
  return missing("not filed for this fiscal year");
}

/** The value of a duration line in a quarter: filed for the quarter, or computed from year-to-date values. */
function quarterCell(book: Book, line: CatalogLine, period: Period): Cell {
  const unit = book.unitOf(line);
  const start = period.start as string;
  for (const concept of book.tags(line)) {
    const found = nearest(book.series(concept, unit), period.end, ["quarter"], start, 7);
    if (found) return filedCell(line, concept, found);
  }
  const yearStart = period.yearStart;
  if (!line.additive) {
    return missing(
      "no three-month value filed; per-share figures and share counts are not computed from year-to-date or annual values",
    );
  }
  if (yearStart && yearStart !== start) {
    for (const concept of book.tags(line)) {
      const series = book.series(concept, unit);
      const through = nearest(series, period.end, ["half", "nine", "year"], yearStart, 3);
      const before = nearest(series, addDays(start, -1), ["quarter", "half", "nine"], yearStart, 3);
      if (!through || !before) continue;
      const states: Cell["states"] = {
        value: {
          reason: `computed: ${filing(through.fact)} (${span(through.fact)}) less ${filing(before.fact)} (${span(before.fact)})`,
          retry: "never",
        },
      };
      const note = line.notes?.[concept];
      if (note) states.concept = { reason: note, retry: null };
      return { value: through.fact.val - before.fact.val, facts: [through.fact, before.fact], states };
    }
  }
  return missing("not filed for this quarter");
}

/** The value of a balance-sheet line at a date: filed, computed from its formula, or the cover page's count. */
function instantCell(book: Book, line: CatalogLine, period: Period): Cell {
  const unit = book.unitOf(line);
  const at = (concept: string) => {
    const chosen = book.series(concept, unit).byPeriod.get(period.end);
    return chosen && !chosen.fact.start ? chosen : undefined;
  };
  for (const concept of book.tags(line)) {
    const found = at(concept);
    if (found) return filedCell(line, concept, found);
  }
  const formula = book.formula(line);
  if (formula) {
    const added = formula.add.map((concept) => [concept, at(concept)] as const).filter(([, found]) => found);
    const subtracted = (formula.subtract ?? [])
      .map((concept) => [concept, at(concept)] as const)
      .filter(([, found]) => found);
    const complete =
      formula.needs === "any"
        ? added.length > 0
        : added.length === formula.add.length && subtracted.length === (formula.subtract ?? []).length;
    if (complete) {
      const facts = [...added, ...subtracted].map(([, found]) => (found as Chosen).fact);
      const value =
        added.reduce((sum, [, found]) => sum + (found as Chosen).fact.val, 0) -
        subtracted.reduce((sum, [, found]) => sum + (found as Chosen).fact.val, 0);
      const names = (list: readonly (readonly [string, unknown])[]) =>
        list.map(([concept]) => concept).join(" + ");
      const sources = [...new Set(facts.map(filing))].join(", ");
      return {
        value,
        facts,
        states: {
          value: {
            reason: `computed: ${names(added)}${subtracted.length ? ` less ${names(subtracted)}` : ""}, as filed in ${sources}`,
            retry: "never",
          },
        },
      };
    }
  }
  if (line.dei) {
    // The cover page states the count at a date after the period's end (the report's own date).
    const cover = [...book.series(line.dei, "shares", "dei").byPeriod.values()]
      .filter((chosen) => !chosen.fact.start && chosen.fact.end >= period.end)
      .filter((chosen) => daysBetween(period.end, chosen.fact.end) <= 100)
      .sort((a, b) => (a.fact.end < b.fact.end ? -1 : 1))[0];
    if (cover) {
      return {
        value: cover.fact.val,
        facts: [cover.fact],
        states: {
          value: {
            reason:
              cover.fact.end === period.end
                ? `the cover page's count (dei ${line.dei}, ${filing(cover.fact)})`
                : `the cover page's count at ${cover.fact.end} (dei ${line.dei}, ${filing(cover.fact)}), not at the balance-sheet date`,
            retry: "never",
          },
        },
      };
    }
  }
  return missing("not filed for this date");
}

/** A statement's periods and the lines the filer files, before paging; with why it has none when it has none. */
export type BuiltStatement = {
  taxonomy: Taxonomy;
  currency: string;
  periods: { period: Period; cells: Map<string, Cell> }[];
  lines: CatalogLine[];
};

/** Every period of one statement of a filer's facts, newest first, with each line's value in it. */
export function buildStatement(
  facts: CompanyFacts,
  statement: StatementKind,
  periodType: "quarterly" | "annual",
): BuiltStatement | undefined {
  const taxonomy = taxonomyOf(facts);
  if (!taxonomy) return undefined;
  const book = new Book(facts, taxonomy);
  const lines = linesOf(statement).filter((line) => book.knows(line));
  const years = fiscalYearsOf(book);
  let periods: Period[];
  if (statement === "balance_sheet") {
    const dates =
      periodType === "annual"
        ? years.map((year) => year.end)
        : balanceDatesOf(book, linesOf("balance_sheet"));
    periods = dates.map((end) => ({ start: null, end }));
  } else {
    periods = periodType === "annual" ? years.map((year) => ({ ...year })) : quartersOf(book, years);
  }
  const built = periods
    .sort((a, b) => (a.end < b.end ? 1 : -1))
    .map((period) => {
      const cells = new Map<string, Cell>();
      for (const line of lines) {
        cells.set(
          line.label,
          line.period === "instant"
            ? instantCell(book, line, period)
            : periodType === "annual"
              ? annualCell(book, line, period)
              : quarterCell(book, line, period),
        );
      }
      return { period, cells };
    })
    // A period of which no line has a value is not a period of this statement.
    .filter(({ cells }) => [...cells.values()].some((cell) => cell.value !== null));
  return { taxonomy, currency: book.currency, periods: built, lines };
}

/** The original periodic reports, whose facts SEC's XBRL data should hold once filed. */
const REPORT_FORMS: ReadonlySet<string> = new Set(["10-K", "10-Q", "20-F", "40-F", "10-KT", "10-QT"]);

async function readStatement(
  sec: SecSource,
  symbol: string,
  query: Parameters<Statements["statement"]>[1],
  call: Call | undefined,
): Promise<Statement> {
  if (query.after !== undefined && !DATE.test(query.after)) {
    throw invalid(
      `after must be a cursor a previous call returned (a period end, YYYY-MM-DD), not "${query.after}"`,
    );
  }
  const { filer, index, instrument } = await companyOf(sec, symbol, call);
  const name = index.name || filer.name;
  let { facts, storedAt } = await sec.facts(filer.cik, call);
  // The newest periodic report the index lists should be in the facts: reread them when the copy kept is older
  // than it, and say so when SEC's own data does not hold it yet (TSMC's 20-F for 2025 was missing for months).
  const newest = index.recent.find((row) => REPORT_FORMS.has(row.form) && row.xbrl);
  if (
    newest &&
    !facts.financialAccessions.includes(newest.accession) &&
    storedAt < Date.parse(newest.acceptedAt)
  ) {
    ({ facts, storedAt } = await sec.facts(filer.cik, { ...call, fresh: true }));
  }
  const gap =
    newest && !facts.financialAccessions.includes(newest.accession)
      ? `SEC's XBRL financial data does not hold its latest report yet (${newest.form} ${newest.accession}, filed ${newest.filed}${newest.reportDate ? ` for the period ending ${newest.reportDate}` : ""}), so that report's figures are not shown`
      : undefined;
  const built = buildStatement(facts, query.statement, query.periodType);
  if (!built || (!built.lines.length && !built.periods.length)) {
    throw new DataError(
      "no_data",
      `${SEC_SOURCE}'s XBRL financial data for ${name} holds none of the ${query.statement.replaceAll("_", " ")} lines this app reads.`,
      { source: SEC_SOURCE, retry: "never" },
    );
  }
  if (query.periodType === "quarterly" && !new Book(facts, built.taxonomy).quarterly()) {
    throw invalid(
      `${name} files annual reports with the SEC (such as a 20-F), so its XBRL financial data holds no quarterly statements: ask for annual periods`,
    );
  }
  const after = query.after;
  const remaining = built.periods.filter(({ period }) => after === undefined || period.end < after);
  const served = remaining.slice(0, Math.max(1, query.limit));
  const accessions = new Set(
    served.flatMap(({ cells }) => [...cells.values()].flatMap((cell) => cell.facts.map((fact) => fact.accn))),
  );
  const rows = accessions.size
    ? await sec.filings(filer.cik, accessions, call)
    : new Map<string, FilingRow>();
  const periods = served.map(({ period, cells }) => ({
    period_end: period.end,
    lines: built.lines.map((line): StatementLine => {
      const cell = cells.get(line.label) as Cell;
      const states: Record<string, { reason: string; retry: "never" | null }> = { ...cell.states };
      const sources = [...new Map(cell.facts.map((fact) => [fact.accn, fact])).values()].map((fact) => {
        const row = rows.get(fact.accn);
        if (!row) {
          states.accepted_at = {
            reason: `${fact.accn} is not in SEC's filing index, so its filing date is given for when it was accepted`,
            retry: null,
          };
        }
        return {
          accession: fact.accn,
          form: fact.form,
          accepted_at: row?.acceptedAt ?? fact.filed,
          cik: filer.cik,
          predecessor: false,
        };
      });
      return {
        line: line.label,
        value: cell.value,
        unit: bookUnit(built, line),
        period_start: line.period === "duration" ? period.start : null,
        field_states: Object.keys(states).length ? (states as FieldStates) : null,
        sources,
      };
    }),
  }));
  return {
    instrument,
    periods,
    succession: successionOf(filer.cik, gap),
    next_cursor: remaining.length > served.length ? (served.at(-1)?.period.end ?? null) : null,
  };
}

/** A line's unit in a built statement. */
function bookUnit(built: BuiltStatement, line: CatalogLine): string {
  return line.unit === "currency"
    ? built.currency
    : line.unit === "per_share"
      ? `${built.currency}/shares`
      : "shares";
}

// Filings ---------------------------------------------------------------------------------------------

/** Form types EDGAR renamed, so a filter by either name finds both. */
const RENAMED: Readonly<Record<string, string>> = {
  "SC 13G": "SCHEDULE 13G",
  "SC 13G/A": "SCHEDULE 13G/A",
  "SC 13D": "SCHEDULE 13D",
  "SC 13D/A": "SCHEDULE 13D/A",
};

/** The forms a filter asks for, as EDGAR writes them: exact ("/A" only when asked), renamed forms both ways. */
function formsWanted(forms: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (!forms?.length) return undefined;
  const wanted = new Set<string>();
  const renamed = Object.entries(RENAMED);
  for (const form of forms) {
    const written = form.trim().toUpperCase().replace(/\s+/g, " ");
    wanted.add(written);
    for (const [old, now] of renamed) {
      if (written === old) wanted.add(now);
      if (written === now) wanted.add(old);
    }
  }
  return wanted;
}

async function listFilings(
  sec: SecSource,
  symbol: string,
  query: Parameters<Filings["list"]>[1],
  call: Call | undefined,
): Promise<FilingList> {
  if (query.after !== undefined && !ACCESSION.test(query.after)) {
    throw invalid(
      `after must be a cursor a previous call returned (an accession number), not "${query.after}"`,
    );
  }
  const { filer, index, instrument } = await companyOf(sec, symbol, call);
  const wanted = formsWanted(query.forms);
  const limit = Math.max(1, query.limit);
  const listed: FilingRow[] = [];
  let resuming = query.after;
  let more = false;
  const blocks = index.pages.length + 1;
  for (let block = 0; block < blocks && !more; block++) {
    const rows =
      block === 0 ? index.recent : await sec.page(filer.cik, index.pages[block - 1] as FilingPage, call);
    for (const row of rows) {
      if (resuming !== undefined) {
        if (row.accession === resuming) resuming = undefined;
        continue;
      }
      if (wanted && !wanted.has(row.form)) continue;
      if (listed.length === limit) {
        more = true;
        break;
      }
      listed.push(row);
    }
    // A full page at a block's end: older pages may hold more, read when the cursor asks for them.
    if (!more && listed.length === limit && block + 1 < blocks) more = true;
    if (listed.length === limit) break;
  }
  if (resuming !== undefined) {
    throw invalid(
      `after names no filing in ${index.name || filer.name}'s index (${resuming}); list the filings again without it`,
    );
  }
  return {
    instrument,
    succession: successionOf(filer.cik),
    data: listed.map((row) => ({
      form: row.form,
      accession: row.accession,
      cik: filer.cik,
      predecessor: false,
      filed: row.filed,
      accepted_at: row.acceptedAt,
      report_date: row.reportDate,
      url: archiveUrl(filer.cik, row.accession, row.primaryDocument),
      sections: sectionsOfForm(row.form).map((section) => ({ section, state: "available" })),
    })),
    next_cursor: more ? (listed.at(-1)?.accession ?? null) : null,
  };
}

async function readSection(
  deps: ForkDeps,
  sec: SecSource,
  target: { symbol: string; accession: string; section: FilingSectionName },
  query: { after?: string },
  call: Call | undefined,
): Promise<SectionText> {
  if (!ACCESSION.test(target.accession)) {
    throw invalid(`${target.accession} is not an accession number such as 0000320193-26-000026`);
  }
  if (query.after !== undefined) {
    throw invalid("this source serves a section whole, with no further pages: continue by character offset");
  }
  const { filer, index } = await companyOf(sec, target.symbol, call);
  const row = (await sec.filings(filer.cik, [target.accession], call)).get(target.accession);
  if (!row) {
    throw invalid(
      `${target.accession} is not among the filings in ${index.name || filer.name}'s index; list them with filings`,
    );
  }
  const base = {
    form: row.form,
    accession: row.accession,
    accepted_at: row.acceptedAt,
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
  if (!sectionsOfForm(row.form.replace(/\/A$/, "")).includes(target.section)) {
    return none(`section_not_found: a ${row.form} has no ${target.section} section that this source reads`);
  }
  const text = await documentText(deps, filer.cik, row, call);
  if (text === undefined) return none("section_not_found: the filing index names no primary document for it");
  const found = findSection(text, row.form, target.section);
  if (found.state === "not_found") return none(`section_not_found: ${found.reason}`);
  return {
    ...base,
    state: found.state,
    content: found.content,
    chars: found.content.length,
    field_states: null,
    next_cursor: null,
  };
}

// Insider transactions ---------------------------------------------------------------------------------

/**
 * Reports read at once: SEC's published rate is 10 requests a second, so a wave's turns all come within a second
 * of being asked, well inside each request's deadline, and no more is read than the page needs by a wave's width.
 */
const WAVE = 10;

const CURSOR = /^(\d{10}-\d{2}-\d{6})~(\d+)$/;

async function readTransactions(
  deps: ForkDeps,
  sec: SecSource,
  symbol: string,
  query: Parameters<Ownership["transactions"]>[1],
  call: Call | undefined,
): Promise<InsiderTransactions> {
  const codes = query.codes?.length
    ? new Set(query.codes.map((code) => code.trim().toUpperCase()))
    : undefined;
  if (codes && secTicker(symbol) === undefined) {
    throw invalid(
      `transaction codes are those of SEC Form 4, and ${symbol} is not a US listing, whose insiders file no such codes`,
    );
  }
  const { start, end } = query;
  if (start && end && start > end) throw invalid(`start (${start}) is after end (${end})`);
  let resume: { accession: string; skip: number } | undefined;
  if (query.after !== undefined) {
    const cursor = CURSOR.exec(query.after);
    if (!cursor) throw invalid(`after must be a cursor a previous call returned, not "${query.after}"`);
    resume = { accession: cursor[1] as string, skip: Number(cursor[2]) };
  }
  const { filer, index, instrument } = await companyOf(sec, symbol, call);
  const name = index.name || filer.name;
  const today = deps.clock().toISOString().slice(0, 10);
  const through = end && end < today ? end : today;
  const limit = Math.max(1, query.limit);
  // A Form 4's transactions are dated on or after its period (reportDate) and on or before its filing date; a
  // Form 5's within the fiscal year its period ends.
  const earliest = (row: FilingRow) => {
    const period = row.reportDate ?? row.filed;
    return row.form.startsWith("5") ? addDays(period, -400) : period;
  };
  const eligible = (row: FilingRow) =>
    TRANSACTION_FORMS.has(row.form) &&
    (start === undefined || row.filed >= start) &&
    (end === undefined || earliest(row) <= end);
  const inWindow = (date: string | null) =>
    date === null
      ? start === undefined && end === undefined
      : (!start || date >= start) && (!end || date <= end);
  // A foreign private issuer's insiders file Forms 3, 4 and 5 only from some date on (TSMC's from March 2026):
  // its first report in the index is where coverage starts.
  const foreign =
    index.recent.some((row) => row.form === "20-F" || row.form === "40-F") &&
    !index.recent.some((row) => row.form === "10-K" || row.form === "10-Q");

  const data: InsiderTransactions["data"] = [];
  const filings: InsiderTransactions["filings"] = {};
  const order = new Map<string, number>();
  let unreadable = 0;
  /** The earliest report read in XML, the latest one filed before EDGAR took XML, and the first insider report. */
  let earliestRead: string | undefined;
  let latestBeforeXml: string | undefined;
  let firstReport: string | undefined;
  /** Where the page stopped: the cursor, and the latest filing date of the reports it leaves unread. */
  let next: string | null = null;
  let unreadFrom: string | undefined;
  const blocks = index.pages.length + 1;
  scan: for (let block = 0; block < blocks; block++) {
    const listed = index.pages[block - 1];
    // An older page the index dates wholly before the window is not read (its dates are hints: a day of slack).
    if (start !== undefined && listed?.filingTo && addDays(listed.filingTo, 1) < start) break;
    const rows = block === 0 ? index.recent : await sec.page(filer.cik, listed as FilingPage, call);
    for (const row of rows) {
      if (/^[345](\/A)?$/.test(row.form) && (!firstReport || row.filed < firstReport))
        firstReport = row.filed;
    }
    // Pages are newest first: one wholly before the window ends the reading.
    if (start !== undefined && rows.length && rows.every((row) => row.filed < start)) break;
    let candidates = rows.filter(eligible);
    if (resume) {
      const at = candidates.findIndex((row) => row.accession === resume?.accession);
      if (at < 0) continue;
      candidates = candidates.slice(at);
    }
    for (let first = 0; first < candidates.length; first += WAVE) {
      const wave = candidates.slice(first, first + WAVE);
      const reads = await Promise.all(wave.map((row) => readOwnership(deps, filer.cik, row, call)));
      for (const [offset, row] of wave.entries()) {
        const read = reads[offset] as Awaited<ReturnType<typeof readOwnership>>;
        const skip = resume?.accession === row.accession ? resume.skip : 0;
        if (resume?.accession === row.accession) resume = undefined;
        if (!read.document) {
          // A report filed before EDGAR took XML is outside what this source covers; any other is a gap in it.
          if (/^no XML document/.test(read.why)) {
            if (!latestBeforeXml || row.filed > latestBeforeXml) latestBeforeXml = row.filed;
          } else unreadable++;
          continue;
        }
        if (!earliestRead || row.filed < earliestRead) earliestRead = row.filed;
        // A report in which the company is a reporting owner of another issuer is not about its shares.
        if (read.document.issuerCik && read.document.issuerCik !== filer.cik) continue;
        const matching = read.document.transactions.filter(
          (one) => inWindow(one.date) && (!codes || (one.code !== null && codes.has(one.code))),
        );
        const unread = (cut: boolean) => {
          // Every transaction dated after the latest report left unread is in the reports read.
          const left = [...(cut ? [row] : []), ...candidates.slice(first + offset + 1)].map(
            (one) => one.filed,
          );
          if (left.length) return left.sort().at(-1) as string;
          // Reports on older pages were all filed on or before this page's oldest.
          return rows.map((one) => one.filed).sort()[0] ?? row.filed;
        };
        for (const [position, one] of matching.entries()) {
          if (position < skip) continue;
          if (data.length === limit) {
            next = `${row.accession}~${position}`;
            unreadFrom = unread(true);
            break scan;
          }
          data.push({
            accession: row.accession,
            transaction_date: one.date,
            code: one.code,
            shares: one.shares,
            security_title: one.securityTitle,
            derivative: one.derivative,
            conversion_or_exercise_price: one.conversionOrExercisePrice,
            underlying_shares: one.underlyingShares,
            underlying_title: one.underlyingTitle,
            price: one.price,
            acquired_disposed: one.acquiredDisposed,
            owned_following: one.ownedFollowing,
          });
          if (!order.has(row.accession)) order.set(row.accession, order.size);
          filings[row.accession] = {
            form: row.form,
            accepted_at: row.acceptedAt,
            owners: read.document.owners.map((owner) => ({
              name: owner.name,
              // The role as the report states it: an officer's title, or how another insider relates.
              officer_title:
                owner.isOfficer || owner.officerTitle
                  ? owner.officerTitle
                  : owner.isOther
                    ? owner.otherText
                    : null,
              is_director: owner.isDirector,
              is_ten_percent_owner: owner.isTenPercentOwner,
            })),
          };
        }
        if (data.length === limit) {
          // A full page: the reports after it (in this block, or on an older page) are read when asked for.
          if (first + offset + 1 < candidates.length || block + 1 < blocks) {
            next = `${row.accession}~${matching.length}`;
            unreadFrom = unread(false);
          }
          break scan;
        }
      }
    }
  }
  if (resume) throw invalid(`after names no insider report in ${name}'s index; ask again without it`);
  let from: string | null;
  let before = false;
  if (next !== null && unreadFrom !== undefined) from = addDays(unreadFrom, 1);
  else {
    // Every report of the window was read: it is covered from its start, or from where the source's reports
    // begin when the dates asked start earlier (EDGAR's XML reports; a foreign issuer's first report).
    const begins = [
      latestBeforeXml ? addDays(latestBeforeXml, 1) : undefined,
      foreign ? firstReport : undefined,
    ].reduce<string | undefined>(
      (latest, one) => (one && (!latest || one > latest) ? one : latest),
      undefined,
    );
    from = start ?? begins ?? earliestRead ?? null;
    if (begins && from !== null && begins > from) {
      before = start !== undefined;
      from = begins;
    }
  }
  const after = weekdaysAfter(through, 2);
  // Newest first by transaction date within the page; reports in the order they were accepted.
  data.sort(
    (a, b) =>
      (b.transaction_date ?? "").localeCompare(a.transaction_date ?? "") ||
      (order.get(a.accession) ?? 0) - (order.get(b.accession) ?? 0),
  );
  return {
    instrument,
    filings,
    coverage: {
      from,
      through,
      complete: unreadable === 0,
      requested_before_window: before,
      not_yet_served: null,
      complete_after: after > today ? after : null,
    },
    data,
    next_cursor: next,
  };
}
