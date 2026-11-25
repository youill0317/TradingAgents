// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The one HTTP client every public-data source reads through. Yahoo is the exception: yahoo-finance2
 * makes its own requests with its own User-Agent, configured as upstream's Yahoo provider configures it
 * (deps.ts). A request here:
 *
 * - carries the caller's signal and a deadline covering the answer's body too (hang protection, the way
 *   upstream bounds each Yahoo request): FORK_REQUEST_MS by kind of read, or the caller's own;
 * - waits for its turn where a service publishes a rate (HOST_RULES: SEC's 10 a second shared by its
 *   hosts, FRED's 120 a minute, GDELT's one per 5 seconds, whose identical requests in flight share one
 *   answer), and fails as rate_limited, without waiting, when its turn would come after its deadline;
 * - honours Retry-After on 429 and 503 when the wait fits its deadline (else rate_limited with
 *   retryAfterMs), and is retried once after a transient failure: a dropped connection or a 5xx;
 * - names its sender: SEC's hosts get the configured SEC_USER_AGENT, the others the app's name;
 * - fails with a DataError whose kind the router acts on: 401 and 403 rejected (SEC's 403 explains its
 *   User-Agent rule), 404 and 410 as the caller says (no_data by default), 429 rate_limited, 5xx, network,
 *   a body past its bound and a body that is not the JSON asked for unavailable. No message names a key:
 *   each is scrubbed of every configured secret, in a query or a path, as written or URL-encoded.
 *
 * Nothing here limits how much or how often anything is read beyond what a service publishes.
 */
import { message, USER_AGENT } from "../../contracts/index.js";
import { ANSWER_BYTES, REQUEST_MS } from "../../contracts/limits.js";
import { bounded } from "../../data/bounded.js";
import { DataError, type DataErrorDetails, type DataErrorKind } from "../../data/errors.js";
import { redact } from "./redact.js";
import { abortable, REAL_TIMER, type Timer } from "./timer.js";

/** How long one request may take, its body included, by the kind of read: hang protection only. */
export const FORK_REQUEST_MS = {
  /** An API answer or a file of ordinary size: upstream's bound for one Yahoo request (30 s). */
  read: REQUEST_MS.yahoo,
  /**
   * A large file (a company's complete XBRL facts, a registry's ZIP) or a source measured slow (the ECB took
   * 21 s for one day of every currency): twice that.
   */
  bulk: 2 * REQUEST_MS.yahoo,
} as const;

/** The pause before the one retry of a transient failure. */
export const RETRY_PAUSE_MS = 1_000;

/** A service's published rate: at most `requests` starts in any `perMs`. */
export type Pace = { requests: number; perMs: number };

/** A rate a service publishes for some hosts, and how their requests are made. */
export type HostRule = {
  name: string;
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
    // GDELT's DOC API: one request every 5 seconds.
    name: "api.gdeltproject.org",
    matches: (host) => host === "api.gdeltproject.org",
    pace: { requests: 1, perMs: 5_000 },
    coalesce: true,
  },
];

/** The rule for `host`, if a service publishes one. */
export function ruleFor(host: string): HostRule | undefined {
  return HOST_RULES.find((rule) => rule.matches(host.toLowerCase()));
}

/**
 * When each rule's requests may start: the starts taken within the last window, per rule. The services
 * count per sender, so one pacer serves the whole process unless a test passes its own.
 */
export class Pacer {
  private readonly starts = new Map<string, number[]>();

  /**
   * The next start `rule` allows at `now`, taken unless it is more than `within` away (then nothing is
   * taken); `wait` is how long until it.
   */
  take(rule: HostRule, now: number, within: number): { wait: number; taken: boolean } {
    const { requests, perMs } = rule.pace;
    const starts = (this.starts.get(rule.name) ?? []).filter((at) => at > now - perMs);
    const at =
      starts.length >= requests ? Math.max(now, (starts[starts.length - requests] as number) + perMs) : now;
    const wait = at - now;
    const taken = wait <= within;
    if (taken) starts.push(at);
    this.starts.set(rule.name, starts);
    return { wait, taken };
  }
}

const SHARED_PACER = new Pacer();

export type HttpOptions = {
  /** The source as people read it ("SEC EDGAR"): its errors name it. */
  source: string;
  signal?: AbortSignal | undefined;
  /** The request's deadline, its body included; FORK_REQUEST_MS.read unless given. */
  timeoutMs?: number;
  headers?: Readonly<Record<string, string>>;
  /** What a 404 (or 410) means for this request: no_data unless given. */
  notFound?: "no_data" | "unsupported" | "invalid";
  notFoundMessage?: string;
  /** Statuses the caller reads itself (a source's error body), answered rather than failed. */
  accept?: readonly number[];
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
  /** Where the published rates' turns are kept: the process's own unless given. */
  pacer?: Pacer;
};

type Opened = { response: Response; deadline: AbortSignal; timeoutMs: number };
type Buffered = { status: number; headers: Headers; body: Uint8Array };

export function createHttp(deps: HttpDeps): Http {
  const timer = deps.timer ?? REAL_TIMER;
  const pacer = deps.pacer ?? (timer === REAL_TIMER ? SHARED_PACER : new Pacer());
  const secrets = deps.secrets ?? [];
  const generic = deps.userAgent ?? USER_AGENT;
  const inflight = new Map<string, Promise<Buffered>>();
  const fail = (kind: DataErrorKind, text: string, details: DataErrorDetails) =>
    new DataError(kind, redact(text, secrets), details);

  /** One request, retried once when it fails in passing; the answer unread. */
  async function attempt(
    url: string,
    rule: HostRule | undefined,
    options: HttpOptions,
    retried: boolean,
  ): Promise<Opened> {
    const { source, signal } = options;
    const timeoutMs = options.timeoutMs ?? FORK_REQUEST_MS.read;
    if (rule) {
      const turn = pacer.take(rule, timer.now(), timeoutMs);
      if (!turn.taken) {
        throw fail(
          "rate_limited",
          `${source} allows ${rule.pace.requests} request${rule.pace.requests === 1 ? "" : "s"} every ${seconds(rule.pace.perMs)}, and this one's turn comes after its ${seconds(timeoutMs)} deadline.`,
          { source, retryAfterMs: Math.ceil(turn.wait) },
        );
      }
      if (turn.wait > 0) await timer.sleep(turn.wait, signal);
    }
    if (signal?.aborted) throw signal.reason;
    const deadline = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      const headers = new Headers(options.headers);
      // The sender is ours to name, whatever the caller's headers say.
      headers.set("User-Agent", rule?.sender === "sec" ? (deps.secUserAgent ?? generic) : generic);
      response = await deps.fetch(url, {
        headers,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch (error) {
      // A cancelled call is the caller's, as it came.
      if (signal?.aborted) throw error;
      if (deadline.aborted)
        throw fail("unavailable", `${source} did not answer within ${seconds(timeoutMs)}.`, { source });
      if (!retried) {
        await timer.sleep(RETRY_PAUSE_MS, signal);
        return attempt(url, rule, options, true);
      }
      throw fail("unavailable", `${source} could not be reached (${reasonOf(error)}).`, { source });
    }
    const { status } = response;
    if (response.ok || options.accept?.includes(status)) return { response, deadline, timeoutMs };
    const wait = retryAfterMs(response.headers.get("retry-after"));
    await response.body?.cancel().catch(() => {});
    if (status === 429 || status === 503) {
      if (wait !== undefined) {
        if (!retried && wait <= timeoutMs) {
          await timer.sleep(wait, signal);
          return attempt(url, rule, options, true);
        }
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
        return attempt(url, rule, options, true);
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

  /** A request whose identical twin in flight shares its answer (a service that asks for this). */
  async function shared(url: string, rule: HostRule, options: HttpOptions): Promise<Answer> {
    let pending = inflight.get(url);
    if (!pending) {
      // No one caller's cancellation stops a request others wait on; each stops waiting on its own.
      const alone = { ...options, signal: undefined };
      const started: Promise<Buffered> = (async () => {
        const answer = answerOf(await attempt(url, rule, alone, false), alone);
        return { status: answer.status, headers: answer.headers, body: await answer.bytes() };
      })();
      const done = () => {
        if (inflight.get(url) === started) inflight.delete(url);
      };
      started.then(done, done);
      inflight.set(url, started);
      pending = started;
    }
    const { status, headers, body } = await abortable(pending, options.signal);
    return reading(status, headers, async () => body, options.source);
  }

  const get = async (url: string, options: HttpOptions): Promise<Answer> => {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new Error("the data client was given something that is not a URL");
    }
    const rule = ruleFor(host);
    if (rule?.coalesce) return shared(url, rule, options);
    return answerOf(await attempt(url, rule, options, false), options);
  };
  return {
    get,
    bytes: async (url, options) => (await get(url, options)).bytes(),
    text: async (url, options) => (await get(url, options)).text(),
    json: async (url, options) => (await get(url, options)).json(),
    redact: (text) => redact(text, secrets),
  };
}

/** A Retry-After header's wait in milliseconds: seconds, or an HTTP date; undefined when there is none. */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1_000);
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function seconds(ms: number): string {
  const value = ms / 1_000;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} s`;
}

/** What a failed fetch says about itself, without its message (which may quote the address). */
function reasonOf(error: unknown): string {
  const failure = error as { code?: unknown; name?: unknown } | null;
  if (typeof failure?.code === "string" && /^[A-Za-z_]+$/.test(failure.code)) return failure.code;
  return typeof failure?.name === "string" ? failure.name : "error";
}
