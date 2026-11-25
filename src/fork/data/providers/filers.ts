// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "SEC EDGAR", routes.ts key `filers`: what companies file.
 *
 * Today it declares no capability.
 *
 * It will serve, only when SEC_USER_AGENT is set (without it these capabilities are not declared, and the
 * start-up note says what to set):
 * - statements.statement from SEC companyfacts (us-gaap, and ifrs-full for 20-F filers), each value with its
 *   filing (submissions give accepted_at); derived quarters marked in field_states;
 * - filings.list from submissions (recent and the older pages) and filings.section from the primary
 *   document (html.ts), split by Item;
 * - ownership.transactions from Form 3/4/5 XML (xml.ts) found through the issuer's submissions.
 * In Phase 4 it adds OpenDART for Korean filers (named "SEC EDGAR / OpenDART" when DART_API_KEY is set).
 */
import type { DataProvider } from "../../../data/capabilities.js";
import type { ForkDeps } from "../deps.js";

export function filersProvider(_deps: ForkDeps): DataProvider {
  return { name: "SEC EDGAR", capabilities: {} };
}
