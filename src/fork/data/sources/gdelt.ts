// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * GDELT's DOC 2.0 API (no key), as the news provider reads it: its article list (`mode=artlist`,
 * `format=json`), newest first (`sort=datedesc`), as many articles a request as GDELT gives (`maxrecords`, at
 * most GDELT_MAX_RECORDS), within `startdatetime` and `enddatetime` (UTC, YYYYMMDDHHMMSS) when asked.
 *
 * The documented answer is `{"articles": [{url, url_mobile, title, seendate, socialimage, domain, language,
 * sourcecountry}, ...]}`: `seendate` is when GDELT first saw the article (`20261125T141500Z`), `domain` the
 * publisher's site; nothing matching is `{}`. A search GDELT refuses (a keyword too short or too common, OR'd
 * terms without parentheses, a request sooner than its pace allows) is answered in plain text, not JSON. Its
 * JSON sometimes carries a raw control character or a stray backslash in a title: such an answer is mended
 * and read again. Its article lists cover a rolling window of about three months (GDELT_COVERAGE).
 *
 * GDELT's published pace, one request every 5 seconds, is kept by http.ts (HOST_RULES), which also has
 * identical requests in flight share one answer, and fails a request whose turn would come after its deadline
 * as rate_limited. An answer is kept for GDELT_KEEP_MS (GDELT updates its index every 15 minutes), so a search
 * asked again within that time is answered without a request.
 *
 * How the news filters are put to GDELT: the caller's words as written, cleaned of punctuation GDELT does not
 * read; a topic as words (TOPIC_WORDS); the market's latest, asked with neither words nor a topic, as words
 * about the stock market (MARKET_WORDS); a search made only of these words of the app's own is limited to
 * English-language sources (`sourcelang:english`). A tone is one of GDELT's tone operators (TONES): bearish
 * `tone<-5` and bullish `tone>5`, GDELT's own examples of fairly negative and fairly positive coverage, and
 * neutral between them (`toneabs<5`); the basis is said with each article.
 */
import type { Call, NEWS_TOPICS } from "../../../data/capabilities.js";
import { DataError } from "../../../data/errors.js";
import type { ForkDeps } from "../deps.js";
import type { Answer } from "../http.js";

export const GDELT_SOURCE = "GDELT";

export const GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc";

/** The most articles GDELT gives for one request (its documented maximum of `maxrecords`). */
export const GDELT_MAX_RECORDS = 250;

/** How long an answer is kept: GDELT updates its index every 15 minutes. */
export const GDELT_KEEP_MS = 15 * 60_000;

/** What GDELT's article lists cover, said where an answer depends on it. */
export const GDELT_COVERAGE = "GDELT's article lists cover a rolling window of about three months";

/** The most of GDELT's own words a message keeps. */
const MESSAGE_CHARS = 200;

export type NewsTopic = (typeof NEWS_TOPICS)[number];
export type Tone = "bearish" | "bullish" | "neutral";

/** Each news topic as GDELT is asked for it: words, OR'd, phrases quoted, no word under three letters. */
export const TOPIC_WORDS: { readonly [Topic in NewsTopic]: string } = {
  earnings: '(earnings OR "quarterly results" OR "quarterly profit")',
  revenue: '(revenue OR "quarterly sales")',
  guidance: '(guidance OR "profit forecast" OR "sales forecast" OR "earnings outlook")',
  ipo: '(IPO OR "initial public offering")',
  merger: '(merger OR mergers OR "merger talks")',
  acquisition: "(acquisition OR acquires OR takeover)",
  regulation: "(regulation OR regulator OR regulators OR regulatory)",
  lawsuit: '(lawsuit OR litigation OR "class action" OR sued)',
  product_launch: '("product launch" OR launches OR unveils)',
  partnership: '(partnership OR "joint venture" OR "strategic alliance")',
  supply_chain: '("supply chain" OR "supply chains" OR shortages)',
  layoffs: '(layoffs OR "job cuts" OR redundancies)',
  executive: '("chief executive" OR CEO OR CFO OR "steps down" OR resigns)',
  dividend: "(dividend OR dividends)",
  buyback: '(buyback OR buybacks OR "share repurchase")',
  bankruptcy: '(bankruptcy OR insolvency OR "bankruptcy protection")',
  macro: '(economy OR "economic growth" OR recession OR "economic data")',
  fed: '("Federal Reserve" OR FOMC OR "Fed chair" OR "Fed officials")',
  inflation: '(inflation OR "consumer prices" OR CPI)',
  rates: '("interest rates" OR "rate cut" OR "rate hike" OR "bond yields")',
  employment: '(unemployment OR payrolls OR "jobs report" OR "labor market")',
  gdp: '(GDP OR "gross domestic product")',
  trade: '("trade deal" OR "trade talks" OR "trade deficit" OR exports OR imports)',
  tariffs: "(tariff OR tariffs)",
  sanctions: "(sanction OR sanctions)",
  geopolitics: '(geopolitical OR geopolitics OR "military conflict")',
  technology: '(technology OR "tech industry" OR "tech stocks")',
  ai: '("artificial intelligence" OR "machine learning" OR "large language model")',
  semiconductor: "(semiconductor OR semiconductors OR chipmaker OR chipmakers)",
  energy: '(energy OR electricity OR "natural gas")',
  oil: '("oil prices" OR "crude oil" OR OPEC OR Brent)',
  commodities: "(commodities OR commodity)",
  real_estate: '("real estate" OR "home prices" OR "housing market" OR mortgage)',
  healthcare: '(healthcare OR "health care" OR hospitals OR "health insurer")',
  pharma: '(pharmaceutical OR pharmaceuticals OR drugmaker OR "drug approval")',
  banking: "(banks OR banking OR lenders)",
  fintech: '(fintech OR "digital payments" OR "payments company")',
  crypto: "(cryptocurrency OR crypto OR bitcoin OR ethereum)",
  defi: '(DeFi OR "decentralized finance")',
  mining: '(mining OR miners OR "mining company")',
  stablecoin: "(stablecoin OR stablecoins)",
};

/** The market's latest, asked with neither words nor a topic. */
export const MARKET_WORDS = '("stock market" OR stocks OR "Wall Street" OR equities)';

/** The tone GDELT's operators pick out, and how each article chosen by one says it. */
export const TONE_THRESHOLD = 5;
export const TONES: { readonly [T in Tone]: { operator: string; basis: string } } = {
  bearish: {
    operator: `tone<-${TONE_THRESHOLD}`,
    basis: `bearish: GDELT tone below -${TONE_THRESHOLD}`,
  },
  bullish: {
    operator: `tone>${TONE_THRESHOLD}`,
    basis: `bullish: GDELT tone above ${TONE_THRESHOLD}`,
  },
  neutral: {
    operator: `toneabs<${TONE_THRESHOLD}`,
    basis: `neutral: GDELT tone between -${TONE_THRESHOLD} and ${TONE_THRESHOLD}`,
  },
};

/**
 * The caller's words as GDELT reads them: typographic quotes made plain, possessives and the punctuation GDELT
 * does not read (commas, semicolons, question and exclamation marks, apostrophes) dropped, and every quote
 * mark dropped when one is left unmatched (GDELT would read a phrase without its end).
 */
export function searchWords(text: string): string {
  let words = text
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‛]/g, "'")
    .replace(/'s\b/gi, "")
    .replace(/[,;!?']/g, " ");
  if ((words.match(/"/g)?.length ?? 0) % 2 === 1) words = words.replaceAll('"', " ");
  return words.replace(/\s+/g, " ").trim();
}

/** The search GDELT is asked: the caller's words, a topic's, or the market's; a tone; English sources for the app's own words. */
export function gdeltQuery({
  words,
  topic,
  tone,
}: {
  words?: string;
  topic?: NewsTopic;
  tone?: Tone;
}): string {
  const parts: string[] = [];
  if (words) parts.push(words);
  if (topic) parts.push(TOPIC_WORDS[topic]);
  if (!words && !topic) parts.push(MARKET_WORDS);
  if (tone) parts.push(TONES[tone].operator);
  if (!words) parts.push("sourcelang:english");
  return parts.join(" ");
}

/** One article request: the search, and the window (epoch ms) when one is asked. */
export type ArtListRequest = { query: string; start?: number | undefined; end?: number | undefined };

/** The address of an article list: always the same for the same request, so identical ones share answers. */
export function artListUrl({ query, start, end }: ArtListRequest): string {
  const params = new URLSearchParams({
    query,
    mode: "artlist",
    format: "json",
    maxrecords: String(GDELT_MAX_RECORDS),
    sort: "datedesc",
  });
  if (start !== undefined) params.set("startdatetime", gdeltTime(start));
  if (end !== undefined) params.set("enddatetime", gdeltTime(end));
  return `${GDELT_DOC_API}?${params}`;
}

/** An instant (epoch ms) as GDELT writes one: YYYYMMDDHHMMSS, UTC, to the second. */
export function gdeltTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace(/[-T:]/g, "");
}

/** GDELT's time (`20261125T141500Z`, or `20261125141500`) as epoch ms; undefined when it is not one. */
export function parseGdeltTime(text: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/.exec(text.trim());
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  // A time off the calendar (a 31 November, a 25th hour) comes back as another one.
  return gdeltTime(ms) === match.slice(1).join("") ? ms : undefined;
}

/** One article of GDELT's list. */
export type GdeltArticle = {
  url: string;
  title: string | null;
  /** When GDELT first saw it (epoch ms). */
  seen: number;
  /** The publisher's site, as GDELT names it ("example.com"). */
  domain: string | null;
  language: string | null;
  country: string | null;
};

/**
 * An answer's articles, newest first (articles seen at the same time by their address), and whether GDELT
 * gave as many as it gives for one request: then older ones may be left out of it.
 */
export type ArtList = { articles: GdeltArticle[]; full: boolean };

/** GDELT's article list for `request`, kept GDELT_KEEP_MS (on disk too when the setup has a cache directory). */
export async function artList(deps: ForkDeps, request: ArtListRequest, call?: Call): Promise<ArtList> {
  const url = artListUrl(request);
  const signal = call?.signal;
  return deps.cache.remember(
    `gdelt:artlist:${url.slice(GDELT_DOC_API.length + 1)}`,
    GDELT_KEEP_MS,
    async () => {
      let answer: Answer;
      try {
        answer = await deps.http.get(url, {
          source: GDELT_SOURCE,
          signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        // The API missing from its address is the source's failure, not a search without articles.
        if (error instanceof DataError && error.kind === "no_data") {
          throw new DataError(
            "unavailable",
            `GDELT's DOC API is not at its address (HTTP ${error.details.status ?? 404}).`,
            { ...error.details, source: GDELT_SOURCE },
          );
        }
        throw error;
      }
      const { articles, count } = parseArtList(await answer.text());
      return { articles, full: count >= GDELT_MAX_RECORDS };
    },
    { signal, disk: "json" },
  );
}

/**
 * GDELT's answer read: its usable articles, newest first, and how many it gave (`count`, usable or not). A
 * refusal in words is the DataError its words call for; an answer in any other form is unavailable.
 */
export function parseArtList(text: string): { articles: GdeltArticle[]; count: number } {
  const body = text.trim();
  if (!body) throw unreadable("an empty body");
  const answer = json(body);
  if (answer === undefined) throw refusal(body);
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw unreadable("its article list");
  const list = (answer as { articles?: unknown }).articles;
  if (list === undefined) {
    // `{}`: nothing matched.
    if (Object.keys(answer).length === 0) return { articles: [], count: 0 };
    throw unreadable("its article list");
  }
  if (!Array.isArray(list)) throw unreadable("its article list");
  const seen = new Set<string>();
  const articles: GdeltArticle[] = [];
  for (const item of list) {
    const row = item as Record<string, unknown> | null;
    if (!row || typeof row !== "object") continue;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    const time = typeof row.seendate === "string" ? parseGdeltTime(row.seendate) : undefined;
    if (!/^https?:\/\/\S+$/i.test(url) || time === undefined || seen.has(url)) continue;
    seen.add(url);
    articles.push({
      url,
      title: field(row.title),
      seen: time,
      domain: field(row.domain),
      language: field(row.language),
      country: field(row.sourcecountry),
    });
  }
  if (list.length && !articles.length) {
    throw new DataError("unavailable", "GDELT answered articles without an address or a time.", {
      source: GDELT_SOURCE,
    });
  }
  articles.sort((a, b) => b.seen - a.seen || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return { articles, count: list.length };
}

/** Raw control characters (not allowed in a JSON string), built here: the formatter would rewrite an escape. */
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]+`, "g");

/** The body as JSON, mended once if it is not: control characters spaced out, stray backslashes doubled. */
function json(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    try {
      return JSON.parse(body.replace(CONTROL, " ").replace(/\\(?!["\\/bfnrtu])/g, "\\\\")) as unknown;
    } catch {
      return undefined;
    }
  }
}

/** GDELT's answer in words: a search it refuses, its pace, a period it cannot search; anything else unavailable. */
function refusal(body: string): DataError {
  if (body.startsWith("<")) return unreadable("an HTML page");
  // JSON cut off or broken past mending is not words.
  if (/^[[{]/.test(body)) return unreadable("its article list");
  const said = clip(body);
  if (/limit requests|too many requests|rate limit/i.test(said)) {
    return new DataError("rate_limited", `GDELT is limiting requests ("${said}").`, { source: GDELT_SOURCE });
  }
  if (/datetime|\bdates?\b|time ?span/i.test(said)) {
    return new DataError("unsupported", `it could not search that period ("${said}"); ${GDELT_COVERAGE}`, {
      source: GDELT_SOURCE,
    });
  }
  if (/keyword|phrase|query|term|operator|parenthes|short|long|common|search|invalid/i.test(said)) {
    return new DataError("invalid", `it refused the search ("${said}")`, {
      source: GDELT_SOURCE,
      retry: "change_request",
    });
  }
  return new DataError("unavailable", `GDELT answered in words this app does not read ("${said}").`, {
    source: GDELT_SOURCE,
  });
}

function unreadable(what: string): DataError {
  return new DataError("unavailable", `GDELT answered ${what} in a form this app does not read.`, {
    source: GDELT_SOURCE,
  });
}

/** A text field on one line, or null when it is empty or not text. */
function field(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/\s+/g, " ").trim();
  return line || null;
}

/** GDELT's words on one line, at most MESSAGE_CHARS long. */
function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MESSAGE_CHARS ? `${line.slice(0, MESSAGE_CHARS - 3)}...` : line;
}
