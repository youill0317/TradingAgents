// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "Yahoo", routes.ts key `yahoo`: the composite every Yahoo-served capability is routed to.
 *
 * Today it is upstream's Yahoo provider (src/data/yahoo/provider.ts), unchanged, over the shared
 * yahoo-finance2 client (deps.ts): quotes and daily price history of US listings and the venues upstream
 * knows, with upstream's answers, errors and notes.
 *
 * It will serve, reading every listing form through listings.ts first and handing upstream the ones it
 * serves (US tickers and its MIC:SYMBOL venues):
 * - quotes.quote/many and priceHistory.daily/dailyPair/intraday, also for Korean listings (XKRX:, XKOS:,
 *   .KS, .KQ, a bare code: one batched quote of both spellings), futures (`CL=F`, with
 *   instrument.continuous), currency pairs (`=X`), crypto pairs and price series (`^GSPC`); a Korean
 *   listing it cannot answer fails as unsupported or unavailable, never no_data, so the router asks FSC;
 *   a value series fails as invalid (listings.ts `notPriced`);
 * - technicals.latest, computed from daily bars (compute/technicals.ts);
 * - profiles.profile/analyst/calendar (quoteSummary);
 * - corporateActions.list (chart events);
 * - ownership.holders (Yahoo's top institutional holders).
 */
import type { DataProvider } from "../../../data/capabilities.js";
import { type YahooClient, yahooProvider } from "../../../data/yahoo/provider.js";
import type { ForkDeps } from "../deps.js";

export function yahooComposite(deps: ForkDeps): DataProvider {
  return yahooProvider({ client: deps.yahoo as unknown as YahooClient, now: deps.clock });
}
