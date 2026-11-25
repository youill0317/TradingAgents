// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "SEC EDGAR", routes.ts key `frames`: sector screens.
 *
 * Today it declares no capability.
 *
 * It will serve crossSections.financials, only when SEC_USER_AGENT is set: SEC's XBRL frames (CY<year-1>
 * and CY<year>, rows kept by the calendar year their fiscal year ends in) joined to the S&P 500, 400 and 600
 * lists with their GICS sectors (Wikipedia, cached), so a screen covers the S&P 1500 and says so
 * (complete false, with the reason).
 */
import type { DataProvider } from "../../../data/capabilities.js";
import type { ForkDeps } from "../deps.js";

export function framesProvider(_deps: ForkDeps): DataProvider {
  return { name: "SEC EDGAR", capabilities: {} };
}
