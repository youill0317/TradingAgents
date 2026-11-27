// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The one HTTP client every public-data source reads through. Yahoo is the exception: yahoo-finance2
 * makes its own requests with its own User-Agent, configured as upstream's Yahoo provider configures it
 * (deps.ts), and a Yahoo address given here is refused (Yahoo answers 429 to any other User-Agent). A
 * request here:
 *
 * - carries the caller's signal and a deadline covering the answer's body too (hang protection, the way
 *   upstream bounds each Yahoo request): FORK_REQUEST_MS by class of source, or the caller's own;
 * - waits for its turn where a service publishes a rate (HOST_RULES: SEC's 10 a second shared by its
 *   hosts, FRED's API's 120 a minute and its website's one a second, GDELT's one per 5 seconds, whose
 *   identical requests in flight share one answer, KOSIS's 200 a minute), counted at the moment each request
 *   actually starts, and
 *   for the end of any pause a source asked for with a 429 or 503 Retry-After (kept for every later request
 *   to that host, or to that rule's hosts);
 *   it fails as rate_limited, without being sent, when its turn would come after its deadline;
 * - honours Retry-After on 429 and 503 when the wait fits its deadline (else rate_limited with
 *   retryAfterMs), and is retried once after a transient failure: a dropped connection or a 5xx;
 * - names its sender: SEC's hosts get the configured SEC_USER_AGENT, the others the app's name;
 * - follows redirects as fetch does, or, when the caller passes `redirect: "same-origin"` (Korea's sources and
 *   the recorder, for a key in the request), only those to its own origin: a redirect elsewhere is
 *   unavailable, so that key reaches nothing but its source;
 * - fails with a DataError whose kind the router acts on: 401 and 403 rejected (SEC's 403 explains its
 *   User-Agent rule), 404 and 410 as the caller says (no_data by default), 429 rate_limited, 5xx, network,
 *   a body past its bound, a body that is not the JSON asked for and a header fetch refuses to send (named,
 *   its value never said; the request is not sent) unavailable. No message names a key:
 *   each is scrubbed of every configured secret, in a query or a path, as written or URL-encoded.
 *
 * Hosts are compared as DNS reads them: in any case, with or without the trailing dot of a fully-qualified
 * name. Nothing here limits how much or how often anything is read beyond what a service publishes.
 */
import { message, USER_AGENT } from "../../contracts/index.js";
import { ANSWER_BYTES, REQUEST_MS } from "../../contracts/limits.js";
import { bounded } from "../../data/bounded.js";
import { DataError, type DataErrorDetails, type DataErrorKind } from "../../data/errors.js";
import { redact } from "./redact.js";
import { abortable, REAL_TIMER, type Timer } from "./timer.js";

/**
 * How long one request may take, its body included, by class of source: hang protection only, never a
 * limit on what is read. Upstream's bound for one Yahoo request (REQUEST_MS.yahoo, 30 s) is the base; every
 * answer measured from these sources fits it many times over.
 */
export const FORK_REQUEST_MS = {
  /**
   * An API answer or a file of ordinary size, the default: SEC's data.sec.gov (0.07-1.4 s, a 9.3 MB
   * companyfacts included), the Treasury's yield-curve CSVs, the New York Fed's rates, FRED's API,
   * Wikipedia's lists (0.1-1.0 s); GDELT's DOC API and SEC's www.sec.gov files likewise.
   */
  api: REQUEST_MS.yahoo,
  /**
   * A source measured slow, the default for its hosts (SLOW_HOSTS): the ECB's data API took 1.1-7.4 s for
   * one series and 21.3 s for every currency's latest rate.
   */
  slow: 2 * REQUEST_MS.yahoo,
  /** A large document read whole when its source asks for it: a filing's primary document, an archive. */
  bulk: 2 * REQUEST_MS.yahoo,
} as const;

/** Hosts whose requests default to FORK_REQUEST_MS.slow. */
export const SLOW_HOSTS: ReadonlySet<string> = new Set(["data-api.ecb.europa.eu"]);

/**
 * A host's name as the rules here compare it: lower case, without the trailing dot a fully-qualified
 * spelling ends with ("data.sec.gov." is data.sec.gov).
 */
export function hostName(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, "");
}

/** The deadline of a request to `host`: the caller's (`given`), else its class's. */
export function requestTimeout(host: string, given?: number): number {
  return given ?? (SLOW_HOSTS.has(hostName(host)) ? FORK_REQUEST_MS.slow : FORK_REQUEST_MS.api);
}

/** Yahoo's hosts: read through yahoo-finance2 (deps.yahoo), never through this client. */
function isYahoo(host: string): boolean {
  return /(^|\.)yahoo\.com$/.test(hostName(host));
}

/** The pause before the one retry of a transient failure. */
export const RETRY_PAUSE_MS = 1_000;

/** Redirect statuses. */
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The most redirects one request follows: the Fetch standard's own limit, which fetch's `follow` applies. */
const FETCH_REDIRECTS = 20;

/** `location` read against `from`, when it is an address of `from`'s own origin (scheme, host and port). */
function sameOriginTarget(from: string, location: string | null): string | undefined {
  if (!location) return undefined;
  try {
    const origin = new URL(from);
    const next = new URL(location, origin);
    return next.protocol === origin.protocol &&
      hostName(next.hostname) === hostName(origin.hostname) &&
      next.port === origin.port
      ? next.href
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A request's headers: the caller's, then the User-Agent in place of any the caller gave. When fetch refuses
 * one (a character above U+00FF or a NUL in its value), that header's name, its value never said.
 */
function headersOf(given: Readonly<Record<string, string>> | undefined, userAgent: string): Headers | string {
  const headers = new Headers();
  let name = "User-Agent";
  try {
    for (const [one, value] of Object.entries(given ?? {})) {
      name = one;
      headers.append(one, value);
    }
    name = "User-Agent";
    headers.set(name, userAgent);
  } catch {
    return name;
  }
  return headers;
}

/** A service's published rate: at most `requests` starts in any `perMs`. */
export type Pace = { requests: number; perMs: number };

/** A rate a service publishes for some hosts, and how their requests are made. */
export type HostRule = {
  name: string;
  /** Whether the rule covers `host`, given as hostName() writes it. */
  matches(host: string): boolean;
  pace: Pace;
  /** Identical requests in flight share one request and its answer. */
  coalesce?: true;
  /** SEC: its requests carry the configured SEC_USER_AGENT. */
  sender?: "sec";
};

export const HOST_RULES: readonly HostRule[] = [
  {
    // SEC's fair-access rule: at most 10 requests a second per sender, www.sec.gov, data.sec.gov and
    // efts.sec.gov together.
    name: "sec.gov",
    matches: (host) => host === "sec.gov" || host.endsWith(".sec.gov"),
    pace: { requests: 10, perMs: 1_000 },
    sender: "sec",
  },
  {
    // FRED's API: about 120 requests a minute per key.
    name: "api.stlouisfed.org",
    matches: (host) => host === "api.stlouisfed.org",
    pace: { requests: 120, perMs: 60_000 },
  },
  {
    // FRED's website (its keyless download, fredgraph.csv): its robots.txt asks every agent for one request a
    // second (Crawl-delay: 1).
    name: "fred.stlouisfed.org",
    matches: (host) => host === "fred.stlouisfed.org",
    pace: { requests: 1, perMs: 1_000 },
  },
  {
    // GDELT's DOC API: one request every 5 seconds.
    name: "api.gdeltproject.org",
    matches: (host) => host === "api.gdeltproject.org",
    pace: { requests: 1, perMs: 5_000 },
    coalesce: true,
  },
  {
    // KOSIS's Open API: at most 200 requests a minute (its service introduction, kosis.kr/openapi).
    name: "kosis.kr",
    matches: (host) => host === "kosis.kr",
    pace: { requests: 200, perMs: 60_000 },
  },
];

/** The rule for `host`, if a service publishes one. */
export function ruleFor(host: string): HostRule | undefined {
  const name = hostName(host);
  return HOST_RULES.find((rule) => rule.matches(name));
}

/** Why a request waits: a service's published rate, or a pause the source asked for (Retry-After). */
export type WaitCause = "pace" | "pause";

/** A turn booked for a request: when it is to start, how long that is from when it was booked, and why. */
export type Booking = { at: number; wait: number; booked: boolean; cause: WaitCause | undefined };

/**
 * When requests may start, per rule (a service's published rate, counted across its hosts) or per host:
 * the turns booked and not yet begun, the starts made within each rate's last window, and the pauses
 * sources asked for with a Retry-After. A turn is booked in order of asking; when it comes, the start is
 * checked against the starts actually made (timers fire late, and a late start must not crowd the next
 * window) and counted at the time it is made. The services count per sender, so one pacer serves the
 * whole process unless a test passes its own. Times are a Timer's.
 */
export class Pacer {
  private readonly booked = new Map<string, number[]>();
  private readonly begun = new Map<string, number[]>();
  private readonly paused = new Map<string, number>();

  /** No request under `key` before `until` (a source's Retry-After); an earlier end leaves a later one. */
  pause(key: string, until: number): void {
    if (until > (this.paused.get(key) ?? Number.NEGATIVE_INFINITY)) this.paused.set(key, until);
  }

  /** When the pause asked for under `key` ends, while it is after `now`. */
  pausedUntil(key: string, now: number): number | undefined {
    const until = this.paused.get(key);
    if (until === undefined) return undefined;
    if (until > now) return until;
    this.paused.delete(key);
    return undefined;
  }

  /**
   * The next start under `key` at `now`: after any pause, and with `pace` after the turns already begun or
   * booked. It is booked unless it is more than `within` away (then nothing is booked).
   */
  book(key: string, pace: Pace | undefined, now: number, within: number): Booking {
    const until = this.pausedUntil(key, now);
    const from = until ?? now;
    let at = from;
    let cause: WaitCause | undefined = until === undefined ? undefined : "pause";
    if (pace) {
      const taken = [...(this.begun.get(key) ?? []), ...(this.booked.get(key) ?? [])]
        .filter((time) => time > from - pace.perMs)
        .sort((a, b) => a - b);
      if (taken.length >= pace.requests) {
        const turn = (taken[taken.length - pace.requests] as number) + pace.perMs;
        if (turn > at) {
          at = turn;
          cause = "pace";
        }
      }
    }
    const wait = at - now;
    const booked = wait <= within;
    if (booked && pace) {
      const list = this.booked.get(key) ?? [];
      list.push(at);
      list.sort((a, b) => a - b);
      this.booked.set(key, list);
    }
    return { at, wait, booked, cause: wait > 0 ? cause : undefined };
  }

  /** Gives back the turn booked at `at` that a request will not take (it was cancelled, or gave up waiting). */
  release(key: string, at: number): void {
    const list = this.booked.get(key);
    if (!list) return;
    const found = list.indexOf(at);
    if (found >= 0) list.splice(found, 1);
    if (!list.length) this.booked.delete(key);
  }

  /**
   * What is to be the start, at `now`, of the request whose turn was booked at `at`: how long it must still
   * wait (its turn has not come, a source asked for a pause, or starts made late fill the window); with
   * nothing left to wait for, the start is counted at `now` and the wait is 0.
   */
  begin(key: string, pace: Pace | undefined, at: number, now: number): { wait: number; cause: WaitCause } {
    if (now < at) return { wait: at - now, cause: "pace" };
    const until = this.pausedUntil(key, now);
    if (until !== undefined) return { wait: until - now, cause: "pause" };
    if (pace) {
      const begun = (this.begun.get(key) ?? []).filter((time) => time > now - pace.perMs);
      if (begun.length >= pace.requests) {
        this.begun.set(key, begun);
        return { wait: (begun[begun.length - pace.requests] as number) + pace.perMs - now, cause: "pace" };
      }
      this.release(key, at);
      begun.push(now);
      this.begun.set(key, begun);
    }
    return { wait: 0, cause: "pace" };
  }
}

const SHARED_PACER = new Pacer();

export type HttpOptions = {
  /** The source as people read it ("SEC EDGAR"): its errors name it. */
  source: string;
  signal?: AbortSignal | undefined;
  /**
   * The request's deadline, its body included: FORK_REQUEST_MS.slow for SLOW_HOSTS, else
   * FORK_REQUEST_MS.api, unless given (FORK_REQUEST_MS.bulk for a large document). Its turn, when it waits
   * for one, must also come within it.
   */
  timeoutMs?: number;
  headers?: Readonly<Record<string, string>>;
  /** What a 404 (or 410) means for this request: no_data unless given. */
  notFound?: "no_data" | "unsupported" | "invalid";
  notFoundMessage?: string;
  /** Statuses the caller reads itself (a source's error body), answered rather than failed. */
  accept?: readonly number[];
  /**
   * Which redirects are followed: every one (`follow`, fetch's own way, the default), or only those to the
   * request's own origin (`same-origin`, which Korea's sources and the recorder pass for a request carrying a
   * key in its address): a redirect elsewhere is not followed, so the key goes nowhere but its source, and
   * the request is unavailable.
   */
  redirect?: "follow" | "same-origin";
  /**
   * Bytes of the answer read at most, a longer one being unavailable: upstream's ANSWER_BYTES (16 MiB) unless
   * given. The largest answers measured fit it comfortably (SEC's companyfacts for MetLife, 9.3 MB decoded, the
   * largest of 18 big filers); a source whose real answers do not passes its own measured bound.
   */
  maxBytes?: number;
};

/** An answer, its body read once whichever way it is asked for. */
export type Answer = {
  status: number;
  headers: Headers;
  bytes(): Promise<Uint8Array>;
  /** The body as UTF-8 text. */
  text(): Promise<string>;
  /** The body parsed as JSON; unavailable when it is not JSON. */
  json(): Promise<unknown>;
};

export type Http = {
  get(url: string, options: HttpOptions): Promise<Answer>;
  bytes(url: string, options: HttpOptions): Promise<Uint8Array>;
  text(url: string, options: HttpOptions): Promise<string>;
  json(url: string, options: HttpOptions): Promise<unknown>;
  /** `text` with every configured secret removed: for anything a provider says itself. */
  redact(text: string): string;
};

export type HttpDeps = {
  fetch: typeof globalThis.fetch;
  /** Elapsed time for pacing and waits; the process's own unless given. */
  timer?: Timer;
  /** Every configured key (and SEC's User-Agent, which names a person): never in a message. */
  secrets?: readonly string[];
  /** SEC's fair-access User-Agent, for SEC's hosts. */
  secUserAgent?: string | undefined;
  /** The User-Agent other hosts get: the app's name and version unless given. */
  userAgent?: string;
  /**
   * Where the published rates' turns and the sources' pauses are kept: the process's own unless given (a
   * new one with a timer of a test's own).
   */
  pacer?: Pacer;
};

type Opened = { response: Response; deadline: AbortSignal; timeoutMs: number };
type Buffered = { status: number; headers: Headers; body: Uint8Array };

/**
 * A request shared by identical callers (a service that asks for this): the callers that can still
 * cancel, whether one that cannot waits on it, and when its turn was booked to start.
 */
type Flight = {
  promise: Promise<Buffered>;
  controller: AbortController;
  waiting: number;
  held: boolean;
  startsAt: number | undefined;
};

export function createHttp(deps: HttpDeps): Http {
  const timer = deps.timer ?? REAL_TIMER;
  const pacer = deps.pacer ?? (timer === REAL_TIMER ? SHARED_PACER : new Pacer());
  const secrets = deps.secrets ?? [];
  const generic = deps.userAgent ?? USER_AGENT;
  const inflight = new Map<string, Flight>();
  const fail = (kind: DataErrorKind, text: string, details: DataErrorDetails) =>
    new DataError(kind, redact(text, secrets), details);

  /** The failure of a request whose turn would come after its deadline. */
  const tooLate = (
    source: string,
    rule: HostRule | undefined,
    cause: WaitCause | undefined,
    wait: number,
    deadline: number,
  ) =>
    fail(
      "rate_limited",
      cause === "pause" || !rule
        ? `${source} asked to wait before its next request, ${seconds(wait)} more: longer than this one's ${seconds(deadline)} deadline.`
        : `${source} allows ${rule.pace.requests} request${rule.pace.requests === 1 ? "" : "s"} every ${seconds(rule.pace.perMs)}, and this one's turn comes after its ${seconds(deadline)} deadline.`,
      { source, retryAfterMs: Math.ceil(wait) },
    );

  /**
   * Waits for a request's turn under `key`, booked at once (`booked` hears when it is to start), within
   * `deadline`; a turn not taken is given back.
   */
  async function turn(
    key: string,
    rule: HostRule | undefined,
    source: string,
    deadline: number,
    signal: AbortSignal | undefined,
    booked?: (at: number) => void,
  ): Promise<void> {
    const pace = rule?.pace;
    const asked = timer.now();
    const booking = pacer.book(key, pace, asked, deadline);
    if (!booking.booked) throw tooLate(source, rule, booking.cause, booking.wait, deadline);
    booked?.(booking.at);
    for (;;) {
      const now = timer.now();
      const next = pacer.begin(key, pace, booking.at, now);
      if (next.wait <= 0) return;
      if (now - asked + next.wait > deadline) {
        pacer.release(key, booking.at);
        throw tooLate(source, rule, next.cause, next.wait, deadline);
      }
      try {
        await timer.sleep(next.wait, signal);
      } catch (error) {
        pacer.release(key, booking.at);
        throw error;
      }
    }
  }

  /** One request, retried once when it fails in passing; the answer unread. */
  async function attempt(
    url: string,
    key: string,
    rule: HostRule | undefined,
    options: HttpOptions,
    retried: boolean,
    booked?: (at: number) => void,
  ): Promise<Opened> {
    const { source, signal } = options;
    const timeoutMs = options.timeoutMs ?? FORK_REQUEST_MS.api;
    await turn(key, rule, source, timeoutMs, signal, booked);
    if (signal?.aborted) throw signal.reason;
    // The sender is ours to name, whatever the caller's headers say.
    const headers = headersOf(
      options.headers,
      rule?.sender === "sec" ? (deps.secUserAgent ?? generic) : generic,
    );
    // A header fetch cannot send fails the same way every time: said at once, the request not sent.
    if (typeof headers === "string") {
      throw fail(
        "unavailable",
        `${source} was not asked: the ${headers} header of its request holds a character a header cannot carry.`,
        { source },
      );
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const sameOrigin = options.redirect === "same-origin";
    let response: Response;
    let target = url;
    for (let hops = 0; ; hops++) {
      try {
        response = await deps.fetch(target, {
          headers,
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
          ...(sameOrigin ? { redirect: "manual" as const } : {}),
        });
      } catch (error) {
        // A cancelled call is the caller's, as it came.
        if (signal?.aborted) throw error;
        if (deadline.aborted)
          throw fail("unavailable", `${source} did not answer within ${seconds(timeoutMs)}.`, { source });
        if (!retried) {
          await timer.sleep(RETRY_PAUSE_MS, signal);
          return attempt(url, key, rule, options, true);
        }
        throw fail("unavailable", `${source} could not be reached (${reasonOf(error)}).`, { source });
      }
      if (!sameOrigin || !REDIRECTS.has(response.status)) break;
      // A redirect to the request's own origin is followed, as fetch follows one (at most FETCH_REDIRECTS);
      // one elsewhere is not, and its address, which may carry the key, is not said.
      const next = sameOriginTarget(target, response.headers.get("location"));
      await response.body?.cancel().catch(() => {});
      if (next === undefined) {
        throw fail(
          "unavailable",
          `${source} sent the request on to another address (HTTP ${response.status}), which is not followed with its key.`,
          { source, status: response.status },
        );
      }
      if (hops >= FETCH_REDIRECTS) {
        throw fail("unavailable", `${source} redirected the request more than ${FETCH_REDIRECTS} times.`, {
          source,
          status: response.status,
        });
      }
      target = next;
    }
    const { status } = response;
    if (response.ok || options.accept?.includes(status)) return { response, deadline, timeoutMs };
    const wait = retryAfterMs(response.headers.get("retry-after"));
    await response.body?.cancel().catch(() => {});
    if (status === 429 || status === 503) {
      if (wait !== undefined) {
        // The pause holds for every request under this key from now on, this one's retry included.
        pacer.pause(key, timer.now() + wait);
        if (!retried && wait <= timeoutMs) return attempt(url, key, rule, options, true);
        throw fail(
          "rate_limited",
          `${source} asked to wait ${seconds(wait)} before the next request (HTTP ${status}).`,
          { source, status, retryAfterMs: wait },
        );
      }
      if (status === 429)
        throw fail("rate_limited", `${source} is limiting requests (HTTP 429).`, { source, status });
    }
    if (status >= 500) {
      if (!retried) {
        await timer.sleep(RETRY_PAUSE_MS, signal);
        return attempt(url, key, rule, options, true);
      }
      throw fail("unavailable", `${source} answered HTTP ${status}.`, { source, status });
    }
    if (status === 401 || status === 403) {
      throw fail(
        "rejected",
        rule?.sender === "sec" && status === 403
          ? `${source} refused the request (HTTP 403). SEC's fair-access rule asks each program to name its sender in its User-Agent, a name and an email set in SEC_USER_AGENT (such as "Your Name you@example.com"), and to send at most 10 requests a second.`
          : `${source} refused the request (HTTP ${status}).`,
        { source, status },
      );
    }
    if (status === 404 || status === 410) {
      const kind = options.notFound ?? "no_data";
      throw fail(kind, options.notFoundMessage ?? `${source} has no such record (HTTP ${status}).`, {
        source,
        status,
        ...(kind === "invalid" ? { retry: "change_request" as const } : {}),
      });
    }
    throw fail("unavailable", `${source} answered HTTP ${status}.`, { source, status });
  }

  /** An opened answer whose body is read when asked for, within the request's deadline and bound. */
  function answerOf({ response, deadline, timeoutMs }: Opened, options: HttpOptions): Answer {
    const { source, signal } = options;
    const maxBytes = options.maxBytes ?? ANSWER_BYTES;
    let read: Promise<Uint8Array> | undefined;
    const bytes = () => {
      read ??= (async () => {
        const body = bounded(response, maxBytes, () =>
          fail("unavailable", message("data.answerTooLong", { source, bytes: maxBytes }), {
            source,
            status: response.status,
          }),
        );
        try {
          return new Uint8Array(await body.arrayBuffer());
        } catch (error) {
          if (error instanceof DataError) throw error;
          if (signal?.aborted) throw error;
          if (deadline.aborted) {
            throw fail("unavailable", `${source} did not finish answering within ${seconds(timeoutMs)}.`, {
              source,
            });
          }
          throw fail("unavailable", `${source}'s answer was cut off (${reasonOf(error)}).`, { source });
        }
      })();
      return read;
    };
    return reading(response.status, response.headers, bytes, source);
  }

  /** An answer over a body already read. */
  function reading(
    status: number,
    headers: Headers,
    bytes: () => Promise<Uint8Array>,
    source: string,
  ): Answer {
    const text = async () => new TextDecoder().decode(await bytes());
    return {
      status,
      headers,
      bytes,
      text,
      json: async () => {
        const body = await text();
        try {
          return JSON.parse(body) as unknown;
        } catch {
          throw fail("unavailable", `${source} answered with something other than JSON.`, { source, status });
        }
      },
    };
  }

  /**
   * A request whose identical twin in flight shares its answer (a service that asks for this). It runs
   * under its own cancellation: each caller stops waiting on its own, and when the last caller that could
   * cancel has, the request is cancelled and its turn, not yet taken, given back. A caller does not join a
   * request whose turn comes after its own deadline (it fails as rate_limited), and a caller already
   * cancelled starts nothing.
   */
  async function shared(url: string, key: string, rule: HostRule, options: HttpOptions): Promise<Answer> {
    const { source, signal } = options;
    const timeoutMs = options.timeoutMs ?? FORK_REQUEST_MS.api;
    if (signal?.aborted) throw signal.reason;
    let flight = inflight.get(url);
    if (flight) {
      const wait = (flight.startsAt ?? timer.now()) - timer.now();
      if (wait > timeoutMs) throw tooLate(source, rule, "pace", wait, timeoutMs);
    } else {
      const controller = new AbortController();
      const own: HttpOptions = { ...options, signal: controller.signal };
      const state: Omit<Flight, "promise"> = { controller, waiting: 0, held: false, startsAt: undefined };
      // The turn is booked as the request is made, so a caller joining it knows when it starts.
      const promise = (async () => {
        const opened = await attempt(url, key, rule, own, false, (at) => {
          state.startsAt = at;
        });
        const answer = answerOf(opened, own);
        return { status: answer.status, headers: answer.headers, body: await answer.bytes() };
      })();
      const started: Flight = Object.assign(state, { promise });
      const done = () => {
        if (inflight.get(url) === started) inflight.delete(url);
      };
      promise.then(done, done);
      inflight.set(url, started);
      flight = started;
    }
    const joined = flight;
    if (signal) joined.waiting++;
    else joined.held = true;
    try {
      const { status, headers, body } = await abortable(joined.promise, signal);
      return reading(status, headers, async () => body, source);
    } catch (error) {
      if (!signal?.aborted) throw error;
      joined.waiting--;
      if (joined.waiting === 0 && !joined.held) {
        if (inflight.get(url) === joined) inflight.delete(url);
        joined.controller.abort(signal.reason);
      }
      throw signal.reason;
    }
  }

  const get = async (url: string, given: HttpOptions): Promise<Answer> => {
    let host: string;
    try {
      host = hostName(new URL(url).hostname);
    } catch {
      throw new Error("the data client was given something that is not a URL");
    }
    if (isYahoo(host)) {
      throw new Error(
        "Yahoo is read through yahoo-finance2 (deps.yahoo), with its own User-Agent, never here",
      );
    }
    const options: HttpOptions = { ...given, timeoutMs: requestTimeout(host, given.timeoutMs) };
    const rule = ruleFor(host);
    // A rule's hosts share its turns and its pauses; any other host has its own pauses.
    const key = rule?.name ?? host;
    if (rule?.coalesce) return shared(url, key, rule, options);
    return answerOf(await attempt(url, key, rule, options, false), options);
  };
  return {
    get,
    bytes: async (url, options) => (await get(url, options)).bytes(),
    text: async (url, options) => (await get(url, options)).text(),
    json: async (url, options) => (await get(url, options)).json(),
    redact: (text) => redact(text, secrets),
  };
}

/**
 * The failure for an answer read whole that is not in the form `source` documents for it (`what`, such as
 * "its rates"): unavailable, as the source's failure, never a fact about the market.
 */
export function unreadable(source: string, what: string): DataError {
  return new DataError("unavailable", `${source} answered ${what} in a form this app does not read.`, {
    source,
  });
}

/** A Retry-After header's wait in milliseconds: seconds, or an HTTP date; undefined when there is none. */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1_000);
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Milliseconds as seconds, to a tenth. */
function seconds(ms: number): string {
  const value = Math.round(ms / 100) / 10;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} s`;
}

/** What a failed fetch says about itself, without its message (which may quote the address). */
function reasonOf(error: unknown): string {
  const failure = error as { code?: unknown; name?: unknown } | null;
  if (typeof failure?.code === "string" && /^[A-Za-z_]+$/.test(failure.code)) return failure.code;
  return typeof failure?.name === "string" ? failure.name : "error";
}
