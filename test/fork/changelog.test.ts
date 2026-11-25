// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/** The release notes `/changelog` and the welcome show: every upstream version, none of Tauric's services. */
import { expect, test } from "bun:test";
import { CHANGELOG } from "../../src/cli/changelog.generated.js";
import { NOTES } from "../../src/fork/changelog.js";

test("the notes shown name no Tauric service", () => {
  expect(JSON.stringify(NOTES)).not.toMatch(/tauric/i);
});

test("every upstream version keeps its notes, with a highlight first", () => {
  expect(NOTES.map((entry) => entry.version)).toEqual(CHANGELOG.map((entry) => entry.version));
  for (const entry of NOTES) expect(entry.sections[0]?.items[0]).toBeTruthy();
});
