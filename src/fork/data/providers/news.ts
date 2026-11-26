// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "News search", routes.ts key `news`: news.articles and news.article, declared in every setup (neither
 * source needs a key).
 *
 * - A listing's news (symbol) from Yahoo's search, through deps.yahoo (`search(symbol, {newsCount,
 *   quotesCount: 0})`): the latest articles Yahoo lists for the listing's Yahoo symbol, newest first, each
 *   with Yahoo's related tickers. since/until keep those published within them, Yahoo asked for more until
 *   the window is covered or it has no more; a window older than every article Yahoo lists is unsupported
 *   (Yahoo lists recent articles only). Pages go by position in that list (`yh:<n>`). A bare Korean code is
 *   asked as a KOSPI listing, then as a KOSDAQ one.
 * - Words (query), a topic, and the market's latest (neither symbol nor query) from GDELT's DOC API
 *   (sources/gdelt.ts), newest first within since/until. Pages go by time (`gd:<time>:<n>`: the articles GDELT
 *   saw before that time, and the n-th on of those seen at it), from one answer of up to 250 articles; past
 *   it, GDELT is asked for the articles seen before the oldest it gave. When GDELT gives its 250, the oldest
 *   time in its answer may be cut short, so those articles are left to the next answer, which holds them all.
 *   GDELT's article lists cover a rolling window of about three months: a search that finds nothing, and a
 *   period GDELT cannot search, say so.
 * - Each article: an id with its source's prefix (yh:<Yahoo's uuid>, gd:<a hash of the address>), its time
 *   (Yahoo's publication time; for GDELT, when GDELT first saw it), its publisher (Yahoo's; GDELT's domain),
 *   title and link. annotations.summary is null (neither source gives a snippet), impact null, sentiment null
 *   except under a tone filter, where it says its basis (GDELT's tone score).
 * - Filters no source here honours answer invalid, never silently ignored: impact, event type, a mixed tone,
 *   and words, a topic or a tone with a symbol (Yahoo's news for a listing has none of them).
 * - news.article reads an article this session listed: its metadata only (neither source gives the text),
 *   with topics, events, figures and quotations empty; an id not listed here answers no_data, saying to list
 *   news again.
 */
import { createHash } from "node:crypto";
import type { Call, DataProvider, Implementation, News } from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import type { ForkDeps } from "../deps.js";
import { parseListing } from "../listings.js";
import {
  type ArtList,
  artList,
  GDELT_COVERAGE,
  GDELT_SOURCE,
  type GdeltArticle,
  gdeltQuery,
  gdeltTime,
  parseGdeltTime,
  searchWords,
  TONES,
  type Tone,
} from "../sources/gdelt.js";
import { yahooCall } from "../sources/yahoo-call.js";

export const NEWS_SOURCE = "News search";

const YAHOO_SOURCE = "Yahoo";

/** How long Yahoo's answer to one news search is kept: calls made together, or soon after, share it. */
const YAHOO_KEEP_MS = 5 * 60_000;

type ArticlesQuery = Parameters<News["articles"]>[0];
type ArticlePage = Awaited<ReturnType<News["articles"]>>["data"];
type Article = ArticlePage["articles"][number];
type ArticleDetail = Awaited<ReturnType<News["article"]>>["data"];

/** One article as a page lists it, and as the article tool reads it later. */
type Item = { article: Article; detail: ArticleDetail };
type Paged = { items: Item[]; next: string | null };

/** The window asked for (epoch ms), both ends inclusive. */
type Window = { since?: number | undefined; until?: number | undefined };

export function newsProvider(deps: ForkDeps): DataProvider {
  // The articles this session listed, by id: what the article tool reads.
  const listed = new Map<string, ArticleDetail>();
  const news: Implementation<News> = {
    articles: async (query, call) => {
      const { items, next } = await articles(deps, query, call);
      for (const { detail } of items) {
        // A tone said when an article was listed under a tone filter stays with it.
        const sentiment =
          detail.annotations?.sentiment ?? listed.get(detail.id)?.annotations?.sentiment ?? null;
        listed.set(detail.id, { ...detail, annotations: { summary: null, sentiment, impact: null } });
      }
      return { articles: items.map((item) => item.article), next_cursor: next };
    },
    article: async (id) => {
      const found = listed.get(id.trim());
      if (!found) {
        throw new DataError(
          "no_data",
          `no article with id ${id} was listed in this session: list news again and read an id it gives`,
          { source: NEWS_SOURCE },
        );
      }
      return structuredClone(found);
    },
  };
  return { name: NEWS_SOURCE, capabilities: { news } };
}

/** A page of articles for `query`, from Yahoo for a listing, from GDELT otherwise. */
async function articles(deps: ForkDeps, query: ArticlesQuery, call: Call | undefined): Promise<Paged> {
  if (query.impact) {
    throw invalid(
      `impact ${query.impact}: neither news source here (Yahoo's news search, GDELT) rates an article's expected impact; ask without impact`,
    );
  }
  if (query.eventType) {
    throw invalid(
      `event_type ${query.eventType}: neither news source here classifies articles by the event they report; ask without event_type (a topic or words narrow the subject)`,
    );
  }
  if (query.sentiment === "mixed") {
    throw invalid(
      "sentiment mixed: GDELT's tone is one score per article, which cannot show mixed tone; ask for bearish, bullish or neutral, or without sentiment",
    );
  }
  const now = deps.clock().getTime();
  const window = windowOf(query, now);
  if (query.symbol) {
    const narrowed = [
      query.query !== undefined ? "words (query)" : "",
      query.topic ? "a topic" : "",
      query.sentiment ? "a tone (sentiment)" : "",
    ].filter(Boolean);
    if (narrowed.length) {
      throw invalid(
        `Yahoo's news for a listing (${query.symbol}) cannot be narrowed by ${narrowed.join(" or ")}; ask by symbol alone, or search GDELT's articles with the company's name in query (with a topic or sentiment)`,
      );
    }
    return listingNews(deps, query.symbol, window, query.limit, query.after, call);
  }
  return gdeltNews(deps, query, window, now, call);
}

/** since and until as instants, checked against each other and against now. */
function windowOf(query: ArticlesQuery, now: number): Window {
  const since = instantOf(query.since, "since");
  const until = instantOf(query.until, "until");
  if (since !== undefined && until !== undefined && since > until) {
    throw invalid(`since ${query.since} is after until ${query.until}`);
  }
  if (since !== undefined && since > now)
    throw invalid(`since ${query.since} is later than now (${iso(now)})`);
  return { since, until };
}

function instantOf(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw invalid(`${name} ${value} is not a date or a UTC time`);
  return ms;
}

const within = (time: number, window: Window) =>
  (window.since === undefined || time >= window.since) &&
  (window.until === undefined || time <= window.until);

/** " from <since> to <until>", as much of it as was asked. */
function between(window: Window): string {
  return `${window.since !== undefined ? ` from ${iso(window.since)}` : ""}${window.until !== undefined ? ` to ${iso(window.until)}` : ""}`;
}

// A listing's news, from Yahoo --------------------------------------------------------------------

/** One article of Yahoo's news search. */
type YahooItem = {
  id: string;
  title: string | null;
  publisher: string | null;
  url: string | null;
  /** When it was published (epoch ms). */
  time: number;
  tickers: string[];
};

async function listingNews(
  deps: ForkDeps,
  symbol: string,
  window: Window,
  limit: number,
  after: string | undefined,
  call: Call | undefined,
): Promise<Paged> {
  const skip = yahooCursor(after);
  const { label, symbols } = yahooSymbols(symbol);
  for (const [index, yahoo] of symbols.entries()) {
    let count = skip + limit + 1;
    let read: { items: YahooItem[]; answered: number };
    let inWindow: YahooItem[];
    // Yahoo's newest articles, as many as one more than the page needs, or, for a window, until it is covered.
    for (;;) {
      read = await yahooNews(deps, yahoo, count, call);
      inWindow = read.items.filter((item) => within(item.time, window));
      const exhausted = read.answered < count;
      const oldest = read.items.at(-1)?.time;
      const passed = window.since !== undefined && oldest !== undefined && oldest < window.since;
      if (inWindow.length > skip + limit || exhausted || passed) break;
      count *= 2;
    }
    // A bare Korean code Yahoo lists nothing for as a KOSPI listing is asked as a KOSDAQ one.
    if (!read.items.length && index < symbols.length - 1) continue;
    if (!inWindow.length && skip === 0) {
      if (!read.items.length) {
        throw new DataError("no_data", `its news search lists no article about ${label}`, {
          source: YAHOO_SOURCE,
        });
      }
      const oldest = read.items.at(-1)?.time as number;
      if (window.until !== undefined && oldest > window.until) {
        throw new DataError(
          "unsupported",
          `its news search lists only the latest articles about ${label}, back to ${iso(oldest)}, none up to ${iso(window.until)}`,
          { source: YAHOO_SOURCE },
        );
      }
      throw new DataError("no_data", `its news search lists no article about ${label}${between(window)}`, {
        source: YAHOO_SOURCE,
      });
    }
    return {
      items: inWindow.slice(skip, skip + limit).map(yahooArticle),
      next: inWindow.length > skip + limit ? `yh:${skip + limit}` : null,
    };
  }
  // Every symbol was asked; the last one answered or failed above.
  throw new DataError("no_data", `its news search lists no article about ${label}`, {
    source: YAHOO_SOURCE,
  });
}

/** The position a listing's cursor (`yh:<n>`) gives: 0 without one. */
function yahooCursor(after: string | undefined): number {
  if (after === undefined) return 0;
  const match = /^yh:(\d{1,6})$/.exec(after.trim());
  if (!match) {
    throw invalid(
      `after=${after} is not a cursor of a listing's news: page with the next_cursor the same request gave`,
    );
  }
  return Number(match[1]);
}

/** The Yahoo symbols a listing's news is asked under, and the key answers name it by. */
function yahooSymbols(symbol: string): { label: string; symbols: string[] } {
  const listing = parseListing(symbol);
  switch (listing.kind) {
    case "invalid":
      throw invalid(`${symbol}: ${listing.reason}`);
    case "value_series":
      throw invalid(
        `${listing.key} is an economic series, not a listing: ask news with query or topic (such as topic inflation)`,
      );
    case "price_series":
      if (!listing.yahoo)
        throw invalid(`${listing.key} is not a price series this source knows; find_instrument names them`);
      return { label: listing.key, symbols: [listing.yahoo] };
    case "venue":
      if (!listing.yahoo) {
        throw new DataError(
          "unsupported",
          `it lists no listing on ${listing.mic}, so it has no news for ${listing.key}`,
          {
            source: YAHOO_SOURCE,
          },
        );
      }
      return { label: listing.key, symbols: [listing.yahoo] };
    case "kr":
      return { label: listing.key ?? symbol, symbols: listing.yahoo };
    default:
      return { label: listing.key, symbols: [listing.yahoo] };
  }
}

/** Yahoo's latest `count` news articles for `symbol`, newest first, and how many it gave (usable or not). */
async function yahooNews(
  deps: ForkDeps,
  symbol: string,
  count: number,
  call: Call | undefined,
): Promise<{ items: YahooItem[]; answered: number }> {
  const signal = call?.signal;
  return deps.cache.remember(
    `yahoo:news:${symbol}:${count}`,
    YAHOO_KEEP_MS,
    async () => {
      // The answer is read here, item by item: one article Yahoo describes incompletely does not lose the others.
      const answer = await yahooCall(
        () =>
          deps.yahoo.search(
            symbol,
            { newsCount: count, quotesCount: 0 },
            { validateResult: false, fetchOptions: signal ? { signal } : {} },
          ),
        {
          signal,
          notFound: "unavailable",
          notFoundMessage: "Yahoo's search is not at its address (HTTP 404).",
        },
      );
      return yahooItems(answer);
    },
    { signal },
  );
}

/** Yahoo's news articles in a search answer: those with an id and a time, newest first. */
function yahooItems(answer: unknown): { items: YahooItem[]; answered: number } {
  const news = (answer as { news?: unknown } | null)?.news;
  if (!Array.isArray(news)) {
    throw new DataError("unavailable", "Yahoo answered its news search in a form this app does not read.", {
      source: YAHOO_SOURCE,
    });
  }
  const items: YahooItem[] = [];
  const ids = new Set<string>();
  for (const entry of news) {
    const row = entry as Record<string, unknown> | null;
    if (!row || typeof row !== "object") continue;
    const uuid = typeof row.uuid === "string" ? row.uuid.trim() : "";
    const time = publishedAt(row.providerPublishTime);
    if (!uuid || time === undefined) continue;
    const id = /^[A-Za-z0-9._-]{1,77}$/.test(uuid) ? `yh:${uuid}` : `yh:${hashed(uuid)}`;
    if (ids.has(id)) continue;
    ids.add(id);
    const link = field(row.link);
    items.push({
      id,
      title: field(row.title),
      publisher: field(row.publisher),
      url: link && /^https?:\/\//i.test(link) ? link : null,
      time,
      tickers: Array.isArray(row.relatedTickers)
        ? row.relatedTickers.filter((ticker): ticker is string => typeof ticker === "string" && ticker !== "")
        : [],
    });
  }
  if (news.length && !items.length) {
    throw new DataError("unavailable", "Yahoo answered news articles without an id or a time.", {
      source: YAHOO_SOURCE,
    });
  }
  items.sort((a, b) => b.time - a.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { items, answered: news.length };
}

/** Yahoo's publication time (the library's Date, or epoch seconds as Yahoo sends it) as epoch ms. */
function publishedAt(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value * 1000;
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function yahooArticle(item: YahooItem): Item {
  const at = iso(item.time);
  const article: Article = {
    id: item.id,
    title: item.title,
    publisher: item.publisher,
    url: item.url,
    published_at: at,
    annotations: { summary: null, sentiment: null, impact: null },
  };
  return {
    article,
    detail: detailOf(article, { time_kind: "published", instruments: item.tickers }),
  };
}

// Words, topics and the market's latest, from GDELT -----------------------------------------------------------

/** A position in GDELT's newest-first list: the articles seen before `at`, and those seen at it from the `rank`-th on. */
type Position = { at: number; rank: number };

/** An article of an answer with its rank among those seen at the same time (0 for the first). */
type Ranked = GdeltArticle & { rank: number };

async function gdeltNews(
  deps: ForkDeps,
  query: ArticlesQuery,
  window: Window,
  now: number,
  call: Call | undefined,
): Promise<Paged> {
  let position = gdeltCursor(query.after);
  const words = query.query !== undefined ? searchWords(query.query) : undefined;
  if (query.query !== undefined && !words) throw invalid(`query "${query.query}" has no words to search for`);
  const tone = query.sentiment as Tone | undefined;
  const search = gdeltQuery({
    ...(words ? { words } : {}),
    ...(query.topic ? { topic: query.topic } : {}),
    ...(tone ? { tone } : {}),
  });
  // An end at or after now asks for the latest, as an open window does (and shares its answer).
  const range = {
    start: window.since,
    end: window.until !== undefined && window.until < now ? window.until : undefined,
  };
  const sentiment = tone ? TONES[tone].basis : null;
  for (;;) {
    const found = await gdeltPage(deps, search, range, position, query.limit, call);
    const { page } = found;
    // A position that does not move on (GDELT answering an earlier window as a later one) ends the list.
    const next = found.next && progressed(position, found.next) ? found.next : null;
    const shown = page.filter((article) => within(article.seen, window));
    // A page left empty (by an answer's cut-short end) goes on to the next one rather than answer nothing.
    if (!shown.length && next) {
      position = next;
      continue;
    }
    if (!shown.length && !query.after) {
      throw new DataError(
        "no_data",
        `no article matching ${described(query)}${between(window)}; ${GDELT_COVERAGE}`,
        { source: GDELT_SOURCE },
      );
    }
    return {
      items: shown.map((article) => gdeltArticle(article, sentiment)),
      next: next ? `gd:${gdeltTime(next.at)}:${next.rank}` : null,
    };
  }
}

/** What was searched for, as a message says it. */
function described(query: ArticlesQuery): string {
  const parts = [
    query.query !== undefined ? `"${query.query}"` : "",
    query.topic ? `topic ${query.topic}` : "",
    query.query === undefined && !query.topic ? "the stock market (the market's latest)" : "",
    query.sentiment && query.sentiment !== "mixed" ? TONES[query.sentiment].basis : "",
  ].filter(Boolean);
  return parts.join(", ");
}

/**
 * The page after `position` (from the top without one): from the answer for the window, or, for a position
 * it does not hold, the answer for the articles GDELT saw up to the position's time.
 */
async function gdeltPage(
  deps: ForkDeps,
  search: string,
  range: { start: number | undefined; end: number | undefined },
  position: Position | undefined,
  limit: number,
  call: Call | undefined,
): Promise<{ page: Ranked[]; next: Position | null }> {
  let answer = await artList(deps, { query: search, ...range }, call);
  if (position && !holds(answer, position.at)) {
    if (range.start !== undefined && position.at < range.start) return { page: [], next: null };
    // GDELT's end is asked a second past the position, so every article seen at its time is in the answer.
    answer = await artList(deps, { query: search, start: range.start, end: position.at + 1000 }, call);
  }
  // What comes after the position: articles seen later than its time were on the pages before it.
  const from: ArtList = position
    ? { full: answer.full, articles: answer.articles.filter((article) => article.seen <= position.at) }
    : answer;
  const list = ranked(usable(from));
  const after = position
    ? list.filter(
        (article) =>
          article.seen < position.at || (article.seen === position.at && article.rank >= position.rank),
      )
    : list;
  const page = after.slice(0, limit);
  let next: Position | null = null;
  const last = page.at(-1);
  if (after.length > limit && last) next = { at: last.seen, rank: last.rank + 1 };
  else if (from.full && from.articles.length) {
    const oldest = (from.articles.at(-1) as GdeltArticle).seen;
    // The oldest time left out of this answer starts the next; an answer all of one time is passed whole.
    next = list.length < from.articles.length ? { at: oldest, rank: 0 } : { at: oldest - 1000, rank: 0 };
    if (range.start !== undefined && next.at < range.start) next = null;
  }
  return { page, next };
}

/** Whether `to` comes after `from` in GDELT's newest-first list (any position comes after none). */
function progressed(from: Position | undefined, to: Position): boolean {
  return !from || to.at < from.at || (to.at === from.at && to.rank > from.rank);
}

/**
 * The articles of an answer a page may show: all of them, unless GDELT gave as many as it gives, when those
 * of its oldest time may be only some of them and are left to the next answer (all of an answer of one time
 * are kept: there is no older time to leave them to).
 */
function usable(answer: ArtList): GdeltArticle[] {
  const { articles } = answer;
  const oldest = articles.at(-1)?.seen;
  if (!answer.full || oldest === undefined || articles[0]?.seen === oldest) return articles;
  return articles.filter((article) => article.seen > oldest);
}

/** Whether an answer holds every article after a position at time `at`. */
function holds(answer: ArtList, at: number): boolean {
  const oldest = answer.articles.at(-1)?.seen;
  if (!answer.full || oldest === undefined) return true;
  return at > oldest || (answer.articles[0]?.seen === oldest && at === oldest);
}

function ranked(articles: readonly GdeltArticle[]): Ranked[] {
  let time = Number.NaN;
  let rank = 0;
  return articles.map((article) => {
    rank = article.seen === time ? rank + 1 : 0;
    time = article.seen;
    return { ...article, rank };
  });
}

/** The position a GDELT cursor (`gd:<YYYYMMDDHHMMSS>:<n>`) gives; undefined without one. */
function gdeltCursor(after: string | undefined): Position | undefined {
  if (after === undefined) return undefined;
  const match = /^gd:(\d{14}):(\d{1,6})$/.exec(after.trim());
  const at = match ? parseGdeltTime(match[1] as string) : undefined;
  if (!match || at === undefined) {
    throw invalid(
      `after=${after} is not a cursor of GDELT's article search: page with the next_cursor the same request gave`,
    );
  }
  return { at, rank: Number(match[2]) };
}

function gdeltArticle(article: GdeltArticle, sentiment: string | null): Item {
  const listed: Article = {
    id: `gd:${hashed(article.url)}`,
    title: article.title,
    publisher: article.domain,
    url: article.url,
    published_at: iso(article.seen),
    annotations: { summary: null, sentiment, impact: null },
  };
  return { article: listed, detail: detailOf(listed, { time_kind: "seen", instruments: [] }) };
}

// Shared -----------------------------------------------------------------------------------------------------------

/** An article as the article tool reads it: what was listed, with no text, topics, events, figures or quotations. */
function detailOf(article: Article, more: { time_kind: string; instruments: string[] }): ArticleDetail {
  return {
    id: article.id,
    title: article.title,
    publisher: article.publisher ?? null,
    url: article.url ?? null,
    published_at: article.published_at ?? null,
    available_at: article.published_at ?? null,
    time_kind: more.time_kind,
    word_count: null,
    annotations: { summary: null, sentiment: article.annotations?.sentiment ?? null, impact: null },
    topics: [],
    instruments: [...more.instruments],
    events: [],
    figures: [],
    quotations: [],
  };
}

function invalid(detail: string): DataError {
  return new DataError("invalid", detail, { source: NEWS_SOURCE, retry: "change_request" });
}

/** An instant as answers write it: UTC, to the second. */
function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A short, stable id for a text (an address): 16 characters of its SHA-256, URL-safe. */
function hashed(text: string): string {
  return createHash("sha256").update(text).digest("base64url").slice(0, 16);
}

/** A text field on one line, or null when it is empty or not text. */
function field(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/\s+/g, " ").trim();
  return line || null;
}
