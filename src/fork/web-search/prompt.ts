// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * What the main agent's instructions (agents/prompts.ts) say of web_search in a session that offers it:
 * that a claim taken from a page is cited to the page with a link, and, while data is missing, that the
 * web can look for what it would show. Style as in prompts.ts: no em-dash and no middle dot.
 */

/** The sentences for a session that offers web_search (`web`), with capabilities `missing` or not. */
export function webSearchPrompt({ web, missing }: { web: boolean; missing: boolean }): string[] {
  if (!web) return [];
  return [
    ...(missing
      ? [
          "web_search can look on the web for what these would show; a figure from a page is a lead, cited to its page.",
        ]
      : []),
    "A claim or figure taken from web_search is cited to its page with a markdown link, [site](url), beside the id of its result.",
  ];
}
