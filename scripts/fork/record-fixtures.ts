// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Records the fork's data-test fixtures from the live sources. It is the owner's tool, run on the owner's
 * own machine; tests never record, and prove this script only against a local stub server.
 *
 *   bun scripts/fork/record-fixtures.ts [--only <source>[,<source>...]] [--dry-run]
 *                                       [--cases <dir>] [--out <dir>]
 *
 * Each module in scripts/fork/fixture-cases/ (or --cases) exports `cases`: what to read (a URL, built from
 * the settings when it needs a key, or a reading of its own given the fork's HTTP client, its yahoo-finance2
 * client and `yahooAnswer`, which records Yahoo's raw answer to a library call) and where it goes. Every
 * request goes through the fork's own clients, so it is paced, bounded and sent as the app sends it: SEC's
 * hosts with SEC_USER_AGENT when it is set, Yahoo through yahoo-finance2 with the library's own
 * User-Agent, other hosts as `TradingAgents-fork-dev/1.0`. Keys come from the environment, else
 * credentials.json's "data" object, as the app reads them; never from a case module.
 *
 * A case writes test/fork/fixtures (or --out) /<source>/<name>.<ext> and <name>.meta.json (the URL with its
 * keys removed, status, content type, when, bytes, hand_made: false). Every configured key is removed from a
 * text answer; a binary answer that holds one is not written. A case that fails writes nothing, so a failed
 * answer never replaces a fixture; files are replaced whole. --dry-run sends nothing and writes nothing: it
 * lists each case, its URL (keys removed) and the files it would write. The exit status is 1 when any case
 * failed, 2 for an option this script does not take.
 */
import { readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ExtendedCookieJar } from "yahoo-finance2/lib/cookieJar";
import { resolvePaths } from "../../src/config/paths.js";
import { type PublicDataConfig, publicDataConfig, secretsOf } from "../../src/fork/data/config.js";
import { forkDeps, type YahooFinanceClient, yahooClient } from "../../src/fork/data/deps.js";
import type { Http } from "../../src/fork/data/http.js";
import { holdsSecret, redact, redactUrl } from "../../src/fork/data/redact.js";
import { writeAtomic } from "../../src/store/index.js";

/** The User-Agent development requests carry (SEC's hosts get SEC_USER_AGENT when it is set). */
export const DEV_USER_AGENT = "TradingAgents-fork-dev/1.0";

/** What a case read: the body, and what to say about it. */
export type Recorded = {
  body: string | Uint8Array;
  status?: number;
  contentType?: string;
  /** The address read, for the meta (keys are removed before it is written). */
  url?: string;
};

/**
 * Yahoo's raw answer to a call: `call` runs on a yahoo-finance2 client of its own, configured as the app's
 * (the library's User-Agent, its cookie and crumb), and the answer of the first request whose URL matches
 * `match` is recorded as Yahoo sent it, so tests can serve it to the library again. An answer that is not
 * OK fails the case.
 */
export type YahooAnswer = (
  call: (yahoo: YahooFinanceClient) => Promise<unknown>,
  match: RegExp,
) => Promise<Recorded>;

/** What a case's own reading is given besides the HTTP client. */
export type ReadTools = { yahoo: YahooFinanceClient; yahooAnswer: YahooAnswer };

/** One fixture to record. */
export type FixtureCase = {
  /** The fixture's folder under test/fork/fixtures: the source it is from ("ecb", "sec", "yahoo"). */
  source: string;
  /** Its file name without the extension, and its meta's ("exr-usd-last5"). */
  name: string;
  /**
   * A URL to read with the fork's HTTP client, or one built from the settings when it carries a key
   * (`(config) => \`...&api_key=${config.fredKey}\``)...
   */
  url?: string | ((config: PublicDataConfig) => string);
  /** ...or a reading of its own: through the HTTP client, or yahoo-finance2 for Yahoo (`yahooAnswer`). */
  read?: (http: Http, more: ReadTools) => Promise<Recorded>;
  /** The file's name, extension included, when the content type would not give the right one. */
  file?: string;
  /** Statuses recorded as answered (an error body worth a fixture), not failed. */
  accept?: readonly number[];
  /** The request's deadline, when the source needs longer than the HTTP client's default. */
  timeoutMs?: number;
};

const ROOT = join(import.meta.dir, "../..");
const FIXTURES = join(ROOT, "test/fork/fixtures");
const CASES = join(import.meta.dir, "fixture-cases");
/** A source's or a name's spelling: lower case, digits, dots, dashes and underscores. */
const NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** The extension a content type is written with. */
function extensionOf(contentType: string | undefined): string {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("json")) return "json";
  if (type.includes("csv")) return "csv";
  if (type.includes("html")) return "html";
  if (type.includes("xml")) return "xml";
  if (type.includes("zip")) return "zip";
  if (type.startsWith("text/")) return "txt";
  return "bin";
}

/** Whether a body of `contentType` is text (keys are removed from it), not bytes. */
function textual(contentType: string | undefined, extension: string): boolean {
  return (
    /^(text\/|application\/([a-z.+-]*\+)?(json|xml|csv)|application\/javascript)/i.test(contentType ?? "") ||
    ["json", "csv", "xml", "html", "htm", "txt"].includes(extension)
  );
}

/** Every case the case modules in `dir` export, checked for a usable source, name and reading. */
export async function loadCases(dir: string = CASES): Promise<FixtureCase[]> {
  const cases: FixtureCase[] = [];
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .sort()) {
    const module = (await import(join(dir, file))) as { cases?: unknown };
    if (!Array.isArray(module.cases)) throw new Error(`${file}: exports no cases`);
    cases.push(...(module.cases as FixtureCase[]));
  }
  const seen = new Set<string>();
  for (const one of cases) {
    const where = `${one.source}/${one.name}`;
    if (!NAME.test(one.source) || !NAME.test(one.name))
      throw new Error(`${where}: not a usable source or name`);
    if (!one.url === !one.read) throw new Error(`${where}: give a url or a read, one of them`);
    if (one.file !== undefined && (!NAME.test(one.file) || !one.file.includes("."))) {
      throw new Error(`${where}: file must be a plain name with an extension`);
    }
    if (seen.has(where)) throw new Error(`${where}: recorded twice`);
    seen.add(where);
  }
  return cases;
}

/** The URL a case reads, with its keys in it (never said as it is: see redactUrl). */
function urlOf(one: FixtureCase, config: PublicDataConfig): string | undefined {
  return typeof one.url === "function" ? one.url(config) : one.url;
}

/**
 * Yahoo's raw answers to calls made through `fetch` (see YahooAnswer). Its clients share one cookie jar, so
 * a run asks Yahoo for its cookie and crumb once, as the app's one client does.
 */
export function yahooAnswerer(fetchImpl: typeof globalThis.fetch): YahooAnswer {
  const cookieJar = new ExtendedCookieJar();
  return async (call, match) => {
    const answers: {
      url: string;
      ok: boolean;
      status: number;
      type: string | null;
      body: Promise<ArrayBuffer>;
    }[] = [];
    const capturing = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetchImpl(input, init);
      const body = response.clone().arrayBuffer();
      // Only the matching answer's copy is read; the others may fail unread.
      body.catch(() => {});
      answers.push({
        url: input instanceof Request ? input.url : String(input),
        ok: response.ok,
        status: response.status,
        type: response.headers.get("content-type"),
        // A copy of the body, read beside the library's own reading.
        body,
      });
      return response;
    }) as typeof globalThis.fetch;
    let failure: unknown;
    try {
      await call(yahooClient(capturing, { cookieJar }));
    } catch (error) {
      // The raw answer is what is recorded; the library's refusal of it is said only when there is none.
      failure = error;
    }
    const found = answers.find((answer) => match.test(answer.url));
    if (!found) throw new Error(`no Yahoo request matched ${match}${failure ? ` (${String(failure)})` : ""}`);
    if (!found.ok) throw new Error(`Yahoo answered HTTP ${found.status}`);
    return {
      body: new Uint8Array(await found.body),
      status: found.status,
      url: found.url,
      ...(found.type ? { contentType: found.type } : {}),
    };
  };
}

/** What a case read, ready to write: its file, body (keys removed) and meta; it throws when the case failed. */
export async function recordOne(
  one: FixtureCase,
  http: Http,
  tools: ReadTools,
  secrets: readonly string[],
  config: PublicDataConfig = {},
): Promise<{ file: string; body: Uint8Array; meta: Record<string, string | number | boolean> }> {
  let read: Recorded;
  const url = urlOf(one, config);
  if (url) {
    const answer = await http.get(url, {
      source: one.source,
      ...(one.accept ? { accept: one.accept } : {}),
      ...(one.timeoutMs ? { timeoutMs: one.timeoutMs } : {}),
    });
    read = {
      body: await answer.bytes(),
      status: answer.status,
      url,
      ...(answer.headers.get("content-type")
        ? { contentType: answer.headers.get("content-type") as string }
        : {}),
    };
  } else {
    read = await (one.read as NonNullable<FixtureCase["read"]>)(http, tools);
  }
  const extension = one.file ? (one.file.split(".").pop() as string) : extensionOf(read.contentType);
  const file = one.file ?? `${one.name}.${extension}`;
  let body: Uint8Array;
  if (typeof read.body === "string" || textual(read.contentType, extension)) {
    const text = typeof read.body === "string" ? read.body : new TextDecoder().decode(read.body);
    body = new TextEncoder().encode(redact(text, secrets));
  } else {
    if (holdsSecret(Buffer.from(read.body).toString("latin1"), secrets)) {
      throw new Error("the answer holds a key and is not text the key could be removed from");
    }
    body = read.body;
  }
  const meta = {
    source: one.source,
    name: one.name,
    url: read.url ? redactUrl(read.url, secrets) : "",
    status: read.status ?? 200,
    content_type: read.contentType ?? "",
    recorded_at: new Date().toISOString(),
    bytes: body.length,
    hand_made: false,
  };
  return { file, body, meta };
}

/** A run of the recorder: its arguments, and what it reads and writes through. */
export type RecordRun = {
  argv: readonly string[];
  /** Where keys and SEC_USER_AGENT are read (the process's environment, and its home's credentials.json). */
  env?: NodeJS.ProcessEnv;
  /** The fetch every request goes through (a stub server's, in a test). */
  fetch?: typeof globalThis.fetch;
  /** Lines said, and problems. */
  out?: (line: string) => void;
  err?: (line: string) => void;
};

/** One run of the recorder; it answers the exit status. */
export async function record(run: RecordRun): Promise<number> {
  const out = run.out ?? ((line: string) => console.log(line));
  const err = run.err ?? ((line: string) => console.error(line));
  const env = run.env ?? process.env;
  const only = new Set<string>();
  let dryRun = false;
  let casesDir = CASES;
  let outDir = FIXTURES;
  const argv = run.argv;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = argv[i + 1];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--only" && value) {
      for (const source of value.split(",")) if (source.trim()) only.add(source.trim());
      i++;
    } else if (arg === "--cases" && value) {
      casesDir = resolve(value);
      i++;
    } else if (arg === "--out" && value) {
      outDir = resolve(value);
      i++;
    } else {
      err(
        `record-fixtures: ${arg} is not an option (--only <source>[,<source>], --dry-run, --cases <dir>, --out <dir>)`,
      );
      return 2;
    }
  }
  const all = await loadCases(casesDir);
  const cases = only.size ? all.filter((one) => only.has(one.source)) : all;
  if (!cases.length) {
    err(`record-fixtures: no case${only.size ? ` for ${[...only].join(", ")}` : ""}`);
    return 1;
  }
  const { config } = await publicDataConfig(env, resolvePaths(env));
  const secrets = secretsOf(config);
  if (dryRun) {
    for (const one of cases) {
      const url = urlOf(one, config);
      const target = one.file ?? `${one.name}.<ext>`;
      out(
        `${one.source}/${target} and ${one.source}/${one.name}.meta.json <- ${url ? redactUrl(url, secrets) : "(its own reading)"}`,
      );
    }
    return 0;
  }
  // No disk cache: a fixture is what the source answers now.
  const { cacheDir: _cache, ...live } = config;
  const deps = forkDeps(live, { userAgent: DEV_USER_AGENT, ...(run.fetch ? { fetch: run.fetch } : {}) });
  const tools: ReadTools = { yahoo: deps.yahoo, yahooAnswer: yahooAnswerer(deps.fetch) };
  let failed = 0;
  for (const one of cases) {
    const where = `${one.source}/${one.name}`;
    try {
      const { file, body, meta } = await recordOne(one, deps.http, tools, secrets, live);
      const dir = join(outDir, one.source);
      await mkdir(dir, { recursive: true });
      await writeAtomic(join(dir, file), body);
      await writeAtomic(join(dir, `${one.name}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
      out(
        `${one.source}/${file}: ${meta.status} ${meta.content_type || "(no content type)"}, ${meta.bytes} bytes`,
      );
    } catch (error) {
      failed++;
      const said = error instanceof Error ? error.message : String(error);
      err(`FAILED ${where}: ${redact(said, secrets)} (its fixture, if any, is kept as it was)`);
    }
  }
  out(`record-fixtures: ${cases.length - failed} recorded, ${failed} failed`);
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await record({ argv: process.argv.slice(2) });
