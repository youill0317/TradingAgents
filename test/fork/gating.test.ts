// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Which built-in agents and skills an engine offers its main agent, with no network: an agent only when
 * each data tool it names has a source, the built-in skills only with a built-in agent. As built, with
 * the data providers a setup has by default; with the fork's providers as each configuration builds them
 * (over a fixture fetch); then with one stand-in provider serving every capability, and every capability
 * but one, which shows the agents each capability holds back.
 *
 * The agents' data tools (specs/agents/*.md) and the capabilities they read: equity quote, profile,
 * estimates, comps, statements, filings, filing_section, ownership, corporate_actions, screen, news, article;
 * quant quote, price_history, technicals, screen, news, ownership; risk quote, price_history, statements,
 * estimates, filings, filing_section, news; macro macro_series, markets, prediction_markets, quote,
 * price_history, news, article. The fork serves, in every setup, quotes, price history, technicals, profiles,
 * corporate actions, institutional holders, macro series and news (Yahoo, the ECB, the agencies' series,
 * Yahoo's and GDELT's news), and Polymarket serves prediction markets; with SEC_USER_AGENT also statements,
 * filings, insider transactions and sector screens (SEC EDGAR). The market views and instrument search are not
 * built yet, so no setup serves markets, which macro names.
 */
// The network guard, also when this file is run from elsewhere than the repository's root.
import "./net-guard.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ModelRoute } from "../../src/contracts/index.js";
import type { Capability } from "../../src/data/capabilities.js";
import type { Providers } from "../../src/data/router.js";
import { type ProviderName, ROUTES } from "../../src/data/routes.js";
import { createEngine } from "../../src/engine/factory.js";
import type { PublicDataConfig } from "../../src/fork/data/index.js";
import { fixtureFetch } from "./data/harness.js";

/** What an engine offers: its built-in agents by name, in alphabetical order, and how many skills. */
type Offered = { agents: string[]; skills: number };

/** How many skills are built in: an engine offers all of them with any built-in agent, none without. */
const BUILT_IN_SKILLS = 16;

/**
 * What an engine offers as built, with the data providers a setup has by default and no keys: none, and
 * no built-in skill. Without SEC_USER_AGENT nothing is read from SEC EDGAR, so equity and risk lack
 * statements and filings and quant (and equity) the sector screen; macro lacks the market views, which no
 * setup serves yet. Every other tool the agents name has its source.
 */
const AS_BUILT: Offered = { agents: [], skills: 0 };

/** Every setting the fork reads, each set (made-up values: building an engine asks no source anything). */
const EVERY_SETTING: PublicDataConfig = {
  secUserAgent: "Jane Doe jane@example.com",
  fredKey: "fred-0123456789",
  dartKey: "dart-0123456789",
  ecosKey: "ecos-0123456789",
  kosisKey: "kosis-0123456789",
  dataGoKrKey: "datagokr-0123456789",
  naverClientId: "naver-id",
  naverClientSecret: "naver-secret",
  beaKey: "bea-0123456789",
  eiaKey: "eia-0123456789",
};

/**
 * What an engine offers with the fork's providers as each configuration builds them, and why.
 * - No setting: as built (AS_BUILT).
 * - FRED_API_KEY alone: the same. Macro series are served without it (the Treasury, the New York Fed, the
 *   ECB, FRED's keyless download), so it adds no capability: it only adds FRED's vintages and search.
 * - SEC_USER_AGENT: statements, filings, insider transactions and sector screens join, so equity, quant and
 *   risk have every tool they name, and the 16 built-in skills come with them. macro still lacks the market
 *   views.
 * - Every setting the fork reads: the same three. No key serves the market views; macro waits for the
 *   markets provider (src/fork/data/providers/markets.ts), which declares nothing yet.
 */
const CONFIGURED: readonly { name: string; publicData: PublicDataConfig; offered: Offered }[] = [
  { name: "no setting", publicData: {}, offered: AS_BUILT },
  { name: "FRED_API_KEY alone", publicData: { fredKey: "fred-0123456789" }, offered: AS_BUILT },
  {
    name: "SEC_USER_AGENT",
    publicData: { secUserAgent: "Jane Doe jane@example.com" },
    offered: { agents: ["equity", "quant", "risk"], skills: BUILT_IN_SKILLS },
  },
  {
    name: "every setting the fork reads",
    publicData: EVERY_SETTING,
    offered: { agents: ["equity", "quant", "risk"], skills: BUILT_IN_SKILLS },
  },
];

/** What an engine offers when every capability but the one named has a source. */
const WITHOUT: { readonly [Name in Capability]: Offered } = {
  quotes: { agents: [], skills: 0 },
  priceHistory: { agents: ["equity"], skills: BUILT_IN_SKILLS },
  statements: { agents: ["macro", "quant"], skills: BUILT_IN_SKILLS },
  filings: { agents: ["macro", "quant"], skills: BUILT_IN_SKILLS },
  news: { agents: [], skills: 0 },
  profiles: { agents: ["macro", "quant"], skills: BUILT_IN_SKILLS },
  ownership: { agents: ["macro", "risk"], skills: BUILT_IN_SKILLS },
  corporateActions: { agents: ["macro", "quant", "risk"], skills: BUILT_IN_SKILLS },
  technicals: { agents: ["equity", "macro", "risk"], skills: BUILT_IN_SKILLS },
  macroSeries: { agents: ["equity", "quant", "risk"], skills: BUILT_IN_SKILLS },
  instruments: { agents: ["equity", "macro", "quant", "risk"], skills: BUILT_IN_SKILLS },
  crossSections: { agents: ["macro", "risk"], skills: BUILT_IN_SKILLS },
  markets: { agents: ["equity", "quant", "risk"], skills: BUILT_IN_SKILLS },
  predictionMarkets: { agents: ["equity", "quant", "risk"], skills: BUILT_IN_SKILLS },
};

/** Every capability, in the routing table's order. */
const CAPABILITIES = Object.keys(ROUTES) as Capability[];

/** The routing table as loaded, before any test routed the stand-in. */
const BUILT_ROUTES = structuredClone(ROUTES);

/** A model at a local address nothing answers on; building an engine asks it nothing. */
const MODEL: ModelRoute = {
  provider: "openai-compatible",
  model: "stand-in",
  baseURL: "http://127.0.0.1:9/v1",
  thinking: "none",
  sampling: { thinking: {}, plain: {} },
};

/** The address of each request made while a test runs. */
const requests: string[] = [];

/** A fetch for a network that cannot be reached: it records the request and fails it. */
const unreachable = (async (input: string | URL | Request): Promise<Response> => {
  requests.push(input instanceof Request ? input.url : String(input));
  throw new Error("these tests send no request");
}) as typeof globalThis.fetch;

// Code that does not take the fetch it is given reaches no network either while a test runs.
const networkFetch = globalThis.fetch;
beforeEach(() => {
  requests.length = 0;
  globalThis.fetch = unreachable;
});
afterEach(() => {
  globalThis.fetch = networkFetch;
});

/** What an engine built with `providers` offers; with the setup's default data providers when unset. */
function offered(providers?: Providers): Offered {
  const engine = createEngine({
    model: MODEL,
    version: "1.0.0",
    fetch: unreachable,
    ...(providers ? { providers } : {}),
  });
  const { agents, skills } = engine.offered();
  return { agents: [...agents].sort(), skills: skills.length };
}

/**
 * What an engine offers with the data providers a setup builds for `publicData` (the fork's, and
 * Polymarket), over a fixture fetch that answers nothing: building asks no source anything.
 */
function offeredFor(publicData: PublicDataConfig): Offered & { requests: number } {
  const fetch = fixtureFetch([]);
  const engine = createEngine({ model: MODEL, version: "1.0.0", fetch, publicData });
  const { agents, skills } = engine.offered();
  return { agents: [...agents].sort(), skills: skills.length, requests: fetch.requests.length };
}

/**
 * What an engine offers when one stand-in provider serves the capabilities `served`. Every capability is
 * routed to it, under a name the routing table knows, for this call only: the table is put back before
 * the call returns, so no other test sees the stand-in.
 */
function offeredWith(served: readonly Capability[]): Offered {
  const routes = ROUTES as Record<Capability, readonly ProviderName[]>;
  const built = { ...routes };
  try {
    for (const capability of CAPABILITIES) routes[capability] = ["yahoo"];
    const capabilities = Object.fromEntries(served.map((capability) => [capability, {}]));
    return offered({ yahoo: { name: "Stand-in", capabilities } });
  } finally {
    Object.assign(routes, built);
  }
}

test("as built, the engine offers what the default data providers serve", () => {
  expect(offered()).toEqual(AS_BUILT);
});

describe("with the fork's providers as a configuration builds them", () => {
  for (const { name, publicData, offered: expected } of CONFIGURED) {
    test(name, () => {
      expect(offeredFor(publicData)).toEqual({ ...expected, requests: 0 });
    });
  }
});

test("with every capability served, the engine offers every built-in agent and skill", () => {
  expect(offeredWith(CAPABILITIES)).toEqual({
    agents: ["equity", "macro", "quant", "risk"],
    skills: BUILT_IN_SKILLS,
  });
});

describe("with every capability served but one", () => {
  for (const capability of CAPABILITIES) {
    test(`without ${capability}`, () => {
      expect(offeredWith(CAPABILITIES.filter((other) => other !== capability))).toEqual(WITHOUT[capability]);
    });
  }
});

test("building an engine sends no request, and every test leaves the routing table as built", async () => {
  offered();
  offeredWith(CAPABILITIES);
  // A request started while the engines were built would have been made by now.
  await Bun.sleep(0);
  expect(requests).toEqual([]);
  expect(ROUTES).toEqual(BUILT_ROUTES);
});
