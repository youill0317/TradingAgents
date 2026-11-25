// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "Instrument search", routes.ts key `instruments`: finding an instrument's key.
 *
 * Today it declares no capability.
 *
 * It will serve instruments.search: SEC's company tickers (with SEC_USER_AGENT), Yahoo's search, and the
 * fork's catalogs (price series and futures in catalog/instruments.ts, currency and crypto pairs, economic
 * series in catalog/series.ts), each match under the key the tools take (listings.ts) with the capabilities
 * configured for it; in Phase 4, OpenDART's company list for Korean names and codes.
 */
import type { DataProvider } from "../../../data/capabilities.js";
import type { ForkDeps } from "../deps.js";

export function instrumentsProvider(_deps: ForkDeps): DataProvider {
  return { name: "Instrument search", capabilities: {} };
}
