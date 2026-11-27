// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * HTML (and DART's XML-like report documents) as plain text, for a filing's sections: block elements
 * break lines, paragraphs and headings are set apart by a blank line, a table row is one line of
 * tab-separated cells (a table inside a cell stays on the cell's line), and character references are
 * decoded (a no-break space reads as a space). Scripts, styles, the document's head, templates, SVG, form
 * selects and inline XBRL's hidden header (`ix:header`) are left out. Whitespace runs collapse to one space
 * except inside `pre`. It is tolerant as browsers are: unclosed or stray tags, unquoted attributes, a `<`
 * that starts no tag and a head whose end tag is left out (it ends where the body's content starts) never
 * stop it. It reads in one pass, in time proportional to its input, without recursion.
 */
import { decodeEntities, HTML_ENTITIES } from "./entities.js";

/** Elements whose content is not text a reader sees, wherever they are. */
const SKIPPED = new Set(["script", "style", "template", "svg", "noscript", "select", "ix:header"]);

/**
 * What a document's head holds (HTML's "in head" elements); any other start tag, or text, ends a head
 * whose end tag was left out, and is read as the body's.
 */
const HEAD_CONTENT = new Set([
  "base",
  "basefont",
  "bgsound",
  "head",
  "link",
  "meta",
  "noframes",
  "noscript",
  "script",
  "style",
  "template",
  "title",
]);

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
/** A run of what reads as blank in a cell, `pre`'s stand-ins included; and a character that does not. */
const BLANKS = new RegExp(`[\\s${PRE_SPACE}${PRE_TAB}]+`, "g");
const VISIBLE = new RegExp(`[^\\s${PRE_SPACE}${PRE_TAB}]`);

/**
 * A table cell's content: text as written (its whitespace not collapsed yet) and the tables inside it, in
 * order; `filled` once it holds anything a reader sees.
 */
type Cell = { pieces: (string | Table)[]; filled: boolean };
/**
 * A table being read: its rows that hold something (each up to its last filled cell), and the row and the
 * cell open. A table inside a cell is kept whole in it and written out with the outermost table, once.
 */
type Table = { rows: Cell[][]; row: Cell[] | null; cell: Cell | null };

/** The text a reader sees in `html`. */
export function htmlToText(html: string): string {
  // The page so far, in parts joined at the end; `tail` holds its last characters, the only ones read
  // back (never the whole page, which would copy it at each read).
  const parts: string[] = [];
  let tail = "";
  const tables: Table[] = [];
  let pre = 0;
  // The head: open from its start tag until its end tag or the body's first content; one head per page,
  // before any content (text or a table).
  let inHead = false;
  let headSeen = false;
  let content = false;

  const append = (text: string) => {
    if (!text) return;
    parts.push(text);
    tail = text.length >= 4 ? text.slice(-4) : (tail + text).slice(-4);
  };
  const table = () => tables[tables.length - 1];
  /**
   * Text into the open cell, else the open table's next cell, else the page. On the page, a space after a
   * space or a line's end is dropped (as a browser collapses them across elements), so the page never ends
   * in more than one space.
   */
  const write = (text: string) => {
    if (!content && VISIBLE.test(text)) content = true;
    const open = table();
    if (open) {
      if (open.cell === null) {
        if (!VISIBLE.test(text)) return;
        open.row ??= [];
        open.cell = { pieces: [], filled: false };
      }
      open.cell.pieces.push(text);
      if (!open.cell.filled && VISIBLE.test(text)) open.cell.filled = true;
      return;
    }
    const last = tail.charCodeAt(tail.length - 1);
    append(text.charCodeAt(0) === 32 && (tail === "" || last === 32 || last === 10) ? text.slice(1) : text);
  };
  /** How many line ends close the page, past a space after them, counting to `most` (2 at most) at most. */
  const trailingBreaks = (most: number) => {
    let end = tail.length;
    if (end > 0 && tail.charCodeAt(end - 1) === 32) end--;
    let breaks = 0;
    while (breaks < most && breaks < end && tail.charCodeAt(end - breaks - 1) === 10) breaks++;
    return breaks;
  };
  /**
   * A block's edge: the page goes on on a new line (`blank`: after a blank line), however many edges meet
   * there. Within a cell, a space (a cell is one line).
   */
  const lineBreak = (blank: boolean) => {
    const open = table();
    if (open) {
      if (open.cell !== null) open.cell.pieces.push(" ");
      return;
    }
    const wanted = blank ? 2 : 1;
    const breaks = trailingBreaks(wanted);
    if (breaks < wanted) append("\n".repeat(wanted - breaks));
  };
  /**
   * A line break as written (`<br>`): each one counts, up to one blank line (the most the text keeps).
   * Within a cell, a space.
   */
  const newLine = () => {
    const open = table();
    if (open) {
      if (open.cell !== null) open.cell.pieces.push(" ");
      return;
    }
    if (trailingBreaks(2) < 2) append("\n");
  };
  const endCell = (open: Table) => {
    if (open.cell === null) return;
    open.row ??= [];
    open.row.push(open.cell);
    open.cell = null;
  };
  const endRow = (open: Table) => {
    endCell(open);
    if (open.row) {
      // Empty cells at the row's end are left out; a row of empty cells is no line.
      let last = open.row.length;
      while (last > 0 && !(open.row[last - 1] as Cell).filled) last--;
      if (last > 0) open.rows.push(open.row.slice(0, last));
    }
    open.row = null;
  };
  const endTable = () => {
    const open = tables.pop();
    if (!open) return;
    endRow(open);
    const outer = table();
    if (outer) {
      // A table inside a cell: its rows, in one line of the outer cell, written with the outermost table.
      if (open.rows.length) {
        if (outer.cell === null) {
          outer.row ??= [];
          outer.cell = { pieces: [], filled: false };
        }
        outer.cell.pieces.push(open);
        outer.cell.filled = true;
      }
      return;
    }
    if (!open.rows.length) return;
    lineBreak(true);
    append(open.rows.map((row) => row.map(cellText).join("\t")).join("\n"));
    lineBreak(true);
  };

  let at = 0;
  while (at < html.length) {
    const lt = html.indexOf("<", at);
    const chunk = html.slice(at, lt < 0 ? html.length : lt);
    if (chunk) {
      // Text in the head, other than the blanks between its elements, is the body's start.
      if (!inHead || !/^[\t\n\f\r ]*$/.test(chunk)) {
        inHead = false;
        write(textOf(chunk, pre > 0));
      }
    }
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
      inHead = false;
      write("<");
      at = lt + 1;
      continue;
    }
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const end = tagEnd(html, nameEnd);
    at = end;
    const selfClosing = html.charCodeAt(end - 2) === 47; /* "/>" */
    if (closing) {
      if (inHead) {
        // The head's end; or the body's or the page's, which end it too. Other end tags mean nothing there.
        if (name === "head") {
          inHead = false;
          continue;
        }
        if (name !== "body" && name !== "html" && name !== "br") continue;
        inHead = false;
      }
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
    if (inHead) {
      if (HEAD_CONTENT.has(name)) {
        // The head's title is the document's name, not its text.
        if ((name === "title" || name === "noframes") && !selfClosing) at = skippedEnd(html, end, name);
        else if (SKIPPED.has(name) && !selfClosing) at = skippedEnd(html, end, name);
        continue;
      }
      inHead = false;
    }
    if (SKIPPED.has(name) && !selfClosing) {
      at = skippedEnd(html, end, name);
      continue;
    }
    if (name === "head") {
      // A head opens only before anything is written; a stray one later is ignored, as browsers do.
      if (!headSeen && !content && !selfClosing) inHead = true;
      headSeen = true;
    } else if (name === "br") {
      newLine();
    } else if (name === "table") {
      lineBreak(true);
      content = true;
      tables.push({ rows: [], row: null, cell: null });
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
        open.cell = { pieces: [], filled: false };
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
  return tidy(parts.join(""));
}

/** A run of text as it reads: references decoded; outside `pre`, whitespace runs as one space. */
function textOf(raw: string, pre: boolean): string {
  const decoded = decodeEntities(raw, HTML_ENTITIES);
  if (pre) return decoded.replaceAll(NBSP, " ").replaceAll(" ", PRE_SPACE).replaceAll("\t", PRE_TAB);
  return decoded.replace(/\s+/g, " ");
}

/**
 * A cell's text on one line, its blanks collapsed to single spaces; a table inside it reads as its rows,
 * their cells a space apart and the rows "; " apart, set off by spaces. Each piece is read once, depth
 * first, without recursion.
 */
function cellText(cell: Cell): string {
  const out: string[] = [];
  // A space owed before the next text, if more text comes.
  let owed = false;
  const say = (raw: string) => {
    const text = raw.replace(BLANKS, " ");
    if (text === " ") owed = true;
    if (text === " " || text === "") return;
    const lead = text.charCodeAt(0) === 32;
    const trail = text.charCodeAt(text.length - 1) === 32;
    if ((owed || lead) && out.length) out.push(" ");
    out.push(text.slice(lead ? 1 : 0, trail ? text.length - 1 : text.length));
    owed = trail;
  };
  type Frame = { pieces: (string | Table)[]; at: number } | { rows: Cell[][]; row: number; cell: number };
  const stack: Frame[] = [{ pieces: cell.pieces, at: 0 }];
  while (stack.length) {
    const top = stack[stack.length - 1] as Frame;
    if ("pieces" in top) {
      const piece = top.pieces[top.at++];
      if (piece === undefined) stack.pop();
      else if (typeof piece === "string") say(piece);
      else {
        owed = true;
        stack.push({ rows: piece.rows, row: 0, cell: 0 });
      }
      continue;
    }
    const row = top.rows[top.row];
    if (row === undefined) {
      owed = true;
      stack.pop();
      continue;
    }
    const next = row[top.cell];
    if (next === undefined) {
      top.row++;
      top.cell = 0;
      if (top.row < top.rows.length) {
        // Rows apart by "; ": the semicolon right after the row's text.
        if (out.length) out.push(";");
        owed = true;
      }
      continue;
    }
    if (top.cell > 0) owed = true;
    top.cell++;
    stack.push({ pieces: next.pieces, at: 0 });
  }
  return out.join("");
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
