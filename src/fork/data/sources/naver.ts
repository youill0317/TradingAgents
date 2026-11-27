// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Naver's news search (NAVER_CLIENT_ID and NAVER_CLIENT_SECRET), as the news provider reads it for searches
 * in Korean: https://openapi.naver.com/v1/search/news.json with `query`, `display` (at most 100, the most it
 * publishes), `start` (at most 1,000) and `sort=date` (newest first), the client id and secret sent in the
 * X-Naver-Client-Id and X-Naver-Client-Secret headers (never in an address, a message or a cache key).
 *
 * The documented answer is `{lastBuildDate, total, start, display, items: [{title, originallink, link,
 * description, pubDate}]}`: `title` and `description` (the publisher's snippet) mark the words searched with
 * <b> tags and write characters as HTML entities, both removed here (`plainText`); `originallink` is the
 * publisher's address and `link` Naver News's page of it (the publisher's when Naver does not carry it);
 * `pubDate` is when the article reached Naver (its publication time when Naver does not carry it), in RFC
 * 822's form ("Wed, 25 Nov 2026 16:20:00 +0900"), read as an instant (`rfc822Time`).
 *
 * A search reaches the newest NAVER_REACH articles: display 100 from start 1, 101, ... 901, then from 1,000
 * (the most `start` may be), whose first was already read (NAVER_COVERAGE). Its failures, as Naver documents
 * them (`{errorMessage, errorCode}`): a request it refuses (400: SE01 the query, SE02 display, SE03 start,
 * SE04 sort, SE06 the encoding) invalid; the client id and secret refused (401, 403) rejected; the day's
 * requests spent (429 with code 010) quota, and any other 429 (its per-second limit, 012) rate_limited; the
 * API not at its address (404, SE05) and a system error (500, SE99, asked once more) unavailable. A page is
 * kept NAVER_KEEP_MS, so the pages of a search read together, or soon after, are read once.
 */
import type { Call } from "../../../data/capabilities.js";
import { DataError, type DataErrorKind } from "../../../data/errors.js";
import type { ForkDeps } from "../deps.js";
import { type Answer, retryAfterMs, unreadable } from "../http.js";
import { decodeEntities, HTML_ENTITIES } from "../util/entities.js";

export const NAVER_SOURCE = "Naver";

export const NAVER_NEWS_API = "https://openapi.naver.com/v1/search/news.json";

/** The most articles one request gives (`display`), and the furthest `start`, as Naver publishes them. */
export const NAVER_MAX_DISPLAY = 100;
export const NAVER_MAX_START = 1000;

/** How far down its list a search reaches: from the furthest start, a page of the most it gives. */
export const NAVER_REACH = NAVER_MAX_START + NAVER_MAX_DISPLAY - 1;

/** What Naver's news search covers, said where an answer depends on it. */
export const NAVER_COVERAGE = `Naver's news search reaches the newest ${NAVER_REACH.toLocaleString("en-US")} articles of a search (start at most ${NAVER_MAX_START.toLocaleString("en-US")}, display at most ${NAVER_MAX_DISPLAY})`;

/** How long a page is kept: the pages of one search, read together or soon after, are read once. */
export const NAVER_KEEP_MS = 5 * 60_000;

/** The most of Naver's own words a message keeps. */
const MESSAGE_CHARS = 200;

/** An error code as Naver writes one: SE01-SE06 and SE99, or three digits (010, 012, 024). */
const NAVER_CODE = /^[A-Z0-9]{2,6}$/;

/** One article of Naver's list. */
export type NaverArticle = {
  /** The publisher's address (originallink), or Naver's (link) when Naver gives no other. */
  url: string;
  /** Naver News's page of the article, when it carries it. */
  naverUrl: string | null;
  title: string | null;
  /** The publisher's snippet (description). */
  summary: string | null;
  /** pubDate, epoch ms. */
  published: number;
  /** The site of `url`, without "www.". */
  site: string | null;
  /** Its place in Naver's list, from 1. */
  index: number;
};

/** One page of Naver's list: the matches it counts, where the page starts, its usable articles and how many it gave. */
export type NaverPage = { total: number; start: number; articles: NaverArticle[]; given: number };

/** The address of one page of a search, newest first. */
export function naverNewsUrl(query: string, start: number): string {
  const params = new URLSearchParams({
    query,
    display: String(NAVER_MAX_DISPLAY),
    start: String(start),
    sort: "date",
  });
  return `${NAVER_NEWS_API}?${params}`;
}

/** The page of the search `query` from `start`, kept NAVER_KEEP_MS. */
export async function naverNewsPage(
  deps: ForkDeps,
  query: string,
  start: number,
  call?: Call,
): Promise<NaverPage> {
  const signal = call?.signal;
  return deps.cache.remember(
    `naver:news:${start}:${query}`,
    NAVER_KEEP_MS,
    async () => {
      const answer = await deps.http.get(naverNewsUrl(query, start), {
        source: NAVER_SOURCE,
        signal,
        headers: {
          Accept: "application/json",
          "X-Naver-Client-Id": deps.config.naverClientId ?? "",
          "X-Naver-Client-Secret": deps.config.naverClientSecret ?? "",
        },
        // Naver says why in its body: read it.
        accept: [400, 401, 403, 404, 429],
        // The client id and secret are in the headers: a redirect elsewhere is not followed.
        redirect: "same-origin",
      });
      const text = await answer.text();
      if (answer.status >= 400) throw failure(deps, answer, text);
      return parseNaverNews(text, start);
    },
    { signal },
  );
}

/**
 * Naver's failure, as its status and error code call for, in its own words: every configured secret removed
 * before they are cut to length, and an error code quoted only as Naver writes its codes (SE01, 010).
 */
function failure(deps: ForkDeps, answer: Answer, text: string): DataError {
  const { status } = answer;
  let said = "";
  let code = "";
  try {
    const body = JSON.parse(text) as { errorMessage?: unknown; errorCode?: unknown } | null;
    if (typeof body?.errorMessage === "string") said = clip(deps.http.redact(body.errorMessage));
    const written =
      typeof body?.errorCode === "string" || typeof body?.errorCode === "number"
        ? String(body.errorCode).trim()
        : "";
    if (NAVER_CODE.test(written)) code = written;
  } catch {
    // Not Naver's error JSON: the status says what it is.
  }
  const detail = `HTTP ${status}${code ? `, ${code}` : ""}${said ? `: ${said}` : ""}`;
  const fail = (kind: DataErrorKind, text: string, more: { retryAfterMs?: number } = {}) =>
    new DataError(kind, deps.http.redact(text), {
      source: NAVER_SOURCE,
      status,
      ...(code ? { code } : {}),
      ...more,
      ...(kind === "invalid" ? { retry: "change_request" as const } : {}),
    });
  if (status === 400) return fail("invalid", `Naver's news search refused the request (${detail})`);
  if (status === 401 || status === 403) {
    return fail(
      "rejected",
      `Naver's news search refused NAVER_CLIENT_ID and NAVER_CLIENT_SECRET (${detail})`,
    );
  }
  if (status === 429) {
    // Its daily allowance spent (code 010), or its per-second limit (012).
    const perSecond = code === "012" || /rate limit|per second|초당|속도/i.test(said);
    if (code === "010" || (!perSecond && /request limit|daily|일일|하루/i.test(said))) {
      return fail("quota", `Naver's news search allows this application no more requests today (${detail})`);
    }
    const wait = retryAfterMs(answer.headers.get("retry-after"));
    return fail("rate_limited", `Naver's news search is limiting requests (${detail})`, {
      ...(wait !== undefined ? { retryAfterMs: wait } : {}),
    });
  }
  return fail("unavailable", `Naver's news search is not at its address (${detail})`);
}

/**
 * Naver's answer read: its usable articles in its order (each with its place in the list, `start` the first's),
 * how many it gave, and the matches it counts. An answer in any other form is unavailable.
 */
export function parseNaverNews(text: string, start: number): NaverPage {
  let answer: unknown;
  try {
    answer = JSON.parse(text) as unknown;
  } catch {
    throw unreadable(NAVER_SOURCE, "its news search");
  }
  const body = answer as { total?: unknown; items?: unknown } | null;
  const total = typeof body?.total === "number" ? body.total : Number.NaN;
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray(body.items) ||
    !Number.isInteger(total) ||
    total < 0
  ) {
    throw unreadable(NAVER_SOURCE, "its news search");
  }
  const articles: NaverArticle[] = [];
  for (const [offset, item] of body.items.entries()) {
    const row = item as Record<string, unknown> | null;
    if (!row || typeof row !== "object") continue;
    const original = address(row.originallink);
    const naver = address(row.link);
    const url = original ?? naver;
    const published = typeof row.pubDate === "string" ? rfc822Time(row.pubDate) : undefined;
    if (!url || published === undefined) continue;
    articles.push({
      url,
      naverUrl: naver && naver !== url ? naver : null,
      title: typeof row.title === "string" ? plainText(row.title) || null : null,
      summary: typeof row.description === "string" ? plainText(row.description) || null : null,
      published,
      site: siteOf(url),
      index: start + offset,
    });
  }
  if (body.items.length && !articles.length) {
    throw new DataError("unavailable", "Naver answered news articles without an address or a time.", {
      source: NAVER_SOURCE,
    });
  }
  return { total, start, articles, given: body.items.length };
}

/** A web address as given, or null when it is not one. */
function address(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^https?:\/\/\S+$/i.test(text) ? text : null;
}

/** The site of an address, as a publisher is named: its host, without "www.". */
export function siteOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Naver's marked-up text as plain text: tags (its <b> around the words searched) removed, entities decoded, on one line. */
export function plainText(markup: string): string {
  const untagged = markup.replace(/<\/?[A-Za-z][^<>]*>/g, "");
  return decodeEntities(untagged, HTML_ENTITIES).replace(/\s+/g, " ").trim();
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** RFC 822's named zones, as minutes east of UTC. */
const ZONES: Readonly<Record<string, number>> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  Z: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
};

/**
 * An RFC 822 date and time ("Wed, 25 Nov 2026 16:20:00 +0900", the weekday and seconds optional, a two-digit
 * year as RFC 2822 reads it) as epoch ms; undefined when it is not one or names no time on the calendar.
 */
export function rfc822Time(text: string): number | undefined {
  const match =
    /^\s*(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2}|\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+([+-]\d{4}|[A-Za-z]{1,3})\s*$/.exec(
      text,
    );
  if (!match) return undefined;
  const [day, monthName, yearText, hour, minute, second, zone] = match.slice(1) as [
    string,
    string,
    string,
    string,
    string,
    string | undefined,
    string,
  ];
  const month = MONTHS[monthName.toLowerCase()];
  if (month === undefined) return undefined;
  let year = Number(yearText);
  if (yearText.length === 2) year += year < 50 ? 2000 : 1900;
  const [d, h, m, s] = [Number(day), Number(hour), Number(minute), Number(second ?? "0")];
  if (h > 23 || m > 59 || s > 60) return undefined;
  let offset: number | undefined;
  if (/^[+-]\d{4}$/.test(zone)) {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(3));
    if (hours > 23 || minutes > 59) return undefined;
    offset = (zone.startsWith("-") ? -1 : 1) * (hours * 60 + minutes);
  } else {
    offset = ZONES[zone.toUpperCase()];
  }
  if (offset === undefined) return undefined;
  const local = Date.UTC(year, month, d, h, m, Math.min(s, 59));
  const check = new Date(local);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== d) {
    return undefined;
  }
  return local - offset * 60_000;
}

/** Hangul (its syllables, jamo and compatibility jamo), built from code points: the formatter rewrites escapes. */
const HANGUL = new RegExp(
  `[${[
    [0x1100, 0x11ff],
    [0x3130, 0x318f],
    [0xa960, 0xa97f],
    [0xac00, 0xd7af],
    [0xd7b0, 0xd7ff],
  ]
    .map(([from, to]) => `${String.fromCharCode(from as number)}-${String.fromCharCode(to as number)}`)
    .join("")}]`,
);

/** Whether `text` holds Hangul: a search in Korean. */
export function hasHangul(text: string): boolean {
  return HANGUL.test(text);
}

/** Naver's words on one line, at most MESSAGE_CHARS long. */
function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MESSAGE_CHARS ? `${line.slice(0, MESSAGE_CHARS - 3)}...` : line;
}
