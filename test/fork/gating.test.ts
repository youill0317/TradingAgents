// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Which built-in agents and skills an engine offers its main agent, with no network: an agent only when
 * each data tool it names has a source, the built-in skills only with a built-in agent. As built, with
 * the data providers a setup has by default; with the fork's providers as each configuration builds them
 * (over a fixture fetch), which are exactly the agents whose every data tool the routed providers serve;
 * then with one stand-in provider serving every capability, and every capability but one, which shows the
 * agents each capability holds back.
 *
 * The agents' data tools (specs/agents/*.md) and the capabilities they read: equity quote, profile,
 * estimates, comps, statements, filings, filing_section, ownership, corporate_actions, screen, news, article;
 * quant quote, price_history, technicals, screen, news, ownership; risk quote, price_history, statements,
 * estimates, filings, filing_section, news; macro macro_series, markets, prediction_markets, quote,
 * price_history, news, article. The fork serves, in every setup, quotes, price history, technicals, profiles,
 * corporate actions, institutional holders, macro series, news, the market views and instrument search
 * (Yahoo, the ECB, the agencies' series, Yahoo's and GDELT's news, the fork's catalogs), and Polymarket serves
 * prediction markets; with SEC_USER_AGENT also statements, filings, insider transactions and sector screens
 * (SEC EDGAR); with DART_API_KEY statements, filings and insider transactions for Korean listings (OpenDART),
 * and no sector screen. The other Korean keys add sources to capabilities served in every setup (the FSC's
 * prices after Yahoo's, ECOS's and KOSIS's series, the Bank of Korea in the market views, Naver's news), so
 * they gate nothing. Instrument search gates no agent: no agent names find_instrument.
 */
// The network guard, also when this file is run from elsewhere than the repository's root.
import "./net-guard.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { builtinCatalog } from "../../src/agents/catalog.js";
import type { ModelRoute } from "../../src/contracts/index.js";
import type { Capability } from "../../src/data/capabilities.js";
import { type Providers, route } from "../../src/data/router.js";
import { type ProviderName, ROUTES } from "../../src/data/routes.js";
import { createEngine, dataProviders } from "../../src/engine/factory.js";
import type { PublicDataConfig } from "../../src/fork/data/index.js";
import { DATA_TOOLS } from "../../src/tools/catalog.js";
import { fixtureFetch } from "./data/harness.js";

/** What an engine offers: its built-in agents by name, in alphabetical order, and how many skills. */
type Offered = { agents: string[]; skills: number };

/** How many skills are built in: an engine offers all of them with any built-in agent, none without. */
const BUILT_IN_SKILLS = 16;

/**
 * What an engine offers as built, with the data providers a setup has by default and no keys: macro, and
 * with it the 16 built-in skills. Every tool macro names has a source that needs no key: macro_series (the
 * Treasury, the New York Fed, the ECB, FRED's keyless download), markets (Yahoo and the same agencies),
 * prediction_markets (Polymarket), quote and price_history (Yahoo), news and article (Yahoo's and GDELT's).
 * Without SEC_USER_AGENT nothing is read from SEC EDGAR, so equity and risk lack statements and filings, and
 * quant (and equity) the sector screen.
 */
const AS_BUILT: Offered = { agents: ["macro"], skills: BUILT_IN_SKILLS };

/** Korea's keys, each set (made-up values). */
const KOREAN_KEYS: PublicDataConfig = {
  dartKey: "dart-0123456789",
  ecosKey: "ecos-0123456789",
  kosisKey: "kosis-0123456789",
  dataGoKrKey: "datagokr-0123456789",
  naverClientId: "naver-id",
  naverClientSecret: "naver-secret",
};

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
 * What an engine offers with the fork's providers as each configuration builds them: in each, exactly the
 * agents whose every data tool the routed providers serve, and the 16 built-in skills with any of them.
 */
const CONFIGURED: readonly { name: string; publicData: PublicDataConfig; offered: Offered }[] = [
  // As built (AS_BUILT): macro alone, every tool it names served without a key.
  { name: "no setting", publicData: {}, offered: AS_BUILT },
  // The same: macro series and the market views are served without FRED_API_KEY (FRED's keyless download
  // among their sources), so the key adds no capability, only FRED's vintages and search.
  { name: "FRED_API_KEY alone", publicData: { fredKey: "fred-0123456789" }, offered: AS_BUILT },
  // Statements, filings, insider transactions and sector screens join (SEC EDGAR), so equity, quant and risk
  // have every tool they name too: all four agents.
  {
    name: "SEC_USER_AGENT",
    publicData: { secUserAgent: "Jane Doe jane@example.com" },
    offered: { agents: ["equity", "macro", "quant", "risk"], skills: BUILT_IN_SKILLS },
  },
  // DART_API_KEY alone now offers an agent: Risk Analysis. OpenDART serves statements, filings (and their
  // sections) and insider transactions for Korean listings, so those capabilities are declared without
  // SEC_USER_AGENT (a US listing's statements and filings answer that SEC_USER_AGENT is to be set), and risk
  // names nothing more. Equity and quant also name screen, the sector screen over the S&P 1500, which only
  // SEC EDGAR's frames serve: not offered.
  {
    name: "DART_API_KEY alone",
    publicData: { dartKey: "dart-0123456789" },
    offered: { agents: ["macro", "risk"], skills: BUILT_IN_SKILLS },
  },
  // The same two with every Korean key: the FSC's prices, ECOS's and KOSIS's series, the Bank of Korea's rate
  // and Naver's news join capabilities already served in every setup, and none of them serves screen.
  {
    name: "every Korean key, without SEC_USER_AGENT",
    publicData: KOREAN_KEYS,
    offered: { agents: ["macro", "risk"], skills: BUILT_IN_SKILLS },
  },
  // All four, as with SEC_USER_AGENT alone: SEC EDGAR serves every capability the agents name, OpenDART adds
  // Korean listings to capabilities already declared.
  {
    name: "SEC_USER_AGENT with DART_API_KEY",
    publicData: { secUserAgent: "Jane Doe jane@example.com", dartKey: "dart-0123456789" },
    offered: { agents: ["equity", "macro", "quant", "risk"], skills: BUILT_IN_SKILLS },
  },
  // Every key set: the same four; no other key serves a capability an agent names that SEC EDGAR does not.
  {
    name: "every setting the fork reads",
    publicData: EVERY_SETTING,
    offered: { agents: ["equity", "macro", "quant", "risk"], skills: BUILT_IN_SKILLS },
  },
];

/** What an engine offers when every capability but the one named has a source: the agents naming none of its tools. */
const WITHOUT: { readonly [Name in Capability]: Offered } = {
  // Every agent names quote: none is offered, so no skill is.
  quotes: { agents: [], skills: 0 },
  // macro, quant and risk name price_history.
  priceHistory: { agents: ["equity"], skills: BUILT_IN_SKILLS },
  // equity and risk name statements.
  statements: { agents: ["macro", "quant"], skills: BUILT_IN_SKILLS },
  // equity and risk name filings and filing_section.
  filings: { agents: ["macro", "quant"], skills: BUILT_IN_SKILLS },
  // Every agent names news.
  news: { agents: [], skills: 0 },
  // equity names profile, estimates and comps; risk names estimates.
  profiles: { agents: ["macro", "quant"], skills: BUILT_IN_SKILLS },
  // equity and quant name ownership.
  ownership: { agents: ["macro", "risk"], skills: BUILT_IN_SKILLS },
  // equity names corporate_actions.
  corporateActions: { agents: ["macro", "quant", "risk"], skills: BUILT_IN_SKILLS },
  // quant names technicals.
  technicals: { agents: ["equity", "macro", "risk"], skills: BUILT_IN_SKILLS },
  // macro names macro_series.
  macroSeries: { agents: ["equity", "quant", "risk"], skills: BUILT_IN_SKILLS },
  // No agent names find_instrument.
  instruments: { agents: ["equity", "macro", "quant", "risk"], skills: BUILT_IN_SKILLS },
  // equity and quant name screen.
  crossSections: { agents: ["macro", "risk"], skills: BUILT_IN_SKILLS },
  // macro names markets.
  markets: { agents: ["equity", "quant", "risk"], skills: BUILT_IN_SKILLS },
  // macro names prediction_markets.
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
 * The built-in agents, by name, whose every data tool reads a capability the providers a setup builds for
 * `publicData` serve once routed: what the engine should offer, worked out apart from it.
 */
function fullyServed(publicData: PublicDataConfig): string[] {
  const { available } = route(dataProviders({ fetch: fixtureFetch([]), publicData }));
  const capabilityOf = new Map<string, Capability>(DATA_TOOLS.map((entry) => [entry.name, entry.capability]));
  return builtinCatalog()
    .agents.filter((agent) =>
      agent.tools.every((tool) => {
        const capability = capabilityOf.get(tool);
        return capability !== undefined && available.has(capability);
      }),
    )
    .map((agent) => agent.name)
    .sort();
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
  // The default providers are the fork's with no setting, and Polymarket.
  expect(AS_BUILT.agents).toEqual(fullyServed({}));
});

describe("with the fork's providers as a configuration builds them", () => {
  for (const { name, publicData, offered: expected } of CONFIGURED) {
    test(name, () => {
      expect(offeredFor(publicData)).toEqual({ ...expected, requests: 0 });
      // Exactly the agents whose every data tool is served: without SEC_USER_AGENT and DART_API_KEY, macro
      // alone; with DART_API_KEY and no SEC_USER_AGENT, macro and risk.
      expect(expected.agents).toEqual(fullyServed(publicData));
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
