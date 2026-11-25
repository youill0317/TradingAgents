// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * HTML (and DART's XML-like report documents) as plain text, for a filing's sections: block elements
 * break lines, paragraphs and headings are set apart by a blank line, a table row is one line of
 * tab-separated cells, and character references are decoded (a no-break space reads as a space).
 * Scripts, styles, the document's head, templates, SVG, form selects and inline XBRL's hidden header
 * (`ix:header`) are left out. Whitespace runs collapse to one space except inside `pre`. It is tolerant
 * as browsers are: unclosed or stray tags, unquoted attributes and a `<` that starts no tag never stop
 * it, and it reads in one pass without recursion.
 */
import { decodeEntities, HTML_ENTITIES } from "./entities.js";

/** Elements whose content is not text a reader sees. */
const SKIPPED = new Set(["script", "style", "head", "template", "svg", "noscript", "select", "ix:header"]);

/** Elements that start and end a line. */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "center",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hgroup",
  "hr",
  "html",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "summary",
  "ul",
  "caption",
  "legend",
  "option",
  // DART's report documents.
  "library",
  "cover",
  "part",
  "pgbrk",
]);

/** Elements set apart by a blank line: paragraphs, headings, sections. */
const PARAGRAPH = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "section", "title"]);

/** Table cells, HTML's and DART's (TE, TU). */
const CELL = new Set(["td", "th", "te", "tu"]);

/** Stand-ins for a `pre` block's spaces and tabs while lines are trimmed. */
const PRE_SPACE = String.fromCharCode(0xe000);
const PRE_TAB = String.fromCharCode(0xe001);
/** A no-break space, which reads as a space. */
const NBSP = String.fromCharCode(0xa0);

type Table = { row: string[] | null; cell: string | null; lines: string[] };

/** The text a reader sees in `html`. */
export function htmlToText(html: string): string {
  let out = "";
  const tables: Table[] = [];
  let pre = 0;

  const table = () => tables[tables.length - 1];
  /**
   * Text into the open cell, else the open table's next cell, else the page. On the page, a space after a
   * space or a line's end is dropped (as a browser collapses them across elements), so the page never ends
   * in more than one space.
   */
  const write = (text: string) => {
    const open = table();
    if (open) {
      if (open.cell === null) {
        if (!text.trim()) return;
        open.row ??= [];
        open.cell = "";
      }
      open.cell += text;
      return;
    }
    const last = out.charCodeAt(out.length - 1);
    out += text.charCodeAt(0) === 32 && (out === "" || last === 32 || last === 10) ? text.slice(1) : text;
  };
  /** How many line ends close the page, past a space after them, counting to `most` at most. */
  const trailingBreaks = (most: number) => {
    let end = out.length;
    if (end > 0 && out.charCodeAt(end - 1) === 32) end--;
    let breaks = 0;
    while (breaks < most && breaks < end && out.charCodeAt(end - breaks - 1) === 10) breaks++;
    return breaks;
  };
  /**
   * A block's edge: the page goes on on a new line (`blank`: after a blank line), however many edges meet
   * there. Within a cell, a space (a cell is one line).
   */
  const lineBreak = (blank: boolean) => {
    const open = table();
    if (open) {
      if (open.cell !== null) open.cell += " ";
      return;
    }
    const wanted = blank ? 2 : 1;
    const breaks = trailingBreaks(wanted);
    if (breaks < wanted) out += "\n".repeat(wanted - breaks);
  };
  /**
   * A line break as written (`<br>`): each one counts, up to one blank line (the most the text keeps).
   * Within a cell, a space.
   */
  const newLine = () => {
    const open = table();
    if (open) {
      if (open.cell !== null) open.cell += " ";
      return;
    }
    if (trailingBreaks(2) < 2) out += "\n";
  };
  const endCell = (open: Table) => {
    if (open.cell === null) return;
    open.row ??= [];
    open.row.push(collapse(open.cell));
    open.cell = null;
  };
  const endRow = (open: Table) => {
    endCell(open);
    if (open.row) {
      // Empty cells at the row's end are left out; a row of empty cells is no line.
      let last = open.row.length;
      while (last > 0 && open.row[last - 1] === "") last--;
      if (last > 0) open.lines.push(open.row.slice(0, last).join("\t"));
    }
    open.row = null;
  };
  const endTable = () => {
    const open = tables.pop();
    if (!open) return;
    endRow(open);
    const outer = table();
    if (outer) {
      // A table inside a cell: its rows, in one line of the outer cell.
      if (open.lines.length) write(` ${open.lines.map((line) => line.replaceAll("\t", " ")).join("; ")} `);
      return;
    }
    if (!open.lines.length) return;
    lineBreak(true);
    out += open.lines.join("\n");
    lineBreak(true);
  };

  let at = 0;
  while (at < html.length) {
    const lt = html.indexOf("<", at);
    const chunk = html.slice(at, lt < 0 ? html.length : lt);
    if (chunk) write(textOf(chunk, pre > 0));
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt + 2);
      at = end < 0 ? html.length : end + 1;
      continue;
    }
    const closing = html.charCodeAt(lt + 1) === 47; /* / */
    const nameStart = lt + (closing ? 2 : 1);
    const nameEnd = tagNameEnd(html, nameStart);
    if (nameEnd === nameStart || !startsName(html.charCodeAt(nameStart))) {
      write("<");
      at = lt + 1;
      continue;
    }
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const end = tagEnd(html, nameEnd);
    at = end;
    const selfClosing = html.charCodeAt(end - 2) === 47; /* "/>" */
    if (closing) {
      if (CELL.has(name)) {
        const open = table();
        if (open) endCell(open);
      } else if (name === "tr") {
        const open = table();
        if (open) endRow(open);
      } else if (name === "table") {
        endTable();
      } else if (name === "pre") {
        pre = Math.max(0, pre - 1);
        lineBreak(true);
      } else if (PARAGRAPH.has(name) || name.startsWith("section-")) {
        lineBreak(true);
      } else if (BLOCK.has(name)) {
        lineBreak(false);
      }
      continue;
    }
    if (SKIPPED.has(name) && !selfClosing) {
      at = skippedEnd(html, end, name);
      continue;
    }
    if (name === "br") {
      newLine();
    } else if (name === "table") {
      lineBreak(true);
      tables.push({ row: null, cell: null, lines: [] });
    } else if (name === "tr") {
      const open = table();
      if (open) {
        endRow(open);
        open.row = [];
      } else lineBreak(false);
    } else if (CELL.has(name)) {
      const open = table();
      if (open) {
        endCell(open);
        open.row ??= [];
        open.cell = "";
      } else write(" ");
    } else if (name === "pre") {
      lineBreak(true);
      if (!selfClosing) pre++;
    } else if (PARAGRAPH.has(name) || name.startsWith("section-")) {
      lineBreak(true);
    } else if (BLOCK.has(name)) {
      lineBreak(false);
    }
  }
  while (tables.length) endTable();
  return tidy(out);
}

/** A run of text as it reads: references decoded; outside `pre`, whitespace runs as one space. */
function textOf(raw: string, pre: boolean): string {
  const decoded = decodeEntities(raw, HTML_ENTITIES);
  if (pre) return decoded.replaceAll(NBSP, " ").replaceAll(" ", PRE_SPACE).replaceAll("\t", PRE_TAB);
  return decoded.replace(/\s+/g, " ");
}

/** A cell's text on one line. */
function collapse(text: string): string {
  return text.replaceAll(PRE_SPACE, " ").replaceAll(PRE_TAB, " ").replace(/\s+/g, " ").trim();
}

/** Lines trimmed, at most one blank line in a row, none at either end. */
function tidy(text: string): string {
  const lines = text.split("\n").map((line) => line.replace(/^ +| +$/g, ""));
  const kept: string[] = [];
  for (const line of lines) {
    if (line === "" && (kept.length === 0 || kept[kept.length - 1] === "")) continue;
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  return kept.join("\n").replaceAll(PRE_SPACE, " ").replaceAll(PRE_TAB, "\t");
}

function startsName(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** Where a tag's name ends: at whitespace, `/` or `>`. */
function tagNameEnd(html: string, from: number): number {
  let at = from;
  while (at < html.length) {
    const code = html.charCodeAt(at);
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 47 || code === 62)
      break;
    at++;
  }
  return at;
}

/** Just past the `>` that ends the tag whose name ends at `from`, quoted attribute values skipped. */
function tagEnd(html: string, from: number): number {
  let at = from;
  while (at < html.length) {
    const code = html.charCodeAt(at);
    if (code === 62) return at + 1;
    if (code === 34 || code === 39) {
      const close = html.indexOf(String.fromCharCode(code), at + 1);
      if (close < 0) {
        // An unclosed quote runs to the next `>`.
        const gt = html.indexOf(">", at + 1);
        return gt < 0 ? html.length : gt + 1;
      }
      at = close + 1;
      continue;
    }
    at++;
  }
  return html.length;
}

/** Just past the end tag of a skipped element opened before `from`, or the end when it has none. */
function skippedEnd(html: string, from: number, name: string): number {
  let at = from;
  while (at < html.length) {
    const found = html.indexOf("</", at);
    if (found < 0) return html.length;
    const after = found + 2 + name.length;
    const code = html.charCodeAt(after);
    // "</scripts" is not the end of a script.
    if (
      html.slice(found + 2, after).toLowerCase() === name &&
      (after >= html.length || code === 62 || code === 32 || code === 9 || code === 10 || code === 13)
    ) {
      const gt = html.indexOf(">", after);
      return gt < 0 ? html.length : gt + 1;
    }
    at = found + 2;
  }
  return html.length;
}
