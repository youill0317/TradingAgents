// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The fixture recorder, proven against a stub server on 127.0.0.1 and nothing else: the cases it records
 * there (keys removed from bodies and metas), what it refuses to write, a failed answer leaving the
 * fixture it would have replaced, --only and --dry-run, a Yahoo case through yahoo-finance2 with the
 * library's own User-Agent (Yahoo's addresses sent to the stub), and the script itself as the owner runs it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_USER_AGENT, loadCases, record } from "../../../scripts/fork/record-fixtures.js";
import { NET_GUARD } from "../net-guard.js";
import { fixture } from "./harness.js";

const KEY = "fred-key-0123456789abcdef";

/** The stub's requests: path and query, and the User-Agent each came with. */
const seen: { path: string; agent: string | null }[] = [];
let server: ReturnType<typeof Bun.serve>;
let stub: string;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({ path: `${url.pathname}${url.search}`, agent: request.headers.get("user-agent") });
      switch (url.pathname) {
        case "/ecb/exr.csv":
          return new Response("KEY,TIME_PERIOD,OBS_VALUE\r\nEXR.D.USD.EUR.SP00.A,2026-11-25,1.0935\r\n", {
            headers: { "content-type": "text/csv" },
          });
        case "/fred/series":
          // An answer that echoes the key it was asked with, as some error pages do.
          return Response.json({ series_id: url.searchParams.get("series_id"), note: `asked with ${KEY}` });
        case "/gone":
          return new Response("not here", { status: 404 });
        case "/archive.zip":
          return new Response(new TextEncoder().encode(`PK\u0003\u0004 ${KEY}`), {
            headers: { "content-type": "application/zip" },
          });
        case "/yahoo/finance.yahoo.com/quote/AAPL":
          return new Response("", {
            headers: { "set-cookie": "A3=stub; Max-Age=3600; Domain=.yahoo.com; Path=/; Secure" },
          });
        case "/yahoo/query1.finance.yahoo.com/v1/test/getcrumb":
          return new Response("STUBCRUMB", { headers: { "content-type": "text/plain" } });
        case "/yahoo/query2.finance.yahoo.com/v7/finance/quote":
        case "/yahoo/query1.finance.yahoo.com/v7/finance/quote":
          return new Response(fixture("yahoo/quote-aapl.json"), {
            headers: { "content-type": "application/json;charset=utf-8" },
          });
        default:
          return new Response("no such stub path", { status: 500 });
      }
    },
  });
  stub = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  await server.stop(true);
});

/** A fetch that sends Yahoo's addresses to the stub (the library builds them itself), and the rest as given. */
const toStub = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const local = /(^|\.)yahoo\.com$/.test(url.hostname)
    ? `${stub}/yahoo/${url.hostname}${url.pathname}${url.search}`
    : url.href;
  return fetch(local, init);
}) as typeof globalThis.fetch;

let dir: string;
let cases: string;
let out: string;
let env: Record<string, string>;
beforeEach(async () => {
  seen.length = 0;
  dir = await mkdtemp(join(tmpdir(), "fork-recorder-"));
  cases = join(dir, "cases");
  out = join(dir, "fixtures");
  await mkdir(cases);
  // Keys come from the settings, as the app reads them; the case modules never hold one.
  env = { FRED_API_KEY: KEY, HOME: dir, TRADINGAGENTS_HOME: join(dir, "home"), PATH: process.env.PATH ?? "" };
  await writeFile(
    join(cases, "stub.ts"),
    `export const cases = [
  { source: "stub", name: "exr", url: "${stub}/ecb/exr.csv" },
  { source: "stub", name: "keyed", url: (config) => "${stub}/fred/series?series_id=CPIAUCSL&api_key=" + config.fredKey },
  { source: "stub", name: "gone", url: "${stub}/gone" },
  { source: "stub", name: "archive", url: "${stub}/archive.zip" },
  {
    source: "yahoo",
    name: "quote-aapl",
    read: (_http, { yahooAnswer }) => yahooAnswer((yahoo) => yahoo.quote("AAPL"), /\\/v7\\/finance\\/quote\\?/),
  },
];
`,
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One run of the recorder in this process: its exit status and what it said. */
async function run(...argv: string[]) {
  const said: string[] = [];
  const problems: string[] = [];
  const status = await record({
    argv: ["--cases", cases, "--out", out, ...argv],
    env,
    fetch: toStub,
    out: (line) => said.push(line),
    err: (line) => problems.push(line),
  });
  return { status, said, problems };
}

const text = (path: string) => readFile(join(out, path), "utf8");

describe("recording from the stub server", () => {
  test("text answers are written with every key removed, from the body and from the meta's URL", async () => {
    const { status, said, problems } = await run("--only", "stub");
    expect(status).toBe(1);
    expect(said.at(-1)).toBe("record-fixtures: 2 recorded, 2 failed");
    expect(await text("stub/exr.csv")).toBe(
      "KEY,TIME_PERIOD,OBS_VALUE\r\nEXR.D.USD.EUR.SP00.A,2026-11-25,1.0935\r\n",
    );
    expect(JSON.parse(await text("stub/keyed.json"))).toEqual({
      series_id: "CPIAUCSL",
      note: "asked with ***",
    });
    const meta = JSON.parse(await text("stub/keyed.meta.json"));
    expect(meta).toMatchObject({
      source: "stub",
      name: "keyed",
      url: `${stub}/fred/series?series_id=CPIAUCSL&api_key=***`,
      status: 200,
      content_type: "application/json;charset=utf-8",
      hand_made: false,
    });
    expect(meta.bytes).toBe((await readFile(join(out, "stub/keyed.json"))).length);
    // The key was sent (the source needs it) and is in nothing written or said.
    expect(seen.some((request) => request.path.includes(KEY))).toBe(true);
    for (const file of await readdir(join(out, "stub")))
      expect(await text(`stub/${file}`)).not.toContain(KEY);
    expect([...said, ...problems].join("\n")).not.toContain(KEY);
    // Every request named the recorder as its sender.
    expect(new Set(seen.map((request) => request.agent))).toEqual(new Set([DEV_USER_AGENT]));
  });

  test("a binary answer holding a key, and a failed answer, are not written; what was there stays", async () => {
    await mkdir(join(out, "stub"), { recursive: true });
    await writeFile(join(out, "stub/gone.txt"), "the fixture recorded before");
    await writeFile(join(out, "stub/gone.meta.json"), '{"status":200}\n');
    const { problems } = await run("--only", "stub");
    expect(problems).toEqual([
      expect.stringMatching(/^FAILED stub\/gone: .*\(its fixture, if any, is kept as it was\)$/),
      "FAILED stub/archive: the answer holds a key and is not text the key could be removed from (its fixture, if any, is kept as it was)",
    ]);
    expect(await text("stub/gone.txt")).toBe("the fixture recorded before");
    expect(await text("stub/gone.meta.json")).toBe('{"status":200}\n');
    expect((await readdir(join(out, "stub"))).sort()).toEqual([
      "exr.csv",
      "exr.meta.json",
      "gone.meta.json",
      "gone.txt",
      "keyed.json",
      "keyed.meta.json",
    ]);
  });

  test("a Yahoo case records Yahoo's raw answer to a library call, sent with the library's own User-Agent", async () => {
    const { status, said } = await run("--only", "yahoo");
    expect([status, said.at(-1)]).toEqual([0, "record-fixtures: 1 recorded, 0 failed"]);
    expect(await text("yahoo/quote-aapl.json")).toBe(
      new TextDecoder().decode(fixture("yahoo/quote-aapl.json")),
    );
    const meta = JSON.parse(await text("yahoo/quote-aapl.meta.json"));
    expect(meta.url).toMatch(/^https:\/\/query\d\.finance\.yahoo\.com\/v7\/finance\/quote\?.*crumb=\*\*\*/);
    expect(meta.url).not.toContain("STUBCRUMB");
    const yahoo = seen.filter((request) => request.path.startsWith("/yahoo/"));
    expect(yahoo.length).toBeGreaterThanOrEqual(3);
    for (const request of yahoo)
      expect(request.agent ?? "").toStartWith("Mozilla/5.0 (compatible; yahoo-finance2/");
  });

  test("--dry-run lists each case and its files, keys removed, and sends and writes nothing", async () => {
    const { status, said } = await run("--dry-run");
    expect(status).toBe(0);
    expect(said).toEqual([
      `stub/exr.<ext> and stub/exr.meta.json <- ${stub}/ecb/exr.csv`,
      `stub/keyed.<ext> and stub/keyed.meta.json <- ${stub}/fred/series?series_id=CPIAUCSL&api_key=***`,
      `stub/gone.<ext> and stub/gone.meta.json <- ${stub}/gone`,
      `stub/archive.<ext> and stub/archive.meta.json <- ${stub}/archive.zip`,
      "yahoo/quote-aapl.<ext> and yahoo/quote-aapl.meta.json <- (its own reading)",
    ]);
    expect(seen).toEqual([]);
    expect(await readdir(dir)).toEqual(["cases"]);
  });

  test("an option it does not take, and --only naming no case", async () => {
    expect((await run("--live")).status).toBe(2);
    const none = await run("--only", "nothing");
    expect([none.status, none.problems]).toEqual([1, ["record-fixtures: no case for nothing"]]);
    expect(seen).toEqual([]);
  });
});

test("the script as the owner runs it, here behind the tests' network guard, against the stub", async () => {
  const script = join(import.meta.dir, "../../../scripts/fork/record-fixtures.ts");
  const child = Bun.spawn(
    [process.execPath, "--preload", NET_GUARD, script, "--cases", cases, "--out", out, "--only", "stub"],
    { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(1);
  expect(stdout).toContain("stub/exr.csv: 200 text/csv");
  expect(stdout).toContain("record-fixtures: 2 recorded, 2 failed");
  expect(stderr).toContain("FAILED stub/gone");
  expect(stderr).not.toContain("net-guard:");
  expect(`${stdout}${stderr}`).not.toContain(KEY);
  expect(JSON.parse(await text("stub/keyed.json")).note).toBe("asked with ***");
}, 30_000);

test("the repository's case modules load, each case with a source, a name and one way to read it", async () => {
  const all = await loadCases();
  expect(all.map((one) => `${one.source}/${one.name}`)).toContain("ecb/exr-usd-last5");
  for (const one of all) expect(Boolean(one.url) !== Boolean(one.read)).toBe(true);
});
