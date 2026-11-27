// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The data client with scripted answers and fake elapsed time (no network): what each status and failure
 * becomes, when it waits and retries, the published per-host rates, the User-Agent each host gets, that no
 * key reaches a message, and which redirects a request passing `redirect: "same-origin"` (Korea's sources, for
 * their keys) follows (two stub servers on 127.0.0.1).
 */
import { describe, expect, test } from "bun:test";
import { DataError } from "../../../src/data/errors.js";
import {
  createHttp,
  FORK_REQUEST_MS,
  Pacer,
  RETRY_PAUSE_MS,
  requestTimeout,
  retryAfterMs,
  ruleFor,
} from "../../../src/fork/data/http.js";
import { fakeTimer } from "./harness.js";

type Scripted = Response | Error | "hang" | ((url: string) => Response);

/** A fetch answering each request with the next scripted answer (the last one repeats); requests are listed. */
function scripted(...answers: Scripted[]) {
  const requests: { url: string; headers: Headers }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    const answer = answers.length > 1 ? (answers.shift() as Scripted) : (answers[0] as Scripted);
    if (answer === "hang") {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(url) : answer.clone();
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const ok = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers });
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response("refused", { status: code, headers });

const KEY = "fred-key-0123456789abcdef";
const ECOS = "ECOS/KEY+with/odd=chars";

function client(fetch: typeof globalThis.fetch, extra: { secUserAgent?: string } = {}) {
  const timer = fakeTimer();
  const http = createHttp({ fetch, timer, pacer: new Pacer(), secrets: [KEY, ECOS], ...extra });
  return { http, timer };
}

/** The DataError `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<DataError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error("it answered");
}

describe("answers", () => {
  test("text, JSON and bytes, the body read once", async () => {
    const { fetch } = scripted(ok('{"a":[1,2]}', { "content-type": "application/json" }));
    const { http } = client(fetch);
    const answer = await http.get("https://data-api.ecb.europa.eu/x", { source: "ECB" });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ a: [1, 2] });
    expect(await answer.text()).toBe('{"a":[1,2]}');
    expect((await answer.bytes()).length).toBe(11);
    expect(await http.text("https://data-api.ecb.europa.eu/x", { source: "ECB" })).toBe('{"a":[1,2]}');
  });

  test("a body that is not JSON, asked for as JSON, is the source being unavailable", async () => {
    const { fetch } = scripted(ok("<html>maintenance</html>"));
    const error = await failure(
      client(fetch).http.json("https://markets.newyorkfed.org/api/x", { source: "New York Fed" }),
    );
    expect(error.kind).toBe("unavailable");
    expect(error.message).toBe("New York Fed answered with something other than JSON.");
  });

  test("a body past its bound is unavailable, as upstream says it", async () => {
    const { fetch } = scripted(ok("x".repeat(2_000)));
    const error = await failure(
      client(fetch).http.text("https://data.sec.gov/x", { source: "SEC EDGAR", maxBytes: 1_000 }),
    );
    expect(error.kind).toBe("unavailable");
    expect(error.message).toBe("SEC EDGAR answered more than 1000 bytes.");
  });

  test("the default bound fits the largest answer measured (SEC companyfacts, 9.3 MB) and stops a runaway", async () => {
    const largest = 9_337_094;
    const big = await client(scripted(ok("x".repeat(largest))).fetch).http.bytes(
      "https://data.sec.gov/api/xbrl/companyfacts/CIK0001099219.json",
      { source: "SEC EDGAR" },
    );
    expect(big.length).toBe(largest);
    const runaway = await failure(
      client(scripted(ok("x".repeat(16_777_217))).fetch).http.bytes("https://data.sec.gov/x", {
        source: "SEC EDGAR",
      }),
    );
    expect([runaway.kind, runaway.message]).toEqual([
      "unavailable",
      "SEC EDGAR answered more than 16777216 bytes.",
    ]);
  });

  test("statuses the caller reads itself are answered", async () => {
    const { fetch } = scripted(
      new Response('{"error_message":"Bad Request.  The series does not exist."}', { status: 400 }),
    );
    const answer = await client(fetch).http.get("https://api.stlouisfed.org/fred/series", {
      source: "FRED",
      accept: [400],
    });
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error_message: "Bad Request.  The series does not exist." });
  });
});

describe("failures, by kind", () => {
  test("404 and 410: no_data unless the caller says otherwise", async () => {
    const url = "https://data.sec.gov/submissions/CIK9999999999.json";
    expect(
      (await failure(client(scripted(status(404)).fetch).http.json(url, { source: "SEC EDGAR" }))).kind,
    ).toBe("no_data");
    const unsupported = await failure(
      client(scripted(status(410)).fetch).http.json(url, {
        source: "SEC EDGAR",
        notFound: "unsupported",
        notFoundMessage: "SEC EDGAR has no filer with that CIK",
      }),
    );
    expect([unsupported.kind, unsupported.message, unsupported.details.status]).toEqual([
      "unsupported",
      "SEC EDGAR has no filer with that CIK",
      410,
    ]);
    const invalid = await failure(
      client(scripted(status(404)).fetch).http.json(url, { source: "X", notFound: "invalid" }),
    );
    expect([invalid.kind, invalid.details.retry]).toEqual(["invalid", "change_request"]);
  });

  test("SEC's 404 is mapped by its status before its body, an S3 XML page, is read as anything", async () => {
    // The saved shape of data.sec.gov's answer for a CIK it does not have (request and host ids shortened).
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>submissions/CIK9999999999.json</Key><RequestId>R01</RequestId><HostId>h</HostId></Error>`;
    const { fetch } = scripted(
      new Response(body, { status: 404, headers: { "content-type": "application/xml" } }),
    );
    const error = await failure(
      client(fetch).http.json("https://data.sec.gov/submissions/CIK9999999999.json", {
        source: "SEC EDGAR",
        notFoundMessage: "SEC EDGAR has no filer with CIK 9999999999",
      }),
    );
    expect([error.kind, error.message, error.details.status]).toEqual([
      "no_data",
      "SEC EDGAR has no filer with CIK 9999999999",
      404,
    ]);
  });

  test("401 and 403 are refusals; SEC's 403 explains its User-Agent rule without quoting it", async () => {
    const sec = await failure(
      client(scripted(status(403)).fetch, { secUserAgent: "Jane Doe jane@example.com" }).http.get(
        "https://www.sec.gov/files/company_tickers.json",
        { source: "SEC EDGAR" },
      ),
    );
    expect(sec.kind).toBe("rejected");
    expect(sec.message).toContain("SEC_USER_AGENT");
    expect(sec.message).toContain("10 requests a second");
    expect(sec.message).not.toContain("jane@example.com");
    const other = await failure(
      client(scripted(status(401)).fetch).http.get("https://api.stlouisfed.org/x", { source: "FRED" }),
    );
    expect([other.kind, other.message]).toEqual(["rejected", "FRED refused the request (HTTP 401)."]);
  });

  test("another 4xx is the source being unavailable, not a fact about the market", async () => {
    const error = await failure(
      client(scripted(status(418)).fetch).http.get("https://example.org/x", { source: "Teapot" }),
    );
    expect([error.kind, error.message]).toEqual(["unavailable", "Teapot answered HTTP 418."]);
  });
});

describe("waits and retries", () => {
  test("429 without Retry-After: rate_limited at once, never retried", async () => {
    const { fetch, requests } = scripted(status(429), ok("late"));
    const { http, timer } = client(fetch);
    const error = await failure(http.get("https://en.wikipedia.org/w/api.php", { source: "Wikipedia" }));
    expect([error.kind, error.details.retryAfterMs]).toEqual(["rate_limited", undefined]);
    expect(requests).toHaveLength(1);
    expect(timer.slept).toEqual([]);
  });

  test("429 with a Retry-After that fits the deadline: waited, then asked again", async () => {
    const { fetch, requests } = scripted(status(429, { "retry-after": "8" }), ok("list"));
    const { http, timer } = client(fetch);
    expect(await http.text("https://en.wikipedia.org/w/api.php", { source: "Wikipedia" })).toBe("list");
    expect(requests).toHaveLength(2);
    expect(timer.slept).toEqual([8_000]);
  });

  test("a Retry-After past the deadline is not waited for: rate_limited with the wait", async () => {
    const { fetch, requests } = scripted(status(429, { "retry-after": "45" }), ok("late"));
    const { http, timer } = client(fetch);
    const error = await failure(http.get("https://en.wikipedia.org/w/api.php", { source: "Wikipedia" }));
    expect([error.kind, error.details.retryAfterMs, error.details.status]).toEqual([
      "rate_limited",
      45_000,
      429,
    ]);
    expect(requests).toHaveLength(1);
    expect(timer.slept).toEqual([]);
    // A caller with a longer deadline waits for it.
    const patient = scripted(status(429, { "retry-after": "45" }), ok("list"));
    expect(
      await client(patient.fetch).http.text("https://en.wikipedia.org/w", {
        source: "Wikipedia",
        timeoutMs: 60_000,
      }),
    ).toBe("list");
  });

  test("503 with Retry-After as an HTTP date; a second refusal after the wait is said with its wait", async () => {
    const soon = new Date(Date.now() + 5_000).toUTCString();
    const { fetch, requests } = scripted(
      status(503, { "retry-after": soon }),
      status(503, { "retry-after": "3" }),
    );
    const { http, timer } = client(fetch);
    const error = await failure(http.get("https://home.treasury.gov/x", { source: "U.S. Treasury" }));
    expect(requests).toHaveLength(2);
    expect(timer.slept).toHaveLength(1);
    expect(timer.slept[0]).toBeGreaterThan(3_000);
    expect(timer.slept[0]).toBeLessThanOrEqual(5_000);
    expect([error.kind, error.details.retryAfterMs]).toEqual(["rate_limited", 3_000]);
  });

  test("a 5xx is retried once after a pause; a second is unavailable", async () => {
    const once = scripted(status(502), ok("fine"));
    const first = client(once.fetch);
    expect(await first.http.text("https://markets.newyorkfed.org/x", { source: "New York Fed" })).toBe(
      "fine",
    );
    expect(first.timer.slept).toEqual([RETRY_PAUSE_MS]);
    const twice = scripted(status(500), status(500), ok("never asked"));
    const error = await failure(
      client(twice.fetch).http.text("https://markets.newyorkfed.org/x", { source: "New York Fed" }),
    );
    expect([error.kind, error.message, twice.requests.length]).toEqual([
      "unavailable",
      "New York Fed answered HTTP 500.",
      2,
    ]);
  });

  test("a dropped connection is retried once; a second is unavailable, its message without the address", async () => {
    const reset = Object.assign(
      new TypeError(`ECONNRESET at https://api.stlouisfed.org/fred?api_key=${KEY}`),
      {
        code: "ECONNRESET",
      },
    );
    const once = scripted(reset, ok("fine"));
    expect(
      await client(once.fetch).http.text(`https://api.stlouisfed.org/fred?api_key=${KEY}`, {
        source: "FRED",
      }),
    ).toBe("fine");
    const twice = scripted(reset, reset);
    const error = await failure(
      client(twice.fetch).http.text(`https://api.stlouisfed.org/fred?api_key=${KEY}`, { source: "FRED" }),
    );
    expect([error.kind, error.message]).toEqual(["unavailable", "FRED could not be reached (ECONNRESET)."]);
    expect(twice.requests).toHaveLength(2);
  });

  test("each class of source has its deadline: the ECB's hosts the slow one; a caller's own wins", () => {
    expect(requestTimeout("data.sec.gov")).toBe(FORK_REQUEST_MS.api);
    expect(requestTimeout("markets.newyorkfed.org")).toBe(30_000);
    expect(requestTimeout("data-api.ecb.europa.eu")).toBe(FORK_REQUEST_MS.slow);
    expect(FORK_REQUEST_MS.slow).toBeGreaterThan(21_300);
    expect(requestTimeout("data-api.ecb.europa.eu", 5_000)).toBe(5_000);
    expect(requestTimeout("www.sec.gov", FORK_REQUEST_MS.bulk)).toBe(60_000);
  });

  test("a request that hangs ends at its deadline, unavailable and not retried", async () => {
    const { fetch, requests } = scripted("hang");
    const error = await failure(
      client(fetch).http.get("https://data-api.ecb.europa.eu/x", { source: "ECB", timeoutMs: 50 }),
    );
    expect(error.kind).toBe("unavailable");
    expect(error.message).toStartWith("ECB did not answer within");
    expect(requests).toHaveLength(1);
  });

  test("a cancelled call is the caller's: its reason, as it came, and no retry", async () => {
    const { fetch, requests } = scripted("hang");
    const controller = new AbortController();
    const pending = client(fetch).http.get("https://data-api.ecb.europa.eu/x", {
      source: "ECB",
      signal: controller.signal,
    });
    while (!requests.length) await Bun.sleep(0);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(1);
    // Cancelled before it was sent, it sends nothing.
    const early = new AbortController();
    const unsent = client(fetch).http.get("https://data-api.ecb.europa.eu/y", {
      source: "ECB",
      signal: early.signal,
    });
    early.abort();
    await expect(unsent).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(1);
  });

  test("Retry-After values", () => {
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("12")).toBe(12_000);
    expect(retryAfterMs("1.5")).toBe(1_500);
    expect(retryAfterMs("Wed, 25 Nov 2026 15:00:10 GMT", Date.parse("2026-11-25T15:00:00Z"))).toBe(10_000);
    expect(retryAfterMs("Wed, 25 Nov 2026 14:00:00 GMT", Date.parse("2026-11-25T15:00:00Z"))).toBe(0);
    expect(retryAfterMs("soon")).toBeUndefined();
  });
});

describe("the rates services publish", () => {
  test("which hosts have one", () => {
    expect(
      ["www.sec.gov", "data.sec.gov", "efts.sec.gov", "SEC.GOV"].map((host) => ruleFor(host)?.name),
    ).toEqual(["sec.gov", "sec.gov", "sec.gov", "sec.gov"]);
    expect(ruleFor("api.stlouisfed.org")?.pace).toEqual({ requests: 120, perMs: 60_000 });
    // FRED's website: robots.txt's Crawl-delay of one second.
    expect(ruleFor("fred.stlouisfed.org")?.pace).toEqual({ requests: 1, perMs: 1_000 });
    expect(ruleFor("api.gdeltproject.org")?.pace).toEqual({ requests: 1, perMs: 5_000 });
    // KOSIS's Open API: 200 requests a minute.
    expect(ruleFor("kosis.kr")?.pace).toEqual({ requests: 200, perMs: 60_000 });
    expect(["notsec.gov", "stlouisfed.org", "data-api.ecb.europa.eu"].map((host) => ruleFor(host))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    // None for OpenDART, ECOS, data.go.kr or Naver: their documents give no number of requests a second or a
    // minute, and their daily quotas are theirs to enforce.
    expect(
      ["opendart.fss.or.kr", "ecos.bok.or.kr", "apis.data.go.kr", "openapi.naver.com"].map((host) =>
        ruleFor(host),
      ),
    ).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("SEC: ten requests in any second, across its hosts", async () => {
    const { fetch, requests } = scripted(ok("{}"));
    const { http, timer } = client(fetch);
    const hosts = ["data.sec.gov", "www.sec.gov"];
    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        http.text(`https://${hosts[i % 2]}/${i}`, { source: "SEC EDGAR" }),
      ),
    );
    expect(requests).toHaveLength(15);
    // Ten start at once; the other five each wait for the second to turn.
    expect(timer.slept).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
  });

  test("FRED: 120 a minute; a turn after the deadline fails at once as rate_limited", async () => {
    const { fetch, requests } = scripted(ok("{}"));
    const { http, timer } = client(fetch);
    for (let i = 0; i < 120; i++)
      await http.text(`https://api.stlouisfed.org/fred/series?id=${i}`, { source: "FRED" });
    const error = await failure(
      http.text("https://api.stlouisfed.org/fred/series?id=late", { source: "FRED" }),
    );
    expect([error.kind, error.details.retryAfterMs]).toEqual(["rate_limited", 60_000]);
    expect(error.message).toContain("120 requests every 60 s");
    expect(requests).toHaveLength(120);
    expect(timer.slept).toEqual([]);
  });

  test("GDELT: one request per 5 s; a call whose turn would come after its deadline fails at once", async () => {
    const { fetch, requests } = scripted((url) => ok(url));
    const { http, timer } = client(fetch);
    const calls = Array.from({ length: 8 }, (_, i) =>
      http.text(`https://api.gdeltproject.org/api/v2/doc/doc?query=q${i}`, { source: "GDELT" }).then(
        (text) => ({ text }),
        (error: DataError) => ({ kind: error.kind, retryAfterMs: error.details.retryAfterMs }),
      ),
    );
    const results = await Promise.all(calls);
    expect(results.slice(0, 7).every((result) => "text" in result)).toBe(true);
    expect(results[7]).toEqual({ kind: "rate_limited", retryAfterMs: 35_000 });
    expect(requests).toHaveLength(7);
    expect(timer.slept).toEqual([5_000, 10_000, 15_000, 20_000, 25_000, 30_000]);
    expect(FORK_REQUEST_MS.api).toBe(30_000);
  });

  test("GDELT: identical requests in flight share one answer; one caller cancelling leaves the others theirs", async () => {
    let release = (_: Response) => {};
    const { fetch, requests } = scripted(() => ok("never"));
    const gated = (async (input: string | URL | Request, init?: RequestInit) => {
      await new Promise<void>((resolve) => {
        release = (response) => {
          resolve();
          return response;
        };
      });
      return fetch(input, init);
    }) as typeof globalThis.fetch;
    const { http } = client(gated);
    const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=fed&mode=ArtList&format=json";
    const leaving = new AbortController();
    const first = http.text(url, { source: "GDELT" });
    const second = http.text(url, { source: "GDELT", signal: leaving.signal }).then(
      () => "answered",
      (error: Error) => error.name,
    );
    const third = http.json(url, { source: "GDELT" }).catch((error: DataError) => error.kind);
    leaving.abort();
    await Bun.sleep(0);
    release(ok("never"));
    expect(await first).toBe("never");
    expect(await second).toBe("AbortError");
    expect(await third).toBe("unavailable");
    expect(requests).toHaveLength(1);
  });
});

describe("who is named, and what is never said", () => {
  test("SEC's hosts get SEC_USER_AGENT; the others, and SEC without one, the app's name", async () => {
    const { fetch, requests } = scripted(ok("{}"));
    const named = client(fetch, { secUserAgent: "Jane Doe jane@example.com" });
    await named.http.text("https://data.sec.gov/submissions/CIK0000320193.json", { source: "SEC EDGAR" });
    await named.http.text("https://markets.newyorkfed.org/api/rates/all/latest.json", {
      source: "New York Fed",
    });
    await client(fetch).http.text("https://data.sec.gov/x", {
      source: "SEC EDGAR",
      headers: { "User-Agent": "mine" },
    });
    expect(requests.map((request) => request.headers.get("user-agent"))).toEqual([
      "Jane Doe jane@example.com",
      "tradingagents/1.0.0",
      "tradingagents/1.0.0",
    ]);
    const own = createHttp({
      fetch,
      timer: fakeTimer(),
      pacer: new Pacer(),
      userAgent: "TradingAgents-fork-dev/1.0",
    });
    await own.text("https://data-api.ecb.europa.eu/x", { source: "ECB" });
    expect(requests.at(-1)?.headers.get("user-agent")).toBe("TradingAgents-fork-dev/1.0");
  });

  test("a key never reaches a message: in a query or a path, written plainly or URL-encoded", async () => {
    const message = `no series at https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(ECOS)}/json/kr/1/10 (key ${ECOS}, ${KEY})`;
    const error = await failure(
      client(scripted(status(404)).fetch).http.json(
        `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(ECOS)}/json`,
        {
          source: "ECOS",
          notFoundMessage: message,
        },
      ),
    );
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain(ECOS);
    expect(error.message).not.toContain(encodeURIComponent(ECOS));
    expect(error.message).toBe(
      "no series at https://ecos.bok.or.kr/api/StatisticSearch/***/json/kr/1/10 (key ***, ***)",
    );
    expect(client(scripted(ok("")).fetch).http.redact(`api_key=${KEY}`)).toBe("api_key=***");
  });

  test("a header fetch refuses to send: unavailable, unsent and not retried, the header named, its value never", async () => {
    const value = `Hd8sK2mQ5w${String.fromCharCode(0x200b)}`;
    for (const redirect of ["follow", "same-origin"] as const) {
      const { fetch, requests } = scripted(ok("{}"));
      const { http, timer } = client(fetch);
      const error = await failure(
        http.get("https://openapi.naver.com/v1/search/news.json?query=x", {
          source: "Naver",
          headers: { "X-Naver-Client-Id": "Xq3LkZ9pWm2RtY7vBn4C", "X-Naver-Client-Secret": value },
          redirect,
        }),
      );
      expect(error.kind).toBe("unavailable");
      expect(error.message).toBe(
        "Naver was not asked: the X-Naver-Client-Secret header of its request holds a character a header cannot carry.",
      );
      expect(error.message).not.toContain("Hd8sK2mQ5w");
      expect(requests).toEqual([]);
      expect(timer.slept).toEqual([]);
    }
    // A User-Agent fetch cannot send is said the same way.
    const { fetch, requests } = scripted(ok("{}"));
    const error = await failure(
      client(fetch, { secUserAgent: `Jane Doe ${String.fromCharCode(0x2028)} jane@example.com` }).http.get(
        "https://data.sec.gov/x",
        { source: "SEC EDGAR" },
      ),
    );
    expect([error.kind, error.message]).toEqual([
      "unavailable",
      "SEC EDGAR was not asked: the User-Agent header of its request holds a character a header cannot carry.",
    ]);
    expect(requests).toEqual([]);
  });

  test("Yahoo is never asked through this client: its address is refused before any request", async () => {
    const { fetch, requests } = scripted(ok("{}"));
    for (const url of [
      "https://query2.finance.yahoo.com/v7/finance/quote?symbols=AAPL",
      "https://finance.yahoo.com/quote/AAPL",
    ]) {
      await expect(client(fetch).http.get(url, { source: "Yahoo" })).rejects.toThrow("yahoo-finance2");
    }
    expect(requests).toEqual([]);
  });

  test("something that is not a URL is the caller's mistake, said without echoing it", async () => {
    await expect(
      client(scripted(ok("")).fetch).http.get(`not a url ${KEY}`, { source: "X" }),
    ).rejects.toThrow("the data client was given something that is not a URL");
  });

  test("same-origin (a key in the request) follows a redirect to its own origin only; others follow as fetch does", async () => {
    // Two stub servers on 127.0.0.1: two origins. The first redirects within itself and to the second.
    const reached: string[] = [];
    const other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        reached.push(`${url.pathname}${url.search} ${request.headers.get("x-naver-client-secret") ?? "-"}`);
        return new Response("elsewhere");
      },
    });
    const home = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/same") {
          return new Response(null, { status: 302, headers: { location: `/landed${url.search}` } });
        }
        if (url.pathname === "/away") {
          return new Response(null, {
            status: 307,
            headers: { location: `http://localhost:${other.port}/elsewhere${url.search}` },
          });
        }
        return new Response(`landed at ${url.pathname}`);
      },
    });
    try {
      const http = createHttp({
        fetch: globalThis.fetch,
        timer: fakeTimer(),
        pacer: new Pacer(),
        secrets: [KEY],
      });
      const base = `http://127.0.0.1:${home.port}`;
      const keyed = {
        source: "OpenDART",
        redirect: "same-origin" as const,
        headers: { "X-Naver-Client-Secret": KEY },
      };
      expect(await http.text(`${base}/same?crtfc_key=${KEY}`, keyed)).toBe("landed at /landed");
      const refused = await failure(http.get(`${base}/away?crtfc_key=${KEY}`, keyed));
      expect([refused.kind, refused.details.status]).toEqual(["unavailable", 307]);
      expect(refused.message).toBe(
        "OpenDART sent the request on to another address (HTTP 307), which is not followed with its key.",
      );
      // Nothing reached the other origin: neither the key in the address nor the one in the headers.
      expect(reached).toEqual([]);
      // Without the option, a redirect is followed as fetch follows it, as before.
      expect(await http.text(`${base}/away?x=1`, { source: "Somewhere" })).toBe("elsewhere");
      expect(reached).toEqual(["/elsewhere?x=1 -"]);
    } finally {
      home.stop(true);
      other.stop(true);
    }
  });
});

describe("pauses a source asks for, shared requests, and starts that run late", () => {
  const wiki = (title: string) => `https://en.wikipedia.org/w/index.php?title=${title}&action=raw`;

  test("a Retry-After holds for the host's next requests: refused unsent while it outlasts their deadline, waited for when it fits", async () => {
    const { fetch, requests } = scripted(status(429, { "retry-after": "120" }), ok("list"));
    const { http, timer } = client(fetch);
    const first = await failure(http.text(wiki("A"), { source: "Wikipedia" }));
    expect([first.kind, first.details.retryAfterMs]).toEqual(["rate_limited", 120_000]);
    // No time has passed: Wikipedia asked for 120 s of quiet, so the next request is not sent.
    const second = await failure(http.text(wiki("B"), { source: "Wikipedia" }));
    expect([second.kind, second.details.retryAfterMs]).toEqual(["rate_limited", 120_000]);
    expect(second.message).toBe(
      "Wikipedia asked to wait before its next request, 120 s more: longer than this one's 30 s deadline.",
    );
    expect(requests).toHaveLength(1);
    // Another host is not held.
    expect(await http.text("https://markets.newyorkfed.org/api/x", { source: "New York Fed" })).toBe("list");
    // A caller whose deadline the pause fits waits it out, then asks.
    expect(await http.text(wiki("C"), { source: "Wikipedia", timeoutMs: 150_000 })).toBe("list");
    expect(timer.slept).toEqual([120_000]);
    expect(requests.map((request) => request.url)).toEqual([
      wiki("A"),
      "https://markets.newyorkfed.org/api/x",
      wiki("C"),
    ]);
    // Once it has passed, requests go at once.
    expect(await http.text(wiki("D"), { source: "Wikipedia" })).toBe("list");
    expect(timer.slept).toEqual([120_000]);
  });

  test("SEC's hosts share their pause, as they share their rate", async () => {
    const { fetch, requests } = scripted(status(503, { "retry-after": "40" }), ok("{}"));
    const { http } = client(fetch, { secUserAgent: "Jane Doe jane@example.com" });
    const refused = await failure(http.text("https://www.sec.gov/files/x.json", { source: "SEC EDGAR" }));
    expect([refused.kind, refused.details.status]).toEqual(["rate_limited", 503]);
    const held = await failure(
      http.text("https://data.sec.gov/submissions/CIK0000320193.json", { source: "SEC EDGAR" }),
    );
    expect([held.kind, held.details.retryAfterMs]).toEqual(["rate_limited", 40_000]);
    expect(requests).toHaveLength(1);
  });

  test("a host is the same host in capitals or with the trailing dot of a fully-qualified name", async () => {
    expect(ruleFor("DATA.SEC.GOV.")?.name).toBe("sec.gov");
    expect(ruleFor("api.gdeltproject.org.")?.name).toBe("api.gdeltproject.org");
    expect(requestTimeout("data-api.ecb.europa.eu.")).toBe(FORK_REQUEST_MS.slow);
    const { fetch, requests } = scripted(ok("{}"));
    for (const url of [
      "https://query1.finance.yahoo.com./v7/finance/quote?symbols=AAPL",
      "https://FINANCE.YAHOO.COM../quote/AAPL",
    ]) {
      await expect(client(fetch).http.get(url, { source: "x" })).rejects.toThrow("yahoo-finance2");
    }
    expect(requests).toEqual([]);
    const { http, timer } = client(fetch, { secUserAgent: "Jane Doe jane@example.com" });
    await Promise.all(
      Array.from({ length: 15 }, () =>
        http.text("https://data.sec.gov./submissions/CIK0000320193.json", { source: "SEC EDGAR" }),
      ),
    );
    expect(timer.slept).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
    expect(new Set(requests.map((request) => request.headers.get("user-agent")))).toEqual(
      new Set(["Jane Doe jane@example.com"]),
    );
  });

  const gdelt = (query: string) =>
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&format=json`;
  /** Lets the fake timer wake every sleeper there is. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  test("GDELT: a request every caller has cancelled is cancelled unsent, and its turn given back", async () => {
    const { fetch, requests } = scripted((url) => ok(url));
    const { http, timer } = client(fetch);
    await http.text(gdelt("first"), { source: "GDELT" });
    // Six questions at once, each waiting for its turn; the person cancels the run.
    const controller = new AbortController();
    const asked = ["fed", "ecb", "oil", "china", "jobs", "chips"].map((query) =>
      http
        .text(gdelt(query), { source: "GDELT", signal: controller.signal })
        .catch((error: Error) => error.name),
    );
    controller.abort();
    expect(await Promise.all(asked)).toEqual(Array.from({ length: 6 }, () => "AbortError"));
    await settle();
    expect(requests.map((request) => new URL(request.url).searchParams.get("query"))).toEqual(["first"]);
    // The next question takes the first turn after "first", not one after the cancelled six.
    expect(await http.text(gdelt("again"), { source: "GDELT" })).toBe(gdelt("again"));
    expect(timer.slept.at(-1)).toBe(5_000);
    expect(requests).toHaveLength(2);
  });

  test("GDELT: a caller already cancelled starts nothing", async () => {
    const { fetch, requests } = scripted((url) => ok(url));
    const { http } = client(fetch);
    const gone = new AbortController();
    gone.abort();
    await expect(http.text(gdelt("fed"), { source: "GDELT", signal: gone.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(requests).toHaveLength(0);
    expect(await http.text(gdelt("fed"), { source: "GDELT" })).toBe(gdelt("fed"));
    expect(requests).toHaveLength(1);
  });

  test("GDELT: a caller does not join a shared request whose turn comes after its own deadline", async () => {
    const { fetch, requests } = scripted((url) => ok(url));
    const { http } = client(fetch);
    await http.text(gdelt("first"), { source: "GDELT" });
    const waiting = http.text(gdelt("second"), { source: "GDELT" });
    const hurried = await failure(http.text(gdelt("second"), { source: "GDELT", timeoutMs: 1_000 }));
    expect([hurried.kind, hurried.details.retryAfterMs]).toEqual(["rate_limited", 5_000]);
    expect(hurried.message).toContain("this one's turn comes after its 1 s deadline");
    const patient = http.text(gdelt("second"), { source: "GDELT", timeoutMs: 10_000 });
    expect(await waiting).toBe(gdelt("second"));
    expect(await patient).toBe(gdelt("second"));
    expect(requests).toHaveLength(2);
  });

  test("a turn cancelled while it waits is given back to those after it", async () => {
    const { fetch } = scripted(ok("{}"));
    const { http, timer } = client(fetch);
    const sec = (i: number) => `https://data.sec.gov/x/${i}`;
    await Promise.all(Array.from({ length: 10 }, (_, i) => http.text(sec(i), { source: "SEC EDGAR" })));
    // Ten more would wait for the next second; they are cancelled while they wait.
    const controller = new AbortController();
    const cancelled = Array.from({ length: 10 }, (_, i) =>
      http.text(sec(10 + i), { source: "SEC EDGAR", signal: controller.signal }).catch(() => "cancelled"),
    );
    controller.abort();
    await Promise.all(cancelled);
    await http.text(sec(99), { source: "SEC EDGAR" });
    // The next second's first turn, not the one after the ten cancelled.
    expect(timer.slept.at(-1)).toBe(1_000);
  });

  test("starts are counted when they are made: requests woken late never put more in a second than SEC allows", async () => {
    const starts: number[] = [];
    // The second second's turns are woken 4 ms late, the third's 1 ms late, as a busy timer may.
    const timer = fakeTimer(0, (index) => (index < 10 ? 4 : 1));
    const fetch = (async () => {
      starts.push(timer.now());
      return ok("{}");
    }) as unknown as typeof globalThis.fetch;
    const http = createHttp({ fetch, timer, pacer: new Pacer(), secUserAgent: "Jane Doe jane@example.com" });
    const hosts = ["https://data.sec.gov/x", "https://www.sec.gov/y", "https://efts.sec.gov/z"];
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => http.text(`${hosts[i % 3]}/${i}`, { source: "SEC EDGAR" })),
    );
    expect(starts).toHaveLength(25);
    const most = Math.max(
      ...starts.map((start) => starts.filter((t) => t >= start && t < start + 1_000).length),
    );
    expect(most).toBe(10);
    // The third second's requests waited for the second's late starts to leave the window.
    expect(Math.min(...starts.slice(20))).toBeGreaterThanOrEqual(Math.max(...starts.slice(10, 20)) + 1_000);
  });
});
