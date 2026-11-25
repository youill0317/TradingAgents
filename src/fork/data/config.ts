// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The free public-data sources' settings: SEC's User-Agent and each agency's key, read from the
 * environment first and then from a "data" object in credentials.json, keyed by the same variable names
 * ({"data": {"FRED_API_KEY": "..."}}); and where their answers are cached on disk. What a session's start
 * says about them (`notes`, a line each) is worded here, and names a setting, never its value.
 *
 * Without SEC_USER_AGENT the SEC-backed data (filings, statements, insider trades, sector screens) is not
 * offered: SEC's fair-access rule asks every program that reads EDGAR to name its sender.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ENV } from "../../config/env.js";
import { isRecord, parseJson } from "../../config/json.js";
import type { Paths } from "../../config/paths.js";
import { APP_NAME } from "../../contracts/index.js";
import { readPrivate } from "../../store/index.js";

export type PublicDataConfig = {
  /** SEC's fair-access User-Agent: a name and an email, "Your Name you@example.com". Not a secret, but personal. */
  secUserAgent?: string;
  /** FRED (St. Louis Fed) API key. */
  fredKey?: string;
  /** OpenDART (Korea's Financial Supervisory Service) API key. */
  dartKey?: string;
  /** Bank of Korea ECOS API key. */
  ecosKey?: string;
  /** Statistics Korea KOSIS API key. */
  kosisKey?: string;
  /** data.go.kr service key (the Financial Services Commission's market data). */
  dataGoKrKey?: string;
  /** Naver search API client id and secret. */
  naverClientId?: string;
  naverClientSecret?: string;
  /** U.S. Bureau of Economic Analysis API key. */
  beaKey?: string;
  /** U.S. Energy Information Administration API key. */
  eiaKey?: string;
  /** Where answers worth keeping are cached on disk; in memory only when unset. */
  cacheDir?: string;
};

/** The settings read, by field: each one's environment variable, also its name under "data" in credentials.json. */
export const PUBLIC_DATA_VARS = {
  secUserAgent: "SEC_USER_AGENT",
  fredKey: "FRED_API_KEY",
  dartKey: "DART_API_KEY",
  ecosKey: "ECOS_API_KEY",
  kosisKey: "KOSIS_API_KEY",
  dataGoKrKey: "DATA_GO_KR_API_KEY",
  naverClientId: "NAVER_CLIENT_ID",
  naverClientSecret: "NAVER_CLIENT_SECRET",
  beaKey: "BEA_API_KEY",
  eiaKey: "EIA_API_KEY",
} as const satisfies { [Field in Exclude<keyof PublicDataConfig, "cacheDir">]-?: string };

type Field = keyof typeof PUBLIC_DATA_VARS;

/** What a session's start says about the public-data settings, a line each. */
const NOTE = {
  secUnset: () =>
    `SEC_USER_AGENT is not set, so SEC filings, financial statements, insider trades and sector screens are not available: set it to your name and email, such as SEC_USER_AGENT="Your Name you@example.com" (in the environment, or under "data" in credentials.json). SEC's fair-access rule asks every program that reads EDGAR to name its sender this way; it is not a secret.`,
  secNoEmail: () =>
    `SEC_USER_AGENT holds no email address: SEC's fair-access rule asks for a name and an email, such as "Your Name you@example.com", and SEC may refuse requests that do not give one.`,
  secNotAscii: () =>
    `SEC_USER_AGENT holds characters other than plain ASCII letters, digits and punctuation, so it cannot be sent as a User-Agent and SEC data is not available: write it as "Your Name you@example.com".`,
  dataNotObject: (path: string) => `${path}: "data" is not an object, so the data keys in it are not used`,
  unusable: (path: string, name: string) => `${path}: data.${name} is not a usable value, so it is not used`,
  unknown: (path: string, name: string) =>
    `${path}: data.${name} is not a setting this app reads (it reads ${Object.values(PUBLIC_DATA_VARS).join(", ")})`,
};

/** A value as stored and used: trimmed, on one line, not empty. */
function usable(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && !/[\r\n]/.test(text) ? text : undefined;
}

/**
 * The public-data settings `env` and the credentials file in `paths` give, and the notes a session's start
 * says about them. A credentials file that cannot be read adds no note here: the settings already say so.
 */
export async function publicDataConfig(
  env: NodeJS.ProcessEnv,
  paths: Pick<Paths, "home" | "credentials">,
): Promise<{ config: PublicDataConfig; notes: string[] }> {
  const notes: string[] = [];
  const stored = await storedData(paths.credentials, notes);
  const config: PublicDataConfig = {};
  for (const [field, variable] of Object.entries(PUBLIC_DATA_VARS) as [Field, string][]) {
    const value = usable(env[variable]) ?? stored[variable];
    if (value !== undefined) config[field] = value;
  }
  const agent = config.secUserAgent;
  if (agent === undefined) notes.push(NOTE.secUnset());
  else if (!/^[\x20-\x7e]+$/.test(agent)) {
    delete config.secUserAgent;
    notes.push(NOTE.secNotAscii());
  } else if (!/[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/.test(agent)) notes.push(NOTE.secNoEmail());
  return { config: { ...config, cacheDir: cacheDirOf(env, paths) }, notes };
}

/** The "data" settings in the credentials file at `path`, by variable name; problems with them in `notes`. */
async function storedData(path: string, notes: string[]): Promise<Record<string, string>> {
  let text: string | undefined;
  try {
    text = await readPrivate(path);
  } catch {
    return {};
  }
  if (text === undefined) return {};
  const json = parseJson(text);
  if (!isRecord(json) || json.data === undefined) return {};
  if (!isRecord(json.data)) {
    notes.push(NOTE.dataNotObject(path));
    return {};
  }
  const known = new Set<string>(Object.values(PUBLIC_DATA_VARS));
  const found: Record<string, string> = {};
  for (const [name, value] of Object.entries(json.data)) {
    if (!known.has(name)) {
      notes.push(NOTE.unknown(path, name));
      continue;
    }
    const kept = usable(value);
    if (kept === undefined) notes.push(NOTE.unusable(path, name));
    else found[name] = kept;
  }
  return found;
}

/**
 * Where the public data is cached on disk: <home>/cache/fork-data when TRADINGAGENTS_HOME names the home,
 * else fork-data in the app's directory under XDG_CACHE_HOME (when it is absolute) or ~/.cache.
 */
export function cacheDirOf(env: NodeJS.ProcessEnv, paths: Pick<Paths, "home">): string {
  if (env[ENV.home] !== undefined) return join(paths.home, "cache", "fork-data");
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
  return join(base, APP_NAME, "fork-data");
}

/**
 * Every value in `config` that must never be said: each key, and SEC's User-Agent (it names a person). The
 * cache directory is not one.
 */
export function secretsOf(config: PublicDataConfig): string[] {
  return (Object.keys(PUBLIC_DATA_VARS) as Field[]).flatMap((field) => {
    const value = config[field];
    return value === undefined ? [] : [value];
  });
}
