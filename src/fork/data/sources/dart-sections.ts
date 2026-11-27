// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * A Korean periodic report's sections (사업보고서 annual, 반기보고서 half-year and 분기보고서 quarterly
 * reports), from the main document of the filing's archive on OpenDART (document.xml, read by sources/dart.ts):
 * the document's DART XML (dart4.xsd) as the text a reader sees, and the part of it under one chapter's title.
 *
 * A report is laid out in chapters, each a SECTION-1 element whose first child is its TITLE ("II. 사업의 내용"),
 * with sections inside it (SECTION-2, SECTION-3), each starting with its own TITLE. A section is found by its
 * title's words, whatever its number ("이사의 경영진단 및 분석의견" is chapter IV in today's reports and was
 * chapter V before), spacing aside, the outermost one that matches first:
 *
 * - business: the chapter "사업의 내용" (the business: products, sales, orders, contracts, research);
 * - market_risk: "위험관리 및 파생거래" (risk management and derivatives), a section of that chapter;
 * - financial_statements: the chapter "재무에 관한 사항" (the statements, their notes, dividends, funding);
 * - mdna: the chapter "이사의 경영진단 및 분석의견" (the directors' discussion and analysis), which annual
 *   reports give; half-year and quarterly reports leave it out under the disclosure rules (기업공시서식
 *   작성기준) and say so in its place, which is the reason given for its absence (interimMdna).
 *
 * A periodic report has no risk-factors chapter (investment risks are stated in registration statements), so
 * risk_factors is not read. A section is its whole text, its title first: paragraphs and titles a blank line
 * apart, a table row a line of tab-separated cells (util/html.ts reads HTML's cells and DART's own, TE and TU),
 * and DART's `&cr;` a line break. A short section with no sections inside it that only points to another part
 * of the report ("...을 참조하시기 바랍니다", please see ...) is `by_reference`, its content that pointer.
 * Parsed documents are kept a month (on disk too): a receipt number's documents never change (a correction is a
 * filing of its own).
 */
import type { Call, FilingSectionName } from "../../../data/capabilities.js";
import type { ForkDeps } from "../deps.js";
import { decodeEntities, HTML_ENTITIES } from "../util/entities.js";
import { htmlToText } from "../util/html.js";
import type { DartSource } from "./dart.js";

/** The sections a Korean periodic report is read by. */
export const DART_SECTIONS = ["business", "mdna", "market_risk", "financial_statements"] as const;
export type DartSectionName = (typeof DART_SECTIONS)[number];

/** Each section's title as DART reports write it, and the words it is found by (its spacing left out). */
export const DART_SECTION_TITLES: Readonly<Record<DartSectionName, { title: string; words: RegExp }>> = {
  business: { title: "사업의 내용", words: /사업의내용/ },
  mdna: { title: "이사의 경영진단 및 분석의견", words: /이사의경영진단및분석의견/ },
  market_risk: { title: "위험관리 및 파생거래", words: /위험관리및파생거래/ },
  financial_statements: { title: "재무에 관한 사항", words: /재무에관한사항/ },
};

/** OpenDART's periodic reports (pblntf_detail_ty): annual, half-year and quarterly. */
export const DART_PERIODIC: ReadonlySet<string> = new Set(["A001", "A002", "A003"]);

/**
 * The sections filings lists for a report of `code`: an annual report's four; a half-year or quarterly report's
 * without mdna, which those reports leave out (filing_section answers it not found, with what one says in its
 * place: interimMdna). Other reports are not split into sections.
 */
export function sectionsOfDartReport(code: string | null | undefined): FilingSectionName[] {
  if (code === "A001") return ["business", "mdna", "market_risk", "financial_statements"];
  if (code === "A002" || code === "A003") return ["business", "market_risk", "financial_statements"];
  return [];
}

/** Whether a section is one a Korean periodic report is read by. */
export function isDartSection(section: string): section is DartSectionName {
  return (DART_SECTIONS as readonly string[]).includes(section);
}

/** A section as found: its text (its title first), or why there is none. */
export type DartSectionFound =
  | { state: "available" | "by_reference"; content: string }
  | { state: "not_found"; reason: string };

/** A report's main document read into its sections. */
export type DartDocumentSections = {
  /** The main document's name in the archive; null when the archive holds none. */
  document: string | null;
  sections: Record<DartSectionName, DartSectionFound>;
};

/** A part of a DART document: a SECTION-n element, its level n, its title's text, and where it is in the text. */
export type DartPart = { level: number; title: string; start: number; end: number };

/** The tags parts are read by: SECTION-n start and end tags, and TITLE's. */
const TAGS = /<(\/?)(?:SECTION-(\d{1,2})|TITLE)(?=[\s/>])[^>]*>/gi;

/** DART's line break inside a paragraph or a cell. */
const LINE_BREAK = /&cr;/gi;

/** A title's text: its tags left out, references decoded, its blanks one space. */
function titleText(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, " ").replace(LINE_BREAK, " "), HTML_ENTITIES)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every SECTION-n element of a DART document, in the document's order, each with its TITLE (the first one
 * inside it, before any section inside it starts). Tolerant as the readers in util/ are: a section whose end
 * tag is left out ends where a section of its level or an outer one starts, or where an outer one ends, else
 * at the document's end; a stray end tag is passed over. One pass over the tags, in time proportional to the
 * text.
 */
export function dartParts(xml: string): DartPart[] {
  const parts: DartPart[] = [];
  const open: DartPart[] = [];
  // The part that may still take a title (the one opened last, before anything else opened or closed), and
  // the title being read: its part and where its text starts.
  let waiting: DartPart | undefined;
  let titling: { part: DartPart; from: number } | undefined;
  for (const match of xml.matchAll(TAGS)) {
    const at = match.index;
    const closing = match[1] === "/";
    if (match[2] === undefined) {
      if (!closing) {
        if (waiting && !titling) titling = { part: waiting, from: at + match[0].length };
      } else if (titling) {
        titling.part.title = titleText(xml.slice(titling.from, at));
        titling = undefined;
        waiting = undefined;
      }
      continue;
    }
    const level = Number(match[2]);
    titling = undefined;
    if (!closing) {
      // Parts left open at this level or deeper end where this one starts.
      while (open.length && (open.at(-1) as DartPart).level >= level) (open.pop() as DartPart).end = at;
      const part: DartPart = { level, title: "", start: at, end: xml.length };
      parts.push(part);
      open.push(part);
      waiting = part;
      continue;
    }
    const index = open.findLastIndex((part) => part.level === level);
    if (index < 0) continue;
    // Parts inside it left open end where it does.
    for (const inner of open.splice(index + 1)) inner.end = at;
    (open.pop() as DartPart).end = at + match[0].length;
    waiting = undefined;
  }
  return parts;
}

/** DART XML (a document or a part of one) as the text a reader sees: util/html.ts's reading, `&cr;` a break. */
export function dartXmlText(xml: string): string {
  return htmlToText(xml.replace(LINE_BREAK, "<br>"));
}

/**
 * A short section's pointer to another part of the report, as DART reports write one: "...을 참조하시기
 * 바랍니다" (please see ...), "...을 참고하시기 바랍니다", "...을 참조하여 주시기 바랍니다".
 */
const POINTER = /(?:참조|참고)(?:하여\s*주시기|하시기)?\s*바랍니다/;
/** The most text a section that only points elsewhere holds, its title aside (Korean runs shorter than English). */
const POINTER_CHARS = 500;

/**
 * The section `section` of DART XML document `xml` (its parts, `parts`, when read already); `where` names the
 * document in a reason.
 */
export function findDartSection(
  xml: string,
  section: DartSectionName,
  parts: readonly DartPart[] = dartParts(xml),
  where = "the filing's main document",
): DartSectionFound {
  const { title, words } = DART_SECTION_TITLES[section];
  let chosen: DartPart | undefined;
  for (const part of parts) {
    if (!words.test(part.title.replace(/\s+/g, ""))) continue;
    if (!chosen || part.level < chosen.level) chosen = part;
  }
  if (!chosen) return { state: "not_found", reason: `no "${title}" chapter or section found in ${where}` };
  const { start, end } = chosen;
  const content = dartXmlText(xml.slice(start, end));
  // Only a section with no sections inside it is read as a pointer: a chapter's sections are its text.
  const leaf = !parts.some((part) => part.start > start && part.start < end);
  const lineEnd = content.indexOf("\n");
  const pointer = lineEnd < 0 ? content : content.slice(lineEnd + 1).trim();
  if (leaf && pointer.length <= POINTER_CHARS && POINTER.test(pointer))
    return { state: "by_reference", content };
  return { state: "available", content };
}

/**
 * mdna as a half-year or quarterly report gives it: those reports leave the directors' discussion out under the
 * disclosure rules (기업공시서식 작성기준) and say so in the chapter's place, so a chapter holding no more than
 * such a statement (POINTER_CHARS, its title aside) is not_found, with what it says as the reason. A chapter
 * holding more is the report's own text, read as it is.
 */
export function interimMdna(found: DartSectionFound): DartSectionFound {
  if (found.state === "not_found") return found;
  const lineEnd = found.content.indexOf("\n");
  const said = (lineEnd < 0 ? "" : found.content.slice(lineEnd + 1))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  if (said.length > POINTER_CHARS) return found;
  return {
    state: "not_found",
    reason: `half-year and quarterly reports leave out "${DART_SECTION_TITLES.mdna.title}" (the directors' discussion and analysis), which annual reports give${said ? `; in its place this one says: ${said}` : ""}`,
  };
}

/** Every section a periodic report is read by, from its main document `xml` named `name`. */
export function dartDocumentSectionsOf(xml: string, name: string): DartDocumentSections {
  const parts = dartParts(xml);
  const where = `the filing's main document (${name})`;
  return {
    document: name,
    sections: Object.fromEntries(
      DART_SECTIONS.map((section) => [section, findDartSection(xml, section, parts, where)]),
    ) as Record<DartSectionName, DartSectionFound>,
  };
}

/** How long a report's parsed sections are kept: its documents never change. */
export const DART_SECTIONS_TTL_MS = 30 * 86_400_000;

/**
 * The sections of the periodic report with receipt number `rceptNo`, from its archive's main document
 * (DartSource.archive: <rcept_no>.xml), kept a month, on disk too.
 */
export async function dartDocumentSections(
  deps: ForkDeps,
  dart: DartSource,
  rceptNo: string,
  call?: Call,
): Promise<DartDocumentSections> {
  return deps.cache.remember(
    `dart:sections:v1:${rceptNo}`,
    DART_SECTIONS_TTL_MS,
    async () => {
      const main = (await dart.archive(rceptNo, call)).main();
      if (main) return dartDocumentSectionsOf(main.text, main.name);
      const none: DartSectionFound = {
        state: "not_found",
        reason: "the filing's archive holds no XML document",
      };
      return {
        document: null,
        sections: Object.fromEntries(DART_SECTIONS.map((section) => [section, none])) as Record<
          DartSectionName,
          DartSectionFound
        >,
      };
    },
    { disk: "json", signal: call?.signal },
  );
}
