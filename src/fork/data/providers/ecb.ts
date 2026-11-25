// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "ECB", routes.ts key `ecb`: currency pairs' daily reference rates.
 *
 * Today it declares no capability.
 *
 * It will serve priceHistory.referenceRates from the ECB's EXR data (SDMX csvdata): a pair against the euro
 * directly or inverted, any other pair as a cross through the euro (its basis says so).
 */
import type { DataProvider } from "../../../data/capabilities.js";
import type { ForkDeps } from "../deps.js";

export function ecbProvider(_deps: ForkDeps): DataProvider {
  return { name: "ECB", capabilities: {} };
}
