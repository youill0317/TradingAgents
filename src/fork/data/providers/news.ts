// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "News search", routes.ts key `news`: news.articles and news.article, declared in every setup (Yahoo and
 * GDELT need no key; Naver's news search is asked only with NAVER_CLIENT_ID and NAVER_CLIENT_SECRET).
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
 * - Words in Korean (a query holding Hangul), with NAVER_CLIENT_ID and NAVER_CLIENT_SECRET set: from Naver's
 *   news search (sources/naver.ts, newest first) and GDELT, asked as for any words, together: one list,
 *   newest first, each article once (an address both list is shown as its newer listing, the other passed
 *   over), its publisher followed by the source that listed it ("(via Naver)", "(via GDELT)"). Pages go by
 *   each source's own place (`ng:<Naver's>:<GDELT's>`, each a time and a rank among the articles of that
 *   time, `-` before the first, `x` past the last, `f` left after it failed). Naver's list reaches its newest
 *   NAVER_REACH articles
 *   and no window of its own: articles outside since/until are passed over, and a window past its reach is
 *   said with its reach (NAVER_COVERAGE). A source that fails leaves the list to the other for the rest
 *   of the search; both failing, or one failing with the other finding nothing, is the failure. A topic or a
 *   tone cannot narrow Naver's search: invalid. Without the Naver settings, words in Korean go to GDELT
 *   alone, as any words do.
 * - Each article: an id with its source's prefix (yh:<Yahoo's uuid>, gd:<a hash of the address>, nv:<a hash
 *   of the publisher's address>), its time (Yahoo's publication time; for GDELT, when GDELT first saw it;
 *   Naver's pubDate, when it reached Naver), its publisher (Yahoo's; GDELT's domain; for Naver, the site of
 *   the publisher's address), title and link (Naver's: the publisher's). annotations.summary is Naver's
 *   snippet of the article, null for Yahoo and GDELT (neither gives one), impact null, sentiment null except
 *   under a tone filter, where it says its basis (GDELT's tone score).
 * - Filters no source here honours answer invalid, never silently ignored: impact, event type, a mixed tone,
 *   and words, a topic or a tone with a symbol (Yahoo's news for a listing has none of them).
 * - news.article reads an article this session listed: its metadata only (no source here gives the text),
 *   with topics, events, figures and quotations empty; an id not listed here answers no_data, saying to list
 *   news again.
 */
import { createHash } from "node:crypto";
import { message } from "../../../contracts/index.js";
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
import {
  hasHangul,
  NAVER_COVERAGE,
  NAVER_MAX_DISPLAY,
  NAVER_MAX_START,
  NAVER_SOURCE as NAVER_SOURCE_NAME,
  type NaverArticle,
  naverNewsPage,
} from "../sources/naver.js";
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
  // Naver's news search answers words in Korean when both of its settings are given.
  const naver = Boolean(deps.config.naverClientId && deps.config.naverClientSecret);
  const news: Implementation<News> = {
    articles: async (query, call) => {
      const { items, next } = await articles(deps, query, call, naver);
      for (const { detail } of items) {
        // A tone said when an article was listed under a tone filter stays with it.
        const sentiment =
          detail.annotations?.sentiment ?? listed.get(detail.id)?.annotations?.sentiment ?? null;
        const summary = detail.annotations?.summary ?? null;
        listed.set(detail.id, { ...detail, annotations: { summary, sentiment, impact: null } });
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

/**
 * A page of articles for `query`: from Yahoo for a listing; from Naver's news search and GDELT together for
 * words in Korean when Naver's settings are given (`naver`); from GDELT otherwise.
 */
async function articles(
  deps: ForkDeps,
  query: ArticlesQuery,
  call: Call | undefined,
  naver: boolean,
): Promise<Paged> {
  if (query.impact) {
    throw invalid(
      naver
        ? `impact ${query.impact}: no news source here (Yahoo's news search, GDELT, Naver's news search) rates an article's expected impact; ask without impact`
        : `impact ${query.impact}: neither news source here (Yahoo's news search, GDELT) rates an article's expected impact; ask without impact`,
    );
  }
  if (query.eventType) {
    throw invalid(
      naver
        ? `event_type ${query.eventType}: no news source here classifies articles by the event they report; ask without event_type (a topic or words narrow the subject)`
        : `event_type ${query.eventType}: neither news source here classifies articles by the event they report; ask without event_type (a topic or words narrow the subject)`,
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
  if (naver && query.query !== undefined && hasHangul(query.query)) {
    return koreanNews(deps, query as ArticlesQuery & { query: string }, window, now, call);
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
  const range = gdeltRange(window, now);
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

/** The window GDELT is asked for: an end at or after now asks for the latest, as an open window does (and shares its answer). */
function gdeltRange(window: Window, now: number): { start: number | undefined; end: number | undefined } {
  return {
    start: window.since,
    end: window.until !== undefined && window.until < now ? window.until : undefined,
  };
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
 * it does not hold, the answer for the articles GDELT saw up to the position's time. `newer` holds the
 * articles of the answers read that come before the position (those of the pages before it).
 */
async function gdeltPage(
  deps: ForkDeps,
  search: string,
  range: { start: number | undefined; end: number | undefined },
  position: Position | undefined,
  limit: number,
  call: Call | undefined,
): Promise<{ page: Ranked[]; next: Position | null; newer: GdeltArticle[] }> {
  const top = await artList(deps, { query: search, ...range }, call);
  let answer = top;
  const earlier = position ? top.articles.filter((article) => article.seen > position.at) : [];
  if (position && !holds(answer, position.at)) {
    if (range.start !== undefined && position.at < range.start)
      return { page: [], next: null, newer: earlier };
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
  const newer = position
    ? [...earlier, ...list.filter((article) => article.seen === position.at && article.rank < position.rank)]
    : [];
  return { page, next, newer };
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

function gdeltArticle(article: GdeltArticle, sentiment: string | null, via = ""): Item {
  const listed: Article = {
    id: `gd:${hashed(article.url)}`,
    title: article.title,
    publisher: via ? `${article.domain ?? "a site it does not name"}${via}` : article.domain,
    url: article.url,
    published_at: iso(article.seen),
    annotations: { summary: null, sentiment, impact: null },
  };
  return { article: listed, detail: detailOf(listed, { time_kind: "seen", instruments: [] }) };
}

// Words in Korean, from Naver's news search and GDELT together ------------------------------------------------------

/**
 * A source's place in its newest-first list: a position, before its first article, past its last (every article
 * of it gone through), or left for the rest of the search after it failed.
 */
type Place = Position | "start" | "end" | "failed";

/** Where a search in Korean goes on: each source's own place. */
type Places = { naver: Place; gdelt: Place };

/** An article of Naver's list with its rank among the articles of its time. */
type NaverRanked = NaverArticle & { rank: number };

/**
 * What one source gave for a page: its articles after its place, the addresses of those before it (gone
 * through on earlier pages), and whether more follow those given.
 */
type Slice<T> = { items: T[]; newer: Set<string>; more: boolean };

/** Naver's part of a page: also whether it stopped at the furthest start with articles left, and the oldest time read. */
type NaverSlice = Slice<NaverRanked> & { reached: boolean; oldest: number | undefined };

/** GDELT's part of a page: also the place after its page. */
type GdeltSlice = Slice<Ranked> & { next: Position | null };

async function koreanNews(
  deps: ForkDeps,
  query: ArticlesQuery & { query: string },
  window: Window,
  now: number,
  call: Call | undefined,
): Promise<Paged> {
  const narrowed = [query.topic ? "a topic" : "", query.sentiment ? "a tone (sentiment)" : ""].filter(
    Boolean,
  );
  if (narrowed.length) {
    throw invalid(
      `words in Korean ("${query.query}") are searched in Naver's news search and GDELT together, and Naver's search cannot be narrowed by ${narrowed.join(" or ")}; ask without ${narrowed.length > 1 ? "them" : "it"}, with the subject's words in query`,
    );
  }
  let places = mergedCursor(query.after);
  const words = query.query.trim();
  const gdeltWords = searchWords(query.query);
  const search = gdeltQuery({ words: gdeltWords });
  const range = gdeltRange(window, now);
  const limit = query.limit;
  // A source's failure, kept through the pages this call goes on to: the call's when nothing is found.
  let failure: unknown;
  for (;;) {
    const asked = places;
    const [naverSide, gdeltSide] = await Promise.allSettled([
      asked.naver === "failed"
        ? Promise.resolve(undefined)
        : naverSlice(deps, words, window, asked.naver, limit, call),
      asked.gdelt === "failed" || !gdeltWords
        ? Promise.resolve(undefined)
        : gdeltSlice(deps, search, range, window, asked.gdelt, limit, call),
    ]);
    if (call?.signal?.aborted) throw call.signal.reason;
    // A source gone through to its end is read again only for the addresses it listed: its failure then loses nothing.
    const naverFailed = naverSide.status === "rejected" && asked.naver !== "end";
    const gdeltFailed = gdeltSide.status === "rejected" && asked.gdelt !== "end";
    if (naverFailed && gdeltFailed) throw bothFailed(naverSide.reason, gdeltSide.reason);
    if (failure === undefined && naverFailed) failure = naverSide.reason;
    if (failure === undefined && gdeltFailed) failure = gdeltSide.reason;
    const naver = naverSide.status === "fulfilled" ? naverSide.value : undefined;
    const gdelt = gdeltSide.status === "fulfilled" ? gdeltSide.value : undefined;
    const naverItems = naver?.items ?? [];
    const gdeltItems = gdelt?.items ?? [];
    const naverMore = naver?.more ?? false;
    const gdeltMore = (gdelt?.next ?? null) !== null;
    // One list, newest first (Naver's first at the same time); each address once, as its newer listing.
    const shown = new Set<string>();
    const taken: Item[] = [];
    let n = 0;
    let g = 0;
    while (taken.length < limit) {
      const fromNaver = naverItems[n];
      const fromGdelt = gdeltItems[g];
      // A source with articles past those read could have one newer than the other's next: the page ends here.
      if ((!fromNaver && naverMore) || (!fromGdelt && gdeltMore) || (!fromNaver && !fromGdelt)) break;
      const takeNaver =
        fromNaver !== undefined && (fromGdelt === undefined || fromNaver.published >= fromGdelt.seen);
      if (takeNaver) {
        n++;
        const key = articleKey(fromNaver.url);
        if (shown.has(key) || gdelt?.newer.has(key)) continue;
        shown.add(key);
        taken.push(naverItem(fromNaver));
      } else {
        const article = fromGdelt as Ranked;
        g++;
        const key = articleKey(article.url);
        if (shown.has(key) || naver?.newer.has(key) || !within(article.seen, window)) continue;
        shown.add(key);
        taken.push(gdeltArticle(article, null, " (via GDELT)"));
      }
    }
    // Each source goes on past the last of its articles gone through; one that failed is left for the rest of
    // the search, and GDELT's page gone through whole goes on where GDELT's paging says.
    places = {
      naver: naverFailed
        ? "failed"
        : naver === undefined
          ? asked.naver
          : placeAfter(asked.naver, naverItems, n, naverMore, (item) => ({
              at: item.published,
              rank: item.rank + 1,
            })),
      gdelt: gdeltFailed
        ? "failed"
        : gdelt === undefined
          ? asked.gdelt === "failed"
            ? "failed"
            : "end"
          : g === gdeltItems.length
            ? asked.gdelt === "end"
              ? "end"
              : (gdelt.next ?? "end")
            : placeAfter(asked.gdelt, gdeltItems, g, gdeltMore, (item) => ({
                at: item.seen,
                rank: item.rank + 1,
              })),
    };
    const done = (place: Place) => place === "end" || place === "failed";
    const next = done(places.naver) && done(places.gdelt) ? null : places;
    const moved =
      next !== null && (!samePlace(next.naver, asked.naver) || !samePlace(next.gdelt, asked.gdelt));
    // A page left empty (every article passed over) goes on to the next one rather than answer nothing.
    if (!taken.length && next && moved) continue;
    if (!taken.length && !query.after) {
      // A source's failure is not an answer about the news: it is the call's when the other found nothing.
      if (failure !== undefined) throw failure;
      if (
        naver?.reached &&
        naver.oldest !== undefined &&
        window.until !== undefined &&
        naver.oldest > window.until
      ) {
        throw new DataError(
          "unsupported",
          `${NAVER_COVERAGE}: those of "${query.query}" go back to ${iso(naver.oldest)}, none up to ${iso(window.until)}, and GDELT lists none${between(window)}; ${GDELT_COVERAGE}`,
          { source: NEWS_SOURCE },
        );
      }
      throw new DataError(
        "no_data",
        `no article matching "${query.query}"${between(window)} in Naver's news search or GDELT; ${NAVER_COVERAGE}; ${GDELT_COVERAGE}`,
        { source: NEWS_SOURCE },
      );
    }
    return { items: taken, next: next && moved ? mergedText(next) : null };
  }
}

/** Whether two places are the same. */
function samePlace(a: Place, b: Place): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.at === b.at && a.rank === b.rank;
}

/**
 * A source's place after a page: past the last of its articles the page went through (taken or passed over),
 * where it was when it went through none, and past its end when nothing of it is left.
 */
function placeAfter<T>(
  place: Place,
  items: readonly T[],
  through: number,
  more: boolean,
  after: (item: T) => Position,
): Place {
  if (through === items.length && !more) return "end";
  if (through === 0) return place;
  return after(items[through - 1] as T);
}

/**
 * The failure of a search both sources failed: each said as the router says a source's failure, the kind of
 * the one that says most about the request.
 */
function bothFailed(naver: unknown, gdelt: unknown): unknown {
  if (!(naver instanceof DataError)) return naver;
  if (!(gdelt instanceof DataError)) return gdelt;
  const order = [
    "invalid",
    "quota",
    "rate_limited",
    "rejected",
    "not_configured",
    "unsupported",
    "unavailable",
  ];
  const rank = (error: DataError) => {
    const found = order.indexOf(error.kind);
    return found < 0 ? order.length : found;
  };
  const lead = rank(gdelt) < rank(naver) ? gdelt : naver;
  const said = [naver, gdelt]
    .map((error) =>
      message("data.attempt", { source: error.details.source, outcome: error.kind, detail: error.message }),
    )
    .join("; ");
  return new DataError(lead.kind, said, {
    ...lead.details,
    source: `${NAVER_SOURCE_NAME} and ${GDELT_SOURCE}`,
    code: "every_source_failed",
  });
}

/**
 * Naver's articles of the search `words` in the window after `place`, newest first: its pages read from the
 * top (kept a while, so a later page reads them again without a request) until the articles after the place
 * are more than a page, its list ends, an article older than the window is reached, or the furthest start
 * is read. Articles of one address are listed once, as their newest; `newer` holds the addresses of those
 * before the place (all of them, past its end).
 */
async function naverSlice(
  deps: ForkDeps,
  words: string,
  window: Window,
  place: Position | "start" | "end",
  limit: number,
  call: Call | undefined,
): Promise<NaverSlice> {
  const read: NaverArticle[] = [];
  const indexes = new Set<number>();
  let start = 1;
  let ended = false;
  let reached = false;
  for (;;) {
    const page = await naverNewsPage(deps, words, start, call);
    for (const article of page.articles) {
      if (indexes.has(article.index)) continue;
      indexes.add(article.index);
      read.push(article);
    }
    const listed = rankedNaver(read, window);
    const isAfter = (article: NaverRanked) =>
      place === "start" ? true : place === "end" ? false : follows(article, place);
    const after = listed.filter(isAfter);
    const oldest = read.reduce<number | undefined>(
      (min, article) => (min === undefined || article.published < min ? article.published : min),
      undefined,
    );
    if (page.given < NAVER_MAX_DISPLAY || start + page.given - 1 >= page.total) ended = true;
    else if (window.since !== undefined && oldest !== undefined && oldest < window.since) ended = true;
    else if (start >= NAVER_MAX_START) reached = true;
    if (ended || reached || after.length > limit) {
      return {
        items: after,
        newer: new Set(
          listed.filter((article) => !isAfter(article)).map((article) => articleKey(article.url)),
        ),
        more: !ended && !reached,
        reached,
        oldest,
      };
    }
    // The next page, or the furthest start Naver takes, whose first article was the last of this one.
    start = Math.min(start + NAVER_MAX_DISPLAY, NAVER_MAX_START);
  }
}

/** Whether an article comes after `place` in its newest-first list. */
function follows(article: { published: number; rank: number }, place: Position): boolean {
  return article.published < place.at || (article.published === place.at && article.rank >= place.rank);
}

/**
 * Naver's articles in the window, newest first (in Naver's order within a time), each address once (its
 * newest listing), ranked among the articles of their time.
 */
function rankedNaver(read: readonly NaverArticle[], window: Window): NaverRanked[] {
  const seen = new Set<string>();
  const sorted = [...read].sort((a, b) => b.published - a.published || a.index - b.index);
  const kept = sorted.filter((article) => {
    const key = articleKey(article.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return within(article.published, window);
  });
  let time = Number.NaN;
  let rank = 0;
  return kept.map((article) => {
    rank = article.published === time ? rank + 1 : 0;
    time = article.published;
    return { ...article, rank };
  });
}

/**
 * GDELT's articles of the search after `place` (a page of them), as the GDELT search pages them; past its end,
 * none, with the addresses of every article of its answer for the window.
 */
async function gdeltSlice(
  deps: ForkDeps,
  search: string,
  range: { start: number | undefined; end: number | undefined },
  window: Window,
  place: Position | "start" | "end",
  limit: number,
  call: Call | undefined,
): Promise<GdeltSlice> {
  const keys = (articles: readonly GdeltArticle[]) =>
    new Set(
      articles.filter((article) => within(article.seen, window)).map((article) => articleKey(article.url)),
    );
  if (place === "end") {
    const answer = await artList(deps, { query: search, ...range }, call);
    return { items: [], newer: keys(answer.articles), more: false, next: null };
  }
  const from = place === "start" ? undefined : place;
  const found = await gdeltPage(deps, search, range, from, limit, call);
  // A place that does not move on (GDELT answering an earlier window as a later one) ends the list.
  const next = found.next && progressed(from, found.next) ? found.next : null;
  return { items: found.page, newer: keys(found.newer), more: next !== null, next };
}

/** One article of Naver's, as a page lists it: its publisher's site, then the source that listed it. */
function naverItem(article: NaverArticle): Item {
  const listed: Article = {
    id: `nv:${hashed(article.url)}`,
    title: article.title,
    publisher: `${article.site ?? "a site it does not name"} (via Naver)`,
    url: article.url,
    published_at: iso(article.published),
    annotations: { summary: article.summary, sentiment: null, impact: null },
  };
  return { article: listed, detail: detailOf(listed, { time_kind: "published", instruments: [] }) };
}

/** An article's address as both sources may write it: without its scheme, "www.", fragment or a closing slash. */
function articleKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "");
    return `${host}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  } catch {
    return url.trim();
  }
}

/** The places a cursor of a search in Korean (`ng:<Naver's>:<GDELT's>`) gives; both sources' starts without one. */
function mergedCursor(after: string | undefined): Places {
  if (after === undefined) return { naver: "start", gdelt: "start" };
  const match = /^ng:(-|x|f|\d{14}\.\d{1,6}):(-|x|f|\d{14}\.\d{1,6})$/.exec(after.trim());
  const naver = match ? placeOf(match[1] as string) : undefined;
  const gdelt = match ? placeOf(match[2] as string) : undefined;
  const open = (place: Place | undefined) => place !== undefined && place !== "end" && place !== "failed";
  if (!naver || !gdelt || !(open(naver) || open(gdelt))) {
    throw invalid(
      `after=${after} is not a cursor of a search in Korean (Naver's news search and GDELT): page with the next_cursor the same request gave`,
    );
  }
  return { naver, gdelt };
}

function placeOf(text: string): Place | undefined {
  if (text === "-") return "start";
  if (text === "x") return "end";
  if (text === "f") return "failed";
  const [time, rank] = text.split(".") as [string, string];
  const at = parseGdeltTime(time);
  return at === undefined ? undefined : { at, rank: Number(rank) };
}

/** A cursor of a search in Korean: each source's place (`-` its start, `x` past its end, `f` left after failing). */
function mergedText(places: Places): string {
  const text = (place: Place) =>
    place === "start"
      ? "-"
      : place === "end"
        ? "x"
        : place === "failed"
          ? "f"
          : `${gdeltTime(place.at)}.${place.rank}`;
  return `ng:${text(places.naver)}:${text(places.gdelt)}`;
}

// Shared -----------------------------------------------------------------------------------------------------------

/** An article as the article tool reads it: what was listed (Naver's snippet too), with no text, topics, events, figures or quotations. */
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
    annotations: {
      summary: article.annotations?.summary ?? null,
      sentiment: article.annotations?.sentiment ?? null,
      impact: null,
    },
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
