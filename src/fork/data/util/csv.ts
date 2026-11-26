// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The CSV reader the agencies' files share (the ECB's SDMX answers, the Treasury's yield curves, FRED's keyless
 * download): RFC 4180 rows, a table read by its header, and numbers as the agencies write them.
 */
/**
 * A CSV text's rows, each a list of fields, as RFC 4180 writes them and the agencies publish them: a field
 * quoted when it holds a comma, a quote or a line end, a quote inside it doubled; lines ended by CRLF or LF,
 * the last with or without its end; a byte-order mark before the first. Blank lines are no rows. One pass,
 * in time proportional to the text; it never throws (an unclosed quote runs to the end of the text).
 */
export function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const end = text.length;
  const finish = () => {
    if (row.length > 1 || (row.length === 1 && row[0] !== "")) rows.push(row);
    row = [];
  };
  while (at < end) {
    let field: string;
    if (text[at] === '"') {
      // A quoted field: up to its closing quote, doubled quotes read as one.
      let value = "";
      let from = at + 1;
      for (;;) {
        const quote = text.indexOf('"', from);
        if (quote < 0) {
          value += text.slice(from);
          at = end;
          break;
        }
        value += text.slice(from, quote);
        if (text[quote + 1] === '"') {
          value += '"';
          from = quote + 2;
          continue;
        }
        at = quote + 1;
        break;
      }
      // Anything between the closing quote and the next separator belongs to the field, as written.
      let next = at;
      while (next < end && text[next] !== "," && text[next] !== "\n" && text[next] !== "\r") next++;
      field = value + text.slice(at, next);
      at = next;
    } else {
      let next = at;
      while (next < end && text[next] !== "," && text[next] !== "\n" && text[next] !== "\r") next++;
      field = text.slice(at, next);
      at = next;
    }
    row.push(field);
    if (at >= end) break;
    const separator = text[at];
    if (separator === ",") {
      at++;
      // A separator at the very end leaves an empty last field.
      if (at >= end) row.push("");
      continue;
    }
    // A line end: CRLF, LF or a lone CR.
    at += separator === "\r" && text[at + 1] === "\n" ? 2 : 1;
    finish();
  }
  finish();
  return rows;
}

/** A CSV text read by its header: the header's names (trimmed) and each row as fields by name. */
export function csvTable(text: string): { header: string[]; rows: Record<string, string>[] } {
  const [first, ...rest] = readCsv(text);
  if (!first) return { header: [], rows: [] };
  const header = first.map((name) => name.trim());
  return {
    header,
    rows: rest.map((fields) => {
      const record: Record<string, string> = Object.create(null);
      header.forEach((name, index) => {
        record[name] = (fields[index] ?? "").trim();
      });
      return record;
    }),
  };
}

/** A number as an agency writes it; null for an empty cell, "NaN", "." and anything that is not a number. */
export function numberOf(text: string | undefined): number | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
