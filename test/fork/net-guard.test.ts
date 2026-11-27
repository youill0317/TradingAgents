// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The network guard every test runs behind (bunfig.toml, test/fork/preload.ts): each way out to a host other
 * than 127.0.0.1 or localhost is refused, said and listed, while loopback servers stay reachable. Every host
 * tried here is under .invalid, a name that resolves nowhere, so not even a broken guard could reach one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { get as httpGet, request as httpRequest } from "node:http";
import { connect as http2Connect } from "node:http2";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { isLoopback, NET_GUARD, NetGuardError, takeBlocked, trapPort } from "./net-guard.js";

const AWAY = "guard-check.invalid";

/** What `run` threw, and the refusals it left, which are taken so this test's own end does not fail on them. */
async function refused(run: () => unknown): Promise<{ error: unknown; blocked: string[] }> {
  const quiet = console.error;
  console.error = () => {};
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  } finally {
    console.error = quiet;
  }
  return { error, blocked: takeBlocked() };
}

afterEach(() => {
  expect(takeBlocked()).toEqual([]);
});

describe("refused", () => {
  test("fetch, by URL, URL object or Request, and through a proxy option", async () => {
    for (const input of [`https://${AWAY}/a?api_key=stand-in`, new URL(`http://${AWAY}:8080/b`)]) {
      const { error, blocked } = await refused(() => fetch(input));
      expect(error).toBeInstanceOf(NetGuardError);
      expect(blocked).toHaveLength(1);
      expect(blocked[0]).not.toContain("stand-in");
    }
    expect((await refused(() => fetch(new Request(`https://${AWAY}/c`)))).blocked).toEqual([
      `fetch https://${AWAY}/c`,
    ]);
    expect((await refused(() => fetch(`s3://${AWAY}/key`))).blocked).toHaveLength(1);
    const proxied = await refused(() =>
      fetch("http://127.0.0.1:9/x", { proxy: `http://${AWAY}:3128` } as RequestInit),
    );
    expect(proxied.blocked).toEqual([`fetch through the proxy http://${AWAY}:3128/`]);
  });

  test("WebSocket and Bun.connect", async () => {
    expect((await refused(() => new WebSocket(`wss://${AWAY}/stream`))).error).toBeInstanceOf(NetGuardError);
    const socket = { open() {}, data() {} };
    expect((await refused(() => Bun.connect({ hostname: AWAY, port: 443, socket }))).blocked).toEqual([
      `Bun.connect ${AWAY}`,
    ]);
  });

  test("node's clients, as imported", async () => {
    const calls: [string, () => unknown][] = [
      ["http.request", () => httpRequest(`http://${AWAY}/`)],
      ["http.get", () => httpGet({ hostname: AWAY, path: "/" })],
      ["https.request", () => httpsRequest({ host: AWAY, port: 443 })],
      ["http2.connect", () => http2Connect(`https://${AWAY}`)],
      ["net.connect", () => netConnect({ host: AWAY, port: 80 })],
      ["net.connect", () => netConnect(80, AWAY)],
      ["net.Socket.connect", () => new Socket().connect(80, AWAY)],
      ["tls.connect", () => tlsConnect({ host: AWAY, port: 443 })],
    ];
    for (const [name, call] of calls) {
      const { error, blocked } = await refused(call);
      expect([name, error instanceof NetGuardError, blocked.length]).toEqual([name, true, 1]);
      expect(blocked[0]).toStartWith(name);
    }
  });

  test("what honours the proxy settings reaches a trap that refuses it and says so", async () => {
    const port = trapPort() as number;
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
      expect(process.env[name]).toBe(`http://127.0.0.1:${port}`);
    }
    expect(process.env.no_proxy).toBe("localhost,127.0.0.1,::1");
    // A request sent to it as a proxy is sent: a CONNECT, as Bun would send for an https URL.
    const { blocked } = await refused(async () => {
      const answer = await new Promise<string>((resolve, reject) => {
        let said = "";
        Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: {
            open(socket) {
              socket.write(`CONNECT ${AWAY}:443 HTTP/1.1\r\nhost: ${AWAY}:443\r\n\r\n`);
            },
            data(_socket, data) {
              said += new TextDecoder().decode(data);
            },
            close() {
              resolve(said);
            },
            error(_socket, error) {
              reject(error);
            },
          },
        });
      });
      expect(answer).toStartWith("HTTP/1.1 403");
    });
    expect(blocked).toEqual([`a request through the proxy settings to ${AWAY}:443`]);
  });
});

describe("allowed", () => {
  test("a server on 127.0.0.1, by address and as localhost", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("here") });
    try {
      expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe("here");
      expect(await (await fetch(`http://localhost:${server.port}/`)).text()).toBe("here");
      const viaNode = await new Promise<number | undefined>((resolve, reject) => {
        httpGet(`http://127.0.0.1:${server.port}/`, (answer) => {
          answer.resume();
          resolve(answer.statusCode);
        }).on("error", reject);
      });
      expect(viaNode).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("loopback names", () => {
    expect(["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST.", "::1", "[::1]"].map(isLoopback)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(["128.0.0.1", "localhost.example.com", "0.0.0.0", "10.0.0.1", AWAY].map(isLoopback)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

test("a process a test starts from source runs behind the guard too, and says what it refused", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "--preload",
      NET_GUARD,
      "-e",
      `await fetch("https://${AWAY}/x").catch((e) => e.name);`,
    ],
    { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
  );
  const [stderr] = await Promise.all([new Response(run.stderr).text(), run.exited]);
  expect(stderr).toContain(`net-guard: fetch https://${AWAY}/x was refused`);
});
