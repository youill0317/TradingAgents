// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Yahoo's failures as the router reads them (sources/yahoo-call.ts): through the fork's yahoo-finance2
 * client on hand-made answers (an answer for each status, the AAPL quote fixture with a market state the
 * library's schema refuses), and the library's own errors as its documentation and source write them.
 */
import { describe, expect, test } from "bun:test";
import { DataError } from "../../../src/data/errors.js";
import { MESSAGE_CHARS, yahooCall, yahooFailure } from "../../../src/fork/data/sources/yahoo-call.js";
import { fixture, testDeps, YAHOO_AAPL } from "./harness.js";

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

/** The fork's client, its quote answered with `status` and `body` (after the cookie page and crumb). */
function quoting(
  status: number,
  body = '{"finance":{"result":null,"error":{"code":"x","description":"x"}}}',
) {
  return testDeps({}, [
    { match: /\/v7\/finance\/quote\?/, body, status, headers: { "content-type": "application/json" } },
    ...YAHOO_AAPL,
  ]).deps.yahoo;
}

describe("statuses, through the fork's client", () => {
  test("404: what the caller says it means (no_data unless it says otherwise)", async () => {
    const yahoo = quoting(404);
    const plain = await failure(yahooCall(() => yahoo.quote("AAPL")));
    expect([plain.kind, plain.details.status, plain.message]).toEqual([
      "no_data",
      404,
      "Yahoo has no such symbol or record (HTTP 404).",
    ]);
    // A Korean listing another provider may answer: a kind that passes the call on.
    const passed = await failure(
      yahooCall(() => yahoo.quote("005930.KS"), {
        notFound: "unsupported",
        notFoundMessage: "Yahoo does not list 005930 on KOSPI",
      }),
    );
    expect([passed.kind, passed.message]).toEqual(["unsupported", "Yahoo does not list 005930 on KOSPI"]);
  });

  test("429 rate_limited, 401 and 403 rejected, 5xx and others unavailable, a known status as the caller names it", async () => {
    const kinds: [number, string][] = [
      [429, "rate_limited"],
      [401, "rejected"],
      [403, "rejected"],
      [503, "unavailable"],
      [422, "unavailable"],
      [400, "unavailable"],
    ];
    for (const [status, kind] of kinds) {
      const error = await failure(yahooCall(() => quoting(status).quote("AAPL")));
      expect([status, error.kind, error.details.status, error.details.source]).toEqual([
        status,
        kind,
        status,
        "Yahoo",
      ]);
    }
    // An intraday range past Yahoo's depth: the caller knows 422 means another source may have it.
    const deep = await failure(
      yahooCall(() => quoting(422).quote("AAPL"), { statuses: { 422: "unsupported", 400: "invalid" } }),
    );
    expect(deep.kind).toBe("unsupported");
    const wrong = await failure(
      yahooCall(() => quoting(400).quote("AAPL"), { statuses: { 400: "invalid" } }),
    );
    expect([wrong.kind, wrong.details.retry]).toEqual(["invalid", "change_request"]);
  });

  test("an answer the library's schema refuses is unavailable, said as upstream says it", async () => {
    const quote = JSON.parse(new TextDecoder().decode(fixture("yahoo/quote-aapl.json"))) as {
      quoteResponse: { result: Record<string, unknown>[] };
    };
    (quote.quoteResponse.result[0] as Record<string, unknown>).marketState = "SOMETHING_NEW";
    const error = await failure(yahooCall(() => quoting(200, JSON.stringify(quote)).quote("AAPL")));
    expect([error.kind, error.message]).toEqual([
      "unavailable",
      "Yahoo could not be read (Failed Yahoo Schema validation).",
    ]);
  });

  test("a cancelled call is the caller's: the signal's reason, as it came", async () => {
    const controller = new AbortController();
    controller.abort(new Error("the question was cancelled"));
    const yahoo = quoting(200, new TextDecoder().decode(fixture("yahoo/quote-aapl.json")));
    await expect(
      yahooCall(() => yahoo.quote("AAPL", {}, { fetchOptions: { signal: controller.signal } }), {
        signal: controller.signal,
      }),
    ).rejects.toThrow("the question was cancelled");
  });

  test("an answer read is passed on untouched", async () => {
    const yahoo = quoting(200, new TextDecoder().decode(fixture("yahoo/quote-aapl.json")));
    const quote = await yahooCall(() => yahoo.quote("AAPL"));
    expect(quote.symbol).toBe("AAPL");
  });
});

describe("the library's own errors, without a status", () => {
  test("its words: too many requests, not found, a crumb's status; a deadline; anything else unavailable", () => {
    const of = (error: unknown, options = {}) => {
      const mapped = yahooFailure(error, options);
      return [mapped.kind, mapped.message];
    };
    expect(of(new Error("Failed to get crumb, status 429, statusText: Too Many Requests"))).toEqual([
      "rate_limited",
      "Yahoo is limiting requests (HTTP 429).",
    ]);
    expect(of(new Error("Too Many Requests"))).toEqual(["rate_limited", "Yahoo is limiting requests."]);
    expect(of(new Error("No data found, symbol may be delisted"))).toEqual([
      "no_data",
      "Yahoo has no such symbol or record (No data found, symbol may be delisted).",
    ]);
    expect(of(new Error("Quote not found for symbol: ZZZZ"), { notFound: "unavailable" })[0]).toBe(
      "unavailable",
    );
    expect(of(new DOMException("The operation timed out.", "TimeoutError"))).toEqual([
      "unavailable",
      "Yahoo did not answer in time.",
    ]);
    expect(of(Object.assign(new Error("Unexpected"), { name: "BadRequestError" }))).toEqual([
      "unavailable",
      "Yahoo could not be read (Unexpected).",
    ]);
    const already = new DataError("unsupported", "not a Yahoo listing", { source: "Yahoo" });
    expect(yahooFailure(already)).toBe(already);
  });

  test("a message is one line, bounded, and never carries Yahoo's crumb", () => {
    const body = `Response.ok where we expect JSON, but the response was not parsable. Response: "${"<html> ".repeat(200)}" url https://query2.finance.yahoo.com/v7/finance/quote?symbols=AAPL&crumb=Ab3dEf9Xyz\nmore`;
    const error = yahooFailure(new Error(body));
    expect(error.kind).toBe("unavailable");
    expect(error.message).not.toContain("Ab3dEf9Xyz");
    expect(error.message).not.toContain("\n");
    expect(error.message.length).toBeLessThan(MESSAGE_CHARS + 40);
    expect(yahooFailure(new Error("see ?crumb=Ab3dEf9Xyz&x=1")).message).toBe(
      "Yahoo could not be read (see ?crumb=***&x=1).",
    );
  });
});
