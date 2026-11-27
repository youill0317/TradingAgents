// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The free public-data sources' settings: SEC's User-Agent and each agency's key, read from the
 * environment first and then from a "data" object in credentials.json, keyed by the same variable names
 * ({"data": {"FRED_API_KEY": "..."}}); and where their answers are cached on disk. What a session's start
 * says about them (`notes`, a line each) is worded here, and names a setting, never its value.
 *
 * Without SEC_USER_AGENT nothing is read from SEC EDGAR, so the SEC-backed data (filings, statements,
 * insider trades, sector screens) is not offered: SEC's fair-access rule asks every program that reads EDGAR
 * to name its sender. A value set where it cannot be used (on more than one line; for SEC_USER_AGENT, with
 * characters a User-Agent cannot carry; for NAVER_CLIENT_ID and NAVER_CLIENT_SECRET, sent in headers, with a
 * character a header cannot carry) is said, and not used: the environment's then gives way to
 * credentials.json's.
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
    `SEC_USER_AGENT is not set, so nothing is read from SEC EDGAR (filings, financial statements, insider trades, sector screens): SEC's fair-access rule asks every program that reads EDGAR to name its sender. Set it to your name and email, such as SEC_USER_AGENT="Your Name you@example.com" (in the environment, or under "data" in credentials.json); it is not a secret.`,
  secUnusable: () =>
    `SEC_USER_AGENT has no value that can be used, so nothing is read from SEC EDGAR: write it as your name and email, such as SEC_USER_AGENT="Your Name you@example.com".`,
  secNoEmail: () =>
    `SEC_USER_AGENT holds no email address: SEC's fair-access rule asks for a name and an email, such as "Your Name you@example.com", and SEC may refuse requests that do not give one.`,
  envUnusable: (variable: string, why: string, fallback: string | undefined) =>
    `${variable} in the environment ${why}, so it is not used${fallback ? `; the one under "data" in ${fallback} is used instead` : ""}`,
  dataNotObject: (path: string) => `${path}: "data" is not an object, so the data keys in it are not used`,
  unusable: (path: string, name: string, why: string) => `${path}: data.${name} ${why}, so it is not used`,
  unknown: (path: string, name: string) =>
    `${path}: data.${name} is not a setting this app reads (it reads ${Object.values(PUBLIC_DATA_VARS).join(", ")})`,
};

/** A setting as read: its value, why a value set cannot be used, or nothing set at all. */
type Read = { value: string } | { why: string } | undefined;

/** The settings sent as a request header's value (Naver's client id and secret). */
const HEADER_VARS: ReadonlySet<string> = new Set([
  PUBLIC_DATA_VARS.naverClientId,
  PUBLIC_DATA_VARS.naverClientSecret,
]);

/**
 * `value` as `variable` uses it: trimmed, on one line, not empty (an empty one is not set); SEC's User-Agent
 * only in printable ASCII, the most a header carries; a setting sent in a header without a character a header
 * cannot carry: one above U+00FF (fetch refuses it) or a control character other than tab (RFC 9110).
 */
function readValue(variable: string, value: unknown): Read {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return { why: "is not text" };
  const text = value.trim();
  if (!text) return undefined;
  if (/[\r\n]/.test(text)) return { why: "spans more than one line" };
  if (variable === PUBLIC_DATA_VARS.secUserAgent && !/^[\x20-\x7e]+$/.test(text)) {
    return {
      why: "holds characters other than plain ASCII letters, digits and punctuation, which a User-Agent cannot carry",
    };
  }
  if (HEADER_VARS.has(variable) && /[^\t\x20-\x7e\x80-\xff]/.test(text)) {
    return { why: "holds a character the request header it is sent in cannot carry" };
  }
  return { value: text };
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
  let secRefused = false;
  for (const [field, variable] of Object.entries(PUBLIC_DATA_VARS) as [Field, string][]) {
    const fromEnv = readValue(variable, env[variable]);
    const fromFile = stored.get(variable);
    const value =
      fromEnv && "value" in fromEnv
        ? fromEnv.value
        : fromFile && "value" in fromFile
          ? fromFile.value
          : undefined;
    if (fromEnv && "why" in fromEnv) {
      notes.push(
        NOTE.envUnusable(variable, fromEnv.why, value === undefined ? undefined : paths.credentials),
      );
    }
    if (fromFile && "why" in fromFile) notes.push(NOTE.unusable(paths.credentials, variable, fromFile.why));
    if (field === "secUserAgent")
      secRefused =
        (fromEnv !== undefined && "why" in fromEnv) || (fromFile !== undefined && "why" in fromFile);
    if (value !== undefined) config[field] = value;
  }
  const agent = config.secUserAgent;
  if (agent === undefined) notes.push(secRefused ? NOTE.secUnusable() : NOTE.secUnset());
  else if (!/[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/.test(agent)) notes.push(NOTE.secNoEmail());
  return { config: { ...config, cacheDir: cacheDirOf(env, paths) }, notes };
}

/**
 * The "data" settings in the credentials file at `path`, by variable name, each as read; the object's own
 * problems (not an object, a name this app does not read) in `notes`.
 */
async function storedData(path: string, notes: string[]): Promise<Map<string, NonNullable<Read>>> {
  const found = new Map<string, NonNullable<Read>>();
  let text: string | undefined;
  try {
    text = await readPrivate(path);
  } catch {
    return found;
  }
  if (text === undefined) return found;
  const json = parseJson(text);
  if (!isRecord(json) || json.data === undefined) return found;
  if (!isRecord(json.data)) {
    notes.push(NOTE.dataNotObject(path));
    return found;
  }
  const known = new Set<string>(Object.values(PUBLIC_DATA_VARS));
  for (const [name, value] of Object.entries(json.data)) {
    if (!known.has(name)) {
      notes.push(NOTE.unknown(path, name));
      continue;
    }
    // An empty value stored is one that cannot be used, not one left unset.
    found.set(name, readValue(name, value) ?? { why: "is empty" });
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
 * cache directory is not one. data.go.kr hands out its key in two spellings, "Encoding" (with percent escapes)
 * and "Decoding": whichever is configured, both are listed. A value's URL-encoded forms are redact()'s.
 */
export function secretsOf(config: PublicDataConfig): string[] {
  return (Object.keys(PUBLIC_DATA_VARS) as Field[]).flatMap((field) => {
    const value = config[field];
    if (value === undefined) return [];
    return field === "dataGoKrKey" ? [...new Set([value, decodedOnce(value)])] : [value];
  });
}

/** `value` with its percent escapes decoded once; as it is when it holds none, or one that cannot be decoded. */
function decodedOnce(value: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
