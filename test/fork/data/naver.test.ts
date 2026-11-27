// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Naver's news search as sources/naver.ts reads it, offline, on answers in its documented forms (fixtures under
 * test/fork/fixtures/naver, or written inline): the request (the words, display 100, start, sort=date, the
 * client id and secret in their headers and nowhere else), the answer read (<b> tags and entities removed,
 * pubDate's RFC 822 time as an instant, the publisher's address and site, each article's place in the list),
 * its failures as the DataError kinds the router acts on (a request it refuses invalid, the id and secret
 * refused rejected, the day's requests spent quota, its per-second limit rate_limited, the API not there or
 * failing unavailable), and neither header value in any message, cache key or answer. No request reaches the
 * network.
 */
import { describe, expect, test } from "bun:test";
import { DataError } from "../../../src/data/errors.js";
import { type Cache, createCache } from "../../../src/fork/data/cache.js";
import {
  hasHangul,
  NAVER_COVERAGE,
  NAVER_MAX_DISPLAY,
  NAVER_MAX_START,
  NAVER_REACH,
  naverNewsPage,
  naverNewsUrl,
  parseNaverNews,
  plainText,
  rfc822Time,
  siteOf,
} from "../../../src/fork/data/sources/naver.js";
import { type FixtureRoute, fixture, fixtureFetch, holdsPart, testDeps } from "./harness.js";

/** The client id and secret (invented). */
const ID = "nvClientId7Qx2Lw";
const SECRET = "nvSecret9Zk4Pd";
const KEYS = { naverClientId: ID, naverClientSecret: SECRET };
const WORDS = "삼성전자 반도체";

/** Naver's answer for `words` (at any start), a fixture or written inline. */
function naver(
  words: string,
  answer: { file?: string; body?: string; status?: number; headers?: Record<string, string> },
): FixtureRoute {
  return {
    match: (url) =>
      url.hostname === "openapi.naver.com" &&
      url.pathname === "/v1/search/news.json" &&
      url.searchParams.get("query") === words,
    ...(answer.file ? { file: answer.file } : {}),
    ...(answer.body !== undefined
      ? { body: answer.body, headers: answer.headers ?? { "content-type": "application/json;charset=utf-8" } }
      : {}),
    ...(answer.status ? { status: answer.status } : {}),
  };
}

/** A cache that lists every key asked of it. */
function listingCache(): Cache & { keys: string[] } {
  const inner = createCache();
  const keys: string[] = [];
  return {
    keys,
    remember: (key, ttl, load, options) => {
      keys.push(key);
      return inner.remember(key, ttl, load, options);
    },
    keep: (key, ttl, load, options) => {
      keys.push(key);
      return inner.keep(key, ttl, load, options);
    },
    forget: (key) => inner.forget(key),
  };
}

function setup(routes: readonly FixtureRoute[]) {
  const fetch = fixtureFetch(routes);
  const cache = listingCache();
  const { deps } = testDeps(KEYS, fetch, { cache });
  return { deps, fetch, cache };
}

/** The DataError a call rejects with. */
async function failure(promise: Promise<unknown>): Promise<DataError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error("it answered");
}

describe("the request", () => {
  test("the words, Naver's most a request (display 100), the start, newest first; the id and secret in their headers only", async () => {
    const { deps, fetch } = setup([naver(WORDS, { file: "naver/news-samsung-semiconductor.json" })]);
    await naverNewsPage(deps, WORDS, 1);
    const [request] = fetch.requests;
    const url = new URL(request?.url as string);
    expect(`${url.origin}${url.pathname}`).toBe("https://openapi.naver.com/v1/search/news.json");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: WORDS,
      display: "100",
      start: "1",
      sort: "date",
    });
    expect(request?.headers.get("x-naver-client-id")).toBe(ID);
    expect(request?.headers.get("x-naver-client-secret")).toBe(SECRET);
    expect(request?.url).not.toContain(ID);
    expect(request?.url).not.toContain(SECRET);
    expect(naverNewsUrl(WORDS, 1000)).toBe(
      "https://openapi.naver.com/v1/search/news.json?query=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90+%EB%B0%98%EB%8F%84%EC%B2%B4&display=100&start=1000&sort=date",
    );
    expect([NAVER_MAX_DISPLAY, NAVER_MAX_START, NAVER_REACH]).toEqual([100, 1000, 1099]);
    expect(NAVER_COVERAGE).toBe(
      "Naver's news search reaches the newest 1,099 articles of a search (start at most 1,000, display at most 100)",
    );
  });

  test("a page is kept a while: asked again, it is answered without a request; the cache key holds no secret", async () => {
    const { deps, fetch, cache } = setup([naver(WORDS, { file: "naver/news-samsung-semiconductor.json" })]);
    await naverNewsPage(deps, WORDS, 1);
    await naverNewsPage(deps, WORDS, 1);
    expect(fetch.requests).toHaveLength(1);
    expect(cache.keys).toEqual([`naver:news:1:${WORDS}`, `naver:news:1:${WORDS}`]);
  });
});

describe("the answer", () => {
  test("its articles: tags and entities removed, the publisher's address and site, Naver's page, the instant, the place", () => {
    const page = parseNaverNews(
      new TextDecoder().decode(fixture("naver/news-samsung-semiconductor.json")),
      1,
    );
    expect([page.total, page.start, page.given, page.articles.length]).toEqual([9, 1, 9, 9]);
    expect(page.articles[0]).toEqual({
      url: "https://www.example.com/news/articleView.html?idxno=1001",
      naverUrl: "https://n.news.naver.com/mnews/article/901/0000001001?sid=101",
      title: "삼성전자, HBM4 양산 앞두고 반도체 설비 투자 확대",
      summary:
        "삼성전자가 차세대 고대역폭메모리(HBM4) 양산을 앞두고 평택 캠퍼스의 반도체 설비 투자를 늘린다. 업계에 따르면 ...",
      published: Date.parse("2026-11-25T09:40:00Z"),
      site: "example.com",
      index: 1,
    });
    expect(page.articles.map((article) => article.title)).toContain(
      '"반도체 겨울은 끝났다"…삼성전자 목표주가 줄상향',
    );
    expect(page.articles[3]?.summary).toBe(
      "코스피가 외국인 매수세에 힘입어 상승하고 있다. 시가총액 1위 삼성전자는 1%대 강세를 보이며 <반도체> 업종 상승을 이끌고 있다.",
    );
    // Not carried by Naver: its link is the publisher's, so there is no Naver page.
    expect(page.articles[5]).toMatchObject({ naverUrl: null, site: "trade.example.org", index: 6 });
    expect(page.articles[6]?.summary).toBe(
      "삼성전자가 미국 텍사스 '테일러 팹'의 가동 일정을 공개했다. 첨단 반도체 생산을 ...",
    );
    expect(page.articles[7]?.title).toBe("R&D 늘리는 삼성전자…반도체 인재 확보 경쟁");
    expect(
      parseNaverNews(new TextDecoder().decode(fixture("naver/news-samsung-semiconductor.json")), 101)
        .articles[0]?.index,
    ).toBe(101);
  });

  test("an article without an address or a time is left out; an answer of only such articles, or not Naver's list, is unavailable", () => {
    const one = (more: Record<string, unknown>) =>
      JSON.stringify({
        lastBuildDate: "Thu, 26 Nov 2026 07:00:00 +0900",
        total: 2,
        start: 1,
        display: 2,
        items: [
          {
            title: "<b>삼성</b>",
            originallink: "https://news.example.com/a",
            link: "https://n.news.naver.com/a",
            description: "",
            pubDate: "Wed, 25 Nov 2026 10:00:00 +0900",
          },
          {
            title: "둘째",
            originallink: "",
            link: "https://n.news.naver.com/b",
            description: "",
            pubDate: "Wed, 25 Nov 2026 09:00:00 +0900",
            ...more,
          },
        ],
      });
    // An empty originallink: Naver's own address serves, and the article stays.
    expect(parseNaverNews(one({}), 1).articles.map((article) => article.url)).toEqual([
      "https://news.example.com/a",
      "https://n.news.naver.com/b",
    ]);
    expect(parseNaverNews(one({ pubDate: "yesterday" }), 1).articles).toHaveLength(1);
    expect(parseNaverNews(one({ link: "", originallink: "" }), 1).articles).toHaveLength(1);
    const none = JSON.stringify({
      total: 1,
      items: [{ title: "x", originallink: "", link: "", pubDate: "" }],
    });
    expect(() => parseNaverNews(none, 1)).toThrow(
      "Naver answered news articles without an address or a time.",
    );
    for (const body of ["<html></html>", "{}", JSON.stringify({ total: "9", items: [] }), "[]"]) {
      expect(() => parseNaverNews(body, 1), body).toThrow(
        "Naver answered its news search in a form this app does not read.",
      );
    }
    expect(parseNaverNews(JSON.stringify({ total: 0, start: 1, display: 0, items: [] }), 1)).toEqual({
      total: 0,
      start: 1,
      articles: [],
      given: 0,
    });
  });

  test("plain text: every tag removed, entities decoded (named and numeric), one line", () => {
    expect(plainText("<b>삼성전자</b>, &quot;HBM&quot; &amp; <B>반도체</B>")).toBe(
      '삼성전자, "HBM" & 반도체',
    );
    expect(plainText("&lt;b&gt;는 태그가 아니다 &#39;인용&#39; &apos;또&apos;")).toBe(
      "<b>는 태그가 아니다 '인용' '또'",
    );
    // Every run of white space, a no-break space too, is one space.
    expect(plainText("  여러\n  줄&nbsp;공백 ")).toBe("여러 줄 공백");
  });

  test("RFC 822 times as instants: Naver's +0900, named zones, a two-digit year; anything else is no time", () => {
    expect(rfc822Time("Wed, 25 Nov 2026 16:20:00 +0900")).toBe(Date.parse("2026-11-25T07:20:00Z"));
    expect(rfc822Time("25 Nov 2026 16:20 +0900")).toBe(Date.parse("2026-11-25T07:20:00Z"));
    expect(rfc822Time("Wed, 25 Nov 26 07:20:00 GMT")).toBe(Date.parse("2026-11-25T07:20:00Z"));
    expect(rfc822Time("Wed, 25 Nov 2026 02:20:00 EST")).toBe(Date.parse("2026-11-25T07:20:00Z"));
    expect(rfc822Time("Mon, 01 Jan 2024 00:30:00 -0130")).toBe(Date.parse("2024-01-01T02:00:00Z"));
    for (const text of [
      "Mon, 31 Nov 2026 10:00:00 +0900",
      "Wed, 25 Nov 2026 25:00:00 +0900",
      "Wed, 25 Nov 2026 10:00:00 KST",
      "Wed, 25 Foo 2026 10:00:00 +0900",
      "2026-11-25T10:00:00+09:00",
      "Wed, 25 Nov 2026 10:00:00",
    ]) {
      expect(rfc822Time(text), text).toBeUndefined();
    }
  });

  test("Hangul tells a search in Korean: syllables, jamo, mixed with other scripts", () => {
    expect(["삼성전자", "ㅋㅋ", "Samsung 반도체", "HBM4 수율"].map(hasHangul)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(["Samsung Electronics", "サムスン", "三星电子", "chip export controls"].map(hasHangul)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  test("a publisher's site: its host without www.", () => {
    expect([
      siteOf("https://www.example.com/a"),
      siteOf("https://biz.example.net/b"),
      siteOf("nonsense"),
    ]).toEqual(["example.com", "biz.example.net", null]);
  });
});

describe("its failures", () => {
  const cases: [string, number, string, string][] = [
    [
      "naver/error-query.json",
      400,
      "invalid",
      "Naver's news search refused the request (HTTP 400, SE01: Incorrect query request (잘못된 쿼리요청입니다.))",
    ],
    [
      "naver/error-authentication.json",
      401,
      "rejected",
      "Naver's news search refused NAVER_CLIENT_ID and NAVER_CLIENT_SECRET (HTTP 401, 024: Authentication failed (인증에 실패했습니다.))",
    ],
    [
      "naver/error-daily-limit.json",
      429,
      "quota",
      "Naver's news search allows this application no more requests today (HTTP 429, 010: Request limit exceeded. (요청 한도를 초과했습니다.))",
    ],
    [
      "naver/error-rate-limit.json",
      429,
      "rate_limited",
      "Naver's news search is limiting requests (HTTP 429, 012: Rate limit exceeded. (속도 제한을 초과했습니다.))",
    ],
  ];
  for (const [file, status, kind, said] of cases) {
    test(`${file.slice(6)}: HTTP ${status} is ${kind}`, async () => {
      const { deps } = setup([naver(WORDS, { file })]);
      const error = await failure(naverNewsPage(deps, WORDS, 1));
      expect([error.kind, error.details.source, error.details.status]).toEqual([kind, "Naver", status]);
      expect(error.message).toBe(said);
      if (kind === "invalid") expect(error.details.retry).toBe("change_request");
    });
  }

  test("a 429 with a Retry-After keeps its wait; a 403, a 404 and a 500 (asked once more) without Naver's words", async () => {
    const limited = setup([
      naver(WORDS, {
        body: JSON.stringify({
          errorMessage: "Rate limit exceeded. (속도 제한을 초과했습니다.)",
          errorCode: "012",
        }),
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "1" },
      }),
    ]);
    const error = await failure(naverNewsPage(limited.deps, WORDS, 1));
    expect([error.kind, error.details.retryAfterMs]).toEqual(["rate_limited", 1000]);
    const forbidden = setup([naver(WORDS, { body: "", status: 403 })]);
    expect((await failure(naverNewsPage(forbidden.deps, WORDS, 1))).message).toBe(
      "Naver's news search refused NAVER_CLIENT_ID and NAVER_CLIENT_SECRET (HTTP 403)",
    );
    const missing = setup([
      naver(WORDS, {
        body: JSON.stringify({
          errorMessage: "Invalid search api (존재하지 않는 검색 api 입니다.)",
          errorCode: "SE05",
        }),
        status: 404,
      }),
    ]);
    const gone = await failure(naverNewsPage(missing.deps, WORDS, 1));
    expect([gone.kind, gone.message]).toEqual([
      "unavailable",
      "Naver's news search is not at its address (HTTP 404, SE05: Invalid search api (존재하지 않는 검색 api 입니다.))",
    ]);
    const down = setup([
      naver(WORDS, {
        body: JSON.stringify({ errorMessage: "System Error", errorCode: "SE99" }),
        status: 500,
      }),
    ]);
    const failed = await failure(naverNewsPage(down.deps, WORDS, 1));
    expect([failed.kind, failed.message]).toEqual(["unavailable", "Naver answered HTTP 500."]);
    expect(down.fetch.requests).toHaveLength(2);
  });

  test("neither header value is in a message, even when Naver's words quote them", async () => {
    const { deps } = setup([
      naver(WORDS, {
        body: JSON.stringify({
          errorMessage: `Authentication failed for ${ID} with ${SECRET}`,
          errorCode: "024",
        }),
        status: 401,
      }),
    ]);
    const error = await failure(naverNewsPage(deps, WORDS, 1));
    expect(error.message).toBe(
      "Naver's news search refused NAVER_CLIENT_ID and NAVER_CLIENT_SECRET (HTTP 401, 024: Authentication failed for *** with ***)",
    );
    expect(JSON.stringify(error.details)).not.toContain(ID);
  });

  test("no part of either is said when Naver quotes one where its words are cut, or as its error code", async () => {
    for (const [errorMessage, errorCode] of [
      // Naver's words keep 200 characters: each value quoted across the cut.
      [`Authentication failed ${"y".repeat(170)} ${SECRET}`, "024"],
      [`Authentication failed ${"y".repeat(175)} client=${ID}`, "024"],
      // A value where Naver writes its code: not a code Naver writes, so no code is said or kept.
      ["Authentication failed", ID],
    ]) {
      const { deps } = setup([
        naver(WORDS, { body: JSON.stringify({ errorMessage, errorCode }), status: 401 }),
      ]);
      const error = await failure(naverNewsPage(deps, WORDS, 1));
      expect(error.kind).toBe("rejected");
      for (const said of [error.message, JSON.stringify(error.details)]) {
        expect(holdsPart(said, ID), said).toBe(false);
        expect(holdsPart(said, SECRET), said).toBe(false);
      }
    }
    const { deps } = setup([
      naver(WORDS, {
        body: JSON.stringify({ errorMessage: "Authentication failed", errorCode: ID }),
        status: 401,
      }),
    ]);
    const error = await failure(naverNewsPage(deps, WORDS, 1));
    expect([error.message, error.details.code]).toEqual([
      "Naver's news search refused NAVER_CLIENT_ID and NAVER_CLIENT_SECRET (HTTP 401: Authentication failed)",
      undefined,
    ]);
  });

  test("a failed page is not kept: asked again, it is asked again", async () => {
    const { deps, fetch } = setup([naver(WORDS, { file: "naver/error-rate-limit.json" })]);
    await failure(naverNewsPage(deps, WORDS, 1));
    await failure(naverNewsPage(deps, WORDS, 1));
    expect(fetch.requests).toHaveLength(2);
  });
});
