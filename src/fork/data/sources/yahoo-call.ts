// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Every read of Yahoo through yahoo-finance2 (deps.yahoo) runs in `yahooCall`, so its failures become the
 * DataError kinds the router acts on, the same for every provider that reads Yahoo (the composite's quotes,
 * profiles, corporate actions, holders and technicals; news; instrument search; the market views). A shared
 * module: changed only on its own and with its tests (test/fork/data/yahoo-call.test.ts). As http.ts maps
 * its own requests:
 *
 * - the caller's cancellation is the caller's: the signal's reason, as it came (the router stops on it);
 * - the deadline upstream's `answeredOrThrown` puts on each request (REQUEST_MS.yahoo) is unavailable;
 * - an HTTP status (`answeredOrThrown` puts a query host's in the error's `code`; without it, the crumb's
 *   failure says it in words): 429 rate_limited; 404 and 410 as the caller says (`notFound`: no_data for a
 *   listing only Yahoo serves, as upstream answers a US one; unsupported or unavailable for one another
 *   provider may answer, such as a Korean listing, so the router asks it); 401 and 403 rejected; any other
 *   unavailable, unless the caller names its kind (`statuses`: 422 unsupported for an intraday range past
 *   Yahoo's depth, 400 invalid where the request itself was wrong);
 * - without a status, the library's words: "too many requests" is rate_limited; "not found", "no data
 *   found", "delisted" and "invalid symbol" are a 404; an answer that fails the library's schema
 *   (FailedYahooValidationError), and anything else, unavailable.
 *
 * Messages are cut to one line of at most MESSAGE_CHARS (the library puts whole bodies in some) and never
 * carry Yahoo's crumb.
 */
import { DataError, type DataErrorKind } from "../../../data/errors.js";

/** The most of the library's words a message keeps. */
export const MESSAGE_CHARS = 200;

export type YahooCallOptions = {
  /** The source the errors name: "Yahoo" unless given. */
  source?: string;
  /** The caller's cancellation (the signal the read itself was given too). */
  signal?: AbortSignal | undefined;
  /** What Yahoo having no such symbol or record (a 404) means for this read: no_data unless given. */
  notFound?: "no_data" | "unsupported" | "unavailable";
  /** What to say then, instead of the library's words. */
  notFoundMessage?: string;
  /** The kind of another status, where the caller knows what it means for this read. */
  statuses?: Readonly<Partial<Record<number, DataErrorKind>>>;
};

/** What `work` (a yahoo-finance2 call) answers, or its failure as a DataError: see the top of this file. */
export async function yahooCall<T>(work: () => Promise<T>, options: YahooCallOptions = {}): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (options.signal?.aborted) throw options.signal.reason;
    throw yahooFailure(cause, options);
  }
}

/** A yahoo-finance2 failure as the DataError the router acts on (a DataError already is one). */
export function yahooFailure(cause: unknown, options: YahooCallOptions = {}): DataError {
  if (cause instanceof DataError) return cause;
  const source = options.source ?? "Yahoo";
  const error = cause as { name?: unknown; message?: unknown; code?: unknown } | null;
  const name = typeof error?.name === "string" ? error.name : "";
  const said = clip(typeof error?.message === "string" ? error.message : String(cause));
  const coded = typeof error?.code === "number" ? error.code : undefined;
  const status = coded ?? (Number(/\bstatus (\d{3})\b/.exec(said)?.[1]) || undefined);
  const notFound = (why: string) => {
    const kind = options.notFound ?? "no_data";
    return new DataError(
      kind,
      options.notFoundMessage ?? `${source} has no such symbol or record (${why}).`,
      {
        source,
        ...(status !== undefined ? { status } : {}),
      },
    );
  };
  if (name === "TimeoutError") {
    return new DataError("unavailable", `${source} did not answer in time.`, { source });
  }
  if (status !== undefined) {
    const given = options.statuses?.[status];
    if (given) {
      return new DataError(given, `${source} answered HTTP ${status}${said ? ` (${said})` : ""}.`, {
        source,
        status,
        ...(given === "invalid" ? { retry: "change_request" as const } : {}),
      });
    }
    if (status === 429) {
      return new DataError("rate_limited", `${source} is limiting requests (HTTP 429).`, { source, status });
    }
    if (status === 404 || status === 410) return notFound(`HTTP ${status}`);
    if (status === 401 || status === 403) {
      return new DataError("rejected", `${source} refused the request (HTTP ${status}).`, { source, status });
    }
    return new DataError("unavailable", `${source} answered HTTP ${status}.`, { source, status });
  }
  if (/too many requests/i.test(said)) {
    return new DataError("rate_limited", `${source} is limiting requests.`, { source });
  }
  if (/\bnot found\b|no data found|delisted|invalid symbol/i.test(said)) return notFound(said);
  return new DataError("unavailable", `${source} could not be read (${said || name || "an error"}).`, {
    source,
  });
}

/** The library's words on one line, at most MESSAGE_CHARS long, Yahoo's crumb taken out. */
function clip(text: string): string {
  const line = text
    .replace(/crumb=[^&\s"']*/gi, "crumb=***")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > MESSAGE_CHARS ? `${line.slice(0, MESSAGE_CHARS - 3)}...` : line;
}
