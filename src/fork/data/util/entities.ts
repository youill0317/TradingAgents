// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Character references, as the XML and HTML readers (xml.ts, html.ts) decode them: numeric ones
 * (&#160; &#xA0;, the semicolon optional as browsers read them) and named ones from a table (the
 * semicolon required). A reference that names no character, or one this table does not know, is left as
 * written; one that names an impossible character (a surrogate, past U+10FFFF, NUL) reads as U+FFFD.
 */

/** XML's five predefined entities. */
export const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** XML's, and the HTML entities that filings and statistics pages use. */
export const HTML_ENTITIES: Readonly<Record<string, string>> = {
  ...XML_ENTITIES,
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwnj: "‌",
  zwj: "‍",
  lrm: "‎",
  rlm: "‏",
  shy: "­",
  ndash: "–",
  mdash: "—",
  minus: "−",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  hellip: "…",
  bull: "•",
  middot: "·",
  prime: "′",
  Prime: "″",
  dagger: "†",
  Dagger: "‡",
  sect: "§",
  para: "¶",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  frac14: "¼",
  frac12: "½",
  frac34: "¾",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  micro: "µ",
  permil: "‰",
  cent: "¢",
  pound: "£",
  yen: "¥",
  euro: "€",
  curren: "¤",
  iexcl: "¡",
  iquest: "¿",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  le: "≤",
  ge: "≥",
  ne: "≠",
  asymp: "≈",
  infin: "∞",
  check: "✓",
  cross: "✗",
  loz: "◊",
  squ: "□",
  square: "□",
  rect: "▭",
  ordf: "ª",
  ordm: "º",
  acute: "´",
  uml: "¨",
  cedil: "¸",
  macr: "¯",
  not: "¬",
  brvbar: "¦",
  Agrave: "À",
  Aacute: "Á",
  Acirc: "Â",
  Atilde: "Ã",
  Auml: "Ä",
  Aring: "Å",
  AElig: "Æ",
  Ccedil: "Ç",
  Egrave: "È",
  Eacute: "É",
  Ecirc: "Ê",
  Euml: "Ë",
  Igrave: "Ì",
  Iacute: "Í",
  Icirc: "Î",
  Iuml: "Ï",
  Ntilde: "Ñ",
  Ograve: "Ò",
  Oacute: "Ó",
  Ocirc: "Ô",
  Otilde: "Õ",
  Ouml: "Ö",
  Oslash: "Ø",
  Ugrave: "Ù",
  Uacute: "Ú",
  Ucirc: "Û",
  Uuml: "Ü",
  Yacute: "Ý",
  szlig: "ß",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  yuml: "ÿ",
};

/** A character reference: numeric (decimal or hex, `;` optional) or named (`;` required). */
const REFERENCE = /&(?:#([0-9]{1,10});?|#[xX]([0-9a-fA-F]{1,8});?|([A-Za-z][A-Za-z0-9]{0,31});)/g;

/** `text` with its character references decoded by `named` (XML's five unless given). */
export function decodeEntities(text: string, named: Readonly<Record<string, string>> = XML_ENTITIES): string {
  if (!text.includes("&")) return text;
  return text.replace(REFERENCE, (whole, decimal: string | undefined, hex: string | undefined, name?: string) => {
    if (name !== undefined) return Object.hasOwn(named, name) ? (named[name] as string) : whole;
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex as string, 16);
    return character(code);
  });
}

/** The character a code point names, or U+FFFD for one that names none (NUL, a surrogate, past U+10FFFF). */
function character(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return "�";
  }
  return String.fromCodePoint(code);
}
