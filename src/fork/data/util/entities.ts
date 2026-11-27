// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Character references, as the XML and HTML readers (xml.ts, html.ts) decode them: numeric ones
 * (&#160; &#xA0;, the semicolon optional as browsers read them) and named ones from a table (the
 * semicolon required). A reference that names no character, or one this table does not know, is left as
 * written; one that names an impossible character (a surrogate, past U+10FFFF, NUL) reads as U+FFFD.
 */

/** XML's five predefined entities, by name: the code point each names. */
export const XML_ENTITIES: Readonly<Record<string, number>> = {
  amp: 0x0026,
  lt: 0x003c,
  gt: 0x003e,
  quot: 0x0022,
  apos: 0x0027,
};

/** XML's, and the HTML entities that filings and statistics pages use, by name: the code point each names. */
export const HTML_ENTITIES: Readonly<Record<string, number>> = {
  ...XML_ENTITIES,
  nbsp: 0x00a0,
  ensp: 0x2002,
  emsp: 0x2003,
  thinsp: 0x2009,
  zwnj: 0x200c,
  zwj: 0x200d,
  lrm: 0x200e,
  rlm: 0x200f,
  shy: 0x00ad,
  ndash: 0x2013,
  mdash: 0x2014,
  minus: 0x2212,
  lsquo: 0x2018,
  rsquo: 0x2019,
  sbquo: 0x201a,
  ldquo: 0x201c,
  rdquo: 0x201d,
  bdquo: 0x201e,
  laquo: 0x00ab,
  raquo: 0x00bb,
  lsaquo: 0x2039,
  rsaquo: 0x203a,
  hellip: 0x2026,
  bull: 0x2022,
  middot: 0x00b7,
  prime: 0x2032,
  Prime: 0x2033,
  dagger: 0x2020,
  Dagger: 0x2021,
  sect: 0x00a7,
  para: 0x00b6,
  copy: 0x00a9,
  reg: 0x00ae,
  trade: 0x2122,
  deg: 0x00b0,
  plusmn: 0x00b1,
  times: 0x00d7,
  divide: 0x00f7,
  frac14: 0x00bc,
  frac12: 0x00bd,
  frac34: 0x00be,
  sup1: 0x00b9,
  sup2: 0x00b2,
  sup3: 0x00b3,
  micro: 0x00b5,
  permil: 0x2030,
  cent: 0x00a2,
  pound: 0x00a3,
  yen: 0x00a5,
  euro: 0x20ac,
  curren: 0x00a4,
  iexcl: 0x00a1,
  iquest: 0x00bf,
  larr: 0x2190,
  rarr: 0x2192,
  uarr: 0x2191,
  darr: 0x2193,
  harr: 0x2194,
  le: 0x2264,
  ge: 0x2265,
  ne: 0x2260,
  asymp: 0x2248,
  infin: 0x221e,
  check: 0x2713,
  cross: 0x2717,
  loz: 0x25ca,
  squ: 0x25a1,
  square: 0x25a1,
  rect: 0x25ad,
  ordf: 0x00aa,
  ordm: 0x00ba,
  acute: 0x00b4,
  uml: 0x00a8,
  cedil: 0x00b8,
  macr: 0x00af,
  not: 0x00ac,
  brvbar: 0x00a6,
  Agrave: 0x00c0,
  Aacute: 0x00c1,
  Acirc: 0x00c2,
  Atilde: 0x00c3,
  Auml: 0x00c4,
  Aring: 0x00c5,
  AElig: 0x00c6,
  Ccedil: 0x00c7,
  Egrave: 0x00c8,
  Eacute: 0x00c9,
  Ecirc: 0x00ca,
  Euml: 0x00cb,
  Igrave: 0x00cc,
  Iacute: 0x00cd,
  Icirc: 0x00ce,
  Iuml: 0x00cf,
  Ntilde: 0x00d1,
  Ograve: 0x00d2,
  Oacute: 0x00d3,
  Ocirc: 0x00d4,
  Otilde: 0x00d5,
  Ouml: 0x00d6,
  Oslash: 0x00d8,
  Ugrave: 0x00d9,
  Uacute: 0x00da,
  Ucirc: 0x00db,
  Uuml: 0x00dc,
  Yacute: 0x00dd,
  szlig: 0x00df,
  agrave: 0x00e0,
  aacute: 0x00e1,
  acirc: 0x00e2,
  atilde: 0x00e3,
  auml: 0x00e4,
  aring: 0x00e5,
  aelig: 0x00e6,
  ccedil: 0x00e7,
  egrave: 0x00e8,
  eacute: 0x00e9,
  ecirc: 0x00ea,
  euml: 0x00eb,
  igrave: 0x00ec,
  iacute: 0x00ed,
  icirc: 0x00ee,
  iuml: 0x00ef,
  ntilde: 0x00f1,
  ograve: 0x00f2,
  oacute: 0x00f3,
  ocirc: 0x00f4,
  otilde: 0x00f5,
  ouml: 0x00f6,
  oslash: 0x00f8,
  ugrave: 0x00f9,
  uacute: 0x00fa,
  ucirc: 0x00fb,
  uuml: 0x00fc,
  yacute: 0x00fd,
  yuml: 0x00ff,
};

/** A character reference: numeric (decimal or hex, `;` optional) or named (`;` required). */
const REFERENCE = /&(?:#([0-9]{1,10});?|#[xX]([0-9a-fA-F]{1,8});?|([A-Za-z][A-Za-z0-9]{0,31});)/g;

/** `text` with its character references decoded by `named` (XML's five unless given). */
export function decodeEntities(text: string, named: Readonly<Record<string, number>> = XML_ENTITIES): string {
  if (!text.includes("&")) return text;
  return text.replace(
    REFERENCE,
    (whole, decimal: string | undefined, hex: string | undefined, name?: string) => {
      if (name !== undefined) return Object.hasOwn(named, name) ? character(named[name] as number) : whole;
      const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex as string, 16);
      return character(code);
    },
  );
}

/** The character a code point names, or U+FFFD for one that names none (NUL, a surrogate, past U+10FFFF). */
function character(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return String.fromCharCode(0xfffd);
  }
  return String.fromCodePoint(code);
}
