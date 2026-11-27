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
        "Data: quotes and prices, company data, economic series, news, market overviews, event odds and instrument search from free public sources (Yahoo, the U.S. Treasury, the New York Fed, the ECB, FRED, GDELT, Polymarket), and with SEC_USER_AGENT set SEC EDGAR's statements, filings, insider transactions and sector screens over Wikipedia's S&P lists.",
        "Korean data, each source with its key: OpenDART's statements, filings and insider reports of Korean companies, and their names in instrument search (DART_API_KEY); the FSC's official KRX end-of-day prices (DATA_GO_KR_API_KEY); the Bank of Korea's ECOS and Statistics Korea's KOSIS series (ECOS_API_KEY, KOSIS_API_KEY); Naver's news search for news in Korean (NAVER_CLIENT_ID, NAVER_CLIENT_SECRET).",
        "Agents: Macro Strategy and the built-in skills are offered in every setup; Equity Research, Quant Research and Risk Analysis with SEC_USER_AGENT set; Risk Analysis with DART_API_KEY set too.",
        "Web search: `web_search` searches the web through Anthropic's or OpenAI's own search with your key for it, or through Google's when TRADINGAGENTS_WEB_SEARCH names it.",
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
