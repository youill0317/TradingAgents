// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * SEC's list of the companies it knows by ticker (www.sec.gov/files/company_tickers_exchange.json): which CIK a
 * US listing files under, and which tickers a CIK trades as. The statements, filings, ownership, screen and
 * instrument-search providers share it: a shared module, changed only on its own and with its tests
 * (test/fork/data/sec-tickers.test.ts, on the hand-made fixture test/fork/fixtures/sec/company-tickers-exchange.json).
 * It needs SEC_USER_AGENT, as every SEC request does; it is kept a day, on disk too, and served past its day
 * when SEC cannot be read.
 *
 * The list's own shape: { fields: ["cik", "name", "ticker", "exchange"], data: [[320193, "Apple Inc.", "AAPL",
 * "Nasdaq"], ...] }, read by its field names. A company with several share classes has a row per ticker; the
 * exchange is null where SEC gives none. Only US listings are looked up: a listing on another venue is
 * another company than the US filer that shares its letters (XLON:BA is BAE Systems, not Boeing), so it
 * finds none, and no request is made for it.
 */
import { DataError } from "../../../data/errors.js";
import type { ForkDeps } from "../deps.js";
import { parseListing, US_VENUES } from "../listings.js";

export const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";

/** The list's key in the cache. */
export const SEC_TICKERS_KEY = "sec:company-tickers-exchange";

/** How long the list is kept: SEC refreshes it daily. */
export const SEC_TICKERS_TTL_MS = 86_400_000;

/** One row of SEC's list: the CIK zero-padded to 10 digits, as data.sec.gov's paths take it. */
export type SecCompany = { cik: string; name: string; ticker: string; exchange: string | null };

export type SecTickers = {
  /**
   * The company a US listing files as (AAPL; BRK.B, BRK-B, XNYS:BRK.B and security:BRK.B alike), or
   * undefined when SEC lists none. A key that names no US listing (another venue's MIC, a Korean code, a
   * pair, a series) is undefined at once, without a request.
   */
  bySymbol(symbol: string, call?: { signal?: AbortSignal }): Promise<SecCompany | undefined>;
  /** Every listed ticker of a CIK (zero-padded or not), in SEC's order. */
  byCik(cik: string | number, call?: { signal?: AbortSignal }): Promise<SecCompany[]>;
  /** The whole list, for instrument search. */
  all(call?: { signal?: AbortSignal }): Promise<readonly SecCompany[]>;
};

/** A US listing's ticker as SEC writes it (BRK-B), from any key the tools pass; undefined for anything else. */
export function secTicker(symbol: string): string | undefined {
  const listing = parseListing(symbol);
  if (listing.kind === "us") return listing.ticker;
  if (listing.kind === "venue" && US_VENUES.has(listing.mic)) return listing.symbol;
  return undefined;
}

/** A ticker as SEC's list writes it: upper case, a class after a dash. */
function listedTicker(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/[./]/g, "-");
}

/** A CIK as data.sec.gov's paths take it: ten digits. */
export function paddedCik(cik: string | number): string {
  return String(cik).replace(/^0+/, "").padStart(10, "0");
}

/** The rows of SEC's list, read by its field names (so a reordering of the columns cannot shift them). */
export function parseSecTickers(body: unknown): SecCompany[] {
  const list = body as { fields?: unknown; data?: unknown };
  if (!Array.isArray(list?.fields) || !Array.isArray(list?.data)) {
    throw new DataError(
      "unavailable",
      "SEC EDGAR answered its ticker list in a form this app does not read.",
      {
        source: "SEC EDGAR",
      },
    );
  }
  const at = (name: string) => (list.fields as unknown[]).indexOf(name);
  const [cik, name, ticker, exchange] = [at("cik"), at("name"), at("ticker"), at("exchange")];
  if (cik < 0 || ticker < 0) {
    throw new DataError("unavailable", "SEC EDGAR's ticker list has no cik or ticker column.", {
      source: "SEC EDGAR",
    });
  }
  const rows: SecCompany[] = [];
  for (const row of list.data as unknown[]) {
    if (!Array.isArray(row)) continue;
    const id = row[cik];
    const symbol = row[ticker];
    if ((typeof id !== "number" && typeof id !== "string") || typeof symbol !== "string" || !symbol.trim())
      continue;
    if (!/^\d{1,10}$/.test(String(id))) continue;
    rows.push({
      cik: paddedCik(id),
      name: name >= 0 && typeof row[name] === "string" ? (row[name] as string) : "",
      ticker: listedTicker(symbol),
      exchange: exchange >= 0 && typeof row[exchange] === "string" ? (row[exchange] as string) : null,
    });
  }
  return rows;
}

/** A loaded list's rows by ticker (the first row of each, as SEC orders them) and by CIK. */
type Index = { tickers: Map<string, SecCompany>; ciks: Map<string, SecCompany[]> };
const INDEXES = new WeakMap<readonly SecCompany[], Index>();

function indexOf(rows: readonly SecCompany[]): Index {
  let index = INDEXES.get(rows);
  if (!index) {
    index = { tickers: new Map(), ciks: new Map() };
    for (const row of rows) {
      if (!index.tickers.has(row.ticker)) index.tickers.set(row.ticker, row);
      const listed = index.ciks.get(row.cik);
      if (listed) listed.push(row);
      else index.ciks.set(row.cik, [row]);
    }
    INDEXES.set(rows, index);
  }
  return index;
}

/** SEC's ticker list over `deps`; not_configured without SEC_USER_AGENT. */
export function secTickers(deps: ForkDeps): SecTickers {
  const load = async (call: { signal?: AbortSignal } = {}): Promise<readonly SecCompany[]> => {
    if (!deps.config.secUserAgent) {
      throw new DataError(
        "not_configured",
        "SEC EDGAR needs SEC_USER_AGENT (a name and an email, SEC's rule).",
        {
          source: "SEC EDGAR",
          retry: "never",
        },
      );
    }
    return deps.cache.remember(
      SEC_TICKERS_KEY,
      SEC_TICKERS_TTL_MS,
      async () =>
        parseSecTickers(await deps.http.json(SEC_TICKERS_URL, { source: "SEC EDGAR", signal: call.signal })),
      { disk: "json", staleOnError: true, signal: call.signal },
    );
  };
  return {
    async bySymbol(symbol, call) {
      const wanted = secTicker(symbol);
      if (wanted === undefined) return undefined;
      return indexOf(await load(call)).tickers.get(wanted);
    },
    async byCik(cik, call) {
      return [...(indexOf(await load(call)).ciks.get(paddedCik(cik)) ?? [])];
    },
    all: (call) => load(call),
  };
}
