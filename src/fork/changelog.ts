// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The release notes this fork shows (`/changelog` and the welcome's "New in" line): upstream's notes as
 * generated from CHANGELOG.md, with every item about Tauric's services left out (they are not in this
 * fork), and the fork's own items for a version first. Upstream's generated file is read as it is, so a
 * new upstream release merges without touching it.
 */
import { CHANGELOG } from "../cli/changelog.generated.js";
import type { VersionNotes } from "../cli/whats-new.js";

/** The fork's own notes, by the version they ship in; the first item is the version's highlight. */
const FORK_NOTES: { readonly [version: string]: VersionNotes["sections"] } = {
  "1.0.0": [
    {
      items: [
        "This fork reads free public data and needs no data account; sessions stay on this computer.",
        "Prices come from Yahoo and event odds from Polymarket.",
      ],
    },
  ],
};

/** Items that name Tauric's services, products or sites. */
const TAURIC = /tauric/i;

function withoutTauric(sections: VersionNotes["sections"]): VersionNotes["sections"] {
  return sections
    .map((section) => ({ ...section, items: section.items.filter((item) => !TAURIC.test(item)) }))
    .filter((section) => section.items.length > 0);
}

export const NOTES: readonly VersionNotes[] = CHANGELOG.map((entry) => ({
  version: entry.version,
  sections: [...(FORK_NOTES[entry.version] ?? []), ...withoutTauric(entry.sections)],
}));
