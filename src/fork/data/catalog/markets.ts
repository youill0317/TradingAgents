// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * What each of the 22 market views lists (providers/markets.ts reads them): instruments by the key the tools
 * take (a ticker such as XLK, `series:`, `future:`, `fx:` and `crypto:` keys, which listings.ts reads and
 * catalog/instruments.ts maps to Yahoo's symbols), the Treasury's maturities, the New York Fed's and the
 * ECB's rates, FRED's series (catalog/series.ts), and Yahoo's predefined screens. A row's key is what the
 * model copies into quote, price_history, news or macro_series.
 */
import { FUTURE_ROOTS, PRICE_SERIES } from "./instruments.js";
import type { PeriodKind } from "./series.js";

/** A row quoted from Yahoo: the key the tools take, the name the row gives it, and what else the row says. */
export type QuotedSpec = {
  key: string;
  name: string;
  /** Other fields of the row: its group, sector or region. */
  extra?: Readonly<Record<string, string>>;
};

/** A price series of catalog/instruments.ts as a row: its key and its catalog name. */
function priceSeries(key: string, extra?: Readonly<Record<string, string>>): QuotedSpec {
  const series = PRICE_SERIES[key];
  if (!series) throw new Error(`catalog/markets.ts: no price series ${key}`);
  return { key: `series:${key}`, name: series.name, ...(extra ? { extra } : {}) };
}

// Equities -----------------------------------------------------------------------------------------

/** One of the 11 SPDR sector funds: its ticker, its name, the GICS sector it holds, and its rotation group. */
export type SectorFund = {
  key: string;
  name: string;
  /** The screen tool's sector key (capabilities.ts SECTORS). */
  sector: string;
  /** Cyclical or defensive, as the rotation reading groups the sectors. */
  group: "cyclical" | "defensive";
};

/** The SPDR sector funds, one per GICS sector, in GICS's order. */
export const SECTOR_FUNDS: readonly SectorFund[] = [
  { key: "XLE", name: "Energy Select Sector SPDR Fund", sector: "energy", group: "cyclical" },
  { key: "XLB", name: "Materials Select Sector SPDR Fund", sector: "materials", group: "cyclical" },
  { key: "XLI", name: "Industrial Select Sector SPDR Fund", sector: "industrials", group: "cyclical" },
  {
    key: "XLY",
    name: "Consumer Discretionary Select Sector SPDR Fund",
    sector: "consumer_discretionary",
    group: "cyclical",
  },
  {
    key: "XLP",
    name: "Consumer Staples Select Sector SPDR Fund",
    sector: "consumer_staples",
    group: "defensive",
  },
  { key: "XLV", name: "Health Care Select Sector SPDR Fund", sector: "health_care", group: "defensive" },
  { key: "XLF", name: "Financial Select Sector SPDR Fund", sector: "financials", group: "cyclical" },
  {
    key: "XLK",
    name: "Technology Select Sector SPDR Fund",
    sector: "information_technology",
    group: "cyclical",
  },
  {
    key: "XLC",
    name: "Communication Services Select Sector SPDR Fund",
    sector: "communication_services",
    group: "cyclical",
  },
  { key: "XLU", name: "Utilities Select Sector SPDR Fund", sector: "utilities", group: "defensive" },
  { key: "XLRE", name: "Real Estate Select Sector SPDR Fund", sector: "real_estate", group: "defensive" },
];

/** The market the sector funds are measured against in the rotation view. */
export const BENCHMARK: QuotedSpec = { key: "SPY", name: "SPDR S&P 500 ETF Trust" };

/** The US indices equity_summary leads with. */
export const SUMMARY_INDICES: readonly QuotedSpec[] = [
  priceSeries("us.equity_index.sp500"),
  priceSeries("us.equity_index.dow_jones"),
  priceSeries("us.equity_index.nasdaq_composite"),
  priceSeries("us.equity_index.russell_2000"),
];

/** The indices view: the US indices, Korea's (KOSPI, KOSDAQ, KOSPI 200) and the other major markets'. */
export const INDICES: readonly QuotedSpec[] = [
  ["us.equity_index.sp500", "US"],
  ["us.equity_index.dow_jones", "US"],
  ["us.equity_index.nasdaq_composite", "US"],
  ["us.equity_index.nasdaq_100", "US"],
  ["us.equity_index.russell_2000", "US"],
  ["us.equity_index.nyse_composite", "US"],
  ["kr.equity_index.kospi", "KR"],
  ["kr.equity_index.kosdaq", "KR"],
  ["kr.equity_index.kospi200", "KR"],
  ["jp.equity_index.nikkei225", "JP"],
  ["hk.equity_index.hang_seng", "HK"],
  ["cn.equity_index.sse_composite", "CN"],
  ["tw.equity_index.taiex", "TW"],
  ["in.equity_index.nifty50", "IN"],
  ["au.equity_index.asx200", "AU"],
  ["gb.equity_index.ftse100", "GB"],
  ["de.equity_index.dax", "DE"],
  ["fr.equity_index.cac40", "FR"],
  ["eu.equity_index.euro_stoxx50", "EU"],
  ["ca.equity_index.tsx", "CA"],
].map(([key, region]) => priceSeries(key as string, { region: region as string }));

/** Yahoo's predefined screens behind the movers views. */
export const SCREENS = {
  gainers: "day_gainers",
  losers: "day_losers",
  most_active: "most_actives",
} as const;

// Volatility -------------------------------------------------------------------------------------

/** The VIX term structure, shortest first: each point's field in the volatility view's summary and its key. */
export const VIX_TERMS: readonly { field: string; key: string }[] = [
  { field: "vix_9d", key: "series:us.volatility.vix_9d" },
  { field: "spot", key: "series:us.volatility.vix" },
  { field: "vix_3m", key: "series:us.volatility.vix_3m" },
  { field: "vix_6m", key: "series:us.volatility.vix_6m" },
  { field: "vix_1y", key: "series:us.volatility.vix_1y" },
];

// Commodities ------------------------------------------------------------------------------------

/** A futures root's continuous front month as a row: `future:<MIC>:<root>`, named by catalog/instruments.ts. */
function futures(roots: readonly string[]): QuotedSpec[] {
  return roots.map((root) => {
    const future = FUTURE_ROOTS[root];
    if (!future) throw new Error(`catalog/markets.ts: no futures root ${root}`);
    return { key: `future:${future.mic}:${root}`, name: future.name };
  });
}

/** The commodity views' futures, by view. */
export const FUTURES = {
  energy: futures(["CL", "BZ", "NG", "RB", "HO"]),
  metals: futures(["GC", "SI", "HG", "PL", "PA"]),
  agriculture: futures(["ZC", "ZW", "ZS", "KC", "SB", "CC", "CT"]),
  livestock: futures(["LE", "GF", "HE"]),
} as const;

/** Commodity volatility indices and the broad commodity indices. */
export const COMMODITY_BENCHMARKS: readonly QuotedSpec[] = [
  priceSeries("us.volatility.oil", { group: "volatility" }),
  priceSeries("us.volatility.gold", { group: "volatility" }),
  priceSeries("us.commodity_index.bloomberg", { group: "index" }),
  priceSeries("us.commodity_index.sp_gsci", { group: "index" }),
];

// Currencies, crypto, cross-asset ----------------------------------------------------------------

/** The major currency pairs, each `fx:<BASE><QUOTE>`, and the dollar index. */
export const FX: readonly QuotedSpec[] = [
  ...["EURUSD", "USDJPY", "GBPUSD", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD", "USDCNY", "USDKRW"].map(
    (pair) => ({
      key: `fx:${pair}`,
      name: `${pair.slice(0, 3)}/${pair.slice(3)}`,
    }),
  ),
  priceSeries("us.currency_index.dollar"),
];

/** Large crypto assets, each as Yahoo's USD pair; the view ranks them by market capitalization. */
export const CRYPTO: readonly QuotedSpec[] = [
  ["BTC", "Bitcoin"],
  ["ETH", "Ethereum"],
  ["USDT", "Tether"],
  ["XRP", "XRP"],
  ["BNB", "BNB"],
  ["SOL", "Solana"],
  ["USDC", "USD Coin"],
  ["DOGE", "Dogecoin"],
  ["ADA", "Cardano"],
  ["TRX", "TRON"],
  ["AVAX", "Avalanche"],
  ["LINK", "Chainlink"],
  ["DOT", "Polkadot"],
  ["LTC", "Litecoin"],
  ["BCH", "Bitcoin Cash"],
  ["XLM", "Stellar"],
].map(([base, name]) => ({ key: `crypto:${base}-USD`, name: name as string }));

/** The cross-asset view: a Treasury yield (its maturity on the par curve) or a quoted instrument, each in its group. */
export type CrossAssetSpec =
  | { treasury: string; name: string; group: string }
  | (QuotedSpec & { group: string });

export const CROSS_ASSET: readonly CrossAssetSpec[] = [
  { treasury: "2y", name: "2-year Treasury yield", group: "rates" },
  { treasury: "10y", name: "10-year Treasury yield", group: "rates" },
  { ...priceSeries("us.equity_index.sp500"), group: "equities" },
  { ...priceSeries("us.volatility.vix"), group: "volatility" },
  { ...priceSeries("us.currency_index.dollar"), group: "currencies" },
  { ...(futures(["GC"])[0] as QuotedSpec), group: "commodities" },
  { ...(futures(["CL"])[0] as QuotedSpec), group: "commodities" },
  { key: "crypto:BTC-USD", name: "Bitcoin", group: "crypto" },
];

// Rates ------------------------------------------------------------------------------------------

/** The par curve's maturities as the Treasury quotes them today, shortest first. */
export const PAR_MATURITIES: readonly string[] = [
  "1m",
  "1.5m",
  "2m",
  "3m",
  "4m",
  "6m",
  "1y",
  "2y",
  "3y",
  "5y",
  "7y",
  "10y",
  "20y",
  "30y",
];

/** The maturities with both a par and a real (TIPS) yield: the breakevens'. */
export const BREAKEVEN_MATURITIES: readonly string[] = ["5y", "7y", "10y", "20y", "30y"];

/** The New York Fed's reference rates the rate_indicators view lists. */
export const NYFED_ROWS: readonly { rate: "effr" | "sofr" | "obfr"; name: string }[] = [
  { rate: "effr", name: "Effective federal funds rate (EFFR)" },
  { rate: "sofr", name: "Secured overnight financing rate (SOFR)" },
  { rate: "obfr", name: "Overnight bank funding rate (OBFR)" },
];

/** Treasury volatility, listed with the rates. */
export const MOVE_INDEX: QuotedSpec = priceSeries("us.volatility.move");

/** The ECB's key interest rates, by its code. */
export const ECB_RATES: readonly { rate: "DFR" | "MRR_FR" | "MLFR"; name: string }[] = [
  { rate: "DFR", name: "deposit facility rate" },
  { rate: "MRR_FR", name: "main refinancing operations rate" },
  { rate: "MLFR", name: "marginal lending facility rate" },
];

/**
 * A central bank's rate FRED serves (the OECD's monthly Main Economic Indicators); catalog/series.ts holds it
 * too, under the key the view's row gives (`us.fred.<code>`), so macro_series reads it without a key.
 */
export type FredBankRate = {
  bank: string;
  /** FRED's code. */
  id: string;
  /** What the rate is, in FRED's title's words. */
  rate: string;
  period: PeriodKind;
  /** FRED's units, as FRED writes them. */
  units: string;
};

/**
 * The Bank of Korea's base rate, which central_banks lists with ECOS_API_KEY: the ECOS series catalog/series.ts
 * holds under this key (table 722Y001, item 0101000, daily), read as macro_series reads it.
 */
export const BOK_BASE_RATE = {
  bank: "Bank of Korea",
  rate: "base rate",
  key: "kr.ecos.722y001.0101000",
} as const;

/** Other central banks' rates with a keyless source: FRED (its download, or its API with FRED_API_KEY). */
export const FRED_BANK_RATES: readonly FredBankRate[] = [
  {
    bank: "Bank of Japan",
    id: "IRSTCB01JPM156N",
    rate: "central bank rate (immediate rates, less than 24 hours; OECD Main Economic Indicators)",
    period: "month",
    units: "Percent",
  },
  {
    bank: "Reserve Bank of India",
    id: "IRSTCB01INM156N",
    rate: "central bank rate (immediate rates, less than 24 hours; OECD Main Economic Indicators)",
    period: "month",
    units: "Percent",
  },
];

/** FRED's corporate bond spreads (catalog/series.ts keys), each with FRED's title. */
export const CREDIT_SPREADS: readonly { key: string; title: string }[] = [
  {
    key: "us.fred.bamlh0a0hym2",
    title: "ICE BofA US High Yield Index Option-Adjusted Spread",
  },
  {
    key: "us.fred.bamlc0a0cm",
    title: "ICE BofA US Corporate Index Option-Adjusted Spread",
  },
  {
    key: "us.fred.baa10y",
    title:
      "Moody's Seasoned Baa Corporate Bond Yield Relative to Yield on 10-Year Treasury Constant Maturity",
  },
];

/** The macro view's headline statistics (catalog/series.ts keys): inflation, labor, growth. */
export const MACRO_SERIES: readonly string[] = [
  "us.fred.cpiaucsl",
  "us.fred.cpilfesl",
  "us.fred.pcepi",
  "us.fred.pcepilfe",
  "us.fred.unrate",
  "us.fred.payems",
  "us.fred.icsa",
  "us.fred.gdpc1",
  "us.fred.a191rl1q225sbea",
];
