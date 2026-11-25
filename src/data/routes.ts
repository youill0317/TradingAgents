// Copyright 2026 Tauric Research
// SPDX-License-Identifier: Apache-2.0
/**
 * The one place that says which providers serve each capability, in order: Yahoo serves quotes and daily
 * price history; prediction-market odds come from Polymarket. A capability with no provider says it is
 * not available when asked. A provider that is not configured, or does not implement the method asked, is
 * skipped.
 */
import type { Capability } from "./capabilities.js";

export type ProviderName = "yahoo" | "polymarket";

export const ROUTES: { readonly [Name in Capability]: readonly ProviderName[] } = {
  quotes: ["yahoo"],
  priceHistory: ["yahoo"],
  statements: [],
  filings: [],
  news: [],
  profiles: [],
  ownership: [],
  corporateActions: [],
  technicals: [],
  macroSeries: [],
  instruments: [],
  crossSections: [],
  markets: [],
  predictionMarkets: ["polymarket"],
};
