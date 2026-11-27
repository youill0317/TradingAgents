// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * A small, tolerant XML reader: enough for SEC's ownership documents (Form 3/4/5), OpenDART's
 * corpCode.xml and DART's report documents, which are XML-like rather than well formed. It reads
 * elements, attributes (quoted, unquoted or bare), text, character references and CDATA, and skips
 * comments, processing instructions and a DOCTYPE (its internal subset too: no entity it declares is
 * expanded). It never throws and never recurses: an end tag that closes nothing is ignored, one that
 * closes an outer element closes the elements left open inside it, anything still open at the end is
 * closed there, and a `<` that starts no tag is text. Names keep their case and prefix; the helpers
 * match a name without a prefix to an element's local name too. Reading takes time in proportion to the
 * text, however the tags nest or fail to close, and attributes are kept in an object with no prototype
 * (an attribute named `__proto__` is an attribute like any other).
 */
import { decodeEntities, HTML_ENTITIES } from "./entities.js";

export type XmlElement = {
  /** As written: "ownershipDocument", "ix:nonNumeric", "SECTION-1". */
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
};
/** An element, or a run of text (references decoded, CDATA as written). */
export type XmlNode = XmlElement | string;

/**
 * The document as an element named "#document" whose children are its top-level nodes. Text that is
 * only whitespace with a line break (indentation) is left out; other text is kept as written, decoded by
 * `entities` (XML's five and the common HTML ones unless given).
 */
export function parseXml(
  text: string,
  { entities = HTML_ENTITIES }: { entities?: Readonly<Record<string, number>> } = {},
): XmlElement {
  const root: XmlElement = { name: "#document", attributes: {}, children: [] };
  const open: Open = { stack: [root], exact: new Map(), folded: new Map() };
  const current = () => open.stack[open.stack.length - 1] as XmlElement;
  const addText = (raw: string, decode: boolean) => {
    if (!raw) return;
    if (/^\s*$/.test(raw) && /[\r\n]/.test(raw)) return;
    current().children.push(decode ? decodeEntities(raw, entities) : raw);
  };
  let at = 0;
  while (at < text.length) {
    const lt = text.indexOf("<", at);
    if (lt < 0) {
      addText(text.slice(at), true);
      break;
    }
    if (lt > at) addText(text.slice(at, lt), true);
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      at = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      addText(text.slice(lt + 9, end < 0 ? text.length : end), false);
      at = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      at = declarationEnd(text, lt + 2);
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      at = end < 0 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith("</", lt)) {
      const end = text.indexOf(">", lt + 2);
      const name = text.slice(lt + 2, end < 0 ? text.length : end).trim();
      at = end < 0 ? text.length : end + 1;
      close(open, name);
      continue;
    }
    const tag = readTag(text, lt, entities);
    if (!tag) {
      // A `<` that starts no tag ("a < b") is text.
      addText("<", false);
      at = lt + 1;
      continue;
    }
    const element: XmlElement = { name: tag.name, attributes: tag.attributes, children: [] };
    current().children.push(element);
    if (!tag.selfClosing) push(open, element);
    at = tag.end;
  }
  return root;
}

/**
 * The elements open, innermost last (the document first), and how many of them carry each name, as
 * written and in lower case: an end tag that matches none is passed over without a search.
 */
type Open = { stack: XmlElement[]; exact: Map<string, number>; folded: Map<string, number> };

function count(names: Map<string, number>, name: string, by: number): void {
  const next = (names.get(name) ?? 0) + by;
  if (next > 0) names.set(name, next);
  else names.delete(name);
}

function push(open: Open, element: XmlElement): void {
  open.stack.push(element);
  count(open.exact, element.name, 1);
  count(open.folded, element.name.toLowerCase(), 1);
}

/** Where a declaration (`<!DOCTYPE ...>`, with any internal subset in brackets) ends. */
function declarationEnd(text: string, from: number): number {
  const close = text.indexOf(">", from);
  // A subset's bracket is looked for only up to the declaration's `>`, so many declarations read in one pass.
  const head = close < 0 ? text.length : close;
  let bracket = -1;
  for (let at = from; at < head; at++) {
    if (text.charCodeAt(at) === 91 /* [ */) {
      bracket = at;
      break;
    }
  }
  if (bracket >= 0) {
    const subsetEnd = text.indexOf("]", bracket + 1);
    const after = subsetEnd < 0 ? -1 : text.indexOf(">", subsetEnd + 1);
    return after < 0 ? text.length : after + 1;
  }
  return close < 0 ? text.length : close + 1;
}

/**
 * Closes the innermost open element named `name` (exactly, else ignoring case) and every element opened
 * inside it; an end tag that matches nothing open is ignored. A search runs only when an element of that
 * name is open, and every element it passes is closed, so each element is looked at once at most.
 */
function close(open: Open, name: string): void {
  const { stack } = open;
  const lower = name.toLowerCase();
  const exact = open.exact.has(name);
  if (!exact && !open.folded.has(lower)) return;
  let index = -1;
  for (let i = stack.length - 1; i > 0; i--) {
    const candidate = (stack[i] as XmlElement).name;
    if (exact ? candidate === name : candidate.toLowerCase() === lower) {
      index = i;
      break;
    }
  }
  if (index < 1) return;
  for (let i = stack.length - 1; i >= index; i--) {
    const closed = (stack[i] as XmlElement).name;
    count(open.exact, closed, -1);
    count(open.folded, closed.toLowerCase(), -1);
  }
  stack.length = index;
}

/** A name's first character: a letter, `_` or `:` (or any non-ASCII character). */
function startsName(code: number): boolean {
  return (
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 58 || code > 127
  );
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

/** The start tag at `lt`: its name, attributes, whether it closes itself, and where it ends; none if no tag starts there. */
function readTag(
  text: string,
  lt: number,
  entities: Readonly<Record<string, number>>,
): { name: string; attributes: Record<string, string>; selfClosing: boolean; end: number } | undefined {
  let at = lt + 1;
  if (at >= text.length || !startsName(text.charCodeAt(at))) return undefined;
  const nameStart = at;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (isSpace(code) || code === 62 /* > */ || code === 47 /* / */) break;
    at++;
  }
  const name = text.slice(nameStart, at);
  // No prototype: a name such as `__proto__` or `constructor` is stored as an attribute, nothing more.
  const attributes = Object.create(null) as Record<string, string>;
  while (at < text.length) {
    while (at < text.length && isSpace(text.charCodeAt(at))) at++;
    if (at >= text.length) break;
    const code = text.charCodeAt(at);
    if (code === 62 /* > */) return { name, attributes, selfClosing: false, end: at + 1 };
    if (code === 47 /* / */) {
      if (text.charCodeAt(at + 1) === 62) return { name, attributes, selfClosing: true, end: at + 2 };
      at++;
      continue;
    }
    const keyStart = at;
    while (at < text.length) {
      const c = text.charCodeAt(at);
      if (isSpace(c) || c === 61 /* = */ || c === 62 || c === 47) break;
      at++;
    }
    const key = text.slice(keyStart, at);
    while (at < text.length && isSpace(text.charCodeAt(at))) at++;
    if (text.charCodeAt(at) !== 61 /* = */) {
      // A bare attribute (`<option selected>`).
      if (key && !Object.hasOwn(attributes, key)) attributes[key] = "";
      continue;
    }
    at++;
    while (at < text.length && isSpace(text.charCodeAt(at))) at++;
    const quote = text.charCodeAt(at);
    let value: string;
    if (quote === 34 /* " */ || quote === 39 /* ' */) {
      const end = text.indexOf(String.fromCharCode(quote), at + 1);
      if (end < 0) {
        // An unclosed quote runs to the tag's next `>`.
        const gt = text.indexOf(">", at + 1);
        value = text.slice(at + 1, gt < 0 ? text.length : gt);
        at = gt < 0 ? text.length : gt;
      } else {
        value = text.slice(at + 1, end);
        at = end + 1;
      }
    } else {
      const valueStart = at;
      while (at < text.length) {
        const c = text.charCodeAt(at);
        if (isSpace(c) || c === 62) break;
        at++;
      }
      value = text.slice(valueStart, at);
    }
    if (key && !Object.hasOwn(attributes, key)) attributes[key] = decodeEntities(value, entities);
  }
  // The text ended inside the tag: it is read as far as it goes.
  return { name, attributes, selfClosing: false, end: text.length };
}

/** Whether `element` is named `name`: exactly, or by its local name when `name` has no prefix. */
export function named(element: XmlElement, name: string): boolean {
  if (element.name === name) return true;
  if (name.includes(":")) return false;
  const colon = element.name.indexOf(":");
  return colon >= 0 && element.name.slice(colon + 1) === name;
}

/** The child elements of `element`, those named `name` when given. */
export function children(element: XmlElement, name?: string): XmlElement[] {
  return element.children.filter(
    (node): node is XmlElement => typeof node !== "string" && (name === undefined || named(node, name)),
  );
}

/** The first child element named `name`. */
export function child(element: XmlElement, name: string): XmlElement | undefined {
  for (const node of element.children) {
    if (typeof node !== "string" && named(node, name)) return node;
  }
  return undefined;
}

/** The element at `path` ("reportingOwner/reportingOwnerId/rptOwnerCik"), each step the first child so named. */
export function find(element: XmlElement, path: string): XmlElement | undefined {
  let at: XmlElement | undefined = element;
  for (const step of path.split("/").filter(Boolean)) {
    at = at ? child(at, step) : undefined;
  }
  return at;
}

/** Every descendant named `name`, in document order (those inside a match included). */
export function findAll(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const stack: XmlNode[] = [...element.children].reverse();
  while (stack.length) {
    const node = stack.pop() as XmlNode;
    if (typeof node === "string") continue;
    if (named(node, name)) found.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as XmlNode);
  }
  return found;
}

/** All the text inside `node`, in document order, as written. */
export function textOf(node: XmlNode | undefined): string {
  if (node === undefined) return "";
  if (typeof node === "string") return node;
  let out = "";
  const stack: XmlNode[] = [...node.children].reverse();
  while (stack.length) {
    const next = stack.pop() as XmlNode;
    if (typeof next === "string") out += next;
    else for (let i = next.children.length - 1; i >= 0; i--) stack.push(next.children[i] as XmlNode);
  }
  return out;
}

/** The trimmed text at `path` under `element`; undefined when there is no such element or it holds no text. */
export function valueAt(element: XmlElement, path: string): string | undefined {
  const text = textOf(find(element, path)).trim();
  return text === "" ? undefined : text;
}
