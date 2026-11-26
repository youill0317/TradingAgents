// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The economic series macro_series names by default, each under the short name the skills and agents ask
 * for ("CPI", "core CPI", "unemployment rate", "payrolls", "GDP", "10-year Treasury yield", "Treasury bill
 * yield", "2-year Treasury yield", "effective federal funds rate", "SOFR", ...), with the other names and
 * codes that name it exactly (FRED's codes among them) and the words a broader search finds it by.
 *
 * macro_series takes a series only on an exact name or a bare key, so a search answers the series a name
 * names first and under that very name (searchCatalog). Keys are `<area>.<publisher>.<code>`, lower case,
 * as the tool's key pattern reads them (`series:` before them in answers): `us.treasury.par_10y`,
 * `us.nyfed.effr`, `ea.ecb.dfr`, `us.fred.cpiaucsl`. A key, once given, keeps naming the same series.
 *
 * Publishers: the U.S. Treasury's daily par and real yield curves (and the breakevens and spreads derived
 * from them, the derivation stated), the New York Fed's reference rates, the ECB's key interest rates, and
 * FRED for the statistics no keyless official source among them publishes (the U.S. Bureau of Labor
 * Statistics', the Bureau of Economic Analysis', the Fed's); each FRED entry carries what FRED says of the
 * series (title words aside), so it can be described without asking FRED.
 */

/** How a value's changes read: percents and points give differences, the others percent changes. */
export type UnitKind =
  | "percent"
  | "percentage_points"
  | "index"
  | "index_points"
  | "currency"
  | "count"
  | "quantity"
  | "ratio";

/** What one observation's period is. */
export type PeriodKind = "calendar_day" | "week" | "month" | "quarter" | "half_year" | "year";

export type SeriesUnit = {
  kind: UnitKind;
  /** The base-unit multiplier: 1000 for thousands, 1e9 for billions. */
  multiplier: number;
  /** ISO 4217 code when the value is money. */
  currency: string | null;
  /** The denominator of a rate ("hour" in dollars per hour). */
  per: string | null;
};

/** A point of one of the Treasury's curves: the par (nominal) or real curve, at a maturity ("10y", "1.5m"). */
export type CurveLeg = { curve: "par" | "real"; maturity: string };

/** Where a series' values come from. */
export type SeriesOrigin =
  | {
      publisher: "fred";
      /** FRED's code, as FRED writes it. */
      id: string;
      /** A weekly series whose date is the week's last day ("Weekly, Ending Saturday"). */
      weekEnding?: true;
    }
  | {
      publisher: "treasury";
      leg: CurveLeg;
      /** The leg subtracted from `leg`: a breakeven (par less real) or a spread (one maturity less another). */
      less?: CurveLeg;
      /** The first year the Treasury's files hold this maturity (both legs' for a derived series). */
      since: number;
    }
  | { publisher: "nyfed"; rate: "effr" | "obfr" | "sofr" | "tgcr" | "bgcr" }
  | { publisher: "ecb"; rate: "DFR" | "MRR_FR" | "MLFR" };

export type CatalogSeries = {
  /** `<area>.<publisher>.<code>`, lower case, without `series:`. */
  key: string;
  /** The short name a skill asks for: unique across the catalog. */
  name: string;
  /** Other names that name exactly this series. */
  aliases: readonly string[];
  /** FRED's codes for this very series besides a FRED series' own: FRED's copies of its publisher's (DGS10). */
  codes: readonly string[];
  /** Words a broader search finds it by ("inflation", "rates", "central banks"). */
  keywords: readonly string[];
  /** A headline series: answered before the others a broad search finds. */
  headline?: true;
  origin: SeriesOrigin;
  frequency: string;
  period: PeriodKind;
  seasonal_adjustment: string | null;
  unit: SeriesUnit;
  /** The unit, frequency and seasonal adjustment in the publisher's words. */
  as_published: { unit: string; frequency: string; seasonal_adjustment: string | null };
};

const unit = (kind: UnitKind, multiplier = 1, currency: string | null = null, per: string | null = null) => ({
  kind,
  multiplier,
  currency,
  per,
});

const PERCENT = unit("percent");
const POINTS = unit("percentage_points");
const INDEX = unit("index");

const RATES = ["rates", "interest rates"];
const CURVE = [...RATES, "treasury", "treasuries", "yield curve", "curve", "government bonds", "bonds"];
const DAILY = "daily (business days)";

/** "10y" -> "10-year", "3m" -> "3-month", "1.5m" -> "1.5-month". */
function tenor(maturity: string): string {
  const number = maturity.slice(0, -1);
  return `${number}-${maturity.endsWith("y") ? "year" : "month"}`;
}

/** A key's code for a maturity: "1.5m" -> "1_5m". */
const code = (maturity: string) => maturity.replace(".", "_");

/** A point of the Treasury's par yield curve. */
function par(
  maturity: string,
  since: number,
  more: { name?: string; aliases?: string[]; codes?: string[]; headline?: true } = {},
): CatalogSeries {
  const term = tenor(maturity);
  const name = more.name ?? `${term} Treasury yield`;
  return {
    key: `us.treasury.par_${code(maturity)}`,
    name,
    aliases: [
      ...(more.name ? [`${term} Treasury yield`] : []),
      `${term} Treasury rate`,
      `${term} par yield`,
      ...(more.aliases ?? []),
    ],
    codes: more.codes ?? [],
    keywords: [...CURVE, "nominal", "par yield curve", "constant maturity"],
    ...(more.headline ? { headline: true as const } : {}),
    origin: { publisher: "treasury", leg: { curve: "par", maturity }, since },
    frequency: "daily",
    period: "calendar_day",
    seasonal_adjustment: null,
    unit: PERCENT,
    as_published: {
      unit: "percent (par yield, bond-equivalent basis)",
      frequency: DAILY,
      seasonal_adjustment: null,
    },
  };
}

/** A point of the Treasury's real (TIPS) par yield curve. */
function real(maturity: string, since: number, codes: string[] = []): CatalogSeries {
  const term = tenor(maturity);
  return {
    key: `us.treasury.real_${code(maturity)}`,
    name: `${term} real Treasury yield`,
    aliases: [`${term} TIPS yield`, `${term} real yield`],
    codes,
    keywords: [...CURVE, "real yields", "tips", "inflation-protected", "inflation protected"],
    origin: { publisher: "treasury", leg: { curve: "real", maturity }, since },
    frequency: "daily",
    period: "calendar_day",
    seasonal_adjustment: null,
    unit: PERCENT,
    as_published: {
      unit: "percent (real par yield of TIPS)",
      frequency: DAILY,
      seasonal_adjustment: null,
    },
  };
}

/** A breakeven inflation rate: the par yield less the real yield at one maturity, as FRED's T5YIE and T10YIE. */
function breakeven(maturity: string, since: number, codes: string[] = []): CatalogSeries {
  const term = tenor(maturity);
  return {
    key: `us.treasury.breakeven_${code(maturity)}`,
    name: `${term} breakeven inflation`,
    aliases: [`${term} breakeven`, `${term} breakeven inflation rate`],
    codes,
    keywords: [
      "inflation",
      "inflation expectations",
      "market-implied inflation",
      "breakevens",
      "tips",
      "treasury",
    ],
    origin: {
      publisher: "treasury",
      leg: { curve: "par", maturity },
      less: { curve: "real", maturity },
      since,
    },
    frequency: "daily",
    period: "calendar_day",
    seasonal_adjustment: null,
    unit: PERCENT,
    as_published: {
      unit: `percent (the Treasury's ${term} par yield less its ${term} real yield)`,
      frequency: DAILY,
      seasonal_adjustment: null,
    },
  };
}

/** A spread between two points of the par curve. */
function spread(long: string, short: string, aliases: string[], codes: string[]): CatalogSeries {
  return {
    key: `us.treasury.spread_${code(long)}_${code(short)}`,
    name: `${tenor(long)} minus ${tenor(short)} Treasury spread`,
    aliases,
    codes,
    keywords: [...CURVE, "spread", "term spread", "curve slope", "inversion"],
    origin: {
      publisher: "treasury",
      leg: { curve: "par", maturity: long },
      less: { curve: "par", maturity: short },
      since: 1990,
    },
    frequency: "daily",
    period: "calendar_day",
    seasonal_adjustment: null,
    unit: POINTS,
    as_published: {
      unit: `percentage points (the Treasury's ${tenor(long)} par yield less its ${tenor(short)} par yield)`,
      frequency: DAILY,
      seasonal_adjustment: null,
    },
  };
}

/** One of the New York Fed's reference rates (FRED's `codes` copy some of them). */
function nyfed(
  rate: "effr" | "obfr" | "sofr" | "tgcr" | "bgcr",
  name: string,
  more: { aliases: string[]; keywords: string[]; codes?: string[]; headline?: true; unit?: string },
): CatalogSeries {
  const { aliases, keywords, codes = [], headline, unit = "percent (volume-weighted median)" } = more;
  return {
    key: `us.nyfed.${rate}`,
    name,
    aliases,
    codes,
    keywords: [...RATES, "new york fed", "overnight", "money market", "funding", ...keywords],
    ...(headline ? { headline } : {}),
    origin: { publisher: "nyfed", rate },
    frequency: "daily",
    period: "calendar_day",
    seasonal_adjustment: null,
    unit: PERCENT,
    as_published: { unit, frequency: DAILY, seasonal_adjustment: null },
  };
}

/** One of the ECB's key interest rates, each observation a change and the date it took effect. */
function ecb(
  rate: "DFR" | "MRR_FR" | "MLFR",
  name: string,
  aliases: string[],
  fredCode: string,
  headline?: true,
): CatalogSeries {
  return {
    key: `ea.ecb.${rate.toLowerCase()}`,
    name,
    aliases: [...aliases, rate],
    codes: [fredCode],
    keywords: [
      ...RATES,
      "ecb",
      "european central bank",
      "euro area",
      "eurozone",
      "euro",
      "central banks",
      "central bank",
      "policy rates",
      "key interest rates",
      "monetary policy",
    ],
    ...(headline ? { headline } : {}),
    origin: { publisher: "ecb", rate },
    frequency: "at each change",
    period: "calendar_day",
    seasonal_adjustment: null,
    unit: PERCENT,
    as_published: {
      unit: "percent a year",
      frequency: "at each change (the date it took effect)",
      seasonal_adjustment: null,
    },
  };
}

type FredFacts = {
  key: string;
  name: string;
  id: string;
  aliases?: string[];
  keywords: string[];
  headline?: true;
  unit: SeriesUnit;
  period: PeriodKind;
  /** FRED's units, frequency and seasonal adjustment, as FRED writes them. */
  units: string;
  frequency: string;
  adjustment: string;
  weekEnding?: true;
};

const FREQUENCIES: Record<PeriodKind, string> = {
  calendar_day: "daily",
  week: "weekly",
  month: "monthly",
  quarter: "quarterly",
  half_year: "semiannual",
  year: "annual",
};

/** A FRED series; FRED's code names it too unless another series' name is that code ("GDP"). */
function fred(facts: FredFacts): CatalogSeries {
  return {
    key: facts.key,
    name: facts.name,
    aliases: facts.aliases ?? [],
    codes: [],
    keywords: facts.keywords,
    ...(facts.headline ? { headline: true as const } : {}),
    origin: { publisher: "fred", id: facts.id, ...(facts.weekEnding ? { weekEnding: true as const } : {}) },
    frequency: FREQUENCIES[facts.period],
    period: facts.period,
    seasonal_adjustment: facts.adjustment.toLowerCase(),
    unit: facts.unit,
    as_published: { unit: facts.units, frequency: facts.frequency, seasonal_adjustment: facts.adjustment },
  };
}

const SA = "Seasonally Adjusted";
const NSA = "Not Seasonally Adjusted";
const SAAR = "Seasonally Adjusted Annual Rate";
const INFLATION = ["inflation", "prices", "price index"];
const LABOR = ["employment", "labor", "labour", "jobs", "labor market"];
const GROWTH = ["growth", "output", "economy", "economic activity", "activity"];
const HOUSING = ["housing", "real estate", "homes"];
const CREDIT = ["credit", "credit spreads", "corporate bonds", "spread"];

/** Every series, headline ones first within their kind. */
export const SERIES: readonly CatalogSeries[] = [
  // FRED: the statistics the skills ask for by name.
  fred({
    key: "us.fred.cpiaucsl",
    name: "CPI",
    id: "CPIAUCSL",
    aliases: ["consumer price index", "CPI-U", "headline CPI", "CPI inflation", "consumer prices"],
    keywords: [...INFLATION, "consumer"],
    headline: true,
    unit: INDEX,
    period: "month",
    units: "Index 1982-1984=100",
    frequency: "Monthly",
    adjustment: SA,
  }),
  fred({
    key: "us.fred.cpilfesl",
    name: "core CPI",
    id: "CPILFESL",
    aliases: ["CPI less food and energy", "core consumer price index", "core CPI inflation"],
    keywords: [...INFLATION, "core inflation", "consumer"],
    headline: true,
    unit: INDEX,
    period: "month",
    units: "Index 1982-1984=100",
    frequency: "Monthly",
    adjustment: SA,
  }),
  fred({
    key: "us.fred.unrate",
    name: "unemployment rate",
    id: "UNRATE",
    aliases: ["unemployment", "jobless rate", "civilian unemployment rate"],
    keywords: LABOR,
    headline: true,
    unit: PERCENT,
    period: "month",
    units: "Percent",
    frequency: "Monthly",
    adjustment: SA,
  }),
  fred({
    key: "us.fred.payems",
    name: "payrolls",
    id: "PAYEMS",
    aliases: [
      "nonfarm payrolls",
      "NFP",
      "total nonfarm payrolls",
      "nonfarm employment",
      "all employees, total nonfarm",
    ],
    keywords: LABOR,
    headline: true,
    unit: unit("count", 1000),
    period: "month",
    units: "Thousands of Persons",
    frequency: "Monthly",
    adjustment: SA,
  }),
  fred({
    key: "us.fred.gdpc1",
    name: "GDP",
    id: "GDPC1",
    aliases: ["real GDP", "gross domestic product", "real gross domestic product"],
    keywords: GROWTH,
    headline: true,
    unit: unit("currency", 1e9, "USD"),
    period: "quarter",
    units: "Billions of Chained 2017 Dollars",
    frequency: "Quarterly",
    adjustment: SAAR,
  }),
  fred({
    key: "us.fred.gdp",
    name: "nominal GDP",
    id: "GDP",
    aliases: ["nominal gross domestic product", "GDP in current dollars"],
    keywords: GROWTH,
    unit: unit("currency", 1e9, "USD"),
    period: "quarter",
    units: "Billions of Dollars",
    frequency: "Quarterly",
    adjustment: SAAR,
  }),
  fred({
    key: "us.fred.a191rl1q225sbea",
    name: "real GDP growth",
    id: "A191RL1Q225SBEA",
    aliases: ["GDP growth", "real GDP growth rate", "GDP growth rate"],
    keywords: GROWTH,
    unit: PERCENT,
    period: "quarter",
    units: "Percent Change from Preceding Period",
    frequency: "Quarterly",
    adjustment: SAAR,
  }),
  fred({
    key: "us.fred.pcepi",
    name: "PCE price index",
    id: "PCEPI",
    aliases: ["PCE inflation", "PCE deflator", "personal consumption expenditures price index"],
    keywords: [...INFLATION, "consumer", "spending"],
    unit: INDEX,
    period: "month",
    units: "Index 2017=100",
    frequency: "Monthly",
    adjustment: SA,
  }),
  fred({
    key: "us.fred.pcepilfe",
    name: "core PCE price index",
    id: "PCEPILFE",
    aliases: ["core PCE", "core PCE inflation", "core PCE deflator"],
    keywords: [...INFLATION, "core inflation", "consumer"],
    unit: INDEX,
    period: "month",
    units: "Index 2017=100",
    frequency: "Monthly",
    adjustment: SA,
  }),
  fred({
    key: "us.fred.ppifis",
    name: "PPI",
    id: "PPIFIS",
    aliases: ["producer price index", "PPI final demand", "producer prices"],
    keywords: [...INFLATION, "producer", "wholesale"],
    unit: INDEX,
    period: "month",
    units: "Index Nov 2009=100",
    frequency: "Monthly",
    adjustment: SA,
  }),
  fred({
    key: "us.fred.icsa",
    name: "initial jobless claims",
    id: "ICSA",
    aliases: ["initial claims", "jobless claims", "weekly jobless claims", "unemployment claims"],
    keywords: [...LABOR, "claims", "weekly"],
    unit: unit("count"),
    period: "week",
    units: "Number",
    frequency: "Weekly, Ending Saturday",
    adjustment: SA,
    weekEnding: true,
  }),
  fred({
    key: "us.fred.jtsjol",
    name: "job openings",
    id: "JTSJOL",
    aliases: ["JOLTS", "JOLTS job openings", "job vacancies"],
    keywords: [...LABOR, "labor demand"],
    unit: unit("count", 1000),
    period: "month",
    units: "Level in Thousands",
    frequency: "Monthly",
    adjustment: SA,
  }),
  fred({
    key: "us.fred.ces0500000003",
    name: "average hourly earnings",
    id: "CES0500000003",
    aliases: ["hourly earnings", "wages", "wage growth"],
    keywords: [...LABOR, "pay", "income"],
    unit: unit("currency", 1, "USD", "hour"),
    period: "month",
    units: "Dollars per Hour",
    frequency: "Monthly",
    adjustment: SA,
  }),
  fred({
    key: "us.fred.indpro",
    name: "industrial production",
    id: "INDPRO",
    aliases: ["industrial production index", "industrial output"],
    keywords: [...GROWTH, "manufacturing", "industry", "production"],
    unit: INDEX,
    period: "month",
    units: "Index 2017=100",
    frequency: "Monthly",
    adjustment: SA,
  }),
  fred({
    key: "us.fred.rsafs",
    name: "retail sales",
    id: "RSAFS",
    aliases: ["advance retail sales", "retail and food services sales"],
    keywords: [...GROWTH, "consumer", "spending", "consumption"],
    unit: unit("currency", 1e6, "USD"),
    period: "month",
    units: "Millions of Dollars",
    frequency: "Monthly",
    adjustment: SA,
  }),
  fred({
    key: "us.fred.m2sl",
    name: "M2 money supply",
    id: "M2SL",
    aliases: ["M2", "money supply", "money stock"],
    keywords: ["money", "liquidity", "monetary aggregates"],
    unit: unit("currency", 1e9, "USD"),
    period: "month",
    units: "Billions of Dollars",
    frequency: "Monthly",
    adjustment: SA,
  }),
  fred({
    key: "us.fred.umcsent",
    name: "consumer sentiment",
    id: "UMCSENT",
    aliases: [
      "University of Michigan consumer sentiment",
      "Michigan sentiment",
      "Michigan consumer sentiment",
    ],
    keywords: ["sentiment", "confidence", "consumer", "survey"],
    unit: INDEX,
    period: "month",
    units: "Index 1966:Q1=100",
    frequency: "Monthly",
    adjustment: NSA,
  }),
  fred({
    key: "us.fred.houst",
    name: "housing starts",
    id: "HOUST",
    aliases: ["new housing starts", "housing units started"],
    keywords: [...HOUSING, "construction"],
    unit: unit("count", 1000),
    period: "month",
    units: "Thousands of Units",
    frequency: "Monthly",
    adjustment: SAAR,
  }),
  fred({
    key: "us.fred.csushpinsa",
    name: "Case-Shiller home price index",
    id: "CSUSHPINSA",
    aliases: ["Case-Shiller", "home prices", "house prices", "home price index"],
    keywords: [...HOUSING, "prices"],
    unit: INDEX,
    period: "month",
    units: "Index Jan 2000=100",
    frequency: "Monthly",
    adjustment: NSA,
  }),
  fred({
    key: "us.fred.mortgage30us",
    name: "30-year mortgage rate",
    id: "MORTGAGE30US",
    aliases: ["mortgage rate", "30-year fixed mortgage rate", "mortgage rates"],
    keywords: [...HOUSING, ...RATES, "mortgage", "weekly"],
    unit: PERCENT,
    period: "week",
    units: "Percent",
    frequency: "Weekly, Ending Thursday",
    adjustment: NSA,
    weekEnding: true,
  }),
  fred({
    key: "us.fred.fedfunds",
    name: "federal funds rate, monthly average",
    id: "FEDFUNDS",
    aliases: ["monthly fed funds rate", "fed funds rate, monthly"],
    keywords: [...RATES, "fed", "federal reserve", "policy rates", "central banks", "monetary policy"],
    unit: PERCENT,
    period: "month",
    units: "Percent",
    frequency: "Monthly",
    adjustment: NSA,
  }),
  fred({
    key: "us.fred.bamlh0a0hym2",
    name: "high-yield credit spread",
    id: "BAMLH0A0HYM2",
    aliases: ["high-yield spread", "HY OAS", "high-yield OAS", "junk bond spread"],
    keywords: [...CREDIT, "high yield", "option-adjusted spread"],
    unit: POINTS,
    period: "calendar_day",
    units: "Percent",
    frequency: "Daily, Close",
    adjustment: NSA,
  }),
  fred({
    key: "us.fred.bamlc0a0cm",
    name: "investment-grade credit spread",
    id: "BAMLC0A0CM",
    aliases: ["investment-grade spread", "IG OAS", "investment-grade OAS", "corporate bond spread"],
    keywords: [...CREDIT, "investment grade", "option-adjusted spread"],
    unit: POINTS,
    period: "calendar_day",
    units: "Percent",
    frequency: "Daily, Close",
    adjustment: NSA,
  }),
  fred({
    key: "us.fred.baa10y",
    name: "Baa corporate bond spread",
    id: "BAA10Y",
    aliases: ["Baa spread", "Moody's Baa spread"],
    keywords: [...CREDIT, "baa"],
    unit: POINTS,
    period: "calendar_day",
    units: "Percent",
    frequency: "Daily",
    adjustment: NSA,
  }),
  fred({
    key: "us.fred.dtwexbgs",
    name: "trade-weighted dollar index",
    id: "DTWEXBGS",
    aliases: ["broad dollar index", "nominal broad dollar index", "trade-weighted dollar"],
    keywords: ["dollar", "currency", "fx", "exchange rate"],
    unit: INDEX,
    period: "calendar_day",
    units: "Index Jan 2006=100",
    frequency: "Daily",
    adjustment: NSA,
  }),

  // The U.S. Treasury's par (nominal) yield curve, the risk-free inputs the skills ask for first.
  par("10y", 1990, {
    headline: true,
    aliases: ["10-year yield", "10-year Treasury", "10-year Treasury note yield", "10y Treasury yield"],
    codes: ["DGS10"],
  }),
  par("3m", 1990, {
    name: "Treasury bill yield",
    headline: true,
    aliases: [
      "3-month Treasury bill yield",
      "3-month T-bill yield",
      "T-bill yield",
      "Treasury bill rate",
      "3-month yield",
    ],
    codes: ["DGS3MO"],
  }),
  par("2y", 1990, {
    headline: true,
    aliases: ["2-year yield", "2-year Treasury", "2-year Treasury note yield", "2y Treasury yield"],
    codes: ["DGS2"],
  }),
  par("1m", 2001, { aliases: ["1-month Treasury bill yield", "1-month T-bill yield"], codes: ["DGS1MO"] }),
  par("1.5m", 2025, { aliases: ["6-week Treasury bill yield"] }),
  par("2m", 2018, { aliases: ["2-month Treasury bill yield"] }),
  par("4m", 2022, { aliases: ["4-month Treasury bill yield"] }),
  par("6m", 1990, { aliases: ["6-month Treasury bill yield", "6-month T-bill yield"], codes: ["DGS6MO"] }),
  par("1y", 1990, { aliases: ["1-year yield"], codes: ["DGS1"] }),
  par("3y", 1990, { aliases: ["3-year yield"], codes: ["DGS3"] }),
  par("5y", 1990, { aliases: ["5-year yield"], codes: ["DGS5"] }),
  par("7y", 1990, { aliases: ["7-year yield"], codes: ["DGS7"] }),
  par("20y", 1993, { aliases: ["20-year yield"], codes: ["DGS20"] }),
  par("30y", 1990, { aliases: ["30-year yield", "long bond yield"], codes: ["DGS30"] }),

  // Breakevens and the curve's slope, derived from the Treasury's curves as FRED derives its own.
  breakeven("10y", 2003, ["T10YIE"]),
  breakeven("5y", 2003, ["T5YIE"]),
  breakeven("7y", 2003),
  breakeven("20y", 2004),
  breakeven("30y", 2010),
  spread("10y", "2y", ["2s10s spread", "2s10s", "10y-2y spread"], ["T10Y2Y"]),
  spread("10y", "3m", ["3m10y spread", "10y-3m spread"], ["T10Y3M"]),

  // The Treasury's real (TIPS) par yield curve.
  real("10y", 2003, ["DFII10"]),
  real("5y", 2003, ["DFII5"]),
  real("7y", 2003, ["DFII7"]),
  real("20y", 2004, ["DFII20"]),
  real("30y", 2010, ["DFII30"]),

  // The New York Fed's reference rates.
  nyfed("effr", "effective federal funds rate", {
    aliases: ["fed funds rate", "fed funds", "federal funds rate", "effective fed funds rate"],
    keywords: [
      "fed",
      "federal reserve",
      "fomc",
      "target range",
      "fed funds target",
      "policy rates",
      "central banks",
      "monetary policy",
    ],
    codes: ["EFFR"],
    headline: true,
    // The New York Fed's method since March 2016; before, a volume-weighted mean of brokered trades.
    unit: "percent (volume-weighted median; a volume-weighted mean before March 2016)",
  }),
  nyfed("sofr", "SOFR", {
    aliases: ["secured overnight financing rate"],
    keywords: ["repo", "secured"],
    codes: ["SOFR"],
    headline: true,
  }),
  nyfed("obfr", "OBFR", {
    aliases: ["overnight bank funding rate"],
    keywords: ["unsecured", "bank funding"],
    codes: ["OBFR"],
  }),
  nyfed("tgcr", "TGCR", {
    aliases: ["tri-party general collateral rate"],
    keywords: ["repo", "secured", "general collateral"],
  }),
  nyfed("bgcr", "BGCR", {
    aliases: ["broad general collateral rate"],
    keywords: ["repo", "secured", "general collateral"],
  }),

  // The ECB's key interest rates.
  ecb("DFR", "ECB deposit facility rate", ["ECB deposit rate", "deposit facility rate"], "ECBDFR", true),
  ecb(
    "MRR_FR",
    "ECB main refinancing rate",
    ["ECB main refinancing operations rate", "main refinancing rate", "ECB refi rate", "MRO rate"],
    "ECBMRRFR",
  ),
  ecb(
    "MLFR",
    "ECB marginal lending facility rate",
    ["ECB marginal lending rate", "marginal lending facility rate"],
    "ECBMLFR",
  ),
];

/** Words a query leaves out when matched against names: they add nothing to these (mostly U.S.) series. */
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "in",
  "us",
  "u.s",
  "u.s.",
  "usa",
  "united",
  "states",
]);

/** `text` as names are compared: lower case, punctuation as spaces, runs of spaces as one. */
export function normalizeName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/(^|\s)\.+|\.+(\s|$)/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** A word as a search compares it: a plural of letters only read as its singular ("yields", "rates"). */
function stem(word: string): string {
  return /^[a-z]{4,}s$/.test(word) && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/** The words of `text` as searches compare them: normalized, stemmed, stop words left out. */
export function searchWords(text: string): string[] {
  return normalizeName(text)
    .split(" ")
    .filter((word) => word && !STOP_WORDS.has(word))
    .map(stem);
}

/** A name as an exact match compares it: its words, stop words left out, in order. */
export function exactName(text: string): string {
  return searchWords(text).join(" ");
}

const BY_KEY = new Map(SERIES.map((entry) => [entry.key, entry]));

/** The catalog's series under `key` (with or without `series:`, in any case). */
export function catalogSeries(key: string): CatalogSeries | undefined {
  return BY_KEY.get(key.replace(/^series:/i, "").toLowerCase());
}

/** The catalog's series FRED's code `id` names: a FRED series' own code, or FRED's copy of another's (DGS10). */
export function catalogByCode(id: string): CatalogSeries | undefined {
  const wanted = id.toUpperCase();
  return SERIES.find(
    (entry) =>
      (entry.origin.publisher === "fred" && entry.origin.id === wanted) || entry.codes.includes(wanted),
  );
}

/** Every name a series is named by exactly: its name, its aliases and its FRED codes. */
export function namesOf(entry: CatalogSeries): string[] {
  const names = [entry.name, ...entry.aliases, ...entry.codes];
  if (entry.origin.publisher === "fred") names.push(entry.origin.id);
  return names;
}

/**
 * The series each exact name names. A series' name is always its own; another name of it that is some
 * series' name is left out (FRED's code "GDP" names nominal GDP at FRED, but "GDP" is real GDP here).
 */
const EXACT = (() => {
  const forms = new Map<string, CatalogSeries>();
  for (const entry of SERIES) forms.set(exactName(entry.name), entry);
  for (const entry of SERIES) {
    for (const name of namesOf(entry).slice(1)) {
      const form = exactName(name);
      if (!forms.has(form)) forms.set(form, entry);
    }
  }
  return forms;
})();

/** Each series' words for a broad search: those of its name, and those of all its names and keywords. */
const WORDS = new Map(
  SERIES.map((entry) => [
    entry,
    {
      name: new Set(searchWords(entry.name)),
      all: new Set(
        [...namesOf(entry), ...entry.keywords, entry.key.split(".").at(-1) ?? ""].flatMap(searchWords),
      ),
    },
  ]),
);

/** A catalog series a search found: exactly named (by a name, an alias, a code or its key), or by its words. */
export type CatalogMatch = { entry: CatalogSeries; exact: boolean };

/**
 * The catalog's series `query` finds, best first: the one it names exactly (a name, an alias, a code or a
 * key, compared without case or punctuation), then every series whose names and keywords hold each word
 * of it: headline series first, then those whose own name holds every word, then the rest, each group in
 * the catalog's order. Nothing is left out for being found less well.
 */
export function searchCatalog(query: string): CatalogMatch[] {
  const asKey = query
    .trim()
    .replace(/^series:/i, "")
    .toLowerCase();
  const exact = BY_KEY.get(asKey) ?? EXACT.get(exactName(query));
  const words = [...new Set(searchWords(query))];
  const found: { entry: CatalogSeries; rank: number }[] = [];
  if (words.length) {
    for (const entry of SERIES) {
      if (entry === exact) continue;
      const known = WORDS.get(entry);
      if (!known || !words.every((word) => known.all.has(word))) continue;
      const inName = words.every((word) => known.name.has(word));
      found.push({ entry, rank: (entry.headline ? 2 : 0) + (inName ? 1 : 0) });
    }
  }
  // Sorting is stable: equal ranks keep the catalog's order.
  found.sort((a, b) => b.rank - a.rank);
  return [
    ...(exact ? [{ entry: exact, exact: true }] : []),
    ...found.map(({ entry }) => ({ entry, exact: false })),
  ];
}
