// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * How the FSC provider reads data.go.kr and fails, offline, on answers in the service's documented forms
 * (fixtures, or written inline): the key sent encoded once whichever of data.go.kr's two spellings is
 * configured, and neither spelling ever said, cached or kept; the gateway's failures in XML, even when JSON is
 * asked, each the DataError kind the router acts on (a key refused: rejected, the day's requests spent: quota,
 * the service failing: unavailable), and the other address asked when the first does not know the key; every
 * page read to the count the service gives; keys of other markets passed on unasked (unsupported); a code the
 * FSC holds no row of at all unsupported too, and a window without a session of a share it holds no_data; a
 * listing on the other market invalid, naming it; a session without trades, a
 * corporate action's base price, a share without recent sessions and a history that starts in the window, each
 * said as the FSC gives it. No request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import type { Call, DataProvider, Quote, QuoteBatch } from "../../../src/data/capabilities.js";
import { DataError } from "../../../src/data/errors.js";
import { type Cache, createCache } from "../../../src/fork/data/cache.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import { fscProvider } from "../../../src/fork/data/providers/fsc.js";
import {
  amountOf,
  decodedKey,
  FSC_ADDRESSES,
  FSC_PAGE_ROWS,
  keySpellings,
  serviceKeyParam,
} from "../../../src/fork/data/sources/fsc.js";
import { type FixtureFetch, fixture, holdsPart, type TestOptions, testDeps } from "./harness.js";

// The key, in data.go.kr's two spellings (invented: base64-like, as data.go.kr's keys are; fsc.test.ts's too).
const KEY_DECODED = "Fk3a9Q+Zr7Lw2/Xp5Tn8Vb1=Hc6Jd4Mg0Ks+Ye3Ru9Wq/Ai2Ov7Sl5Nf8Bh1Gx4==";
const KEY_ENCODED = encodeURIComponent(KEY_DECODED);

// Answers written inline, in the service's documented forms ------------------------------------------------------

type Item = Record<string, string>;

/** One row of the FSC's answer (every value a string, as it writes them). */
function item(date: string, close: number, change: number, more: Partial<Item> = {}): Item {
  const shares = 1_000_000;
  const previous = close - change;
  const percent = previous ? Math.round((change / previous) * 10_000) / 100 : 0;
  return {
    basDt: date.replaceAll("-", ""),
    srtnCd: "123450",
    isinCd: "KR7123450004",
    itmsNm: "예시전자",
    mrktCtg: "KOSPI",
    clpr: String(close),
    vs: String(change),
    fltRt: String(percent).replace(/^(-?)0\./, "$1."),
    mkp: String(close - 100),
    hipr: String(close + 200),
    lopr: String(close - 300),
    trqu: "250000",
    trPrc: String(250_000 * close),
    lstgStCnt: String(shares),
    mrktTotAmt: String(close * shares),
    ...more,
  };
}

/** The service's JSON answer holding `items` (newest first), `totalCount` all of them unless given. */
function answer(items: Item[], page: { rows?: number; no?: number; total?: number } = {}): string {
  return JSON.stringify({
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
      body: {
        numOfRows: page.rows ?? FSC_PAGE_ROWS,
        pageNo: page.no ?? 1,
        totalCount: page.total ?? items.length,
        items: items.length === 1 ? { item: items[0] } : items.length ? { item: items } : "",
      },
    },
  });
}

/** data.go.kr's gateway failure, in XML whatever was asked. */
function envelope(code: string, auth: string, err = "SERVICE ERROR"): string {
  return `<OpenAPI_ServiceResponse>
	<cmmMsgHeader>
		<errMsg>${err}</errMsg>
		<returnAuthMsg>${auth}</returnAuthMsg>
		<returnReasonCode>${code}</returnReasonCode>
	</cmmMsgHeader>
</OpenAPI_ServiceResponse>`;
}

const JSON_TYPE = { "content-type": "application/json;charset=UTF-8" };
const XML_TYPE = { "content-type": "text/xml;charset=UTF-8" };

/** What the stub answers a request: a body, its status, its headers. */
type Reply = { body: string; status?: number; headers?: Record<string, string> };

/** A fetch answering each request with what `reply` gives for its address, every request listed. */
function stub(reply: (url: URL) => Reply): FixtureFetch {
  const requests: FixtureFetch["requests"] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason;
    const { body, status = 200, headers = JSON_TYPE } = reply(new URL(url));
    return new Response(body, { status, headers });
  };
  return Object.assign(fetch, { requests, unmatched: [] as string[] }) as FixtureFetch;
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

/** The FSC provider over `fetch`, its methods, and what it asked. */
function fsc(
  fetch: FixtureFetch,
  config: PublicDataConfig = { dataGoKrKey: KEY_ENCODED },
  extra: TestOptions = {},
) {
  const cache = listingCache();
  const { deps, timer } = testDeps(config, fetch, { cache, ...extra });
  const provider = fscProvider(deps);
  const quotes = provider.capabilities.quotes as NonNullable<DataProvider["capabilities"]["quotes"]>;
  const history = provider.capabilities.priceHistory as NonNullable<
    DataProvider["capabilities"]["priceHistory"]
  >;
  return {
    provider,
    cache,
    timer,
    quote: (key: string, call?: Call) => (quotes.quote as (k: string, c?: Call) => Promise<Quote>)(key, call),
    many: (keys: string[]) => (quotes.many as (k: string[]) => Promise<QuoteBatch>)(keys),
    daily: (key: string, from: string, to: string) =>
      (
        history.daily as (
          k: string,
          w: { from: string; to: string },
        ) => Promise<{
          bars: { date: string; open?: number | null; close?: number | null; field_states?: unknown }[];
          coverage: Record<string, unknown>;
          earlier_end: string | null;
          instrument?: { key?: string | null } | null;
        }>
      )(key, { from, to }),
  };
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

/** The serviceKey parameter of a request, as written in its address (not decoded). */
function sentKey(url: string): string | undefined {
  return /[?&]serviceKey=([^&]*)/.exec(url)?.[1];
}

const V2 = new URL(FSC_ADDRESSES[0]).pathname;
const V1 = new URL(FSC_ADDRESSES[1]).pathname;

/** Samsung's fixture rows, for a stub that answers them at any address. */
const SAMSUNG = new TextDecoder().decode(fixture("fsc/stock-price-005930.json"));

// The tests --------------------------------------------------------------------------------------------

describe("the key", () => {
  test("either of data.go.kr's spellings is sent encoded once, the same way", async () => {
    for (const configured of [KEY_ENCODED, KEY_DECODED]) {
      const fetch = stub(() => ({ body: SAMSUNG }));
      await fsc(fetch, { dataGoKrKey: configured }).quote("XKRX:005930");
      expect(
        fetch.requests.map((request) => sentKey(request.url)),
        configured,
      ).toEqual([encodeURIComponent(KEY_DECODED)]);
    }
    expect(decodedKey(KEY_ENCODED)).toBe(KEY_DECODED);
    expect(decodedKey(KEY_DECODED)).toBe(KEY_DECODED);
    expect(serviceKeyParam(KEY_DECODED)).toBe(KEY_ENCODED);
    expect(keySpellings(KEY_ENCODED).sort()).toEqual([KEY_DECODED, KEY_ENCODED].sort());
  });

  test("neither spelling is in an answer, an error, a cache key or a note, even when data.go.kr echoes one", async () => {
    for (const configured of [KEY_ENCODED, KEY_DECODED]) {
      // A gateway that quotes the key back in both spellings, as no documented answer does.
      const fetch = stub(() => ({
        body: envelope("20", `SERVICE_ACCESS_DENIED_ERROR ${KEY_DECODED} ${KEY_ENCODED}`, KEY_DECODED),
        status: 401,
        headers: XML_TYPE,
      }));
      const { quote, daily, cache } = fsc(fetch, { dataGoKrKey: configured });
      const refused = await failure(quote("XKRX:005930"));
      expect(refused.kind).toBe("rejected");
      const again = await failure(daily("XKRX:005930", "2026-11-01", "2026-11-24"));
      for (const said of [refused.message, again.message, JSON.stringify(refused.details), ...cache.keys]) {
        expect(holdsPart(said, KEY_DECODED), configured).toBe(false);
        expect(holdsPart(said, KEY_ENCODED), configured).toBe(false);
        expect(holdsPart(said, encodeURIComponent(KEY_ENCODED)), configured).toBe(false);
      }
      expect(refused.message).toContain("***");
    }
    // An answer's rows, its cache keys and the quote hold neither spelling either.
    const fetch = stub(() => ({ body: SAMSUNG }));
    const { quote, cache } = fsc(fetch, { dataGoKrKey: KEY_DECODED });
    const answered = JSON.stringify(await quote("XKRX:005930"));
    for (const said of [answered, ...cache.keys]) {
      expect(holdsPart(said, KEY_DECODED)).toBe(false);
      expect(holdsPart(said, KEY_ENCODED)).toBe(false);
    }
    expect(cache.keys).toEqual(["fsc:rows:005930:2026-10-26:"]);
  });

  test("a key data.go.kr quotes where its words are cut leaves no part of it said; other bodies are not quoted", async () => {
    // The key escaped as JSON may write it (a slash as \/), which no spelling of it matches.
    const escaped = KEY_DECODED.replaceAll("/", "\\/");
    const replies: [string, (url: URL) => Reply][] = [
      // The gateway's words quote the key across the 160 characters a message keeps of them.
      ...[KEY_DECODED, KEY_ENCODED].map((echoed): [string, (url: URL) => Reply] => [
        `the envelope, ${echoed === KEY_DECODED ? "decoded" : "encoded"}`,
        () => ({
          body: envelope("20", `SERVICE_ACCESS_DENIED_ERROR ${"x".repeat(120)} ${echoed}`),
          status: 401,
          headers: XML_TYPE,
        }),
      ]),
      // A plain-text refusal quoting the address it was asked at, the key in it as sent.
      [
        "plain text quoting the address",
        (url) => ({
          body: `Unauthorized request: ${url.href}`,
          status: 401,
          headers: { "content-type": "text/plain" },
        }),
      ],
      // Plain text quoting the key after serviceKey= with JSON's escapes.
      [
        "plain text, escaped",
        () => ({
          body: `Bad Request: serviceKey=${escaped}`,
          status: 400,
          headers: { "content-type": "text/plain" },
        }),
      ],
      // JSON that is not the gateway's envelope: not quoted at all.
      [
        "JSON of another form",
        () => ({ body: `{"serviceKey":"${escaped}","reason":"refused"}`, status: 400 }),
      ],
    ];
    for (const configured of [KEY_ENCODED, KEY_DECODED]) {
      for (const [what, reply] of replies) {
        const error = await failure(fsc(stub(reply), { dataGoKrKey: configured }).quote("XKRX:005930"));
        for (const said of [error.message, JSON.stringify(error.details)]) {
          for (const spelling of [KEY_DECODED, KEY_ENCODED, escaped]) {
            expect(holdsPart(said, spelling), `${what}: ${said}`).toBe(false);
          }
        }
      }
    }
    const plain = await failure(
      fsc(stub((url) => ({ body: `Unauthorized request: ${url.href}`, status: 401 }))).quote("XKRX:005930"),
    );
    // The key removed first, then the words cut to 160 characters.
    expect(plain.message).toBe(
      `data.go.kr refused DATA_GO_KR_API_KEY for the FSC's stock prices (HTTP 401: Unauthorized request: https://apis.data.go.kr${V2}?serviceKey=***&numOfRows=10000&pageNo=1&resultType=j).`,
    );
    const json = await failure(
      fsc(stub(() => ({ body: `{"serviceKey":"${escaped}"}`, status: 400 }))).quote("XKRX:005930"),
    );
    expect(json.message).toBe("the FSC's stock prices failed (HTTP 400).");
  });
});

describe("the gateway's failures, in XML though JSON is asked", () => {
  const cases: [string, string, number, string, string][] = [
    [
      "22",
      "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR",
      200,
      "quota",
      "daily requests for this key are spent",
    ],
    [
      "23",
      "LIMITED_NUMBER_OF_SERVICE_REQUESTS_PER_SECOND_EXCEEDS_ERROR",
      429,
      "rate_limited",
      "limiting requests",
    ],
    ["21", "TEMPORARILY_DISABLE_THE_SERVICEKEY_ERROR", 200, "rejected", "refused DATA_GO_KR_API_KEY"],
    ["29", "BLACKLIST_IP_ACCESS_ERROR", 200, "rejected", "refused DATA_GO_KR_API_KEY"],
    ["31", "DEADLINE_HAS_EXPIRED_ERROR", 200, "rejected", "refused DATA_GO_KR_API_KEY"],
    ["32", "UNREGISTERED_IP_ERROR", 200, "rejected", "refused DATA_GO_KR_API_KEY"],
    ["10", "INVALID_REQUEST_PARAMETER_ERROR", 200, "invalid", "refused the request"],
    ["11", "NO_MANDATORY_REQUEST_PARAMETERS_ERROR", 200, "invalid", "refused the request"],
    ["1", "APPLICATION_ERROR", 200, "unavailable", "failed"],
    ["5", "SERVICETIMEOUT_ERROR", 200, "unavailable", "failed"],
    ["99", "UNKNOWN_ERROR", 200, "unavailable", "failed"],
  ];
  for (const [code, name, status, kind, said] of cases) {
    test(`returnReasonCode ${code} (${name}) is ${kind}, from the first address alone`, async () => {
      const fetch = stub(() => ({ body: envelope(code, name), status, headers: XML_TYPE }));
      const error = await failure(fsc(fetch).quote("XKRX:005930"));
      expect([error.kind, error.details.source]).toEqual([kind, "FSC"]);
      expect(error.message).toContain(said);
      expect(error.message).toContain(`${name}, code ${code}`);
      expect(fetch.requests.map((request) => new URL(request.url).pathname)).toEqual([V2]);
    });
  }

  test("the fixtures: a key not registered (403, code 30) and the day's requests spent (200, code 22)", async () => {
    const quota = stub(() => ({
      body: new TextDecoder().decode(fixture("fsc/error-quota.xml")),
      headers: XML_TYPE,
    }));
    expect((await failure(fsc(quota).quote("XKRX:005930"))).kind).toBe("quota");
    const refused = stub(() => ({
      body: new TextDecoder().decode(fixture("fsc/error-key-not-registered.xml")),
      status: 403,
      headers: XML_TYPE,
    }));
    const error = await failure(fsc(refused).quote("XKRX:005930"));
    expect(error.kind).toBe("rejected");
    expect(error.message).toBe(
      "data.go.kr refused DATA_GO_KR_API_KEY for the FSC's stock prices (SERVICE_KEY_IS_NOT_REGISTERED_ERROR, code 30: SERVICE ERROR), at both of its addresses (getStockPriceInfo_V2 and getStockPriceInfo).",
    );
    expect(refused.requests.map((request) => new URL(request.url).pathname)).toEqual([V2, V1]);
  });

  test("a 429 the gateway gives without its code: rate_limited, with the wait it asks for", async () => {
    const fetch = stub(() => ({
      body: "API rate limit exceeded",
      status: 429,
      headers: { "content-type": "text/plain", "retry-after": "2" },
    }));
    const error = await failure(fsc(fetch).quote("XKRX:005930"));
    expect([error.kind, error.details.retryAfterMs]).toEqual(["rate_limited", 2000]);
    expect(error.message).toBe("data.go.kr is limiting requests (HTTP 429: API rate limit exceeded).");
  });

  test("a code in the JSON header is read as the XML one: 22 in JSON is quota too", async () => {
    const body = JSON.stringify({
      response: {
        header: { resultCode: "22", resultMsg: "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR" },
      },
    });
    const error = await failure(fsc(stub(() => ({ body }))).quote("XKRX:005930"));
    expect(error.kind).toBe("quota");
  });

  test("its 'no data' (code 03) is an answer without rows: a code without a row is one it does not cover", async () => {
    const body = JSON.stringify({ response: { header: { resultCode: "03", resultMsg: "NODATA_ERROR" } } });
    const error = await failure(fsc(stub(() => ({ body }))).quote("XKRX:005930"));
    expect(error.kind).toBe("unsupported");
  });

  test("a 401 or 403 without data.go.kr's words is rejected; a 500 is asked once more, then unavailable", async () => {
    for (const status of [401, 403]) {
      const error = await failure(fsc(stub(() => ({ body: "", status }))).quote("XKRX:005930"));
      expect(error.kind, String(status)).toBe("rejected");
    }
    const down = stub(() => ({ body: "<html><body>Internal Server Error</body></html>", status: 500 }));
    const error = await failure(fsc(down).quote("XKRX:005930"));
    expect([error.kind, error.message]).toEqual(["unavailable", "FSC answered HTTP 500."]);
    expect(down.requests).toHaveLength(2);
  });

  test("an answer in no form it documents is unavailable: an HTML page, JSON of another shape, a count missing", async () => {
    for (const body of [
      "<html><body>maintenance</body></html>",
      JSON.stringify({ result: [] }),
      JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: "" } } }),
    ]) {
      const error = await failure(fsc(stub(() => ({ body }))).quote("XKRX:005930"));
      expect(error.kind, body).toBe("unavailable");
      expect(error.message, body).toBe("FSC answered its stock prices in a form this app does not read.");
    }
  });
});

describe("the two addresses", () => {
  test("a key the first address does not know (code 30) is asked of the other, which is asked first from then on", async () => {
    const fetch = stub((url) =>
      url.pathname === V2
        ? { body: envelope("30", "SERVICE_KEY_IS_NOT_REGISTERED_ERROR"), status: 403, headers: XML_TYPE }
        : { body: SAMSUNG },
    );
    const { quote, daily } = fsc(fetch);
    const answered = await quote("XKRX:005930");
    expect(answered.price).toBe(83000);
    await daily("XKRX:005930", "2026-11-18", "2026-11-24");
    expect(fetch.requests.map((request) => new URL(request.url).pathname)).toEqual([V2, V1, V1, V1]);
  });

  test("a key without an approved application at the first address (code 20) is asked of the other", async () => {
    const fetch = stub((url) =>
      url.pathname === V2
        ? { body: envelope("20", "SERVICE_ACCESS_DENIED_ERROR"), status: 401, headers: XML_TYPE }
        : { body: SAMSUNG },
    );
    expect((await fsc(fetch).quote("XKRX:005930")).price).toBe(83000);
    expect(fetch.requests.map((request) => new URL(request.url).pathname)).toEqual([V2, V1]);
    // Refused at both: rejected, said once for both addresses.
    const both = stub(() => ({
      body: envelope("20", "SERVICE_ACCESS_DENIED_ERROR"),
      status: 401,
      headers: XML_TYPE,
    }));
    const error = await failure(fsc(both).quote("XKRX:005930"));
    expect(error.kind).toBe("rejected");
    expect(error.message).toBe(
      "data.go.kr refused DATA_GO_KR_API_KEY for the FSC's stock prices (SERVICE_ACCESS_DENIED_ERROR, code 20: SERVICE ERROR), at both of its addresses (getStockPriceInfo_V2 and getStockPriceInfo).",
    );
  });

  test("no such service at the first address (code 12, or its 404 page): the other is asked", async () => {
    for (const first of [
      { body: envelope("12", "NO_OPENAPI_SERVICE_ERROR"), headers: XML_TYPE },
      { body: "<html><body>Not Found</body></html>", status: 404, headers: { "content-type": "text/html" } },
    ]) {
      const fetch = stub((url) => (url.pathname === V2 ? first : { body: SAMSUNG }));
      expect((await fsc(fetch).quote("XKRX:005930")).price).toBe(83000);
      expect(fetch.requests.map((request) => new URL(request.url).pathname)).toEqual([V2, V1]);
    }
  });

  test("any other failure of the first address is the answer: the other is not asked", async () => {
    const fetch = stub((url) =>
      url.pathname === V2
        ? { body: envelope("22", "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR"), headers: XML_TYPE }
        : { body: SAMSUNG },
    );
    expect((await failure(fsc(fetch).quote("XKRX:005930"))).kind).toBe("quota");
    expect(fetch.requests).toHaveLength(1);
  });
});

describe("pages", () => {
  test("every page is read to the count the service gives, 10,000 rows a page", async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      item(`2026-10-${String(i + 1).padStart(2, "0")}`, 10_000 + i, 1),
    );
    const fetch = stub((url) => {
      const size = Number(url.searchParams.get("numOfRows"));
      const page = Number(url.searchParams.get("pageNo"));
      // The service's own page size here: 10 rows, whatever is asked.
      const cap = Math.min(size, 10);
      const start = (page - 1) * size;
      return { body: answer(rows.slice(start, start + cap), { rows: cap, no: page, total: rows.length }) };
    });
    const { daily } = fsc(fetch);
    const bars = await daily("123450", "2026-10-01", "2026-10-25");
    expect(bars.bars.map((bar) => bar.date)).toEqual(rows.map((row) => `2026-10-${row.basDt?.slice(6)}`));
    expect(
      fetch.requests
        .map((request) => new URL(request.url).searchParams)
        .filter((params) => params.has("beginBasDt"))
        .map((params) => `${params.get("numOfRows")}/${params.get("pageNo")}`),
    ).toEqual(["10000/1", "10/2", "10/3"]);
  });

  test("a page that stops short of the count before the end is unavailable, never a shorter history", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => item(`2026-10-0${i + 1}`, 10_000 + i, 1));
    // Two rows on the first page, then none, of the five it counts.
    const cut = stub((url) => ({
      body: answer(url.searchParams.get("pageNo") === "1" ? rows.slice(0, 2) : [], { total: 5 }),
    }));
    const error = await failure(fsc(cut).daily("123450", "2026-10-01", "2026-10-05"));
    expect(error.kind).toBe("unavailable");
    expect(error.message).toBe("the FSC's stock prices of 123450 stopped at 2 of the 5 rows they count.");
    // Pages that repeat the same rows reach the count without its rows: unavailable too.
    const repeated = stub(() => ({ body: answer(rows.slice(0, 2), { total: 5 }) }));
    const again = await failure(fsc(repeated).daily("123450", "2026-10-01", "2026-10-05"));
    expect([again.kind, again.message]).toEqual([
      "unavailable",
      "the FSC's stock prices of 123450 stopped at 2 of the 5 rows they count.",
    ]);
  });

  test("one row is an object, not a list; no rows is an empty items", async () => {
    const one = stub(() => ({ body: answer([item("2026-11-24", 10_000, 100)]) }));
    expect((await fsc(one).quote("123450")).price).toBe(10_000);
    const none = stub(() => ({ body: answer([]) }));
    expect((await failure(fsc(none).quote("123450"))).kind).toBe("unsupported");
  });

  test("the service's answer written in XML is read as its JSON is", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header><body><numOfRows>10000</numOfRows><pageNo>1</pageNo><totalCount>1</totalCount><items><item><basDt>20261124</basDt><srtnCd>123450</srtnCd><isinCd>KR7123450004</isinCd><itmsNm>예시전자</itmsNm><mrktCtg>KOSDAQ</mrktCtg><clpr>9870</clpr><vs>-30</vs><fltRt>-.3</fltRt><mkp>9900</mkp><hipr>9950</hipr><lopr>9800</lopr><trqu>1200</trqu><trPrc>11844000</trPrc><lstgStCnt>1000000</lstgStCnt><mrktTotAmt>9870000000</mrktTotAmt></item></items></body></response>`;
    const quote = await fsc(stub(() => ({ body: xml, headers: XML_TYPE }))).quote("123450");
    expect([quote.price, quote.change, quote.change_percent, quote.instrument?.key]).toEqual([
      9870,
      -30,
      -0.3,
      "XKOS:123450",
    ]);
  });
});

describe("keys, codes and markets", () => {
  test("a key that is not a Korean listing is unsupported (the router moves on), asked of nobody", async () => {
    const fetch = stub(() => ({ body: SAMSUNG }));
    const { quote, daily } = fsc(fetch);
    for (const key of [
      "AAPL",
      "XNAS:AAPL",
      "XLON:VOD",
      "fx:EURUSD",
      "crypto:BTC-USD",
      "future:CL",
      "series:us.equity_index.sp500",
      "series:us.fred.cpiaucsl",
      "XKRX:12",
    ]) {
      const error = await failure(quote(key));
      expect([error.kind, error.details.source], key).toEqual(["unsupported", "FSC"]);
      expect((await failure(daily(key, "2026-11-01", "2026-11-24"))).kind, key).toBe("unsupported");
    }
    expect((await failure(quote("AAPL"))).message).toBe(
      "its stock prices are KRX's, for KOSPI and KOSDAQ listings (XKRX:, XKOS:, .KS, .KQ or a six-character code); AAPL is not one",
    );
    expect(fetch.requests).toEqual([]);
  });

  test("a listing the FSC places on the other market is invalid, naming the one it is on", async () => {
    const error = await failure(fsc(stub(() => ({ body: SAMSUNG }))).quote("XKOS:005930"));
    expect([error.kind, error.message, error.details.candidates]).toEqual([
      "invalid",
      "005930 is listed on KOSPI (XKRX:005930), not KOSDAQ",
      [{ symbol: "XKRX:005930", name: "삼성전자 (KOSPI)" }],
    ]);
  });

  test("a KONEX listing is unsupported: no listing key names one", async () => {
    const body = answer([item("2026-11-24", 3_000, 0, { mrktCtg: "KONEX" })]);
    const error = await failure(fsc(stub(() => ({ body }))).quote("123450"));
    expect([error.kind, error.message]).toEqual([
      "unsupported",
      "it lists 123450 (예시전자) on KONEX; XKRX: and XKOS: keys name KOSPI and KOSDAQ listings",
    ]);
  });

  test("a code written with KRX's leading A is the same code", async () => {
    const body = answer([item("2026-11-24", 10_000, 100, { srtnCd: "A123450" })]);
    expect((await fsc(stub(() => ({ body }))).quote("XKRX:123450")).price).toBe(10_000);
  });

  test("numbers as the FSC writes them: no leading zero, a sign, empty", () => {
    expect([amountOf(".48"), amountOf("-.61"), amountOf("1.2"), amountOf("84000"), amountOf("")]).toEqual([
      0.48,
      -0.61,
      1.2,
      84000,
      null,
    ]);
    expect([amountOf("1,234"), amountOf("n/a"), amountOf(null)]).toEqual([1234, null, null]);
  });
});

describe("what a quote and a history say", () => {
  test("a session without trades (a halt): no open, high or low, the previous close carried, said", async () => {
    const halted = item("2026-11-24", 52_000, 0, {
      mkp: "0",
      hipr: "0",
      lopr: "0",
      trqu: "0",
      trPrc: "0",
      fltRt: "0",
    });
    const body = answer([halted, item("2026-11-23", 52_000, -500)]);
    const { quote, daily } = fsc(stub(() => ({ body })));
    const answered = await quote("XKRX:123450");
    expect(answered.day).toEqual({ open: null, high: null, low: null, volume: 0 });
    expect(answered.field_states?.day?.reason).toBe(
      "no trades this session (trading halted): the close is the previous close carried over",
    );
    const bars = await daily("XKRX:123450", "2026-11-23", "2026-11-24");
    expect(bars.bars.at(-1)).toMatchObject({ date: "2026-11-24", open: null, close: 52_000 });
    expect(bars.bars.at(-1)?.field_states).toEqual({
      close: {
        reason:
          "no trades this session (trading halted): the previous close carried over, no open, high or low",
      },
    });
  });

  test("a corporate action's day: the change is against the exchange's base price, which field_states names", async () => {
    // A 1:5 split: the close falls from 558,000 to 120,500, up 8,500 on a base price of 112,000.
    const body = answer([item("2026-11-24", 120_500, 8_500), item("2026-11-23", 558_000, 3_000)]);
    const answered = await fsc(stub(() => ({ body }))).quote("XKRX:123450");
    expect([answered.change, answered.change_basis, answered.previous_close]).toEqual([
      8_500,
      "base_price",
      { value: 112_000, date: "2026-11-23" },
    ]);
    expect(answered.field_states?.previous_close?.reason).toBe(
      "the exchange's base price for 2026-11-24: the 2026-11-23 close of 558000 adjusted for a corporate action",
    );
  });

  test("a share without a session in the last 31 days: its last row, said, from its whole history", async () => {
    const fetch = stub((url) =>
      url.searchParams.has("beginBasDt")
        ? { body: answer([]) }
        : { body: answer([item("2025-03-10", 7_100, -900), item("2025-03-07", 8_000, 0)]) },
    );
    const answered = await fsc(fetch).quote("XKRX:123450");
    expect([answered.session_date, answered.price, answered.instrument?.listing]).toEqual([
      "2025-03-10",
      7_100,
      null,
    ]);
    expect(answered.field_states?.session_date?.reason).toBe(
      "the FSC's latest row of 123450 is of 2025-03-10; it lists no session of it since",
    );
    expect(fetch.requests.map((request) => new URL(request.url).searchParams.get("beginBasDt"))).toEqual([
      "20261026",
      null,
    ]);
  });

  test("a history the FSC starts within the window: marked incomplete from its first session, nothing earlier", async () => {
    const fetch = stub((url) =>
      url.searchParams.get("numOfRows") === "1"
        ? { body: answer([], { rows: 1, total: 0 }) }
        : { body: answer([item("2026-11-24", 21_000, 500), item("2026-11-23", 20_500, 5_500)]) },
    );
    const bars = await fsc(fetch).daily("XKRX:123450", "2026-11-01", "2026-11-24");
    expect(bars.coverage).toEqual({
      from: "2026-11-23",
      through: "2026-11-24",
      complete: false,
      complete_reason: "insufficient_history",
      history_from: "2026-11-23",
      missing_sessions: 0,
    });
    expect(bars.earlier_end).toBeNull();
  });

  test("a window without a session of a share the FSC holds is no_data, naming it; a code it holds no row of is unsupported", async () => {
    // The window empty; the share's whole history (one row asked, to count them) holds rows.
    const held = stub((url) => ({
      body: url.searchParams.has("beginBasDt")
        ? answer([])
        : answer([item("2026-11-20", 10_000, 100)], { rows: 1, total: 250 }),
    }));
    const error = await failure(fsc(held).daily("XKRX:123450", "2026-11-21", "2026-11-22"));
    expect([error.kind, error.message]).toEqual([
      "no_data",
      "its stock prices hold no session of XKRX:123450 from 2026-11-21 to 2026-11-22",
    ]);
    expect(held.requests.map((request) => new URL(request.url).searchParams.get("numOfRows"))).toEqual([
      "10000",
      "1",
    ]);
    // No row of the code at all: not a share the FSC's stock prices list, so the router says every reason.
    const none = await failure(
      fsc(stub(() => ({ body: answer([]) }))).daily("XKRX:123450", "2026-11-21", "2026-11-22"),
    );
    expect([none.kind, none.message]).toEqual([
      "unsupported",
      "its stock prices list KOSPI, KOSDAQ and KONEX shares and hold no row of the code 123450 (XKRX:123450)",
    ]);
  });
});

describe("several quotes, the cache, a cancelled call", () => {
  test("many: each listing's own answer or failure, with its kind", async () => {
    const fetch = stub((url) => ({
      body: url.searchParams.get("likeSrtnCd") === "005930" ? SAMSUNG : answer([]),
    }));
    const batch = await fsc(fetch).many(["XKRX:005930", "XKRX:999990", "AAPL"]);
    expect(batch.quotes.map((one) => [one.instrument, one.quote.price])).toEqual([["XKRX:005930", 83000]]);
    expect(batch.errors.map((one) => [one.instrument, one.kind])).toEqual([
      ["XKRX:999990", "unsupported"],
      ["AAPL", "unsupported"],
    ]);
  });

  test("many: every listing failing for one reason (the day's requests spent) is the call's failure", async () => {
    const fetch = stub(() => ({
      body: envelope("22", "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR"),
      headers: XML_TYPE,
    }));
    const error = await failure(fsc(fetch).many(["XKRX:005930", "XKOS:035900"]));
    expect(error.kind).toBe("quota");
  });

  test("an answer is kept a while: the same window asked again sends nothing", async () => {
    const fetch = stub(() => ({ body: SAMSUNG }));
    const { quote } = fsc(fetch);
    await quote("XKRX:005930");
    await quote("005930.KS");
    expect(fetch.requests).toHaveLength(1);
  });

  test("a cancelled call is the caller's, and nothing is asked", async () => {
    const fetch = stub(() => ({ body: SAMSUNG }));
    const controller = new AbortController();
    controller.abort(new Error("stopped by the caller"));
    const error = await fsc(fetch)
      .quote("XKRX:005930", { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("stopped by the caller");
    expect(fetch.requests).toEqual([]);
  });
});
