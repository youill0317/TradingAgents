// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * A filing's sections, from its primary document in EDGAR's archives: the document as the text a reader sees
 * (util/html.ts) and the part of it under one Item heading, the table of contents skipped.
 *
 * Which Item holds which section (SEC's forms):
 * - 10-K: business Item 1, risk_factors Item 1A, mdna Item 7, market_risk Item 7A, financial_statements Item 8;
 * - 10-Q: financial_statements Part I Item 1, mdna Part I Item 2, market_risk Part I Item 3, risk_factors Part II
 *   Item 1A (a 10-Q numbers its Items again in Part II);
 * - 20-F: business Item 4, risk_factors Item 3.D (the "Risk Factors" part of Item 3), mdna Item 5, market_risk
 *   Item 11, financial_statements Item 18 (or 17).
 *
 * How the Item is found: every line that starts like an Item heading ("Item 1A. Risk Factors", "ITEM 7 -
 * MANAGEMENT'S...", a table-of-contents row "Item 1A.<tab>Risk Factors<tab>5") is a candidate, and a line
 * that only mentions an Item ("Item 7 of this report...", "Item 1A, Risk Factors") is not; parts are tracked by
 * their "PART II" lines. The table of contents lists every Item a line apart, so of the candidates for an Item
 * the one followed by the most text before the next heading is its section; the section runs to that next
 * heading. A section whose few lines say its text is elsewhere ("incorporated herein by reference", "is
 * included in Item 7") is `by_reference`, its content that pointer. A document that names no such Item (some
 * banks file a cross-reference index instead of Item headings) has no such section.
 */

import { ANSWER_BYTES } from "../../../contracts/limits.js";
import type { FilingSectionName } from "../../../data/capabilities.js";
import type { ForkDeps } from "../deps.js";
import { FORK_REQUEST_MS } from "../http.js";
import { htmlToText } from "../util/html.js";
import { archiveUrl, type FilingRow, SEC_SOURCE } from "./sec.js";

/**
 * The most of a primary document read. No primary document has been measured yet (www.sec.gov needs a contact
 * User-Agent): an annual report's inline XBRL can run to tens of MB for the largest banks, so the bound is
 * four times upstream's ANSWER_BYTES (64 MiB), to be checked against the largest real ones.
 */
export const SEC_DOCUMENT_BYTES = 4 * ANSWER_BYTES;

/** How long a document's text is kept: a filed document never changes (an amendment is a filing of its own). */
export const DOCUMENT_TTL_MS = 30 * 86_400_000;

/** Where a section is: its Item, the Part when a form numbers Items again (10-Q), a subsection (20-F 3.D). */
type ItemRef = { items: readonly string[]; part?: string; sub?: RegExp };

const TEN_K: Readonly<Partial<Record<FilingSectionName, ItemRef>>> = {
  business: { items: ["1"] },
  risk_factors: { items: ["1A"] },
  mdna: { items: ["7"] },
  market_risk: { items: ["7A"] },
  financial_statements: { items: ["8"] },
};
const TEN_Q: Readonly<Partial<Record<FilingSectionName, ItemRef>>> = {
  financial_statements: { items: ["1"], part: "I" },
  mdna: { items: ["2"], part: "I" },
  market_risk: { items: ["3"], part: "I" },
  risk_factors: { items: ["1A"], part: "II" },
};
const TWENTY_F: Readonly<Partial<Record<FilingSectionName, ItemRef>>> = {
  business: { items: ["4"] },
  risk_factors: { items: ["3"], sub: /^\s*(?:item\s+)?(?:3\s*\.?\s*)?D\s*[.:\-—–]?\s*Risk\s+Factors\b/i },
  mdna: { items: ["5"] },
  market_risk: { items: ["11"] },
  financial_statements: { items: ["18", "17"] },
};

/** The Item layout of a form (its amendments are laid out as it is), when it has one this reads. */
function layoutOf(form: string): Readonly<Partial<Record<FilingSectionName, ItemRef>>> | undefined {
  const base = form.replace(/\/A$/, "");
  if (base === "10-K" || base === "10-KT" || base === "10-K405") return TEN_K;
  if (base === "10-Q" || base === "10-QT") return TEN_Q;
  if (base === "20-F") return TWENTY_F;
  return undefined;
}

/**
 * The sections a filing of `form` is read by, as filings lists them: an annual or quarterly report's (its
 * amendments are left out: most amend a few Items, and which is not known until read).
 */
export function sectionsOfForm(form: string): FilingSectionName[] {
  if (form.endsWith("/A")) return [];
  const layout = layoutOf(form);
  return layout ? (Object.keys(layout) as FilingSectionName[]) : [];
}

/** A section as found: its text (the heading first), or why there is none. */
export type SectionFound =
  | { state: "available" | "by_reference"; content: string }
  | { state: "not_found"; reason: string };

/** A heading line: an Item's (with its key, "1A") or a Part's, and where it starts in the text. */
type Heading = { at: number; item?: string; part?: string };

/** A Part's heading line: "PART II", "Part I - Financial Information". */
const PART_LINE = /^\s*[Pp][Aa][Rr][Tt]\s+([Ii][Vv]|[Ii]{1,3})(?![A-Za-z])/;
/**
 * The start of an Item heading: "Item 1A", "ITEM 7", "Items 1", maybe after its Part on the same line. The
 * letter is taken only when no other letter follows it ("Item 1 Business" is Item 1).
 */
const ITEM_START =
  /^\s*(?:[Pp][Aa][Rr][Tt]\s+([Ii][Vv]|[Ii]{1,3})\s*[,.:\-—–]?\s*)?[Ii][Tt][Ee][Mm][Ss]?\s+(\d{1,2})(?:\s*([A-Da-d])(?![A-Za-z]))?/;
/**
 * What follows an Item's number in a heading: punctuation, a dash or a tab (never a subsection's letter, as in
 * "Item 3.D Risk Factors")...
 */
const STRONG_END = /^(?:\s*[.:](?![A-Za-z](?:[.\s]|$))|\s*[—–-]|\t)/;
/** ...or the line's end, or a title starting with a capital; never a sentence going on ("Item 7 of", "Item 1A,"). */
const WEAK_END = /^(?:\s*$|\s+["“'‘(A-Z])/;
/**
 * The longest line taken as a heading whatever follows its number: a table-of-contents row with its title and
 * page. A longer line (a heading run into its first paragraph) is one only when punctuation follows the number.
 */
const HEADING_CHARS = 250;

function headingsOf(text: string): Heading[] {
  const headings: Heading[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const item = ITEM_START.exec(line);
    const rest = item ? line.slice(item[0].length) : "";
    if (item && (STRONG_END.test(rest) || (line.length <= HEADING_CHARS && WEAK_END.test(rest)))) {
      headings.push({
        at,
        item: `${item[2]}${(item[3] ?? "").toUpperCase()}`,
        ...(item[1] ? { part: item[1].toUpperCase() } : {}),
      });
    } else if (line.length <= HEADING_CHARS) {
      const part = PART_LINE.exec(line);
      if (part) headings.push({ at, part: (part[1] as string).toUpperCase() });
    }
    at += line.length + 1;
  }
  return headings;
}

/** Whether a short section only points elsewhere for its text. */
const POINTER =
  /incorporated\s+(?:herein\s+)?by\s+reference|\b(?:is|are)\s+(?:included|set\s+forth|contained|presented|provided|found)\s+(?:in|under|on|at|within)\b|\bset\s+forth\s+(?:in|under)\b|\brefer\s+to\b|\bsee\s+(?:the\s+)?(?:information|discussion|section)\b/i;
/** The most text a section that only points elsewhere holds, its heading aside. */
const POINTER_CHARS = 1_500;

/** The section of `form`'s document `text` that `section` names. */
export function findSection(text: string, form: string, section: FilingSectionName): SectionFound {
  const layout = layoutOf(form);
  const ref = layout?.[section];
  if (!layout) return { state: "not_found", reason: `a ${form} is not split into sections here` };
  if (!ref) return { state: "not_found", reason: `a ${form} has no ${section} section` };
  const headings = headingsOf(text);
  // Each Item heading with the Part it is in: its own, or the last Part line before it.
  let part: string | undefined;
  const items: (Heading & { part?: string; end: number })[] = [];
  for (const [index, heading] of headings.entries()) {
    if (heading.part) part = heading.part;
    if (!heading.item) continue;
    const next = headings[index + 1];
    items.push({ ...heading, ...(part ? { part } : {}), end: next ? next.at : text.length });
  }
  const parted = items.some((heading) => heading.part);
  for (const item of ref.items) {
    let candidates = items.filter((heading) => heading.item === item);
    // Parts are told apart only when the document marks them.
    if (ref.part && parted) {
      const inPart = candidates.filter((heading) => heading.part === ref.part);
      if (inPart.length) candidates = inPart;
    }
    if (!candidates.length) continue;
    const chosen = candidates.reduce((best, heading) =>
      heading.end - heading.at > best.end - best.at ? heading : best,
    );
    let content = text.slice(chosen.at, chosen.end).trim();
    if (ref.sub) {
      const lines = content.split("\n");
      const start = lines.findIndex(
        (line, index) => index > 0 && line.length <= HEADING_CHARS && ref.sub?.test(line),
      );
      if (start < 0) {
        return {
          state: "not_found",
          reason: `no "Risk Factors" part found under Item ${item} of the ${form}`,
        };
      }
      content = lines.slice(start).join("\n").trim();
    }
    const body = content.slice(content.indexOf("\n") + 1).trim();
    const pointer = content.includes("\n") ? body : content;
    if (pointer.length <= POINTER_CHARS && POINTER.test(pointer)) return { state: "by_reference", content };
    return { state: "available", content };
  }
  return {
    state: "not_found",
    reason: `no Item ${ref.items.join(" or Item ")}${ref.part ? ` in Part ${ref.part}` : ""} heading found in the ${form}'s primary document`,
  };
}

/** Whether a document is HTML (most primary documents) rather than plain text (some older filings). */
function isHtml(name: string, body: string): boolean {
  return /\.(?:x?html?)$/i.test(name) || /<(?:html|body|div|p|table)\b/i.test(body.slice(0, 4_096));
}

/**
 * The text of filing `row`'s primary document, as a reader sees it, kept a month (on disk too); undefined when
 * the index names no primary document.
 */
export async function documentText(
  deps: ForkDeps,
  cik: string,
  row: FilingRow,
  call?: { signal?: AbortSignal },
): Promise<string | undefined> {
  const name = row.primaryDocument;
  if (!name) return undefined;
  return deps.cache.remember(
    `sec:document:${row.accession}`,
    DOCUMENT_TTL_MS,
    async () => {
      const body = await deps.http.text(archiveUrl(cik, row.accession, name), {
        source: SEC_SOURCE,
        signal: call?.signal,
        timeoutMs: FORK_REQUEST_MS.bulk,
        maxBytes: SEC_DOCUMENT_BYTES,
        notFound: "no_data",
        notFoundMessage: `${SEC_SOURCE} has no document ${name} in filing ${row.accession}.`,
      });
      return isHtml(name, body) ? htmlToText(body) : body.replace(/\r\n?/g, "\n");
    },
    { disk: "text", signal: call?.signal },
  );
}
