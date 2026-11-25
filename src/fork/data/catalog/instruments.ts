// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Instruments known by key rather than by a listing's ticker: price series (indices, volatility and
 * currency indices) under `series:` keys, and futures roots under `future:<MIC>:<root>` keys, each with
 * the Yahoo symbol that serves it. Yahoo symbols with `^` or `=` cannot be typed into the tools (their
 * instrument pattern refuses them), so these keys are how the model asks for them; find_instrument hands
 * them out. Rows are added here, never changed in meaning: a key, once given, keeps naming the same thing.
 *
 * The Yahoo symbols are as Yahoo publishes them; those marked "verify" were not yet seen answering live.
 */

/** A price series: an index or other quoted level with daily bars, as Yahoo serves it. */
export type PriceSeries = {
  yahoo: string;
  name: string;
  /** What it is, as answers classify it. */
  type: "index" | "volatility" | "currency_index" | "commodity_index";
  currency: string | null;
};

/** The families of price series: a `series:<area>.<family>.<name>` key in one of them is a price, not a statistic. */
export const PRICE_SERIES_FAMILIES = new Set([
  "equity_index",
  "volatility",
  "currency_index",
  "commodity_index",
]);

/** Price series by key (without the `series:` prefix). */
export const PRICE_SERIES: Readonly<Record<string, PriceSeries>> = {
  "us.equity_index.sp500": { yahoo: "^GSPC", name: "S&P 500", type: "index", currency: "USD" },
  "us.equity_index.nasdaq_composite": {
    yahoo: "^IXIC",
    name: "Nasdaq Composite",
    type: "index",
    currency: "USD",
  },
  "us.equity_index.nasdaq_100": { yahoo: "^NDX", name: "Nasdaq-100", type: "index", currency: "USD" },
  "us.equity_index.dow_jones": {
    yahoo: "^DJI",
    name: "Dow Jones Industrial Average",
    type: "index",
    currency: "USD",
  },
  "us.equity_index.russell_2000": { yahoo: "^RUT", name: "Russell 2000", type: "index", currency: "USD" },
  "us.equity_index.nyse_composite": { yahoo: "^NYA", name: "NYSE Composite", type: "index", currency: "USD" },
  "us.volatility.vix": {
    yahoo: "^VIX",
    name: "Cboe Volatility Index (VIX)",
    type: "volatility",
    currency: null,
  },
  "us.volatility.vix_9d": {
    yahoo: "^VIX9D",
    name: "Cboe 9-Day Volatility Index",
    type: "volatility",
    currency: null,
  },
  "us.volatility.vix_3m": {
    yahoo: "^VIX3M",
    name: "Cboe 3-Month Volatility Index",
    type: "volatility",
    currency: null,
  },
  "us.volatility.vix_6m": {
    yahoo: "^VIX6M",
    name: "Cboe 6-Month Volatility Index",
    type: "volatility",
    currency: null,
  },
  // verify
  "us.volatility.vix_1y": {
    yahoo: "^VIX1Y",
    name: "Cboe 1-Year Volatility Index",
    type: "volatility",
    currency: null,
  },
  // verify
  "us.volatility.move": {
    yahoo: "^MOVE",
    name: "ICE BofA MOVE Index (Treasury volatility)",
    type: "volatility",
    currency: null,
  },
  "us.volatility.oil": {
    yahoo: "^OVX",
    name: "Cboe Crude Oil Volatility Index (OVX)",
    type: "volatility",
    currency: null,
  },
  "us.volatility.gold": {
    yahoo: "^GVZ",
    name: "Cboe Gold Volatility Index (GVZ)",
    type: "volatility",
    currency: null,
  },
  "us.currency_index.dollar": {
    yahoo: "DX-Y.NYB",
    name: "US Dollar Index (DXY)",
    type: "currency_index",
    currency: null,
  },
  // verify
  "us.commodity_index.bloomberg": {
    yahoo: "^BCOM",
    name: "Bloomberg Commodity Index",
    type: "commodity_index",
    currency: "USD",
  },
  // verify
  "us.commodity_index.sp_gsci": {
    yahoo: "^SPGSCI",
    name: "S&P GSCI",
    type: "commodity_index",
    currency: "USD",
  },
  "kr.equity_index.kospi": { yahoo: "^KS11", name: "KOSPI Composite", type: "index", currency: "KRW" },
  "kr.equity_index.kosdaq": { yahoo: "^KQ11", name: "KOSDAQ Composite", type: "index", currency: "KRW" },
  "kr.equity_index.kospi200": { yahoo: "^KS200", name: "KOSPI 200", type: "index", currency: "KRW" },
  "jp.equity_index.nikkei225": { yahoo: "^N225", name: "Nikkei 225", type: "index", currency: "JPY" },
  "gb.equity_index.ftse100": { yahoo: "^FTSE", name: "FTSE 100", type: "index", currency: "GBP" },
  "de.equity_index.dax": { yahoo: "^GDAXI", name: "DAX", type: "index", currency: "EUR" },
  "fr.equity_index.cac40": { yahoo: "^FCHI", name: "CAC 40", type: "index", currency: "EUR" },
  "eu.equity_index.euro_stoxx50": {
    yahoo: "^STOXX50E",
    name: "EURO STOXX 50",
    type: "index",
    currency: "EUR",
  },
  "hk.equity_index.hang_seng": { yahoo: "^HSI", name: "Hang Seng Index", type: "index", currency: "HKD" },
  "cn.equity_index.sse_composite": {
    yahoo: "000001.SS",
    name: "SSE Composite (Shanghai)",
    type: "index",
    currency: "CNY",
  },
  "tw.equity_index.taiex": { yahoo: "^TWII", name: "TAIEX", type: "index", currency: "TWD" },
  "in.equity_index.nifty50": { yahoo: "^NSEI", name: "NIFTY 50", type: "index", currency: "INR" },
  "au.equity_index.asx200": { yahoo: "^AXJO", name: "S&P/ASX 200", type: "index", currency: "AUD" },
  "ca.equity_index.tsx": { yahoo: "^GSPTSE", name: "S&P/TSX Composite", type: "index", currency: "CAD" },
};

/** A futures root: the exchange (MIC) it trades on and what it is. Yahoo serves its front month as `<root>=F`. */
export type FutureRoot = { mic: string; name: string; currency: string };

/** Futures roots by symbol: NYMEX XNYM, COMEX XCEC, CBOT XCBT, CME XCME, ICE Futures U.S. IFUS. */
export const FUTURE_ROOTS: Readonly<Record<string, FutureRoot>> = {
  CL: { mic: "XNYM", name: "WTI crude oil", currency: "USD" },
  BZ: { mic: "XNYM", name: "Brent crude oil", currency: "USD" },
  NG: { mic: "XNYM", name: "Henry Hub natural gas", currency: "USD" },
  RB: { mic: "XNYM", name: "RBOB gasoline", currency: "USD" },
  HO: { mic: "XNYM", name: "NY Harbor ULSD (heating oil)", currency: "USD" },
  PL: { mic: "XNYM", name: "Platinum", currency: "USD" },
  PA: { mic: "XNYM", name: "Palladium", currency: "USD" },
  GC: { mic: "XCEC", name: "Gold", currency: "USD" },
  SI: { mic: "XCEC", name: "Silver", currency: "USD" },
  HG: { mic: "XCEC", name: "Copper", currency: "USD" },
  ZC: { mic: "XCBT", name: "Corn", currency: "USD" },
  ZW: { mic: "XCBT", name: "Chicago SRW wheat", currency: "USD" },
  ZS: { mic: "XCBT", name: "Soybeans", currency: "USD" },
  ZM: { mic: "XCBT", name: "Soybean meal", currency: "USD" },
  ZL: { mic: "XCBT", name: "Soybean oil", currency: "USD" },
  ZO: { mic: "XCBT", name: "Oats", currency: "USD" },
  ZN: { mic: "XCBT", name: "10-year U.S. Treasury note", currency: "USD" },
  ZB: { mic: "XCBT", name: "U.S. Treasury bond", currency: "USD" },
  ZF: { mic: "XCBT", name: "5-year U.S. Treasury note", currency: "USD" },
  ZT: { mic: "XCBT", name: "2-year U.S. Treasury note", currency: "USD" },
  YM: { mic: "XCBT", name: "E-mini Dow ($5)", currency: "USD" },
  ES: { mic: "XCME", name: "E-mini S&P 500", currency: "USD" },
  NQ: { mic: "XCME", name: "E-mini Nasdaq-100", currency: "USD" },
  RTY: { mic: "XCME", name: "E-mini Russell 2000", currency: "USD" },
  LE: { mic: "XCME", name: "Live cattle", currency: "USD" },
  GF: { mic: "XCME", name: "Feeder cattle", currency: "USD" },
  HE: { mic: "XCME", name: "Lean hogs", currency: "USD" },
  KC: { mic: "IFUS", name: "Coffee C", currency: "USD" },
  SB: { mic: "IFUS", name: "Sugar No. 11", currency: "USD" },
  CC: { mic: "IFUS", name: "Cocoa", currency: "USD" },
  CT: { mic: "IFUS", name: "Cotton No. 2", currency: "USD" },
};
