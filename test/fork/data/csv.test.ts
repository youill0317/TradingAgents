// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The CSV reader the agencies' files share (src/fork/data/util/csv.ts): RFC 4180 rows (CRLF, quoted fields
 * holding commas and quotes, a byte-order mark), a table read by its header (on the ECB's own full-detail answer
 * saved earlier), and numbers as the agencies write them.
 */
import { describe, expect, test } from "bun:test";
import { csvTable, numberOf, readCsv } from "../../../src/fork/data/util/csv.js";
import { fixture } from "./harness.js";

const text = (file: string) => new TextDecoder().decode(fixture(file));

describe("the CSV reader", () => {
  test("CRLF lines, quoted fields holding commas and doubled quotes, a BOM, blank lines, a last line without its end", () => {
    expect(readCsv('﻿a,b,c\r\n1,"x, y",""\r\n\r\n2,"say ""hi""",z')).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", ""],
      ["2", 'say "hi"', "z"],
    ]);
    expect(readCsv("a,b\nc,\n")).toEqual([
      ["a", "b"],
      ["c", ""],
    ]);
    expect(readCsv("")).toEqual([]);
    // An unclosed quote runs to the end of the text; nothing throws.
    expect(readCsv('a,"b\r\nc')).toEqual([["a", "b\r\nc"]]);
  });

  test("a full-detail answer reads by column name, its quoted title whole", () => {
    const { header, rows } = csvTable(text("ecb/exr-krw-2026-11.csv"));
    expect(header).toHaveLength(32);
    expect(rows[0]?.TITLE_COMPL).toBe("ECB reference exchange rate, South Korean won/Euro, 2.15 pm (C.E.T.)");
    expect(rows[0]?.OBS_VALUE).toBe("1506.2");
    expect(rows[0]?.UNIT).toBe("KRW");
  });
});

describe("numbers as the agencies write them", () => {
  test("a number, signed or with an exponent; nothing for an empty cell, a dot, NaN or a grouped number", () => {
    expect(["4.12", " 2 ", "-0.5", "+3", ".25", "1e3"].map(numberOf)).toEqual([4.12, 2, -0.5, 3, 0.25, 1000]);
    expect(["", ".", "NaN", "1,000", "n/a", undefined].map((cell) => numberOf(cell))).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});
