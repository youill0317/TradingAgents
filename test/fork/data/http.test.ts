// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The data client with scripted answers and fake elapsed time (no network): what each status and failure
 * becomes, when it waits and retries, the published per-host rates, the User-Agent each host gets, and that
 * no key reaches a message.
 */
import { describe, expect, test } from "bun:test";
import { DataError } from "../../../src/data/errors.js";
import {
  createHttp,
  FORK_REQUEST_MS,
  Pacer,
  RETRY_PAUSE_MS,
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
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
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
    expect(ruleFor("api.gdeltproject.org")?.pace).toEqual({ requests: 1, perMs: 5_000 });
    expect(
      ["notsec.gov", "fred.stlouisfed.org", "data-api.ecb.europa.eu"].map((host) => ruleFor(host)),
    ).toEqual([undefined, undefined, undefined]);
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
    expect(FORK_REQUEST_MS.read).toBe(30_000);
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

  test("something that is not a URL is the caller's mistake, said without echoing it", async () => {
    await expect(
      client(scripted(ok("")).fetch).http.get(`not a url ${KEY}`, { source: "X" }),
    ).rejects.toThrow("the data client was given something that is not a URL");
  });
});
