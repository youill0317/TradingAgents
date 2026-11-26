// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Wikipedia's lists of the S&P 500, S&P 400 and S&P 600 companies (together the S&P Composite 1500), read
 * through the MediaWiki parse API as wikitext: each member's ticker, name, GICS sector and sub-industry, its CIK
 * where the page gives one, and the date its index added it where the page says. The sector screen
 * (providers/frames.ts) draws its universe from them. The lists are volunteer-kept and licensed CC BY-SA 4.0
 * ("Creative Commons Attribution-Share Alike 4.0", the site's rights information); answers that use them say so.
 *
 * How the pages are read (measured on the pages' wikitext of 2026-11-25, kept in the macro area's facts):
 * - Each list is the table whose id is "constituents"; the S&P 400 and 600 pages also hold a "changes" table
 *   (date, ticker and security added, ticker and security removed, reason), whose rows may span several dates
 *   (`rowspan`), read here for when a page added a ticker.
 * - Cells open a line with "|", "||" or "| " and may follow each other on one line after "||"; cell attributes
 *   stand before a lone pipe (`| style="..." | {{NyseSymbol|AA}}`); splits are made only outside templates and
 *   links. Comments and references are removed first (a reference holds templates with pipes of their own).
 * - Tickers are written {{NyseSymbol|MMM}}, {{NasdaqSymbol|ADBE}}, {{BZX link|CBOE}}, with a leading space
 *   ({{NyseSymbol| EFOR}}), after an {{Anchor|A}}, or as a link whose address is a Lua call
 *   ([{{#invoke:Stock tickers/NYSE|GetURL|PRK|exchange=AMEX}} PRK]); share classes take a dot (BRK.B), read as
 *   SEC and Yahoo write them (BRK-B).
 * - The S&P 500 and 600 pages give a 10-digit CIK column; the S&P 400 page links each company's SEC filings,
 *   with a numeric CIK in some links and the ticker in the others (the screen finds those in SEC's ticker list).
 * - A sector that contradicts the list's own sub-industry (Mortgage REITs under Real Estate, Application
 *   Software under Financials on the S&P 600 page) is read from the sub-industry through GICS's tree
 *   (catalog/gics.ts).
 * - A ticker on two lists (the S&P 400 page adds companies the S&P 600 page has not yet removed) is kept once,
 *   from the list that added it most recently (by the S&P 500's "Date added" column and the other pages' changes
 *   tables); the combined universe says which tickers were.
 *
 * Wikipedia limits how fast it is asked (429 with a Retry-After of 8 to 45 seconds was seen): the pages are read
 * one after another, as MediaWiki's API etiquette asks, through the fork's HTTP client, which honours
 * Retry-After; each list is kept a week, on disk too, and served past its week when Wikipedia cannot be read.
 */
import { DataError } from "../../../data/errors.js";
import { gicsOf, gicsSector } from "../catalog/gics.js";
import type { ForkDeps } from "../deps.js";
import { decodeEntities, HTML_ENTITIES } from "../util/entities.js";

/** The source as answers and errors name it. */
export const WIKIPEDIA_SOURCE = "Wikipedia";

export const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";

/** The licence of what Wikipedia's lists hold, as answers that use them state it. */
export const WIKIPEDIA_LICENCE = "CC BY-SA 4.0";

/** How long a list is kept: the pages change a few times a month, as S&P changes its indices. */
export const LIST_TTL_MS = 7 * 86_400_000;

export type SpIndex = "S&P 500" | "S&P 400" | "S&P 600";

/** One of the three lists: its index, its page's title, and its key in the cache. */
export type SpList = { index: SpIndex; page: string; key: string };

/** The lists, in the order they are read (and, between lists that added a ticker on one day, preferred). */
export const SP_LISTS: readonly SpList[] = [
  { index: "S&P 500", page: "List of S&P 500 companies", key: "sp500" },
  { index: "S&P 400", page: "List of S&P 400 companies", key: "sp400" },
  { index: "S&P 600", page: "List of S&P 600 companies", key: "sp600" },
];

/** The parse API's address for a page's wikitext. */
export function wikitextUrl(page: string): string {
  const title = encodeURIComponent(page.replaceAll(" ", "_"));
  return `${WIKIPEDIA_API}?action=parse&page=${title}&prop=wikitext&format=json&formatversion=2`;
}

// Wikitext ------------------------------------------------------------------------------------------

/** Comments and references removed: a reference holds templates and links whose pipes are not cells'. */
export function withoutNoise(wikitext: string): string {
  let text = "";
  let at = 0;
  // Comments first: one may sit inside a reference. An unclosed comment hides the rest, as MediaWiki reads it.
  for (;;) {
    const open = wikitext.indexOf("<!--", at);
    if (open < 0) {
      text += wikitext.slice(at);
      break;
    }
    text += wikitext.slice(at, open);
    const close = wikitext.indexOf("-->", open + 4);
    if (close < 0) break;
    at = close + 3;
  }
  let out = "";
  at = 0;
  const lower = text.toLowerCase();
  // Once no "</ref" follows a point, none follows any later one: it is looked for again only past the last found.
  let nextClose = -2;
  const closeFrom = (from: number) => {
    if (nextClose === -1 || nextClose >= from) return nextClose;
    nextClose = lower.indexOf("</ref", from);
    return nextClose;
  };
  for (;;) {
    const open = lower.indexOf("<ref", at);
    if (open < 0) {
      out += text.slice(at);
      break;
    }
    const after = lower[open + 4];
    // "<references/>" and other tags that start alike are kept.
    if (after !== ">" && after !== " " && after !== "/" && after !== "\t" && after !== "\n") {
      out += text.slice(at, open + 4);
      at = open + 4;
      continue;
    }
    out += text.slice(at, open);
    const end = lower.indexOf(">", open);
    if (end < 0) break;
    if (lower[end - 1] === "/") {
      at = end + 1;
      continue;
    }
    const close = closeFrom(end);
    if (close < 0) {
      at = end + 1;
      continue;
    }
    const shut = lower.indexOf(">", close);
    at = shut < 0 ? text.length : shut + 1;
  }
  return out;
}

/** `text` split on any of `separators` where it stands outside templates ({{ }}) and links ([[ ]]). */
export function splitOutside(text: string, separators: readonly string[]): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  let index = 0;
  while (index < text.length) {
    const two = text.slice(index, index + 2);
    if (two === "{{" || two === "[[") {
      depth++;
      index += 2;
      continue;
    }
    if (two === "}}" || two === "]]") {
      depth = Math.max(0, depth - 1);
      index += 2;
      continue;
    }
    if (depth === 0) {
      const separator = separators.find((one) => text.startsWith(one, index));
      if (separator) {
        parts.push(text.slice(from, index));
        index += separator.length;
        from = index;
        continue;
      }
    }
    index++;
  }
  parts.push(text.slice(from));
  return parts;
}

/** One cell as written: a header cell or not, its content, and how many rows and columns it spans. */
export type WikiCell = { header: boolean; text: string; rowspan: number; colspan: number };

/** A table: its opening line's attributes and its rows of cells, as written (spans not yet laid out). */
export type WikiTable = { attributes: string; rows: WikiCell[][] };

/** The most columns one cell may span: a page's real tables span a few; a larger number is not a table's. */
const MAX_COLSPAN = 64;

/**
 * The most columns a table is laid out to: the lists have six to eight. A cell spanning rows pushes the later
 * rows' cells rightwards, so a page could otherwise widen a table by every row it has.
 */
const MAX_COLUMNS = 256;

function spanOf(attributes: string, name: "rowspan" | "colspan"): number {
  const found = new RegExp(`${name}\\s*=\\s*["']?\\s*(\\d+)`, "i").exec(attributes);
  const value = found ? Number(found[1]) : 1;
  return Number.isFinite(value) && value >= 1 ? value : 1;
}

/** A cell's content and attributes, from what a line gives it (`attributes | content`, or content alone). */
function cellOf(raw: string, header: boolean): WikiCell {
  const parts = splitOutside(raw, ["|"]);
  let attributes = "";
  let text = raw;
  if (parts.length >= 2) {
    const before = parts[0] as string;
    // Attributes are name=value pairs; text before a pipe that holds a template or a link is content.
    if (/=/.test(before) && !before.includes("{{") && !before.includes("[[")) {
      attributes = before;
      text = parts.slice(1).join("|");
    } else if (before.trim() === "") {
      text = parts.slice(1).join("|");
    }
  }
  return {
    header,
    text: text.trim(),
    rowspan: spanOf(attributes, "rowspan"),
    colspan: Math.min(spanOf(attributes, "colspan"), MAX_COLSPAN),
  };
}

/** The tables of a page's wikitext (comments and references removed), outermost ones, in order. */
export function wikiTables(wikitext: string): WikiTable[] {
  const tables: WikiTable[] = [];
  let current: WikiTable | undefined;
  let row: WikiCell[] | undefined;
  let depth = 0;
  const endRow = () => {
    if (current && row?.length) current.rows.push(row);
    row = undefined;
  };
  const append = (line: string) => {
    const last = row?.at(-1);
    if (last) last.text = `${last.text}\n${line}`.trim();
  };
  for (const raw of withoutNoise(wikitext).split("\n")) {
    const line = raw.trimStart();
    if (line.startsWith("{|")) {
      depth++;
      if (depth === 1) {
        current = { attributes: line.slice(2), rows: [] };
        row = undefined;
      } else append(raw);
      continue;
    }
    if (depth === 0 || !current) continue;
    if (line.startsWith("|}")) {
      depth--;
      if (depth === 0) {
        endRow();
        tables.push(current);
        current = undefined;
      } else append(raw);
      continue;
    }
    // A nested table's lines stay inside the cell that holds it.
    if (depth > 1) {
      append(raw);
      continue;
    }
    if (line.startsWith("|-")) {
      endRow();
      row = [];
      continue;
    }
    if (line.startsWith("|+")) continue;
    if (line.startsWith("!")) {
      row ??= [];
      for (const cell of splitOutside(line.slice(1), ["!!", "||"])) row.push(cellOf(cell, true));
      continue;
    }
    if (line.startsWith("|")) {
      row ??= [];
      // A line may open with more than one pipe ("||Industrials"): the cell starts after them.
      const body = line.replace(/^\|+/, "");
      for (const cell of splitOutside(body, ["||"])) row.push(cellOf(cell, false));
      continue;
    }
    append(raw);
  }
  return tables;
}

/** The table whose id is `id`. */
export function tableById(tables: readonly WikiTable[], id: string): WikiTable | undefined {
  const pattern = new RegExp(`\\bid\\s*=\\s*["']?${id}["'\\s>]`, "i");
  return tables.find((table) => pattern.test(`${table.attributes} `));
}

/** A table's rows laid out on a grid: a cell spanning rows or columns stands in each place it covers. */
export function gridOf(table: WikiTable): { header: boolean; text: string }[][] {
  const grid: { header: boolean; text: string }[][] = [];
  const carried: ({ cell: WikiCell; left: number } | undefined)[] = [];
  const take = (out: WikiCell[], column: number) => {
    const held = carried[column];
    if (!held || held.left <= 0) return false;
    out[column] = held.cell;
    held.left--;
    if (held.left === 0) carried[column] = undefined;
    return true;
  };
  for (const cells of table.rows) {
    const out: WikiCell[] = [];
    let column = 0;
    for (const cell of cells) {
      while (column < MAX_COLUMNS && take(out, column)) column++;
      for (let span = 0; span < cell.colspan && column < MAX_COLUMNS; span++) {
        out[column] = cell;
        if (cell.rowspan > 1) carried[column] = { cell, left: cell.rowspan - 1 };
        column++;
      }
    }
    for (; column < carried.length; column++) take(out, column);
    grid.push(
      Array.from(out, (cell) =>
        cell ? { header: cell.header, text: cell.text } : { header: false, text: "" },
      ),
    );
  }
  return grid;
}

/** `text` without templates ({{...}}, nested ones included), in one pass. */
function withoutTemplates(text: string): string {
  let out = "";
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const two = text.slice(index, index + 2);
    if (two === "{{") {
      depth++;
      index++;
      continue;
    }
    if (two === "}}" && depth > 0) {
      depth--;
      index++;
      continue;
    }
    if (depth === 0) out += text[index];
  }
  return out;
}

/**
 * Links as a reader sees them, in one pass: [[target|label]] as its label, [[target]] as its target,
 * [https://... text] as its text, a bare [https://...] as nothing; an unclosed one is left as written.
 */
function withoutLinks(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("[", at);
    if (open < 0) break;
    out += text.slice(at, open);
    if (text.startsWith("[[", open)) {
      const close = text.indexOf("]]", open + 2);
      if (close < 0) return out + text.slice(open);
      const inner = text.slice(open + 2, close);
      const pipe = inner.indexOf("|");
      out += pipe < 0 ? inner : inner.slice(pipe + 1);
      at = close + 2;
      continue;
    }
    const external = /^\[(?:https?:)?\/\//i.test(text.slice(open, open + 10));
    const close = external ? text.indexOf("]", open + 1) : -1;
    if (close < 0) {
      // Not a link, or one never closed (then none after it is either): kept as written.
      if (external) return out + text.slice(open);
      out += "[";
      at = open + 1;
      continue;
    }
    const inner = text.slice(open + 1, close);
    const space = inner.search(/\s/);
    out += space < 0 ? "" : inner.slice(space + 1);
    at = close + 1;
  }
  return out + text.slice(at);
}

/** What a reader sees of a cell: links' labels, an external link's text, no templates, tags or entities. */
export function plainText(cell: string): string {
  const text = withoutNoise(cell)
    // An external link whose address is a template (a Lua call) reads as its text.
    .replace(/\[\{\{#invoke:[^{}[\]]{0,500}\}\}\s*([^[\]]{0,500})\]/gi, "$1")
    .replace(/\{\{\s*snd\s*\}\}/gi, " – ");
  return decodeEntities(
    withoutLinks(withoutTemplates(text))
      .replace(/'''?/g, "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/?[a-z][^<>]{0,500}>/gi, ""),
    HTML_ENTITIES,
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** A ticker as SEC and Yahoo write it: upper case, a share class after a dash (BRK.B is BRK-B). */
export function tickerOf(symbol: string): string | undefined {
  const ticker = symbol.trim().toUpperCase().replace(/[./]/g, "-");
  return /^[A-Z][A-Z0-9]{0,9}(-[A-Z0-9]{1,3})?$/.test(ticker) ? ticker : undefined;
}

/** The ticker a symbol cell names: from an exchange's template, a Lua-made link, or the cell's text. */
export function symbolOf(cell: string): string | undefined {
  const text = withoutNoise(cell);
  // The template's first argument, or the ticker a Lua-made link's address is built for.
  const template = /\{\{\s*(?:nyse|nasdaq|bzx|cboe|amex)[^|{}]*\|([^|{}]*)/i.exec(text);
  if (template) return tickerOf(template[1] as string);
  const invoked = /\[\{\{#invoke:[^|{}]*\|GetURL\|([^|{}]*)/i.exec(text);
  if (invoked) return tickerOf(invoked[1] as string);
  return tickerOf(plainText(text));
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** A date a cell gives (2017-07-26, "November 18, 2026", "18 November 2026") as YYYY-MM-DD, or null. */
export function dateOf(cell: string): string | null {
  const text = plainText(cell);
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  const valid = (year: number, month: number, day: number) => {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? date.toISOString().slice(0, 10)
      : null;
  };
  if (iso) return valid(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const mdy = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(text);
  const dmy = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(text);
  const parts = mdy
    ? { month: mdy[1] as string, day: mdy[2] as string, year: mdy[3] as string }
    : dmy
      ? { month: dmy[2] as string, day: dmy[1] as string, year: dmy[3] as string }
      : undefined;
  if (!parts) return null;
  const month = MONTHS[parts.month.slice(0, 3).toLowerCase()];
  return month ? valid(Number(parts.year), month, Number(parts.day)) : null;
}

// The S&P lists -------------------------------------------------------------------------------------

/** One company as a list names it. */
export type ListedCompany = {
  /** As SEC and Yahoo write it (BRK-B). */
  ticker: string;
  name: string;
  /** Its GICS sector: the one GICS places its sub-industry in, else the list's. */
  sector: string;
  /** The sector as the list writes it, when that is another (the sector above corrects it). */
  listed_sector: string | null;
  sub_industry: string | null;
  /** The levels between, where GICS's tree holds the sub-industry. */
  industry_group: string | null;
  industry: string | null;
  /** Ten digits, when the list gives one. */
  cik: string | null;
  /** When its index added it (YYYY-MM-DD), when the page says. */
  added: string | null;
};

/** A list as read: its index and page, its companies, and how many rows could not be read. */
export type ParsedList = { index: SpIndex; page: string; companies: ListedCompany[]; skipped: number };

/** What a list's column holds. */
type ColumnKey = "symbol" | "security" | "sector" | "sub_industry" | "date_added" | "cik" | "sec_filings";

/** The column names the lists use, as compared (lower case, single spaces), by what they hold. */
const COLUMNS: Readonly<Record<string, ColumnKey>> = {
  symbol: "symbol",
  "ticker symbol": "symbol",
  ticker: "symbol",
  security: "security",
  company: "security",
  "gics sector": "sector",
  sector: "sector",
  "gics sub-industry": "sub_industry",
  "gics sub industry": "sub_industry",
  "sub-industry": "sub_industry",
  "date added": "date_added",
  "date first added": "date_added",
  cik: "cik",
  "sec filings": "sec_filings",
};

const unreadable = (list: SpList, why: string) =>
  new DataError("unavailable", `${WIKIPEDIA_SOURCE}'s ${list.index} list could not be read: ${why}.`, {
    source: WIKIPEDIA_SOURCE,
  });

/** A grid's column names, header rows combined ("Added" over "Ticker" reads "Added Ticker"). */
function headerOf(grid: readonly { header: boolean; text: string }[][]): {
  names: string[];
  body: { header: boolean; text: string }[][];
} {
  let first = 0;
  while (first < grid.length && (grid[first] as { header: boolean }[]).every((cell) => cell.header)) first++;
  const names: string[] = [];
  for (const row of grid.slice(0, first)) {
    row.forEach((cell, column) => {
      const text = plainText(cell.text);
      const words = names[column] ? names[column].split(" ") : [];
      if (text && !names[column]?.endsWith(text)) names[column] = [...words, text].join(" ").trim();
    });
  }
  return {
    names: names.map((name) => name.toLowerCase().replace(/\s+/g, " ").trim()),
    body: grid.slice(first),
  };
}

/** When the changes table says the page's index added each ticker: the latest date for each. */
export function additionsOf(tables: readonly WikiTable[]): Map<string, string> {
  const added = new Map<string, string>();
  const table = tableById(tables, "changes");
  if (!table) return added;
  const { names, body } = headerOf(gridOf(table));
  const date = names.findIndex((name) => name === "date" || name.startsWith("date"));
  const ticker = names.findIndex((name) => name.startsWith("added") && name.includes("ticker"));
  if (date < 0 || ticker < 0) return added;
  for (const row of body) {
    const when = dateOf(row[date]?.text ?? "");
    const symbol = symbolOf(row[ticker]?.text ?? "");
    if (!when || !symbol) continue;
    const before = added.get(symbol);
    if (!before || before < when) added.set(symbol, when);
  }
  return added;
}

/** A list's companies, from its page's wikitext. */
export function parseSpList(list: SpList, wikitext: string): ParsedList {
  const tables = wikiTables(wikitext);
  const table = tableById(tables, "constituents");
  if (!table) throw unreadable(list, 'the page has no table with the id "constituents"');
  const { names, body } = headerOf(gridOf(table));
  const at = (key: ColumnKey) => names.findIndex((name) => COLUMNS[name] === key);
  const column = {
    symbol: at("symbol"),
    security: at("security"),
    sector: at("sector"),
    sub_industry: at("sub_industry"),
    date_added: at("date_added"),
    cik: at("cik"),
    sec_filings: at("sec_filings"),
  };
  if (column.symbol < 0 || column.sector < 0) {
    throw unreadable(list, "its table has no Symbol or GICS Sector column");
  }
  const additions = additionsOf(tables);
  const companies: ListedCompany[] = [];
  let skipped = 0;
  for (const row of body) {
    if (row.every((cell) => !cell.text.trim())) continue;
    const cell = (index: number) => (index >= 0 ? (row[index]?.text ?? "") : "");
    const ticker = symbolOf(cell(column.symbol));
    const listedSector = gicsSector(plainText(cell(column.sector)));
    const subIndustry = plainText(cell(column.sub_industry)) || null;
    const levels = subIndustry ? gicsOf(subIndustry) : undefined;
    const sector = levels?.sector ?? listedSector;
    if (!ticker || !sector) {
      skipped++;
      continue;
    }
    const cikCell = plainText(cell(column.cik));
    const filed = /CIK=0*(\d{1,10})(?:&|\s|\]|$)/i.exec(cell(column.sec_filings));
    const digits = /^\d{1,10}$/.test(cikCell) ? cikCell : filed ? (filed[1] as string) : undefined;
    companies.push({
      ticker,
      name: plainText(cell(column.security)) || ticker,
      sector,
      listed_sector: listedSector && listedSector !== sector ? listedSector : null,
      sub_industry: levels?.sub_industry ?? subIndustry,
      industry_group: levels?.industry_group ?? null,
      industry: levels?.industry ?? null,
      cik: digits && Number(digits) > 0 ? digits.padStart(10, "0") : null,
      added: column.date_added >= 0 ? dateOf(cell(column.date_added)) : (additions.get(ticker) ?? null),
    });
  }
  if (!companies.length) throw unreadable(list, "its table lists no company this app can read");
  return { index: list.index, page: list.page, companies, skipped };
}

/** The wikitext of a parse API answer (formatversion 2, or 1's {"*": ...}). */
export function wikitextOf(list: SpList, body: unknown): string {
  const answer = body as {
    parse?: { wikitext?: unknown };
    error?: { code?: unknown; info?: unknown };
  } | null;
  if (answer?.error) {
    const code = typeof answer.error.code === "string" ? answer.error.code : "error";
    const kind = code === "ratelimited" ? "rate_limited" : "unavailable";
    throw new DataError(kind, `${WIKIPEDIA_SOURCE} answered "${code}" for its ${list.index} list.`, {
      source: WIKIPEDIA_SOURCE,
      code,
    });
  }
  const wikitext = answer?.parse?.wikitext;
  if (typeof wikitext === "string") return wikitext;
  const legacy = (wikitext as { "*"?: unknown } | undefined)?.["*"];
  if (typeof legacy === "string") return legacy;
  throw unreadable(list, "the answer holds no wikitext");
}

// The universe -------------------------------------------------------------------------------------

/** One company of the S&P 1500, from the list kept for it, and the other lists that also name it. */
export type IndexMember = ListedCompany & {
  index: SpIndex;
  /** Other lists naming the same ticker, and when each says its index added it. */
  also: { index: SpIndex; added: string | null }[];
};

/** A ticker found on more than one list, the list kept, and why. */
export type Duplicate = { ticker: string; kept: SpIndex; dropped: SpIndex[]; reason: string };

export type SpUniverse = {
  members: IndexMember[];
  duplicates: Duplicate[];
  /** When the oldest of the three lists was read (the engine's clock), and whether one is past its week. */
  read_at: string;
  stale: boolean;
};

/** Whether `a` was added more recently than `b` (a date beats none; on a tie, the list read first wins). */
function addedLater(a: { added: string | null; order: number }, b: { added: string | null; order: number }) {
  if (a.added !== b.added) {
    if (a.added === null) return false;
    if (b.added === null) return true;
    return a.added > b.added;
  }
  return a.order < b.order;
}

/** The three lists as one: each ticker once, kept from the list that added it most recently. */
export function combineLists(lists: readonly ParsedList[]): Pick<SpUniverse, "members" | "duplicates"> {
  const byTicker = new Map<string, { company: ListedCompany; index: SpIndex; order: number }[]>();
  lists.forEach((list, order) => {
    for (const company of list.companies) {
      const seen = byTicker.get(company.ticker) ?? [];
      // A ticker listed twice on one page is one company of that list.
      if (!seen.some((entry) => entry.index === list.index)) seen.push({ company, index: list.index, order });
      byTicker.set(company.ticker, seen);
    }
  });
  const members: IndexMember[] = [];
  const duplicates: Duplicate[] = [];
  for (const [ticker, entries] of byTicker) {
    const kept = entries.reduce((best, entry) =>
      addedLater(
        { added: entry.company.added, order: entry.order },
        { added: best.company.added, order: best.order },
      )
        ? entry
        : best,
    );
    const others = entries.filter((entry) => entry !== kept);
    members.push({
      ...kept.company,
      index: kept.index,
      also: others.map((entry) => ({ index: entry.index, added: entry.company.added })),
    });
    if (others.length) {
      const dated =
        kept.company.added !== null && others.every((entry) => entry.company.added !== kept.company.added);
      duplicates.push({
        ticker,
        kept: kept.index,
        dropped: others.map((entry) => entry.index),
        reason: dated
          ? `the ${kept.index} list added it most recently (${kept.company.added})`
          : `neither list dates its addition apart, so the ${kept.index} list is kept`,
      });
    }
  }
  return { members, duplicates };
}

/** A list as kept: what was read of it and when (the engine's clock). */
type KeptList = { list: ParsedList; read_at: string };

/** The cache's key for a list: its format's version is in it, so a format of an older build is not read. */
const listKey = (list: SpList) => `wikipedia:${list.key}:v1`;

/** The S&P 1500 from Wikipedia's three lists, each read once a week. */
export function spUniverse(deps: ForkDeps): { read(call?: { signal?: AbortSignal }): Promise<SpUniverse> } {
  const readList = (list: SpList, signal: AbortSignal | undefined) =>
    deps.cache.keep<KeptList>(
      listKey(list),
      LIST_TTL_MS,
      async () => {
        const answer = await deps.http
          .get(wikitextUrl(list.page), {
            source: WIKIPEDIA_SOURCE,
            signal,
            headers: { Accept: "application/json" },
            accept: [404],
          })
          .catch((error: unknown) => {
            // A page gone from the API is the source failing, never an answer about the market.
            throw error instanceof DataError && error.kind === "no_data"
              ? unreadable(list, error.message)
              : error;
          });
        if (answer.status === 404) {
          await answer.bytes().catch(() => undefined);
          throw unreadable(list, "the API answered HTTP 404");
        }
        return {
          list: parseSpList(list, wikitextOf(list, await answer.json())),
          read_at: deps.clock().toISOString(),
        };
      },
      { disk: "json", staleOnError: true, signal },
    );
  return {
    async read(call = {}) {
      const kept: { value: KeptList; stale: boolean }[] = [];
      // One after another, as MediaWiki's API etiquette asks of its clients.
      for (const list of SP_LISTS) kept.push(await readList(list, call.signal));
      const combined = combineLists(kept.map((one) => one.value.list));
      return {
        ...combined,
        read_at: kept.map((one) => one.value.read_at).sort()[0] ?? deps.clock().toISOString(),
        stale: kept.some((one) => one.stale),
      };
    },
  };
}
