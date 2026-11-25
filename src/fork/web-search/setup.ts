// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Which provider's web search a session runs, and with which key: the chat model's own provider when it
 * is Anthropic, Google or OpenAI, else the first of them with a key (from the environment or the stored
 * credentials, found as the settings found them); none without a key. TRADINGAGENTS_WEB_SEARCH names
 * another: "off", a provider ("google"), or a provider and its model ("openai/gpt-6-luna").
 */

import { readCredentials } from "../../config/credentials.js";
import { envName } from "../../config/env.js";
import type { Paths } from "../../config/paths.js";
import type { Settings } from "../../config/settings.js";
import type { ModelRoute } from "../../contracts/index.js";
import {
  defaultSearchModel,
  WEB_SEARCH_PROVIDERS,
  type WebSearchProvider,
  type WebSearchSetup,
} from "./search.js";

/** The variable that turns web search off or names its provider and model. */
export const WEB_SEARCH_VAR = envName("WEB_SEARCH");

const isProvider = (value: string): value is WebSearchProvider =>
  (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value);

/** What the setting asks for: no search, a provider (and model), or the default choice; undefined when unreadable. */
export function readChoice(
  value: string | undefined,
): { off: true } | { provider?: WebSearchProvider; model?: string } | undefined {
  const text = value?.trim();
  if (!text) return {};
  if (text.toLowerCase() === "off") return { off: true };
  const at = text.indexOf("/");
  const provider = (at < 0 ? text : text.slice(0, at)).toLowerCase();
  const model = at < 0 ? undefined : text.slice(at + 1).trim();
  if (!isProvider(provider) || model === "") return undefined;
  return { provider, ...(model ? { model } : {}) };
}

/**
 * The search from the choice in `setting`, the chat `model`, and `keyOf` (a provider's key, if it has one):
 * the provider named, else the chat model's, else the first with a key. Undefined when it has no key, or
 * when the setting is off or cannot be read.
 */
export async function chooseWebSearch(
  setting: string | undefined,
  model: ModelRoute | undefined,
  keyOf: (provider: WebSearchProvider) => Promise<string | undefined>,
): Promise<WebSearchSetup | undefined> {
  const choice = readChoice(setting);
  if (!choice || "off" in choice) return undefined;
  const chat = model && isProvider(model.provider) ? model.provider : undefined;
  const candidates = choice.provider ? [choice.provider] : [...(chat ? [chat] : []), ...WEB_SEARCH_PROVIDERS];
  for (const provider of new Set(candidates)) {
    const apiKey = await keyOf(provider);
    if (apiKey) return { provider, model: choice.model ?? defaultSearchModel(provider), apiKey };
  }
  return undefined;
}

/**
 * The search a session on `settings` runs: each provider's key read where the settings found it (the chat
 * model's own, the variable named in `keyFrom`, or credentials.json), the setting from `env`.
 */
export function webSearchSetup(
  settings: Pick<Settings, "model" | "keyFrom">,
  env: NodeJS.ProcessEnv,
  paths: Pick<Paths, "credentials">,
): Promise<WebSearchSetup | undefined> {
  let stored: Promise<Partial<Record<string, string>>> | undefined;
  const keyOf = async (provider: WebSearchProvider) => {
    const { model } = settings;
    if (model?.provider === provider && "apiKey" in model && model.apiKey) return model.apiKey;
    const from = settings.keyFrom[provider];
    if (from === undefined) return undefined;
    if (from !== "stored") return env[from]?.trim() || undefined;
    stored ??= readCredentials(paths.credentials, []);
    return (await stored)[provider];
  };
  return chooseWebSearch(env[WEB_SEARCH_VAR], settings.model, keyOf);
}
