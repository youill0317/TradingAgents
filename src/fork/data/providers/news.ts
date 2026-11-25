// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * "News search", routes.ts key `news`: articles.
 *
 * Today it declares no capability.
 *
 * It will serve news.articles and news.article: a listing's news from Yahoo's search, a query's or topic's
 * from GDELT's DOC API (its published pace of one request per 5 seconds kept by http.ts, identical queries
 * in flight sharing one answer, recent answers cached; its rolling window of about three months stated),
 * the publisher's snippet in annotations.summary. Filters no source honours (impact, event type, a
 * sentiment) answer invalid, never silently ignored.
 */
import type { DataProvider } from "../../../data/capabilities.js";
import type { ForkDeps } from "../deps.js";

export function newsProvider(_deps: ForkDeps): DataProvider {
  return { name: "News search", capabilities: {} };
}
