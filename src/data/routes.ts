// Copyright 2026 Tauric Research
// SPDX-License-Identifier: Apache-2.0
// Changed in this fork of TradingAgents 1.0.0.
/**
 * The one place that says which providers serve each capability, in order. This fork's public-data
 * providers (src/fork/data: Yahoo, SEC filers and frames, the ECB, public statistics, market views,
 * instrument and news search) serve most; prediction-market odds come from Polymarket; FSC (Korea's
 * official end-of-day prices) follows Yahoo for prices. A capability with no provider says
 * it is not available when asked. A provider that is not configured, or does not implement the method
 * asked, is skipped.
 */
import type { Capability } from "./capabilities.js";

export type ProviderName =
  | "yahoo"
  | "fsc"
  | "filers"
  | "frames"
  | "ecb"
  | "statistics"
  | "markets"
  | "instruments"
  | "news"
  | "polymarket";

export const ROUTES: { readonly [Name in Capability]: readonly ProviderName[] } = {
  quotes: ["yahoo", "fsc"],
  priceHistory: ["yahoo", "ecb", "fsc"],
  statements: ["filers"],
  filings: ["filers"],
  news: ["news"],
  profiles: ["yahoo"],
  // Insider transactions from the filers, institutional holders from Yahoo.
  ownership: ["filers", "yahoo"],
  corporateActions: ["yahoo"],
  technicals: ["yahoo"],
  macroSeries: ["statistics"],
  instruments: ["instruments"],
  crossSections: ["frames"],
  markets: ["markets"],
  predictionMarkets: ["polymarket"],
};
