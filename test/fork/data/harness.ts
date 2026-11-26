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
 * - `fixedClock`, `fakeTimer`: the engine's day, fixed; elapsed time whose sleeps end at once, in order.
 * - `testDeps(config, routes)`, `testProviders(config, routes)`: the fork's deps or providers over a fixture
 *   fetch, a fixed clock, a fake timer, a pacer of their own (no turn waits on another test's), a memory
 *   cache and a yahoo-finance2 client with cookies of its own: what every provider test builds on.
 * - `buildTools(providers)`: route(providers), the data tools, the compute tools and the evidence tool in a
 *   ToolRegistry, as the engine builds them, over one evidence store; `runTool(name, input)` runs one call
 *   as the model's would be run (a compute tool's `{"ref": "e1"}` reads an earlier call's result), and
 *   answers what the model reads (`text`), the transcript's summary, the recorded payload and its provenance.
 * - `readCheck(data)`: a view of a provider's answer that logs each field the tool reads, so a test can
 *   assert that every field read was supplied (not undefined). `buildTools(providers, { check: true })`
 *   puts every answer behind one, and `runTool` answers the call's log as `reads`; for answers a tool
 *   spreads or passes on whole, the keys it needs are checked too (SPREAD_KEYS).
 *
 * Importing this file puts the network guard in place (test/fork/net-guard.ts), so its tests reach no
 * host even when run from another directory than the repository's, where bunfig.toml's preload is not read.
 */
import "../net-guard.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../../../src/contracts/index.js";
import { type DataProvider, INDICATORS } from "../../../src/data/capabilities.js";
import { type Providers, route } from "../../../src/data/router.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import { type ForkDeps, type ForkOptions, forkDeps } from "../../../src/fork/data/deps.js";
import { Pacer } from "../../../src/fork/data/http.js";
import { forkProviders } from "../../../src/fork/data/index.js";
import type { Timer } from "../../../src/fork/data/timer.js";
import { computeTools, dataTools } from "../../../src/tools/catalog.js";
import { evidenceTool } from "../../../src/tools/evidence.js";
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
  /** What a hand-made fixture is made from. */
  note?: string;
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
 * Elapsed time that moves only when slept, without waiting: each sleep is listed in `slept` (in the order
 * asked), and the sleeps end one at a time in the order of the times they end at, the time set to each one's
 * end as it ends, so what a sleeper does on waking sees the time it woke at, as with real time; calls made
 * together all see the time they were made at. A sleep's signal ends it early with the signal's reason.
 * `late` says how many milliseconds after its time the sleep asked `index`-th (from 0) ends, as a real
 * timer fires a little late (none unless given).
 */
export function fakeTimer(start = 0, late?: (index: number) => number): Timer & { slept: number[] } {
  let now = start;
  let order = 0;
  const slept: number[] = [];
  const due: { at: number; order: number; wake(): void }[] = [];
  let scheduled = false;
  // One sleeper wakes per turn of the event loop, so what it does on waking runs before the next wakes.
  const wakeNext = () => {
    scheduled = false;
    due.sort((a, b) => a.at - b.at || a.order - b.order);
    const next = due.shift();
    if (!next) return;
    now = Math.max(now, next.at);
    next.wake();
    if (due.length) schedule();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(wakeNext);
  };
  return {
    now: () => now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const index = slept.push(ms) - 1;
        const entry = {
          at: now + Math.max(0, ms) + (late?.(index) ?? 0),
          order: order++,
          wake: () => {
            signal?.removeEventListener("abort", stop);
            resolve();
          },
        };
        const stop = () => {
          const at = due.indexOf(entry);
          if (at >= 0) due.splice(at, 1);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", stop, { once: true });
        due.push(entry);
        schedule();
      }),
    slept,
  };
}

// Deps and providers for a test -----------------------------------------------------------------

/** The engine's day in the harness's tests. */
export const TEST_DAY = "2026-11-25T22:00:00Z";

/** What a test builds a provider on: the fixture fetch, clock and timer, to look at afterwards. */
export type TestSetup = { fetch: FixtureFetch; clock: Clock; timer: Timer & { slept: number[] } };

/** What a test may give besides its routes: the engine's day, a timer, and any other of ForkOptions. */
export type TestOptions = Omit<ForkOptions, "fetch" | "clock" | "timer"> & {
  /** The engine's day: TEST_DAY unless given. */
  now?: string;
  timer?: Timer & { slept: number[] };
};

/**
 * The options a provider test builds the fork's deps with: `routes` (or a fixture fetch of its own) for
 * every request, the engine's day fixed, a fake timer and a pacer of the test's own, so no turn or
 * Retry-After pause of another test's is waited for; the cache is in memory unless `config` names a
 * directory (or `extra` gives one), and the yahoo-finance2 client keeps cookies of its own.
 */
function testOptions(
  routes: readonly FixtureRoute[] | FixtureFetch,
  { now = TEST_DAY, timer = fakeTimer(), ...extra }: TestOptions,
): { options: ForkOptions } & TestSetup {
  const fetch = typeof routes === "function" ? routes : fixtureFetch(routes);
  const clock = fixedClock(now);
  return { options: { pacer: new Pacer(), ...extra, fetch, clock, timer }, fetch, clock, timer };
}

/** The fork's deps for `config` over `routes`, for a test: see testOptions. */
export function testDeps(
  config: PublicDataConfig = {},
  routes: readonly FixtureRoute[] | FixtureFetch = [],
  extra: TestOptions = {},
): { deps: ForkDeps } & TestSetup {
  const { options, ...setup } = testOptions(routes, extra);
  return { deps: forkDeps(config, options), ...setup };
}

/** The fork's providers for `config` over `routes`, for a test: see testOptions. */
export function testProviders(
  config: PublicDataConfig = {},
  routes: readonly FixtureRoute[] | FixtureFetch = [],
  extra: TestOptions = {},
): { providers: Providers } & TestSetup {
  const { options, ...setup } = testOptions(routes, extra);
  return { providers: forkProviders(config, options), ...setup };
}

// Read checks ----------------------------------------------------------------------------------

/** The fields read of a provider's answer, by path ("instrument.currency", "bars[].close"). */
export type ReadLog = {
  /** How often each path was read, and how often it held nothing (undefined). */
  reads: Map<string, { reads: number; missing: number }>;
  /** The paths whose keys a reader listed (a spread, Object.keys): "" for the answer itself. */
  listed: Set<string>;
  /** The paths read, sorted. */
  paths(): string[];
  /** The paths read at least once where the answer held nothing, sorted. */
  missing(): string[];
  clear(): void;
};

export function readLog(): ReadLog {
  const reads = new Map<string, { reads: number; missing: number }>();
  const listed = new Set<string>();
  return {
    reads,
    listed,
    paths: () => [...reads.keys()].sort(),
    missing: () =>
      [...reads.entries()]
        .filter(([, count]) => count.missing > 0)
        .map(([path]) => path)
        .sort(),
    clear: () => {
      reads.clear();
      listed.clear();
    },
  };
}

/** Counts one read of `path` in `log`, and whether it found nothing. */
function count(log: ReadLog, path: string, missing: boolean): void {
  const counted = log.reads.get(path) ?? { reads: 0, missing: 0 };
  counted.reads++;
  if (missing) counted.missing++;
  log.reads.set(path, counted);
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
 * value; nested objects and arrays are viewed the same way, an array's items as "<path>[]". A field asked
 * about with `in` counts as read but never as missing (asking is not reading); listing an object's keys
 * (a spread, Object.keys) is noted in `log.listed`: a field a spread leaves out is invisible to a view, so
 * a tool that spreads an answer has its keys checked by SPREAD_KEYS instead.
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
        count(log, at, value === undefined);
        return plain(value) ? view(value, at) : value;
      },
      has(object, property) {
        if (typeof property === "string" && !Array.isArray(object) && !NOT_FIELDS.has(property)) {
          count(log, path ? `${path}.${property}` : property, false);
        }
        return Reflect.has(object, property);
      },
      ownKeys(object) {
        log.listed.add(path);
        return Reflect.ownKeys(object);
      },
    });
    views.set(target, made);
    return made;
  };
  const copy = structuredClone(data);
  return { value: (plain(copy) ? view(copy, "") : copy) as T, log };
}

/**
 * The keys a tool needs of an answer it spreads, or passes on whole, by capability and method ("technicals.latest"),
 * each at a path in the answer ("" the answer itself, "holders[]" each holder): a spread or a whole record
 * never asks the view for a key the answer leaves out, so `checkedProviders` logs each of these as read,
 * and as missing when the answer has none. From what the tools read (src/tools/technicals.ts, company.ts):
 * technicals' indicators and the fields its text states; the estimates preview's consensus, targets and
 * next earnings; the institutional holders the contract requires of every row.
 */
export const SPREAD_KEYS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "technicals.latest": {
    "": [
      ...INDICATORS,
      "through",
      "last_value",
      "window",
      "price_basis",
      "volume_available",
      "price_vs_sma50",
      "price_vs_sma200",
      "sma50_vs_sma200",
    ],
  },
  "profiles.analyst": { "": ["recommendation", "target_low_price", "target_high_price"] },
  "profiles.calendar": { "": ["earnings", "dividend"] },
  "ownership.holders": {
    "": ["quarter", "complete", "quarters", "caveats", "holders", "next_cursor"],
    "holders[]": [
      "manager",
      "filed",
      "form",
      "value",
      "value_unit",
      "shares",
      "shares_type",
      "put_call",
      "discretion",
      "accession",
    ],
  },
};

/** The objects at `path` in `data` ("" itself, "a.b", "list[]" each item, "a.list[].b"). */
function objectsAt(data: unknown, path: string): object[] {
  let found: unknown[] = [data];
  for (const step of path ? path.split(".") : []) {
    const each = step.endsWith("[]");
    const name = each ? step.slice(0, -2) : step;
    found = found.flatMap((item) => {
      if (!plain(item) || Array.isArray(item)) return [];
      const value = (item as Record<string, unknown>)[name];
      if (!each) return [value];
      return Array.isArray(value) ? value : [];
    });
  }
  return found.filter((item): item is object => plain(item) && !Array.isArray(item));
}

/** Logs, in `log`, each of `keys` (SPREAD_KEYS' form) as read in `data`, and missing when it has none. */
export function expectKeys(
  data: unknown,
  keys: Readonly<Record<string, readonly string[]>>,
  log: ReadLog,
): void {
  for (const [path, names] of Object.entries(keys)) {
    for (const object of objectsAt(data, path)) {
      for (const name of names) {
        count(log, path ? `${path}.${name}` : name, (object as Record<string, unknown>)[name] === undefined);
      }
    }
  }
}

/**
 * `providers` with every answer of every method behind a read check logging into `log`, and the keys
 * SPREAD_KEYS names for the method checked.
 */
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
              async (...args: unknown[]) => {
                const answer = await run.apply(implementation, args);
                const keys = SPREAD_KEYS[`${capability}.${method}`];
                if (keys) expectKeys(answer, keys, log);
                return readCheck(answer, log).value;
              },
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
  /** The id of the result recorded ("e1"), for a later call to reference; undefined when the call failed. */
  evidence?: string;
  /** The payload recorded, and where it came from; undefined when the call failed. */
  payload: unknown;
  provenance: Provenance | undefined;
  /** The fields of the providers' answers the tool read (with `check`). */
  reads: ReadLog;
};

/**
 * The tools over `providers` as the engine builds them (src/engine/factory.ts): the data tools, the compute
 * tools and the evidence tool, in one registry over one evidence store, and a way to call them. Each call
 * is a step of its own, so a compute tool's reference to an earlier call's result (`{"ref": "e1"}`) reads it.
 */
export function buildTools(
  providers: Providers,
  { clock = fixedClock(TEST_DAY), check = false }: { clock?: Clock; check?: boolean } = {},
) {
  const log = readLog();
  const routed = route(check ? checkedProviders(providers, log) : providers);
  const offered = dataTools(routed.capabilities, clock);
  const data = offered.map(([, tool]) => tool);
  const compute = computeTools();
  const registry = new ToolRegistry([...data, ...compute, evidenceTool([...data, ...compute])]);
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
    for (const [path, counted] of log.reads) reads.reads.set(path, { ...counted });
    for (const path of log.listed) reads.listed.add(path);
    return {
      text: outcome.output,
      summary: outcome.summary,
      ...(outcome.failure ? { failure: outcome.failure } : {}),
      ...(outcome.source ? { source: outcome.source } : {}),
      ...(record ? { evidence: record.id } : {}),
      payload: record?.payload,
      provenance: record?.provenance,
      reads,
    };
  };
  return { registry, available: routed.available, capabilities: routed.capabilities, runTool };
}
