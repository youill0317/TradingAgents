// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The fork's public-data providers, by routes.ts key: composites, each named for its sources, built on
 * shared deps (deps.ts). Which capability each one serves, and from where, is said at the top of its module
 * in providers/. Polymarket is upstream's and the engine adds it as upstream builds it; FSC (Phase 4) is
 * not built yet, so the router skips it.
 */
import type { Providers } from "../../data/router.js";
import type { PublicDataConfig } from "./config.js";
import { type ForkOptions, forkDeps } from "./deps.js";
import { ecbProvider } from "./providers/ecb.js";
import { filersProvider } from "./providers/filers.js";
import { framesProvider } from "./providers/frames.js";
import { instrumentsProvider } from "./providers/instruments.js";
import { marketsProvider } from "./providers/markets.js";
import { newsProvider } from "./providers/news.js";
import { statisticsProvider } from "./providers/statistics.js";
import { yahooComposite } from "./providers/yahoo.js";

export type { PublicDataConfig } from "./config.js";
export type { ForkDeps, ForkOptions } from "./deps.js";

/** The fork's providers for `config`, over the deps `options` gives (the defaults otherwise). */
export function forkProviders(config: PublicDataConfig, options: ForkOptions = {}): Providers {
  const deps = forkDeps(config, options);
  return {
    yahoo: yahooComposite(deps),
    filers: filersProvider(deps),
    frames: framesProvider(deps),
    ecb: ecbProvider(deps),
    statistics: statisticsProvider(deps),
    markets: marketsProvider(deps),
    instruments: instrumentsProvider(deps),
    news: newsProvider(deps),
  };
}
