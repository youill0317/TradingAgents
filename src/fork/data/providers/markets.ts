// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "Market overview", routes.ts key `markets`: the 22 market views.
 *
 * Today it declares no capability.
 *
 * It will serve markets.view, each row naming its own source: indices, sectors (the SPDR sector funds),
 * gainers, losers and most active (Yahoo's screens), volatility (the VIX term structure), the Treasury yield
 * curve and breakevens, rate indicators (the New York Fed), central banks, credit spreads and macro
 * headlines (FRED, the ECB), commodities by group, currencies, crypto and cross-asset views
 * (catalog/markets.ts lists each view's rows).
 */
import type { DataProvider } from "../../../data/capabilities.js";
import type { ForkDeps } from "../deps.js";

export function marketsProvider(_deps: ForkDeps): DataProvider {
  return { name: "Market overview", capabilities: {} };
}
