// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "SEC EDGAR", routes.ts key `frames`: sector screens. Served only when SEC_USER_AGENT is set (SEC's fair-access
 * rule asks every program to name its sender); without it nothing is declared, so screens show as not available
 * and the start-up note says what to set.
 *
 * crossSections.financials: one statement line (catalog/lines.ts: any case, with or without "(Loss)", by name or
 * alias) for every S&P 1500 member of a GICS sector, for the fiscal year ending in a calendar year Y:
 * - The universe is Wikipedia's S&P 500, 400 and 600 lists (sources/wikipedia.ts, CC BY-SA 4.0), each company's
 *   sector read from its sub-industry through GICS's tree; share classes of one CIK are one company; a CIK the
 *   S&P 400 list does not give is found in SEC's ticker list. Every answer is incomplete (complete false), and
 *   says why in a few words that are the same for every year read, since a change screen prints each year's.
 * - Values are SEC's XBRL frames (sources/sec-frames.ts), us-gaap concepts in the catalog's order for each
 *   company, the first it filed giving its value. A duration line is read from frames CY<Y-1> and CY<Y>, rows kept
 *   whose period ends in Y, with its start; a balance-sheet line from the instant frames CY<Y-1>Q4I to CY<Y>Q4I,
 *   the row dated at the company's fiscal year end, which the duration frames of net income (else revenue) give,
 *   since an instant frame holds quarter ends too; its start is null. A line not filed as such may be computed
 *   from the catalog's formula, said in the row's derivation.
 * - Frames give no filing date and only the latest value filed: known_at is when they were read (the engine's
 *   clock), the query's knownAt cannot move it, and form is null; accession is the latest filing that reported
 *   the value. The whole sector is one page (pages 1), whatever maxPages allows.
 * - A company without a value says why (missing_because); a year no filer has a value for yet is no_data; a line
 *   the catalog lacks, or one with no us-gaap concept, is invalid, naming the lines a screen reads.
 */
import type {
  CrossSectionRow,
  CrossSections,
  DataProvider,
  Implementation,
} from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import { SECTOR_NAMES } from "../catalog/gics.js";
import {
  type CatalogLine,
  evaluateFormula,
  findLine,
  formulaConcepts,
  formulaWords,
  LINES,
  type LineFormula,
} from "../catalog/lines.js";
import type { ForkDeps } from "../deps.js";
import { SEC_SOURCE } from "../sources/sec.js";
import {
  annualFrame,
  type Frame,
  type FrameRow,
  type FrameUnit,
  instantFrame,
  instantOf,
  rowOf,
  type SecFrames,
  secFrames,
} from "../sources/sec-frames.js";
import { type SecTickers, secTickers } from "../sources/sec-tickers.js";
import {
  type Duplicate,
  type SpIndex,
  type SpUniverse,
  spUniverse,
  WIKIPEDIA_LICENCE,
} from "../sources/wikipedia.js";

type Call = { signal?: AbortSignal };
type Data<M> = M extends (...args: never[]) => Promise<infer D> ? D : never;
type Section = Data<NonNullable<Implementation<CrossSections>["financials"]>>;
type Query = Parameters<CrossSections["financials"]>[0];

/** What a screen is about, in a few words that read the same for every year asked. */
export const UNIVERSE = `S&P 1500 members only (Wikipedia's S&P lists, ${WIKIPEDIA_LICENCE})`;

/** Why a company has no value. */
export const MISSING = {
  noCik: "no CIK for its ticker in SEC's list",
  noTickerList: "SEC's ticker list could not be read for its CIK",
  notInFrames: "not in SEC's frames",
  noYearEnd: "no fiscal year end in SEC's frames",
  notAtYearEnd: "not in SEC's frames at its fiscal year end",
} as const;

/** One company of a sector's screen: its CIK (when found, else why not), name and tickers. */
type Member = { cik: string | null; name: string; tickers: string[]; noCik?: string };

/** A company's value: a frame's row as filed, or computed from the line's formula. */
type Value = { value: number; start: string | null; end: string; accession: string; derivation: string };

/** What was read for a line: each company's value or why it has none, and the frames read. */
type Read = { values: Map<string, Value>; missing: Map<string, string>; frames: Frame[]; yearFiled: boolean };

type Sources = { universe: ReturnType<typeof spUniverse>; tickers: SecTickers; frames: SecFrames };

const invalid = (message: string) =>
  new DataError("invalid", message, { source: SEC_SOURCE, retry: "change_request" });

export function framesProvider(deps: ForkDeps): DataProvider {
  if (!deps.config.secUserAgent) return { name: SEC_SOURCE, capabilities: {} };
  const sources: Sources = { universe: spUniverse(deps), tickers: secTickers(deps), frames: secFrames(deps) };
  return {
    name: SEC_SOURCE,
    capabilities: {
      crossSections: {
        financials: (query, call) => financials(deps, sources, query, call),
      },
    },
  };
}

/** The lines a screen reads: those with a us-gaap concept or formula (frames are read by us-gaap concept). */
export function screenLines(): CatalogLine[] {
  return LINES.filter((line) => line.usGaap.length > 0 || line.compute?.usGaap);
}

/** The catalog's line a screen asks for, as a person or a model writes it. */
export function screenLine(name: string): CatalogLine {
  const line = findLine(name);
  const lines = screenLines();
  const names = () => lines.map((one) => one.label).join(", ");
  if (!line) throw invalid(`"${name}" is not a statement line a screen reads. Lines: ${names()}.`);
  if (!lines.includes(line)) {
    throw invalid(`${line.label} is not filed under a us-gaap concept SEC's frames hold. Lines: ${names()}.`);
  }
  return line;
}

/** The unit a line's frames are read in, as written in answers, and the group values are compared in. */
function unitsOf(line: CatalogLine): { frame: FrameUnit; unit: string; group: string } {
  if (line.unit === "per_share")
    return { frame: "USD-per-shares", unit: "USD/shares", group: "currency/USD/shares" };
  if (line.unit === "shares") return { frame: "shares", unit: "shares", group: "count//" };
  return { frame: "USD", unit: "USD", group: "currency/USD/" };
}

/** A name of a share class's row ("Alphabet Inc. (Class A)") as the company's. */
function companyName(name: string): string {
  return name.replace(/\s*\((?:Class|Series) [A-Z0-9]+\)\s*$/i, "").trim() || name;
}

/**
 * The sector's companies: each CIK once (share classes together), a CIK the list lacks found by its ticker in
 * SEC's ticker list. When that list cannot be read (www.sec.gov failing while data.sec.gov answers), the
 * companies it was needed for say so, and the others are read.
 */
async function sectorMembers(
  sources: Sources,
  universe: SpUniverse,
  sector: string,
  call: Call,
): Promise<Member[]> {
  const members: Member[] = [];
  const byCik = new Map<string, Member>();
  let unread: DataError | undefined;
  const lookUp = async (ticker: string): Promise<string | null> => {
    if (unread) return null;
    try {
      return (await sources.tickers.bySymbol(ticker, call))?.cik ?? null;
    } catch (error) {
      if (!(error instanceof DataError) || call.signal?.aborted || !LIST_FAILURES.has(error.kind))
        throw error;
      unread = error;
      return null;
    }
  };
  for (const listed of universe.members) {
    if (listed.sector !== sector) continue;
    const cik = listed.cik ?? (await lookUp(listed.ticker));
    const same = cik ? byCik.get(cik) : undefined;
    if (same) {
      if (!same.tickers.includes(listed.ticker)) same.tickers.push(listed.ticker);
      same.name = companyName(same.name);
      continue;
    }
    const member: Member = {
      cik,
      name: listed.name,
      tickers: [listed.ticker],
      ...(cik ? {} : { noCik: unread ? MISSING.noTickerList : MISSING.noCik }),
    };
    if (cik) byCik.set(cik, member);
    members.push(member);
  }
  return members;
}

/** Failures of SEC's ticker list after which the companies it was needed for say so, and the rest are read. */
const LIST_FAILURES: ReadonlySet<string> = new Set(["unavailable", "rate_limited", "quota"]);

/** Of rows found for a company, the latest one whose period ends in `year`. */
function endingIn(year: number, rows: readonly (FrameRow | undefined)[]): FrameRow | undefined {
  const prefix = `${year}-`;
  let found: FrameRow | undefined;
  for (const row of rows) {
    if (row?.end.startsWith(prefix) && (!found || row.end > found.end)) found = row;
  }
  return found;
}

/** Whether any filer's row in `frames` has a period ending in `year`. */
function filedFor(year: number, frames: readonly Frame[]): boolean {
  const prefix = `${year}-`;
  return frames.some((frame) => frame.rows.some((row) => row[2].startsWith(prefix)));
}

/** A value of `line`'s formula from rows found for each concept, all of one period; undefined when incomplete. */
function computed(
  formula: LineFormula,
  rowFor: (concept: string) => FrameRow | undefined,
): Value | undefined {
  const derived = evaluateFormula(formula, rowFor, (row) => row.value);
  const first = (derived?.added[0] ?? derived?.subtracted[0])?.[1];
  if (!derived || !first) return undefined;
  return {
    value: derived.value,
    start: first.start,
    end: first.end,
    accession: first.accession,
    derivation: formulaWords(derived),
  };
}

/** A duration line's values for fiscal years ending in `year`: frames CY<year-1> and CY<year>. */
async function durationValues(
  sources: Sources,
  members: readonly Member[],
  line: CatalogLine,
  year: number,
  call: Call,
): Promise<Read> {
  const { frame: unit } = unitsOf(line);
  const values = new Map<string, Value>();
  const missing = new Map<string, string>();
  const frames: Frame[] = [];
  const read = new Map<string, readonly [Frame, Frame]>();
  const yearsOf = async (concept: string) => {
    let pair = read.get(concept);
    if (!pair) {
      pair = await Promise.all([
        sources.frames.frame(concept, unit, annualFrame(year - 1), call),
        sources.frames.frame(concept, unit, annualFrame(year), call),
      ]);
      read.set(concept, pair);
      frames.push(...pair);
    }
    return pair;
  };
  const lacking = () => members.filter((member) => member.cik && !values.has(member.cik));
  for (const concept of line.usGaap) {
    if (!lacking().length) break;
    const pair = await yearsOf(concept);
    for (const member of lacking()) {
      const cik = member.cik as string;
      const row = endingIn(
        year,
        pair.map((frame) => rowOf(frame, cik)),
      );
      if (row) values.set(cik, { ...row, derivation: "filed" });
    }
  }
  const formula = line.compute?.usGaap;
  if (formula && lacking().length) {
    const pairs = new Map<string, readonly [Frame, Frame]>();
    for (const concept of formulaConcepts(formula)) pairs.set(concept, await yearsOf(concept));
    for (const member of lacking()) {
      const cik = member.cik as string;
      // The components must be of one period: the first one found sets it.
      let period: { start: string | null; end: string } | undefined;
      const value = computed(formula, (concept) => {
        const row = endingIn(
          year,
          (pairs.get(concept) ?? []).map((frame) => rowOf(frame, cik)),
        );
        if (!row) return undefined;
        period ??= { start: row.start, end: row.end };
        return row.start === period.start && row.end === period.end ? row : undefined;
      });
      if (value) values.set(cik, value);
    }
  }
  for (const member of members) {
    if (member.cik && !values.has(member.cik)) missing.set(member.cik, MISSING.notInFrames);
  }
  return { values, missing, frames, yearFiled: filedFor(year, frames) };
}

/** The concepts whose annual frames give each company's fiscal year end: net income, else revenue. */
function yearEndConcepts(): string[] {
  const concepts = [...(findLine("Net Income (Loss)")?.usGaap ?? []), ...(findLine("Revenue")?.usGaap ?? [])];
  return [...new Set(concepts)];
}

/** Each company's fiscal year ending in `year`, from annual frames read until every company has one. */
async function fiscalYearEnds(
  sources: Sources,
  members: readonly Member[],
  year: number,
  call: Call,
): Promise<{ ends: Map<string, string>; frames: Frame[] }> {
  const ends = new Map<string, string>();
  const frames: Frame[] = [];
  for (const concept of yearEndConcepts()) {
    const lacking = members.filter((member) => member.cik && !ends.has(member.cik));
    if (!lacking.length) break;
    const pair = await Promise.all([
      sources.frames.frame(concept, "USD", annualFrame(year - 1), call),
      sources.frames.frame(concept, "USD", annualFrame(year), call),
    ]);
    frames.push(...pair);
    for (const member of lacking) {
      const cik = member.cik as string;
      const row = endingIn(
        year,
        pair.map((frame) => rowOf(frame, cik)),
      );
      if (row) ends.set(cik, row.end);
    }
  }
  return { ends, frames };
}

/** A balance-sheet line's values at each company's fiscal year end in `year`: instant frames around it. */
async function instantValues(
  sources: Sources,
  members: readonly Member[],
  line: CatalogLine,
  year: number,
  call: Call,
): Promise<Read> {
  const { frame: unit } = unitsOf(line);
  const { ends, frames: yearFrames } = await fiscalYearEnds(sources, members, year, call);
  const values = new Map<string, Value>();
  const missing = new Map<string, string>();
  const frames: Frame[] = [...yearFrames];
  const periods = [
    instantFrame(year - 1, 4),
    instantFrame(year, 1),
    instantFrame(year, 2),
    instantFrame(year, 3),
    instantFrame(year, 4),
  ];
  const read = new Map<string, Frame[]>();
  const quartersOf = async (concept: string) => {
    let list = read.get(concept);
    if (!list) {
      list = await Promise.all(periods.map((period) => sources.frames.frame(concept, unit, period, call)));
      read.set(concept, list);
      frames.push(...list);
    }
    return list;
  };
  // The row dated at the fiscal year's end, never a quarter's end the same frame holds.
  const atEnd = (list: readonly Frame[], cik: string, end: string) =>
    list.map((frame) => rowOf(frame, cik)).find((row) => row?.end === end && row.start === null);
  const lacking = () =>
    members.filter((member) => member.cik && ends.has(member.cik) && !values.has(member.cik));
  for (const concept of line.usGaap) {
    if (!lacking().length) break;
    const list = await quartersOf(concept);
    for (const member of lacking()) {
      const cik = member.cik as string;
      const row = atEnd(list, cik, ends.get(cik) as string);
      if (row) values.set(cik, { ...row, derivation: "filed" });
    }
  }
  const formula = line.compute?.usGaap;
  if (formula && lacking().length) {
    const lists = new Map<string, Frame[]>();
    for (const concept of formulaConcepts(formula)) lists.set(concept, await quartersOf(concept));
    for (const member of lacking()) {
      const cik = member.cik as string;
      const end = ends.get(cik) as string;
      const value = computed(formula, (concept) => atEnd(lists.get(concept) ?? [], cik, end));
      if (value) values.set(cik, value);
    }
  }
  for (const member of members) {
    if (!member.cik || values.has(member.cik)) continue;
    missing.set(member.cik, ends.has(member.cik) ? MISSING.notAtYearEnd : MISSING.noYearEnd);
  }
  return { values, missing, frames, yearFiled: filedFor(year, yearFrames) };
}

/** The few words a screen says about its universe: the lists, and tickers two lists name. */
export function universeNote(universe: SpUniverse, members: readonly Member[]): string {
  const tickers = new Set(members.flatMap((member) => member.tickers));
  const twice = universe.duplicates.filter((duplicate) => tickers.has(duplicate.ticker));
  const byKept = new Map<SpIndex, Duplicate[]>();
  for (const duplicate of twice)
    byKept.set(duplicate.kept, [...(byKept.get(duplicate.kept) ?? []), duplicate]);
  const said = [...byKept].map(([kept, list]) => {
    const names = list.map((duplicate) => duplicate.ticker);
    const listed = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
    const dated = list.every((duplicate) => /most recently/.test(duplicate.reason));
    return `${listed} on two lists, counted as ${kept}${dated ? " (added there most recently)" : ""}`;
  });
  const stale = universe.stale ? [`lists as read ${universe.read_at.slice(0, 10)}`] : [];
  return [UNIVERSE, ...said, ...stale].join("; ");
}

async function financials(deps: ForkDeps, sources: Sources, query: Query, call: Call = {}): Promise<Section> {
  const sector = SECTOR_NAMES[query.sector];
  if (!sector) throw invalid(`"${query.sector}" is not a GICS sector a screen reads.`);
  const line = screenLine(query.line);
  const year = query.fiscalYear;
  if (!Number.isInteger(year)) throw invalid(`The fiscal year must be a calendar year, not ${year}.`);
  const universe = await sources.universe.read(call);
  const members = await sectorMembers(sources, universe, sector, call);
  const incomplete_because = universeNote(universe, members);
  const withCik = members.filter((member) => member.cik);
  if (!withCik.length) {
    return {
      rows: members.map((member) => row(line, member, undefined, member.noCik ?? MISSING.noCik)),
      pages: 1,
      complete: false,
      incomplete_because,
      known_at: instantOf(deps.clock()),
    };
  }
  const read =
    line.period === "duration"
      ? await durationValues(sources, withCik, line, year, call)
      : await instantValues(sources, withCik, line, year, call);
  if (!read.yearFiled) {
    throw new DataError(
      "no_data",
      `${SEC_SOURCE}'s XBRL frames hold no ${line.label} of any filer for a fiscal year ending in ${year}.`,
      { source: SEC_SOURCE, retry: "later" },
    );
  }
  // Every value was known by the latest reading of the frames it comes from.
  const latest = read.frames.reduce<string | undefined>(
    (found, frame) =>
      found === undefined || Date.parse(frame.read_at) > Date.parse(found) ? frame.read_at : found,
    undefined,
  );
  const known_at = latest ?? instantOf(deps.clock());
  return {
    rows: members.map((member) =>
      member.cik
        ? row(line, member, read.values.get(member.cik), read.missing.get(member.cik) ?? MISSING.notInFrames)
        : row(line, member, undefined, member.noCik ?? MISSING.noCik),
    ),
    pages: 1,
    complete: false,
    incomplete_because,
    known_at,
  };
}

/** A company's row: its value, or why it has none. */
function row(line: CatalogLine, member: Member, value: Value | undefined, missing: string): CrossSectionRow {
  const units = unitsOf(line);
  return {
    ciks: member.cik ? [member.cik] : [],
    name: member.name,
    symbols: [...member.tickers],
    value: value ? value.value : null,
    unit: value ? units.unit : null,
    unit_group: value ? units.group : null,
    period_start: value && line.period === "duration" ? value.start : null,
    period_end: value ? value.end : null,
    derivation: value ? value.derivation : null,
    missing_because: value ? null : missing,
    form: null,
    accession: value ? value.accession : null,
  };
}
