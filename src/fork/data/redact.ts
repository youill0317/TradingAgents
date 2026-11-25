// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Keeping keys out of what the fork's data code says. A key reaches a source in a query string
 * (`api_key=`, `crtfc_key=`, `serviceKey=`), in a path (ECOS: `/api/StatisticSearch/<key>/json/...`) or in
 * a header; whatever is said afterwards (an error, a note, a log line, a fixture's metadata, a cache key)
 * goes through here first. Each secret is replaced wherever it appears as written or URL-encoded (as
 * encodeURIComponent writes it and as a form query does, either case of hex); in a URL the values of the
 * query parameters that carry keys are removed too, whatever they hold.
 */
import { KEYS } from "../../contracts/limits.js";

/** What a removed secret reads as. */
export const REDACTED = "***";

/** Query parameters that carry keys at the sources the fork reads, compared without case. */
const KEY_PARAMETERS = new Set([
  "api_key",
  "apikey",
  "key",
  "crtfc_key",
  "servicekey",
  "client_secret",
  "client_id",
  "token",
  "access_token",
  "auth",
  "authkey",
  "appkey",
]);

/** Each way `secret` may be written in text or a URL, longest first. */
function spellings(secret: string): string[] {
  const encoded = encodeURIComponent(secret);
  const form = new URLSearchParams({ s: secret }).toString().slice(2);
  const lower = (text: string) => text.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());
  return [...new Set([secret, encoded, lower(encoded), form, lower(form)])].sort((a, b) => b.length - a.length);
}

/** `text` with every secret (at least KEYS.scrubMinChars long) replaced, however it is spelled. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < KEYS.scrubMinChars) continue;
    for (const spelling of spellings(secret)) out = out.replaceAll(spelling, REDACTED);
  }
  return out;
}

/** Whether `text` holds any secret, however it is spelled. */
export function holdsSecret(text: string, secrets: readonly string[]): boolean {
  return redact(text, secrets) !== text;
}

/**
 * `url` fit to show: every secret removed from it (path, query, fragment), and the value of each query
 * parameter that carries a key replaced, whatever it holds. Text that is not a URL is only redacted.
 */
export function redactUrl(url: string, secrets: readonly string[]): string {
  const scrubbed = redact(url, secrets);
  let parsed: URL;
  try {
    parsed = new URL(scrubbed);
  } catch {
    return scrubbed;
  }
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
  }
  const query = parsed.search.slice(1);
  if (!query) return parsed.toString();
  // Parameter by parameter as written, so the rest of the query keeps its spelling.
  const kept = query.split("&").map((pair) => {
    const equals = pair.indexOf("=");
    const written = (equals < 0 ? pair : pair.slice(0, equals)).replaceAll("+", " ");
    let name = written;
    try {
      name = decodeURIComponent(written);
    } catch {
      // A malformed escape: the name as written.
    }
    return KEY_PARAMETERS.has(name.toLowerCase()) && equals >= 0
      ? `${pair.slice(0, equals)}=${REDACTED}`
      : pair;
  });
  parsed.search = `?${kept.join("&")}`;
  return parsed.toString();
}
