// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/** Hangul in a text (src/fork/data/util/hangul.ts): what tells a search in Korean. */
import { expect, test } from "bun:test";
import { hasHangul } from "../../../src/fork/data/util/hangul.js";

test("Hangul tells a search in Korean: syllables, jamo, mixed with other scripts", () => {
  expect(["삼성전자", "ㅋㅋ", "Samsung 반도체", "HBM4 수율"].map(hasHangul)).toEqual([
    true,
    true,
    true,
    true,
  ]);
  expect(["Samsung Electronics", "サムスン", "三星电子", "chip export controls"].map(hasHangul)).toEqual([
    false,
    false,
    false,
    false,
  ]);
});
