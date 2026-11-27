// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Hangul in a text: what tells a search in Korean (instrument search reads a company's Korean name from
 * OpenDART's company list).
 */

/** Hangul (its syllables, jamo and compatibility jamo), built from code points: the formatter rewrites escapes. */
const HANGUL = new RegExp(
  `[${[
    [0x1100, 0x11ff],
    [0x3130, 0x318f],
    [0xa960, 0xa97f],
    [0xac00, 0xd7af],
    [0xd7b0, 0xd7ff],
  ]
    .map(([from, to]) => `${String.fromCharCode(from as number)}-${String.fromCharCode(to as number)}`)
    .join("")}]`,
);

/** Whether `text` holds Hangul: a search in Korean. */
export function hasHangul(text: string): boolean {
  return HANGUL.test(text);
}
