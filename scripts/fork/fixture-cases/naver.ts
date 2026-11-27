// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of a search in Korean, for the news provider's tests that read Naver's news search and GDELT together
 * (test/fork/data/news-naver*.test.ts, naver*.test.ts): Naver's answer to the words 삼성전자 반도체, newest first,
 * and GDELT's answer to the same words as the news provider asks it (sources/gdelt.ts), kept beside it (naver/).
 * Naver's client id and secret come from the settings (NAVER_CLIENT_ID and NAVER_CLIENT_SECRET, in the
 * environment or credentials.json's "data") when a case runs, never from here, and are sent only in the headers
 * Naver documents; the recorder removes every configured key from what it writes.
 *
 * Naver's case reads its answer itself, so that an error answer fails the case and writes nothing. Both are
 * recorded at ten articles (Naver's `display`, GDELT's `maxrecords`) to keep them small; the tests match a search
 * by its words, whatever its count. The repository's fixtures of these names are hand-made in the documented
 * forms until the owner records them; times follow the day of recording, so the tests' days and golden texts
 * follow a new recording.
 */
import { resolvePaths } from "../../../src/config/paths.js";
import { publicDataConfig } from "../../../src/fork/data/config.js";
import type { Http } from "../../../src/fork/data/http.js";
import { artListUrl, gdeltQuery } from "../../../src/fork/data/sources/gdelt.js";
import { naverNewsUrl } from "../../../src/fork/data/sources/naver.js";
import type { FixtureCase, Recorded } from "../record-fixtures.ts";

/** The words of the recorded search in Korean. */
export const WORDS = "삼성전자 반도체";

/** Naver's answer to `words`, newest first, ten articles; refused unless it is Naver's list. */
async function naverAnswer(http: Http, words: string): Promise<Recorded> {
  const { config } = await publicDataConfig(process.env, resolvePaths(process.env));
  if (!config.naverClientId || !config.naverClientSecret) {
    throw new Error("NAVER_CLIENT_ID and NAVER_CLIENT_SECRET are not set");
  }
  const url = new URL(naverNewsUrl(words, 1));
  url.searchParams.set("display", "10");
  const answer = await http.get(url.href, {
    source: "Naver",
    headers: {
      Accept: "application/json",
      "X-Naver-Client-Id": config.naverClientId,
      "X-Naver-Client-Secret": config.naverClientSecret,
    },
    redirect: "same-origin",
  });
  const body = await answer.text();
  let items: unknown;
  try {
    items = (JSON.parse(body) as { items?: unknown }).items;
  } catch {
    items = undefined;
  }
  if (!Array.isArray(items)) {
    // The settings' keys are removed before the body is cut, so no part of one is left at the cut.
    const said = http.redact(body.trim()).slice(0, 160);
    throw new Error(`Naver answered something other than its news list (${said})`);
  }
  return {
    body,
    status: answer.status,
    url: url.href,
    ...(answer.headers.get("content-type")
      ? { contentType: answer.headers.get("content-type") as string }
      : {}),
  };
}

/** GDELT's article list for `words`, as the news provider asks it, ten articles. */
function gdeltAnswer(words: string): string {
  const url = new URL(artListUrl({ query: gdeltQuery({ words }) }));
  url.searchParams.set("maxrecords", "10");
  return url.href;
}

export const cases: FixtureCase[] = [
  {
    source: "naver",
    name: "news-samsung-semiconductor",
    read: (http) => naverAnswer(http, WORDS),
    file: "news-samsung-semiconductor.json",
  },
  {
    source: "naver",
    name: "gdelt-artlist-samsung-semiconductor",
    url: gdeltAnswer(WORDS),
    file: "gdelt-artlist-samsung-semiconductor.json",
  },
];
