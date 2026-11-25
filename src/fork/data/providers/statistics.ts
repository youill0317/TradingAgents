// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "Public statistics", routes.ts key `statistics`: economic series.
 *
 * Today it declares no capability.
 *
 * It will serve macroSeries.search and macroSeries.observations from a curated catalog (catalog/series.ts:
 * each series under the short name the skills ask for, found first) and its publishers: FRED (with
 * FRED_API_KEY, every vintage giving known_from), the U.S. Treasury's par and real yield curves, the New
 * York Fed's reference rates, the ECB's policy rates; in Phase 4 the Bank of Korea (ECOS) and Statistics
 * Korea (KOSIS). A series whose source needs a key that is not set answers not_configured, naming it.
 */
import type { DataProvider } from "../../../data/capabilities.js";
import type { ForkDeps } from "../deps.js";

export function statisticsProvider(_deps: ForkDeps): DataProvider {
  return { name: "Public statistics", capabilities: {} };
}
