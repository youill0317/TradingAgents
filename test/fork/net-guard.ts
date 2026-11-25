// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Tests make no real call: this guard, loaded before any test (bunfig.toml's [test] preload, through
 * test/fork/preload.ts) and into each process a test starts from source (`bun --preload <NET_GUARD>`),
 * refuses every request to a host other than 127.0.0.1, another loopback address or localhost. A refused
 * request is printed on stderr ("net-guard: ..."), listed (`takeBlocked`), and thrown as a NetGuardError;
 * in the test runner, the preload then fails the test that made it, even when the code under test caught
 * the error.
 *
 * What it watches: fetch (its `proxy` option too; `unix` sockets are local), WebSocket, EventSource,
 * Bun.connect, and node's http, https, http2, net and tls clients as require() gives them
 * (net.Socket.prototype.connect included). The preload also hands those node modules, so guarded, to
 * every `import` of them in tests. Bun.fetch cannot be replaced; for it, and anything else that honours the
 * proxy settings, every proxy variable is pointed at a local trap that refuses and reports each request,
 * with only loopback addresses exempt (Bun prefers the lower-case variables, so all four are set).
 */
import { createRequire } from "node:module";

/** This file, for `bun --preload` in a process a test starts. */
export const NET_GUARD = import.meta.path;

/** A request the guard refused. */
export class NetGuardError extends Error {
  override readonly name = "NetGuardError";
}

type State = { blocked: string[]; installed: boolean; trap: number | undefined };
const KEY = Symbol.for("tradingagents.fork.netGuard");
const holder = globalThis as unknown as { [KEY]?: State };
holder[KEY] ??= { blocked: [], installed: false, trap: undefined };
const state = holder[KEY] as State;

/** The hosts a test may reach: 127.0.0.0/8, ::1 and localhost. */
export function isLoopback(host: string): boolean {
  const name = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
  return (
    name === "localhost" ||
    name === "::1" ||
    name === "0:0:0:0:0:0:0:1" ||
    /^(::ffff:)?127(\.\d{1,3}){3}$/.test(name)
  );
}

/** The requests refused since the last call, oldest first; the list is emptied. */
export function takeBlocked(): string[] {
  return state.blocked.splice(0);
}

/** The local address every proxy variable points at once the guard is installed. */
export function trapPort(): number | undefined {
  return state.trap;
}

/** Records and prints a refused request; `throws` unless it was the trap's (which answers instead). */
function note(what: string): string {
  const said = `net-guard: ${what} was refused: tests reach no host but 127.0.0.1 and localhost`;
  state.blocked.push(what);
  console.error(said);
  return said;
}

function refuse(what: string): never {
  throw new NetGuardError(note(what));
}

/** A URL as said: its scheme, host and path, never its query (which may carry a test's stand-in key). */
function shown(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/** Refuses `input` unless it names a loopback host or needs no network (data:, blob:, file:). */
function checkUrl(what: string, input: unknown): void {
  let url: URL;
  try {
    url = new URL(
      input instanceof Request ? input.url : input instanceof URL ? input.href : String(input as string),
    );
  } catch {
    // Not a URL: the call itself fails as it would without the guard.
    return;
  }
  if (["data:", "blob:", "file:"].includes(url.protocol)) return;
  if (!isLoopback(url.hostname)) refuse(`${what} ${shown(url)}`);
}

function checkHost(what: string, host: string | undefined): void {
  if (host !== undefined && !isLoopback(host)) refuse(`${what} ${host}`);
}

type Options = { host?: unknown; hostname?: unknown; path?: unknown; socketPath?: unknown };
const objectOf = (value: unknown): Options | undefined =>
  typeof value === "object" && value !== null && !(value instanceof URL) ? (value as Options) : undefined;

/** The host an http(s).request or .get call names: its URL's, else its options' (localhost by default). */
function requestHost(args: readonly unknown[]): string | undefined {
  const [first, second] = args;
  let host: string | undefined;
  if (typeof first === "string" || first instanceof URL) {
    try {
      host = new URL(String(first)).hostname;
    } catch {
      host = undefined;
    }
  }
  const options = objectOf(first) ?? objectOf(second);
  if (typeof options?.socketPath === "string" && options.socketPath) return undefined;
  const named = options?.hostname ?? options?.host;
  if (typeof named === "string" && named) return named.replace(/:\d+$/, "");
  return host ?? (options ? "localhost" : undefined);
}

/** The host a net or tls connection names (localhost by default); undefined for a local socket path. */
function socketHost(args: readonly unknown[]): string | undefined {
  let [first, second] = args;
  // Node passes its own calls on as one array of normalized arguments.
  if (Array.isArray(first)) [first, second] = first as unknown[];
  const options = objectOf(first);
  if (options) {
    if (typeof options.path === "string" && options.path) return undefined;
    return typeof options.host === "string" && options.host ? options.host : "localhost";
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return typeof second === "string" && second ? second : "localhost";
  }
  return undefined;
}

type Fn = (...args: unknown[]) => unknown;

/** `owner[name]`, checked first by `check`. */
function wrap(owner: Record<string, unknown>, name: string, check: (args: unknown[]) => void): void {
  const original = owner[name];
  if (typeof original !== "function") return;
  const guarded = function (this: unknown, ...args: unknown[]) {
    check(args);
    return (original as Fn).apply(this, args);
  };
  Object.defineProperty(guarded, "name", { value: (original as Fn).name });
  owner[name] = guarded;
}

/** Puts the guard in place (once per process): see the top of this file. */
export function installNetGuard(): void {
  if (state.installed) return;
  state.installed = true;

  const fetchOf = globalThis.fetch;
  const guardedFetch = (input: string | URL | Request, init?: RequestInit) => {
    const options = init as (RequestInit & { proxy?: unknown; unix?: unknown }) | undefined;
    if (!(typeof options?.unix === "string" && options.unix)) checkUrl("fetch", input);
    if (typeof options?.proxy === "string" && options.proxy)
      checkUrl("fetch through the proxy", options.proxy);
    return fetchOf(input, init);
  };
  globalThis.fetch = Object.assign(guardedFetch, {
    preconnect: (url: string | URL, ...rest: unknown[]) => {
      checkUrl("fetch.preconnect", url);
      return (fetchOf.preconnect as Fn)(url, ...rest);
    },
  }) as typeof globalThis.fetch;

  const SocketOf = globalThis.WebSocket;
  if (typeof SocketOf === "function") {
    class GuardedWebSocket extends SocketOf {
      constructor(url: string | URL, ...rest: unknown[]) {
        checkUrl("WebSocket", url);
        super(url, ...(rest as []));
      }
    }
    globalThis.WebSocket = GuardedWebSocket;
  }
  const events = globalThis as unknown as {
    EventSource?: new (url: string | URL, ...rest: unknown[]) => object;
  };
  const EventsOf = events.EventSource;
  if (typeof EventsOf === "function") {
    events.EventSource = class GuardedEventSource extends EventsOf {
      constructor(url: string | URL, ...rest: unknown[]) {
        checkUrl("EventSource", url);
        super(url, ...rest);
      }
    };
  }

  wrap(Bun as unknown as Record<string, unknown>, "connect", ([options]) => {
    const given = objectOf(options) as (Options & { unix?: unknown }) | undefined;
    if (typeof given?.unix === "string" && given.unix) return;
    checkHost("Bun.connect", typeof given?.hostname === "string" ? given.hostname : "localhost");
  });

  const require = createRequire(import.meta.url);
  for (const name of ["node:http", "node:https"]) {
    const module = require(name) as Record<string, unknown>;
    for (const call of ["request", "get"]) {
      wrap(module, call, (args) => checkHost(`${name.slice(5)}.${call}`, requestHost(args)));
    }
  }
  const http2 = require("node:http2") as Record<string, unknown>;
  wrap(http2, "connect", ([authority]) => checkUrl("http2.connect", authority));
  const net = require("node:net") as Record<string, unknown> & { Socket: { prototype: object } };
  for (const call of ["connect", "createConnection"]) {
    wrap(net, call, (args) => checkHost(`net.${call}`, socketHost(args)));
  }
  wrap(net.Socket.prototype as Record<string, unknown>, "connect", (args) =>
    checkHost("net.Socket.connect", socketHost(args)),
  );
  const tls = require("node:tls") as Record<string, unknown>;
  wrap(tls, "connect", (args) => checkHost("tls.connect", socketHost(args)));

  // What honours the proxy settings is sent to a trap that refuses and reports it; loopback stays direct.
  const trap = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {},
      data(socket, data) {
        const line = new TextDecoder().decode(data).split("\r\n", 1)[0] ?? "";
        const target = (line.split(" ")[1] ?? "an unknown host").split("?")[0] as string;
        note(`a request through the proxy settings to ${target}`);
        socket.write("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        socket.end();
      },
    },
  });
  trap.unref();
  state.trap = trap.port;
  const proxy = `http://127.0.0.1:${trap.port}`;
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) process.env[name] = proxy;
  for (const name of ["NO_PROXY", "no_proxy"]) process.env[name] = "localhost,127.0.0.1,::1";
}

installNetGuard();
