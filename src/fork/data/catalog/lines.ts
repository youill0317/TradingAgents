// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The statement lines the fork serves, one table for the statements tool (SEC companyfacts through the filers
 * provider) and the sector screen (SEC frames): each line's name as the tools write it, what kind of value it
 * is, and the XBRL concepts that carry it, in the order they are tried for each period.
 *
 * - Names are the ones statements and screens print, and the dcf tool reads five of them exactly
 *   (src/tools/valuation.ts): "Net Cash from Operating Activities", "Payments to Acquire PP&E", "Payments to
 *   Acquire Productive Assets", "Interest Paid, Excluding Capitalized Interest, Operating Activities" and
 *   "Share-Based Compensation".
 * - `usGaap` and `ifrs` list concepts of the us-gaap and ifrs-full taxonomies (20-F filers report through the
 *   latter), without the taxonomy's prefix. For each period the first concept with a value is used, so a filer
 *   that moved from one concept to another (SalesRevenueNet to RevenueFromContractWithCustomer...) reads as one
 *   line. A concept whose meaning differs from the line's name carries a `notes` entry, said beside its value.
 * - `compute` derives a value when none of the concepts is filed for a period: the sum of the components filed
 *   (`any`: at least one of them; short-term debt is often filed in parts) or a difference that needs every
 *   term (`all`: total liabilities as liabilities and equity less equity). The derivation is said beside the value.
 * - `additive` flows add up over time: a quarter can be computed from year-to-date or annual values (a second
 *   quarter as the first half less the first quarter, a fourth as the year less nine months). Per-share figures
 *   and share counts never are: they are served for a quarter only when a three-month value was filed.
 * - Units are "USD" (or the filer's reporting currency, "TWD", "EUR"), "<currency>/shares" for per-share
 *   figures, and "shares".
 *
 * The concepts come from the design's catalog and from what large filers were seen to file in SEC's own
 * answers: PaymentsOfOrdinaryDividends (Bank of America),
 * DepreciationAmortizationAndAccretionNet (GE), InterestExpenseDebt (Walmart), InterestExpenseOperating
 * (JPMorgan), and TSMC's and SAP's ifrs-full concepts.
 */

/** The statements a line belongs to, as the statements tool names them. */
export type StatementKind = "income_statement" | "balance_sheet" | "cash_flow";

/** What a line's value is: an amount in the reporting currency, an amount per share, or a count of shares. */
export type LineUnit = "currency" | "per_share" | "shares";

/** A value derived from other concepts when the line's own are not filed. */
export type LineFormula = {
  /** Concepts added (and, for a difference, subtracted). */
  add: readonly string[];
  subtract?: readonly string[];
  /** "any": the sum of the components filed, at least one; "all": every term must be filed. */
  needs: "any" | "all";
};

export type CatalogLine = {
  statement: StatementKind;
  /** The line's name as the tools print it. */
  label: string;
  /** Other names a person or a model may ask a screen for ("revenues", "net income"). */
  aliases?: readonly string[];
  /** Over a period (income statement, cash flow) or at a date (balance sheet). */
  period: "duration" | "instant";
  unit: LineUnit;
  /** A flow whose quarters can be computed as differences of year-to-date or annual values. */
  additive: boolean;
  /** us-gaap concepts, tried in this order for each period. */
  usGaap: readonly string[];
  /** ifrs-full concepts, tried in this order for each period. */
  ifrs: readonly string[];
  /** What a value from one of these concepts is, when that is not exactly what the line's name says. */
  notes?: Readonly<Record<string, string>>;
  /** A value derived from other concepts when none of the line's own is filed, per taxonomy. */
  compute?: { usGaap?: LineFormula; ifrs?: LineFormula };
  /** The cover page's count (dei), from the same report, when no balance-sheet count is filed. */
  dei?: string;
};

const duration = (
  statement: Exclude<StatementKind, "balance_sheet">,
  label: string,
  usGaap: readonly string[],
  ifrs: readonly string[],
  more: Partial<CatalogLine> = {},
): CatalogLine => ({
  statement,
  label,
  period: "duration",
  unit: "currency",
  additive: true,
  usGaap,
  ifrs,
  ...more,
});

const instant = (
  label: string,
  usGaap: readonly string[],
  ifrs: readonly string[],
  more: Partial<CatalogLine> = {},
): CatalogLine => ({
  statement: "balance_sheet",
  label,
  period: "instant",
  unit: "currency",
  additive: false,
  usGaap,
  ifrs,
  ...more,
});

/** Every line, by statement, in the order a statement shows them. */
export const LINES: readonly CatalogLine[] = [
  // Income statement ------------------------------------------------------------------------------
  duration(
    "income_statement",
    "Revenue",
    [
      "Revenues",
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "RevenueFromContractWithCustomerIncludingAssessedTax",
      "SalesRevenueNet",
      "RevenuesNetOfInterestExpense",
    ],
    ["Revenue"],
    { aliases: ["revenues", "total revenue", "total revenues", "sales", "net sales"] },
  ),
  duration(
    "income_statement",
    "Cost of Revenue",
    ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"],
    ["CostOfSales"],
    { aliases: ["cost of sales", "cost of goods sold"] },
  ),
  duration("income_statement", "Gross Profit", ["GrossProfit"], ["GrossProfit"]),
  duration(
    "income_statement",
    "Research and Development",
    ["ResearchAndDevelopmentExpense"],
    ["ResearchAndDevelopmentExpense"],
    { aliases: ["research and development expense", "r&d"] },
  ),
  duration(
    "income_statement",
    "Selling, General and Administrative",
    ["SellingGeneralAndAdministrativeExpense"],
    ["SellingGeneralAndAdministrativeExpense"],
    { aliases: ["sg&a", "selling general and administrative expense"] },
  ),
  duration(
    "income_statement",
    "General and Administrative",
    ["GeneralAndAdministrativeExpense"],
    ["GeneralAndAdministrativeExpense", "AdministrativeExpense"],
    { aliases: ["g&a", "administrative expense"] },
  ),
  duration(
    "income_statement",
    "Operating Income (Loss)",
    ["OperatingIncomeLoss"],
    ["ProfitLossFromOperatingActivities"],
    { aliases: ["operating income", "operating profit", "income from operations"] },
  ),
  duration(
    "income_statement",
    "Interest Expense",
    ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "InterestExpenseOperating"],
    ["FinanceCosts"],
    {
      notes: {
        InterestExpenseDebt: "interest on debt (InterestExpenseDebt)",
        InterestExpenseOperating: "interest expense classified as operating (InterestExpenseOperating)",
        FinanceCosts: "finance costs (ifrs-full FinanceCosts), interest and other costs of borrowing",
      },
    },
  ),
  duration(
    "income_statement",
    "Income (Loss) Before Income Taxes",
    [
      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    ],
    ["ProfitLossBeforeTax"],
    { aliases: ["pretax income", "income before income taxes", "income before taxes"] },
  ),
  duration(
    "income_statement",
    "Income Tax Expense (Benefit)",
    ["IncomeTaxExpenseBenefit"],
    ["IncomeTaxExpenseContinuingOperations"],
    { aliases: ["income tax expense", "income taxes", "provision for income taxes"] },
  ),
  duration(
    "income_statement",
    "Net Income (Loss)",
    ["NetIncomeLoss"],
    ["ProfitLossAttributableToOwnersOfParent"],
    {
      aliases: ["net income", "net earnings", "net profit", "earnings"],
    },
  ),
  duration(
    "income_statement",
    "Net Income (Loss) Including Noncontrolling Interests",
    ["ProfitLoss"],
    ["ProfitLoss"],
    { aliases: ["net income including noncontrolling interests", "profit or loss"] },
  ),
  duration("income_statement", "EPS (Basic)", ["EarningsPerShareBasic"], ["BasicEarningsLossPerShare"], {
    unit: "per_share",
    additive: false,
    aliases: ["basic eps", "eps basic", "earnings per share basic"],
  }),
  duration(
    "income_statement",
    "EPS (Diluted)",
    ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"],
    ["DilutedEarningsLossPerShare"],
    {
      unit: "per_share",
      additive: false,
      aliases: ["eps", "diluted eps", "eps diluted", "earnings per share", "earnings per share diluted"],
      notes: { EarningsPerShareBasicAndDiluted: "basic and diluted alike (EarningsPerShareBasicAndDiluted)" },
    },
  ),
  duration(
    "income_statement",
    "Weighted Average Shares (Diluted)",
    ["WeightedAverageNumberOfDilutedSharesOutstanding"],
    ["AdjustedWeightedAverageShares"],
    { unit: "shares", additive: false, aliases: ["diluted shares", "weighted average diluted shares"] },
  ),

  // Balance sheet ---------------------------------------------------------------------------------
  instant(
    "Cash and Cash Equivalents",
    [
      "CashAndCashEquivalentsAtCarryingValue",
      "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
    ["CashAndCashEquivalents"],
    {
      aliases: ["cash"],
      notes: {
        CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents:
          "includes restricted cash (CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents)",
      },
    },
  ),
  instant("Short-Term Investments", ["ShortTermInvestments", "MarketableSecuritiesCurrent"], [], {
    aliases: ["marketable securities"],
  }),
  instant(
    "Accounts Receivable",
    ["AccountsReceivableNetCurrent"],
    ["TradeAndOtherCurrentReceivables", "CurrentTradeReceivables"],
    {
      aliases: ["receivables"],
      notes: { CurrentTradeReceivables: "trade receivables only (CurrentTradeReceivables)" },
    },
  ),
  instant("Inventory", ["InventoryNet"], ["Inventories"], { aliases: ["inventories"] }),
  instant("Total Current Assets", ["AssetsCurrent"], ["CurrentAssets"], { aliases: ["current assets"] }),
  instant(
    "Property, Plant and Equipment, Net",
    ["PropertyPlantAndEquipmentNet"],
    ["PropertyPlantAndEquipment", "PropertyPlantAndEquipmentIncludingRightofuseAssets"],
    {
      aliases: ["pp&e", "property plant and equipment"],
      notes: {
        PropertyPlantAndEquipmentIncludingRightofuseAssets:
          "includes right-of-use assets (PropertyPlantAndEquipmentIncludingRightofuseAssets)",
      },
    },
  ),
  instant("Goodwill", ["Goodwill"], ["Goodwill"]),
  instant("Total Assets", ["Assets"], ["Assets"], { aliases: ["assets"] }),
  instant(
    "Accounts Payable",
    ["AccountsPayableCurrent"],
    ["TradeAndOtherCurrentPayables", "TradeAndOtherCurrentPayablesToTradeSuppliers"],
    {
      aliases: ["payables"],
      notes: {
        TradeAndOtherCurrentPayablesToTradeSuppliers:
          "payables to trade suppliers only (TradeAndOtherCurrentPayablesToTradeSuppliers)",
      },
    },
  ),
  instant("Short-Term Debt", ["DebtCurrent"], ["CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings"], {
    aliases: ["current debt"],
    compute: {
      usGaap: { add: ["LongTermDebtCurrent", "ShortTermBorrowings", "CommercialPaper"], needs: "any" },
      ifrs: {
        add: [
          "ShorttermBorrowings",
          "CurrentPortionOfLongtermBorrowings",
          "CurrentBondsIssuedAndCurrentPortionOfNoncurrentBondsIssued",
        ],
        needs: "any",
      },
    },
  }),
  instant("Total Current Liabilities", ["LiabilitiesCurrent"], ["CurrentLiabilities"], {
    aliases: ["current liabilities"],
  }),
  instant("Long-Term Debt", ["LongTermDebtNoncurrent"], [], {
    aliases: ["long term debt"],
    compute: {
      ifrs: { add: ["LongtermBorrowings", "NoncurrentPortionOfNoncurrentBondsIssued"], needs: "any" },
    },
  }),
  instant("Total Liabilities", ["Liabilities"], ["Liabilities"], {
    aliases: ["liabilities"],
    compute: {
      usGaap: {
        add: ["LiabilitiesAndStockholdersEquity"],
        subtract: ["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
        needs: "all",
      },
      ifrs: { add: ["EquityAndLiabilities"], subtract: ["Equity"], needs: "all" },
    },
  }),
  instant("Stockholders' Equity", ["StockholdersEquity"], ["EquityAttributableToOwnersOfParent"], {
    aliases: ["shareholders equity", "stockholders equity", "equity attributable to parent"],
  }),
  instant(
    "Total Equity",
    ["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
    ["Equity"],
    {
      aliases: ["equity"],
    },
  ),
  instant("Total Liabilities and Equity", ["LiabilitiesAndStockholdersEquity"], ["EquityAndLiabilities"], {
    aliases: ["liabilities and equity"],
  }),
  instant("Shares Outstanding", ["CommonStockSharesOutstanding"], [], {
    unit: "shares",
    aliases: ["shares", "common shares outstanding"],
    dei: "EntityCommonStockSharesOutstanding",
  }),

  // Cash flow ---------------------------------------------------------------------------------
  duration(
    "cash_flow",
    "Net Cash from Operating Activities",
    [
      "NetCashProvidedByUsedInOperatingActivities",
      "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ],
    ["CashFlowsFromUsedInOperatingActivities"],
    {
      aliases: ["operating cash flow", "cash from operations", "net cash provided by operating activities"],
      notes: {
        NetCashProvidedByUsedInOperatingActivitiesContinuingOperations:
          "continuing operations only (NetCashProvidedByUsedInOperatingActivitiesContinuingOperations)",
      },
    },
  ),
  duration(
    "cash_flow",
    "Depreciation and Amortization",
    [
      "DepreciationDepletionAndAmortization",
      "DepreciationAndAmortization",
      "DepreciationAmortizationAndAccretionNet",
    ],
    [
      "AdjustmentsForDepreciationAndAmortisationExpense",
      "DepreciationAndAmortisationExpense",
      "DepreciationExpense",
    ],
    {
      aliases: ["d&a", "depreciation"],
      notes: {
        DepreciationAmortizationAndAccretionNet:
          "includes accretion (DepreciationAmortizationAndAccretionNet)",
        DepreciationExpense: "depreciation alone (ifrs-full DepreciationExpense)",
      },
    },
  ),
  duration(
    "cash_flow",
    "Share-Based Compensation",
    ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"],
    ["AdjustmentsForSharebasedPayments"],
    { aliases: ["stock-based compensation", "stock based compensation", "sbc"] },
  ),
  duration(
    "cash_flow",
    "Payments to Acquire PP&E",
    ["PaymentsToAcquirePropertyPlantAndEquipment"],
    ["PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"],
    { aliases: ["capital expenditure", "capital expenditures", "capex"] },
  ),
  duration(
    "cash_flow",
    "Payments to Acquire Productive Assets",
    ["PaymentsToAcquireProductiveAssets"],
    [
      "PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets",
    ],
    {
      notes: {
        PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets:
          "property, plant and equipment, intangible assets and other noncurrent assets together",
      },
    },
  ),
  duration(
    "cash_flow",
    "Net Cash from Investing Activities",
    [
      "NetCashProvidedByUsedInInvestingActivities",
      "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations",
    ],
    ["CashFlowsFromUsedInInvestingActivities"],
    { aliases: ["investing cash flow", "cash from investing"] },
  ),
  duration(
    "cash_flow",
    "Net Cash from Financing Activities",
    [
      "NetCashProvidedByUsedInFinancingActivities",
      "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations",
    ],
    ["CashFlowsFromUsedInFinancingActivities"],
    { aliases: ["financing cash flow", "cash from financing"] },
  ),
  duration(
    "cash_flow",
    "Dividends Paid",
    ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock", "PaymentsOfOrdinaryDividends"],
    ["DividendsPaidClassifiedAsFinancingActivities", "DividendsPaid"],
    {
      aliases: ["dividends"],
      notes: {
        PaymentsOfDividendsCommonStock: "common stock dividends (PaymentsOfDividendsCommonStock)",
        PaymentsOfOrdinaryDividends: "ordinary dividends (PaymentsOfOrdinaryDividends)",
      },
    },
  ),
  duration(
    "cash_flow",
    "Repurchase of Common Stock",
    ["PaymentsForRepurchaseOfCommonStock"],
    ["PaymentsToAcquireOrRedeemEntitysShares", "PurchaseOfTreasuryShares"],
    { aliases: ["buybacks", "share repurchases", "stock repurchases"] },
  ),
  duration(
    "cash_flow",
    "Interest Paid, Excluding Capitalized Interest, Operating Activities",
    ["InterestPaidNet"],
    ["InterestPaidClassifiedAsOperatingActivities"],
    { aliases: ["interest paid"] },
  ),
  // Kept apart from the line above: interest a filer classifies as financing is not in its operating cash
  // flow, so the dcf tool (which adds after-tax interest paid back to operating cash flow) must not read it.
  duration(
    "cash_flow",
    "Interest Paid, Financing Activities",
    [],
    ["InterestPaidClassifiedAsFinancingActivities"],
  ),
  duration(
    "cash_flow",
    "Income Taxes Paid",
    ["IncomeTaxesPaidNet"],
    [
      "IncomeTaxesPaidRefundClassifiedAsOperatingActivities",
      "IncomeTaxesPaidClassifiedAsOperatingActivities",
    ],
    { aliases: ["taxes paid", "cash taxes"] },
  ),
];

/** The lines of one statement, in the order it shows them. */
export function linesOf(statement: StatementKind): CatalogLine[] {
  return LINES.filter((line) => line.statement === statement);
}

/** Every concept a line may be read from, per taxonomy (its own, its formula's, and dei's). */
export function conceptsOf(line: CatalogLine): { usGaap: string[]; ifrs: string[]; dei: string[] } {
  const formula = (one: LineFormula | undefined) => [...(one?.add ?? []), ...(one?.subtract ?? [])];
  return {
    usGaap: [...line.usGaap, ...formula(line.compute?.usGaap)],
    ifrs: [...line.ifrs, ...formula(line.compute?.ifrs)],
    dei: line.dei ? [line.dei] : [],
  };
}

/** Every concept of the catalog, by taxonomy as SEC names them ("us-gaap", "ifrs-full", "dei"). */
export const CATALOG_CONCEPTS: Readonly<Record<"us-gaap" | "ifrs-full" | "dei", ReadonlySet<string>>> =
  (() => {
    const usGaap = new Set<string>();
    const ifrs = new Set<string>();
    const dei = new Set<string>();
    for (const line of LINES) {
      const concepts = conceptsOf(line);
      for (const name of concepts.usGaap) usGaap.add(name);
      for (const name of concepts.ifrs) ifrs.add(name);
      for (const name of concepts.dei) dei.add(name);
    }
    return { "us-gaap": usGaap, "ifrs-full": ifrs, dei };
  })();

/** A line's name as compared: lower case, without "(loss)" or "(benefit)", punctuation and runs of spaces. */
function comparable(name: string): string {
  return name
    .toLowerCase()
    .replace(/\((loss|benefit)\)/g, " ")
    .replace(/[^a-z0-9&]+/g, " ")
    .trim();
}

const BY_NAME: ReadonlyMap<string, CatalogLine> = (() => {
  const named = new Map<string, CatalogLine>();
  for (const line of LINES) {
    for (const name of [line.label, ...(line.aliases ?? [])]) {
      const key = comparable(name);
      if (!named.has(key)) named.set(key, line);
    }
  }
  return named;
})();

/**
 * The line a name means, as a person or a model writes it: any case, with or without "(Loss)", by its name or
 * a common alias ("revenue", "Net income", "operating income"); undefined for a name the catalog lacks.
 */
export function findLine(name: string): CatalogLine | undefined {
  return BY_NAME.get(comparable(name));
}

/** Every line's name, for a message listing what can be asked for. */
export function lineNames(statement?: StatementKind): string[] {
  return (statement ? linesOf(statement) : LINES).map((line) => line.label);
}
