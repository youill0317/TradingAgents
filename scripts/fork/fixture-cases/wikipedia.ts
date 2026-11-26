// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of Wikipedia's S&P 500, 400 and 600 lists (the MediaWiki parse API's wikitext), for the sector screen's
 * tests (test/fork/data/frames*.test.ts, wikipedia.test.ts, gics.test.ts). Each case reads its page as the app
 * does and keeps an excerpt of it: the list's table opening and header, the rows of the companies the tests read
 * (as the page writes them then), and the rows of the page's changes table that add those companies (a date
 * spanning several rows kept with all of them), with an attribution comment at its head, since the text is
 * Wikipedia's, licensed CC BY-SA 4.0. Wikipedia limits how fast it is asked: the recorder's HTTP client honours
 * its Retry-After, and the cases run one after another.
 *
 * The fixtures in the repository were cut from the answers saved with the planning samples (2026-11-25), to the
 * same rows. A recording takes the pages as they are then, so the golden texts of those tests need bringing up to
 * date (companies join and leave the indices; a ticker the page no longer lists leaves the excerpt). Wikipedia's
 * 429 answer (wikipedia/rate-limited.txt) cannot be asked for and stays as it was saved.
 */

import { SP_LISTS, type SpList, wikitextUrl } from "../../../src/fork/data/sources/wikipedia.js";
import type { FixtureCase, Recorded } from "../record-fixtures.ts";

/** The companies each list's excerpt keeps, by the tickers the page writes. */
const TICKERS: Readonly<Record<string, readonly string[]>> = {
  sp500:
    "MMM AAPL AMD ADI AMAT MSFT SWKS WDC LRCX JPM BAC BRK.B AXP AFL AIG CBOE WMT ADM SYY PG GE HWM ADP NOC AEP APD ABT AMZN GOOGL GOOG".split(
      " ",
    ),
  sp400: "AA AAL ACM CRS EAT FN CORT GKOS FORM CHYM".split(" "),
  sp600:
    "AAMI AIR MATX APOG EPAC KMT NSSC JBSS MRCY CORT EAT FORM GKOS PRK EFOR GEO ALRM NSIT PMT LNN SCHL".split(
      " ",
    ),
};

/** A table's text by its id, from its opening line to its closing line (left out), and the rows after the header. */
function table(
  wikitext: string,
  id: string,
): { opening: string; header: string[]; rows: string[] } | undefined {
  const start = new RegExp(`^\\{\\|[^\\n]*id="${id}"[^\\n]*$`, "m").exec(wikitext);
  if (!start) return undefined;
  const end = /^\|\}/m.exec(wikitext.slice(start.index));
  const text = wikitext.slice(start.index, end ? start.index + end.index : undefined).replace(/\n+$/, "");
  const [opening = "", ...rest] = text.split("\n|-");
  const headers = rest.findIndex((row) => !row.trimStart().startsWith("!"));
  const first = headers < 0 ? rest.length : headers;
  return { opening, header: rest.slice(0, first), rows: rest.slice(first) };
}

/** The ticker a constituents row starts with. */
function tickerOf(row: string): string | undefined {
  const template = /\{\{\s*(?:NyseSymbol|NasdaqSymbol|BZX link)\s*\|\s*([^}|]+?)\s*\}\}/i.exec(row);
  return template?.[1] ?? /GetURL\|([^|}]+)/.exec(row)?.[1];
}

/**
 * The rows of a changes table that add or remove one of `tickers`, and the newest date written once for several
 * rows (rowspan), so the excerpt holds one; such a date's rows are kept whole.
 */
function changesRows(rows: readonly string[], tickers: ReadonlySet<string>): string[] {
  const kept: string[] = [];
  let spanned = false;
  for (let index = 0; index < rows.length; index++) {
    const span = Math.max(1, Number(/^\s*\|\s*rowspan="?(\d+)/.exec(rows[index] as string)?.[1] ?? 1));
    const block = rows.slice(index, index + span);
    const named = block.some((row, at) => {
      const cells = row
        .trim()
        .replace(/^\|+/, "")
        .split("||")
        .map((cell) => cell.trim());
      const [added, , removed] = at === 0 ? cells.slice(1) : cells;
      return tickers.has(added ?? "") || tickers.has(removed ?? "");
    });
    if (named || (span > 1 && !spanned)) kept.push(...block);
    if (span > 1) spanned = true;
    index += span - 1;
  }
  return kept;
}

/** A page's answer cut to what the tests read, with its attribution at the head of the wikitext. */
export function excerpt(list: SpList, answer: unknown, readAt: string): unknown {
  const parse = (answer as { parse?: { title?: string; pageid?: number; wikitext?: unknown } }).parse;
  if (typeof parse?.wikitext !== "string") throw new Error(`${list.page}: the answer holds no wikitext`);
  const wanted = new Set(TICKERS[list.key]);
  const constituents = table(parse.wikitext, "constituents");
  if (!constituents) throw new Error(`${list.page}: no constituents table`);
  const listed = constituents.rows.filter((row) => wanted.has(tickerOf(row) ?? ""));
  const parts = [
    `<!-- An excerpt of the English Wikipedia article "${list.page}" as read on ${readAt.slice(0, 10)} (https://en.wikipedia.org/wiki/${encodeURIComponent(list.page.replaceAll(" ", "_"))}), by Wikipedia's contributors, licensed under the Creative Commons Attribution-ShareAlike 4.0 licence (https://creativecommons.org/licenses/by-sa/4.0/); cut to the rows the tests read. -->`,
    `${[constituents.opening, ...constituents.header, ...listed].join("\n|-")}\n|}`,
  ];
  const changes = table(parse.wikitext, "changes");
  if (changes) {
    const tickers = new Set([...wanted].flatMap((ticker) => [ticker, ticker.replace(".", "-")]));
    parts.push(
      `${[changes.opening, ...changes.header, ...changesRows(changes.rows, tickers)].join("\n|-")}\n|}`,
    );
  }
  return { parse: { title: parse.title, pageid: parse.pageid, wikitext: parts.join("\n\n") } };
}

export const cases: FixtureCase[] = SP_LISTS.map((list) => ({
  source: "wikipedia",
  name: `${list.key}-wikitext`,
  file: `${list.key}-wikitext.json`,
  read: async (http): Promise<Recorded> => {
    const url = wikitextUrl(list.page);
    const answer = await http.get(url, { source: "Wikipedia", headers: { Accept: "application/json" } });
    const body = excerpt(list, await answer.json(), new Date().toISOString());
    return {
      body: JSON.stringify(body),
      status: answer.status,
      contentType: answer.headers.get("content-type") ?? "application/json",
      url,
    };
  },
}));
