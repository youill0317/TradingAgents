// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * What the fork's data tests run on, with no network:
 *
 * - `fixtureFetch(routes)`: a fetch that answers each request from a fixture (a file under
 *   test/fork/fixtures, its status and content type from the `.meta.json` beside it, or a body given
 *   inline), the first route that matches the URL; a request no route matches fails loudly (it is printed
 *   and thrown) and is listed in `unmatched`. Every request is listed in `requests`, with its headers.
 * - `fixedClock`, `fakeTimer`: the engine's day, fixed; elapsed time whose sleeps return at once.
 * - `buildTools(providers)`: route(providers), dataTools and a ToolRegistry, as the engine builds them;
 *   `runTool(name, input)` runs one call as the model's would be run, and answers what the model reads
 *   (`text`), the transcript's summary, the recorded payload and its provenance.
 * - `readCheck(data)`: a view of a provider's answer that logs each field the tool reads, so a test can
 *   assert that every field read was supplied (not undefined). `buildTools(providers, { check: true })`
 *   puts every answer behind one, and `runTool` answers the call's log as `reads`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../../../src/contracts/index.js";
import type { DataProvider } from "../../../src/data/capabilities.js";
import { type Providers, route } from "../../../src/data/router.js";
import type { Timer } from "../../../src/fork/data/timer.js";
import { dataTools } from "../../../src/tools/catalog.js";
import { EvidenceStore } from "../../../src/tools/evidence-store.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import type { Provenance } from "../../../src/tools/tool.js";

/** Where the fixtures are: test/fork/fixtures/<source>/<name>.<ext>, each with <name>.meta.json. */
export const FIXTURES = join(import.meta.dir, "../fixtures");

/** One answer of a fixture fetch, and the requests it answers. */
export type FixtureRoute = {
  /** The whole URL, a pattern it matches, or a test of it (and of the request's options). */
  match: string | RegExp | ((url: URL, init: RequestInit | undefined) => boolean);
  /** A fixture file, relative to test/fork/fixtures ("ecb/exr-usd-last5.csv"). */
  file?: string;
  /** An answer written inline instead. */
  body?: string | Uint8Array;
  /** The status: the fixture's meta, else 200. */
  status?: number;
  headers?: Record<string, string>;
};

export type FixtureFetch = typeof globalThis.fetch & {
  /** Every request made, in order. */
  requests: { url: string; headers: Headers }[];
  /** The requests no route answered. */
  unmatched: string[];
};

const TYPES: Record<string, string> = {
  json: "application/json",
  csv: "text/csv",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  zip: "application/zip",
};

/** A fixture's metadata, as the recorder writes it (hand-made fixtures carry `hand_made: true`). */
export type FixtureMeta = {
  source?: string;
  name?: string;
  url?: string;
  status?: number;
  content_type?: string;
  recorded_at?: string;
  bytes?: number;
  hand_made?: boolean;
};

/** The metadata beside fixture `file`, when it has one. */
export function fixtureMeta(file: string): FixtureMeta | undefined {
  const path = join(FIXTURES, file.replace(/\.[^./]+$/, ".meta.json"));
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as FixtureMeta) : undefined;
}

/** The bytes of fixture `file`. */
export function fixture(file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, file)));
}

export function fixtureFetch(routes: readonly FixtureRoute[]): FixtureFetch {
  const requests: FixtureFetch["requests"] = [];
  const unmatched: string[] = [];
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({ url, headers: new Headers(input instanceof Request ? input.headers : init?.headers) });
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw signal.reason;
    const parsed = new URL(url);
    const found = routes.find(({ match }) =>
      typeof match === "string"
        ? match === url
        : match instanceof RegExp
          ? match.test(url)
          : match(parsed, init),
    );
    if (!found) {
      unmatched.push(url);
      const said = `fixtureFetch: no fixture answers ${url} (these tests send no request to the network)`;
      console.error(said);
      throw new Error(said);
    }
    const meta = found.file ? fixtureMeta(found.file) : undefined;
    const extension = found.file?.split(".").pop() ?? "";
    const body = found.file ? fixture(found.file) : (found.body ?? "");
    const headers = new Headers(found.headers);
    if (!headers.has("content-type")) {
      const type = meta?.content_type ?? TYPES[extension];
      if (type) headers.set("content-type", type);
    }
    return new Response(body, { status: found.status ?? meta?.status ?? 200, headers });
  };
  return Object.assign(answer, { requests, unmatched }) as FixtureFetch;
}

/** Yahoo's cookie page and crumb (inline), and the hand-made quote and chart of AAPL. */
export const YAHOO_AAPL: readonly FixtureRoute[] = [
  {
    match: /^https:\/\/finance\.yahoo\.com\/quote\//,
    body: "",
    headers: { "set-cookie": "A3=fixture; Max-Age=3600; Domain=.yahoo.com; Path=/; Secure" },
  },
  {
    match: /^https:\/\/query1\.finance\.yahoo\.com\/v1\/test\/getcrumb/,
    body: "FIXTURECRUMB",
    headers: { "content-type": "text/plain" },
  },
  {
    match: /^https:\/\/query\d\.finance\.yahoo\.com\/v7\/finance\/quote\?(.*&)?symbols=AAPL(&|$)/,
    file: "yahoo/quote-aapl.json",
  },
  {
    match: /^https:\/\/query\d\.finance\.yahoo\.com\/v8\/finance\/chart\/AAPL\?/,
    file: "yahoo/chart-aapl-1d.json",
  },
];

/** The engine's clock, fixed at `iso`. */
export function fixedClock(iso: string): Clock {
  return () => new Date(iso);
}

/**
 * Elapsed time that moves only when slept: each sleep is listed in `slept` and returns at once, its time
 * passing as it returns (to the end of the longest sleep so far), so calls made together all see the time
 * they were made at.
 */
export function fakeTimer(start = 0): Timer & { slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      const from = now;
      slept.push(ms);
      await Promise.resolve();
      now = Math.max(now, from + ms);
    },
    slept,
  };
}

// Read checks ----------------------------------------------------------------------------------

/** The fields read of a provider's answer, by path ("instrument.currency", "bars[].close"). */
export type ReadLog = {
  /** How often each path was read, and how often it held nothing (undefined). */
  reads: Map<string, { reads: number; missing: number }>;
  /** The paths read, sorted. */
  paths(): string[];
  /** The paths read at least once where the answer held nothing, sorted. */
  missing(): string[];
  clear(): void;
};

export function readLog(): ReadLog {
  const reads = new Map<string, { reads: number; missing: number }>();
  return {
    reads,
    paths: () => [...reads.keys()].sort(),
    missing: () =>
      [...reads.entries()]
        .filter(([, count]) => count.missing > 0)
        .map(([path]) => path)
        .sort(),
    clear: () => reads.clear(),
  };
}

/** Properties a reader asks of any value that are not fields of the data. */
const NOT_FIELDS = new Set([
  "then",
  "toJSON",
  "constructor",
  "valueOf",
  "toString",
  "toLocaleString",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "asymmetricMatch",
  "$$typeof",
  "nodeType",
]);

function plain(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * `data` (a copy of it) behind a view that logs, in `log`, the path of each field read and whether it held a
 * value; nested objects and arrays are viewed the same way, an array's items as "<path>[]".
 */
export function readCheck<T>(data: T, log: ReadLog = readLog()): { value: T; log: ReadLog } {
  const views = new WeakMap<object, object>();
  const view = (target: object, path: string): object => {
    const known = views.get(target);
    if (known) return known;
    const made = new Proxy(target, {
      get(object, property, receiver) {
        const value = Reflect.get(object, property, receiver);
        if (typeof property === "symbol" || NOT_FIELDS.has(property)) return value;
        let at: string;
        if (Array.isArray(object)) {
          if (!/^\d+$/.test(property)) return value;
          // An index past the end is a reader looking, not a field the source left out.
          if (Number(property) >= object.length) return value;
          at = `${path}[]`;
        } else {
          if (typeof value === "function") return value;
          at = path ? `${path}.${property}` : property;
        }
        const count = log.reads.get(at) ?? { reads: 0, missing: 0 };
        count.reads++;
        if (value === undefined) count.missing++;
        log.reads.set(at, count);
        return plain(value) ? view(value, at) : value;
      },
    });
    views.set(target, made);
    return made;
  };
  const copy = structuredClone(data);
  return { value: (plain(copy) ? view(copy, "") : copy) as T, log };
}

/** `providers` with every answer of every method behind a read check logging into `log`. */
export function checkedProviders(providers: Providers, log: ReadLog): Providers {
  const checked = (provider: DataProvider): DataProvider => ({
    ...provider,
    capabilities: Object.fromEntries(
      Object.entries(provider.capabilities).map(([capability, implementation]) => [
        capability,
        Object.fromEntries(
          Object.entries(implementation as Record<string, (...args: unknown[]) => Promise<unknown>>).map(
            ([method, run]) => [
              method,
              async (...args: unknown[]) => readCheck(await run.apply(implementation, args), log).value,
            ],
          ),
        ),
      ]),
    ) as DataProvider["capabilities"],
  });
  return Object.fromEntries(
    Object.entries(providers).map(([name, provider]) => [name, provider ? checked(provider) : provider]),
  ) as Providers;
}

// Tools ------------------------------------------------------------------------------------------

/** One call's outcome as the model and the person watching see it, and what it recorded. */
export type ToolRun = {
  /** The text the model reads. */
  text: string;
  /** The transcript's one line. */
  summary: string;
  /** Why it failed ("data_no_data", "failed", ...), when it did. */
  failure?: string;
  /** The source the transcript names. */
  source?: string;
  /** The payload recorded, and where it came from; undefined when the call failed. */
  payload: unknown;
  provenance: Provenance | undefined;
  /** The fields of the providers' answers the tool read (with `check`). */
  reads: ReadLog;
};

/** The data tools over `providers`, as the engine builds them, and a way to call them. */
export function buildTools(
  providers: Providers,
  { clock = fixedClock("2026-11-25T22:00:00Z"), check = false }: { clock?: Clock; check?: boolean } = {},
) {
  const log = readLog();
  const routed = route(check ? checkedProviders(providers, log) : providers);
  const offered = dataTools(routed.capabilities, clock);
  const registry = new ToolRegistry(offered.map(([, tool]) => tool));
  const store = new EvidenceStore();
  let calls = 0;
  const runTool = async (name: string, input: Record<string, unknown>): Promise<ToolRun> => {
    log.clear();
    calls++;
    const signal = new AbortController().signal;
    const outcome = await registry.execute(
      { callId: `call_${calls}`, name, args: input as never },
      new Set([name]),
      { signal, clock, evidence: store.scope("t1", "main", calls, signal) },
    );
    const record = outcome.evidence ? store.get(outcome.evidence) : undefined;
    const reads = readLog();
    for (const [path, count] of log.reads) reads.reads.set(path, { ...count });
    return {
      text: outcome.output,
      summary: outcome.summary,
      ...(outcome.failure ? { failure: outcome.failure } : {}),
      ...(outcome.source ? { source: outcome.source } : {}),
      payload: record?.payload,
      provenance: record?.provenance,
      reads,
    };
  };
  return { registry, available: routed.available, capabilities: routed.capabilities, runTool };
}
