// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Which provider's web search a session runs, and with which key: the chat model's own provider when it
 * is Anthropic or OpenAI, else the first of them with a key (from the environment or the stored
 * credentials, found as the settings found them). Google searches only when TRADINGAGENTS_WEB_SEARCH names
 * it, and a ChatGPT plan's sign-in is not an API key: without a key, no search. The variable turns search
 * off ("off") or names the provider ("google") or the provider and its model ("openai/gpt-6-luna").
 * What a session's start says about it (`notes`, a line each) is worded here, apart from the app's
 * messages.
 */

import { readCredentials } from "../../config/credentials.js";
import { KEY_VARS } from "../../config/env.js";
import type { Paths } from "../../config/paths.js";
import type { Settings } from "../../config/settings.js";
import { APP_NAME, type ModelRoute } from "../../contracts/index.js";
import {
  defaultSearchModel,
  PROVIDER_NAMES,
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_VAR,
  type WebSearchProvider,
  type WebSearchSetup,
} from "./search.js";

export { WEB_SEARCH_VAR } from "./search.js";

/** The providers a session searches with unless the setting names one, in the order a key is looked for. */
const BY_DEFAULT: readonly WebSearchProvider[] = ["anthropic", "openai"];

const isProvider = (value: string): value is WebSearchProvider =>
  (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value);

/** What a session's start says about its search, a line each. */
const NOTE = {
  unreadable: () =>
    `${WEB_SEARCH_VAR}: not off, anthropic, openai, google, or a provider and its model such as openai/gpt-6-luna, so web_search is off`,
  noKey: (provider: WebSearchProvider) =>
    `${WEB_SEARCH_VAR} names ${provider}, whose search needs its key: set ${KEY_VARS[provider].join(" or ")}, or store one with ${APP_NAME} key ${provider}; web_search is off until then`,
  googleOnly: () =>
    `web_search is off: it searches with an Anthropic or OpenAI key, and only a Google key is set; ${WEB_SEARCH_VAR}=google turns on Google Search grounding, whose terms ask that Google's search suggestions be shown, which this terminal app cannot show`,
  billed: ({ provider, model }: WebSearchSetup) =>
    `web_search runs on ${PROVIDER_NAMES[provider]} (${model}), billed to the ${PROVIDER_NAMES[provider]} key, not the chat model's`,
};

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

/** The search a session runs, if any, and what its start says about it. */
export type WebSearchChoice = { setup?: WebSearchSetup; notes: string[] };

/**
 * The search from the choice in `setting`, the chat `model`, and `keyOf` (a provider's key, if it has
 * one): the provider named, else the chat model's when it is Anthropic or OpenAI, else the first of them
 * with a key. None when the setting is off or cannot be read, or when there is no key; the notes say why
 * where the user would want to know, and which provider's key a search is billed to when it is not the
 * chat model's.
 */
export async function chooseWebSearch(
  setting: string | undefined,
  model: ModelRoute | undefined,
  keyOf: (provider: WebSearchProvider) => Promise<string | undefined>,
): Promise<WebSearchChoice> {
  const choice = readChoice(setting);
  if (!choice) return { notes: [NOTE.unreadable()] };
  if ("off" in choice) return { notes: [] };
  const found = async (provider: WebSearchProvider): Promise<WebSearchSetup | undefined> => {
    const apiKey = await keyOf(provider);
    return apiKey ? { provider, model: choice.model ?? defaultSearchModel(provider), apiKey } : undefined;
  };
  let setup: WebSearchSetup | undefined;
  if (choice.provider) {
    setup = await found(choice.provider);
    if (!setup) return { notes: [NOTE.noKey(choice.provider)] };
  } else {
    const chat = model?.provider === "anthropic" || model?.provider === "openai" ? [model.provider] : [];
    for (const provider of new Set([...chat, ...BY_DEFAULT])) {
      setup = await found(provider);
      if (setup) break;
    }
    // A Google key alone searches only when named, so the user is told how.
    if (!setup) return { notes: (await keyOf("google")) ? [NOTE.googleOnly()] : [] };
  }
  return { setup, notes: model && model.provider !== setup.provider ? [NOTE.billed(setup)] : [] };
}

/**
 * The search a session on `settings` runs, and its notes: each provider's key read where the settings
 * found it (the chat model's own, the variable named in `keyFrom`, or credentials.json), the setting from
 * `env`.
 */
export function webSearchFor(
  settings: Pick<Settings, "model" | "keyFrom">,
  env: NodeJS.ProcessEnv,
  paths: Pick<Paths, "credentials">,
): Promise<WebSearchChoice> {
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
