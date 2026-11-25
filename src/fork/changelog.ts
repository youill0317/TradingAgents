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

/**
 * The fork's own notes, by the version they ship in, under a heading of their own so `/changelog` shows them
 * apart from upstream's; the first item is the version's highlight.
 */
const FORK_NOTES: { readonly [version: string]: VersionNotes["sections"] } = {
  "1.0.0": [
    {
      heading: "This fork",
      items: [
        "This fork needs no data account, and sessions stay on this computer.",
        "Data: prices from Yahoo and event odds from Polymarket. Free public data sources are being added, and the built-in agents and skills are offered as the data they need becomes available.",
        "Web search: `web_search` searches the web through Anthropic's, OpenAI's or Google's own search, with your key for it.",
        "Models: OpenAI, Anthropic, Google, DeepSeek, OpenRouter, AI subscriptions (ChatGPT), or self-hosted models.",
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
