// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Loaded before every test file (bunfig.toml, [test] preload): no test reaches the network. The guard
 * (net-guard.ts) refuses any request to a host other than 127.0.0.1 or localhost; here node's client
 * modules, so guarded, are what every `import` of them in a test gets, and a test that made a refused
 * request fails, even when the code under test caught the refusal. A test that checks a refusal on purpose
 * takes it with `takeBlocked()` before it ends.
 */
import { afterAll, afterEach, mock } from "bun:test";
import { createRequire } from "node:module";
import { installNetGuard, takeBlocked } from "./net-guard.js";

installNetGuard();

const load = createRequire(import.meta.url);
for (const name of ["http", "https", "http2", "net", "tls"]) {
  // The modules as require() gives them, their clients guarded; an import would otherwise get its own copy.
  const guarded = load(`node:${name}`) as Record<string, unknown>;
  const module = () => ({ ...guarded, default: guarded });
  mock.module(`node:${name}`, module);
  mock.module(name, module);
}

const refused = (when: string) => {
  const blocked = takeBlocked();
  if (blocked.length) {
    throw new Error(
      `net-guard: ${when} tried to reach the network (tests make no real call): ${blocked.join("; ")}`,
    );
  }
};
afterEach(() => refused("this test"));
afterAll(() => refused("code run outside a test"));
