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
 *   term (`all`: total liabilities as liabilities and equity less equity and temporary equity). A term whose
 *   concepts overlap lists them in order, the first filed used alone (ShortTermBorrowings holds commercial
 *   paper, which some filers also file as CommercialPaper). The derivation is said beside the value.
 * - `additive` flows add up over time: a quarter can be computed from year-to-date or annual values (a second
 *   quarter as the first half less the first quarter, a fourth as the year less nine months). Per-share figures
 *   and share counts never are: they are served for a quarter only when a three-month value was filed.
 * - Units are "USD" (or the filer's reporting currency, "TWD", "EUR"), "<currency>/shares" for per-share
 *   figures, and "shares".
 * - `dart` lists OpenDART's account ids (account_id of fnlttSinglAcntAll.json, namespace included:
 *   "ifrs-full_Revenue", DART's own "dart_OperatingIncomeLoss"), tried in this order in each report, for Korean
 *   filers (providers/dart-statements.ts); `compute.dart` is a formula over them, and `notes` say what an id
 *   holds where that is not exactly the line's name. A member's breakdown (account_detail) and a row OpenDART
 *   marks "-표준계정코드 미사용-" (no standard id) are matched by no line.
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

/**
 * A term of a formula: a concept, or concepts tried in order, the first filed used alone (a later one is part of
 * an earlier one, filed by those who do not file the whole). An entry that is itself a list is the sum of those
 * of its concepts that are filed.
 */
export type FormulaTerm = string | readonly (string | readonly string[])[];

/** A value derived from other concepts when the line's own are not filed. */
export type LineFormula = {
  /** Terms added (and, for a difference, subtracted). */
  add: readonly FormulaTerm[];
  subtract?: readonly FormulaTerm[];
  /** Terms subtracted where filed and left out where not (temporary equity). */
  lessWhereFiled?: readonly FormulaTerm[];
  /** "any": the sum of the components filed, at least one; "all": every add and subtract term must be filed. */
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
  /** OpenDART's account ids, namespace included ("ifrs-full_Revenue", "dart_OperatingIncomeLoss"), in this order. */
  dart?: readonly string[];
  /** What a value from one of these concepts is, when that is not exactly what the line's name says. */
  notes?: Readonly<Record<string, string>>;
  /** A value derived from other concepts when none of the line's own is filed, per taxonomy. */
  compute?: { usGaap?: LineFormula; ifrs?: LineFormula; dart?: LineFormula };
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
    {
      aliases: ["revenues", "total revenue", "total revenues", "sales", "net sales"],
      dart: ["ifrs-full_Revenue"],
    },
  ),
  duration(
    "income_statement",
    "Cost of Revenue",
    ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"],
    ["CostOfSales"],
    { aliases: ["cost of sales", "cost of goods sold"], dart: ["ifrs-full_CostOfSales"] },
  ),
  duration("income_statement", "Gross Profit", ["GrossProfit"], ["GrossProfit"], {
    dart: ["ifrs-full_GrossProfit"],
  }),
  duration(
    "income_statement",
    "Research and Development",
    ["ResearchAndDevelopmentExpense"],
    ["ResearchAndDevelopmentExpense"],
    {
      aliases: ["research and development expense", "r&d"],
      dart: ["ifrs-full_ResearchAndDevelopmentExpense"],
    },
  ),
  duration(
    "income_statement",
    "Selling, General and Administrative",
    ["SellingGeneralAndAdministrativeExpense"],
    ["SellingGeneralAndAdministrativeExpense"],
    {
      aliases: ["sg&a", "selling general and administrative expense"],
      // 판매비와관리비: DART's own total of selling, general and administrative expenses.
      dart: [
        "dart_TotalSellingGeneralAdministrativeExpenses",
        "ifrs-full_SellingGeneralAndAdministrativeExpense",
      ],
    },
  ),
  duration(
    "income_statement",
    "General and Administrative",
    ["GeneralAndAdministrativeExpense"],
    ["GeneralAndAdministrativeExpense", "AdministrativeExpense"],
    {
      aliases: ["g&a", "administrative expense"],
      dart: ["ifrs-full_GeneralAndAdministrativeExpense", "ifrs-full_AdministrativeExpense"],
    },
  ),
  duration(
    "income_statement",
    "Operating Income (Loss)",
    ["OperatingIncomeLoss"],
    ["ProfitLossFromOperatingActivities"],
    {
      aliases: ["operating income", "operating profit", "income from operations"],
      // 영업이익: DART's own operating income, which Korean filers present on the face of the statement.
      dart: ["dart_OperatingIncomeLoss", "ifrs-full_ProfitLossFromOperatingActivities"],
    },
  ),
  duration(
    "income_statement",
    "Interest Expense",
    ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "InterestExpenseOperating"],
    ["FinanceCosts"],
    {
      dart: ["ifrs-full_InterestExpense", "ifrs-full_FinanceCosts"],
      notes: {
        InterestExpenseDebt: "interest on debt (InterestExpenseDebt)",
        InterestExpenseOperating: "interest expense classified as operating (InterestExpenseOperating)",
        FinanceCosts: "finance costs (ifrs-full FinanceCosts), interest and other costs of borrowing",
        "ifrs-full_FinanceCosts":
          "finance costs (ifrs-full_FinanceCosts): what the statement classifies as finance costs, interest among them",
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
    {
      aliases: ["pretax income", "income before income taxes", "income before taxes"],
      dart: ["ifrs-full_ProfitLossBeforeTax"],
    },
  ),
  duration(
    "income_statement",
    "Income Tax Expense (Benefit)",
    ["IncomeTaxExpenseBenefit"],
    ["IncomeTaxExpenseContinuingOperations"],
    {
      aliases: ["income tax expense", "income taxes", "provision for income taxes"],
      dart: ["ifrs-full_IncomeTaxExpenseContinuingOperations"],
    },
  ),
  // Separate statements (OpenDART's OFS) attribute nothing apart to the parent's owners: their whole profit is
  // read, and said.
  duration(
    "income_statement",
    "Net Income (Loss)",
    ["NetIncomeLoss"],
    ["ProfitLossAttributableToOwnersOfParent"],
    {
      aliases: ["net income", "net earnings", "net profit", "earnings"],
      dart: ["ifrs-full_ProfitLossAttributableToOwnersOfParent", "ifrs-full_ProfitLoss"],
      notes: {
        "ifrs-full_ProfitLoss":
          "the whole profit or loss (ifrs-full_ProfitLoss): the statement gives no share attributable to the parent's owners",
      },
    },
  ),
  duration(
    "income_statement",
    "Net Income (Loss) Including Noncontrolling Interests",
    ["ProfitLoss"],
    ["ProfitLoss"],
    {
      aliases: ["net income including noncontrolling interests", "profit or loss"],
      dart: ["ifrs-full_ProfitLoss"],
    },
  ),
  duration("income_statement", "EPS (Basic)", ["EarningsPerShareBasic"], ["BasicEarningsLossPerShare"], {
    unit: "per_share",
    additive: false,
    aliases: ["basic eps", "eps basic", "earnings per share basic"],
    dart: ["ifrs-full_BasicEarningsLossPerShare"],
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
      dart: ["ifrs-full_DilutedEarningsLossPerShare"],
      notes: { EarningsPerShareBasicAndDiluted: "basic and diluted alike (EarningsPerShareBasicAndDiluted)" },
    },
  ),
  duration(
    "income_statement",
    "Weighted Average Shares (Diluted)",
    ["WeightedAverageNumberOfDilutedSharesOutstanding"],
    ["AdjustedWeightedAverageShares"],
    {
      unit: "shares",
      additive: false,
      aliases: ["diluted shares", "weighted average diluted shares"],
      dart: ["ifrs-full_AdjustedWeightedAverageShares"],
    },
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
      dart: ["ifrs-full_CashAndCashEquivalents"],
      notes: {
        CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents:
          "includes restricted cash (CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents)",
      },
    },
  ),
  instant("Short-Term Investments", ["ShortTermInvestments", "MarketableSecuritiesCurrent"], [], {
    aliases: ["marketable securities"],
    // 단기금융상품: deposits and other short-term financial instruments that are not cash equivalents.
    dart: ["dart_ShortTermDepositsNotClassifiedAsCashEquivalents"],
    notes: {
      dart_ShortTermDepositsNotClassifiedAsCashEquivalents:
        "short-term financial instruments, deposits among them, not classified as cash equivalents (dart_ShortTermDepositsNotClassifiedAsCashEquivalents)",
    },
  }),
  instant(
    "Accounts Receivable",
    ["AccountsReceivableNetCurrent"],
    ["TradeAndOtherCurrentReceivables", "CurrentTradeReceivables"],
    {
      aliases: ["receivables"],
      dart: [
        "ifrs-full_TradeAndOtherCurrentReceivables",
        "ifrs-full_CurrentTradeReceivables",
        "dart_ShortTermTradeReceivable",
      ],
      notes: {
        CurrentTradeReceivables: "trade receivables only (CurrentTradeReceivables)",
        "ifrs-full_CurrentTradeReceivables": "trade receivables only (ifrs-full_CurrentTradeReceivables)",
        dart_ShortTermTradeReceivable: "trade receivables only (dart_ShortTermTradeReceivable)",
      },
    },
  ),
  instant("Inventory", ["InventoryNet"], ["Inventories"], {
    aliases: ["inventories"],
    dart: ["ifrs-full_Inventories"],
  }),
  instant("Total Current Assets", ["AssetsCurrent"], ["CurrentAssets"], {
    aliases: ["current assets"],
    dart: ["ifrs-full_CurrentAssets"],
  }),
  instant(
    "Property, Plant and Equipment, Net",
    ["PropertyPlantAndEquipmentNet"],
    ["PropertyPlantAndEquipment", "PropertyPlantAndEquipmentIncludingRightofuseAssets"],
    {
      aliases: ["pp&e", "property plant and equipment"],
      dart: [
        "ifrs-full_PropertyPlantAndEquipment",
        "ifrs-full_PropertyPlantAndEquipmentIncludingRightofuseAssets",
      ],
      notes: {
        PropertyPlantAndEquipmentIncludingRightofuseAssets:
          "includes right-of-use assets (PropertyPlantAndEquipmentIncludingRightofuseAssets)",
        "ifrs-full_PropertyPlantAndEquipmentIncludingRightofuseAssets":
          "includes right-of-use assets (ifrs-full_PropertyPlantAndEquipmentIncludingRightofuseAssets)",
      },
    },
  ),
  instant("Goodwill", ["Goodwill"], ["Goodwill"], { dart: ["ifrs-full_Goodwill"] }),
  instant("Total Assets", ["Assets"], ["Assets"], { aliases: ["assets"], dart: ["ifrs-full_Assets"] }),
  instant(
    "Accounts Payable",
    ["AccountsPayableCurrent"],
    ["TradeAndOtherCurrentPayables", "TradeAndOtherCurrentPayablesToTradeSuppliers"],
    {
      aliases: ["payables"],
      // 매입채무 is dart_ShortTermTradePayables in DART's balance-sheet template (beside dart_ShortTermTradeReceivable).
      dart: [
        "ifrs-full_TradeAndOtherCurrentPayables",
        "ifrs-full_TradeAndOtherCurrentPayablesToTradeSuppliers",
        "dart_ShortTermTradePayables",
      ],
      notes: {
        TradeAndOtherCurrentPayablesToTradeSuppliers:
          "payables to trade suppliers only (TradeAndOtherCurrentPayablesToTradeSuppliers)",
        "ifrs-full_TradeAndOtherCurrentPayablesToTradeSuppliers":
          "payables to trade suppliers only (ifrs-full_TradeAndOtherCurrentPayablesToTradeSuppliers)",
        dart_ShortTermTradePayables: "trade payables only (dart_ShortTermTradePayables)",
      },
    },
  ),
  // Short-term borrowings hold the commercial paper some filers also file on its own (Walmart filed both,
  // 1,506,000,000 each, at 2009-01-31), and the current portion of long-term borrowings holds the bonds' (TSMC's
  // liabilities arising from financing activities add up with it alone): each part is read only where its whole
  // is not filed.
  instant("Short-Term Debt", ["DebtCurrent"], ["CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings"], {
    aliases: ["current debt"],
    dart: ["ifrs-full_CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings"],
    compute: {
      usGaap: { add: ["LongTermDebtCurrent", ["ShortTermBorrowings", "CommercialPaper"]], needs: "any" },
      ifrs: {
        add: [
          "ShorttermBorrowings",
          [
            "CurrentPortionOfLongtermBorrowings",
            "CurrentBondsIssuedAndCurrentPortionOfNoncurrentBondsIssued",
          ],
        ],
        needs: "any",
      },
      // 단기차입금, and the current portion of long-term debt: DART's template files 유동성장기차입금
      // (ifrs-full_CurrentPortionOfLongtermBorrowings) and 유동성사채 (dart_CurrentPortionOfBonds) apart, so
      // they add up; the ifrs-full element of current bonds is read where neither is filed.
      dart: {
        add: [
          "ifrs-full_ShorttermBorrowings",
          [
            ["ifrs-full_CurrentPortionOfLongtermBorrowings", "dart_CurrentPortionOfBonds"],
            "ifrs-full_CurrentBondsIssuedAndCurrentPortionOfNoncurrentBondsIssued",
          ],
        ],
        needs: "any",
      },
    },
  }),
  instant("Total Current Liabilities", ["LiabilitiesCurrent"], ["CurrentLiabilities"], {
    aliases: ["current liabilities"],
    dart: ["ifrs-full_CurrentLiabilities"],
  }),
  instant("Long-Term Debt", ["LongTermDebtNoncurrent"], [], {
    aliases: ["long term debt"],
    compute: {
      ifrs: { add: ["LongtermBorrowings", "NoncurrentPortionOfNoncurrentBondsIssued"], needs: "any" },
      // 장기차입금 (DART's template: dart_LongTermBorrowingsGross) and 사채 (bonds, dart_BondsIssued), among
      // noncurrent liabilities.
      dart: {
        add: [
          ["ifrs-full_LongtermBorrowings", "dart_LongTermBorrowingsGross"],
          ["ifrs-full_NoncurrentPortionOfNoncurrentBondsIssued", "dart_BondsIssued"],
        ],
        needs: "any",
      },
    },
  }),
  // Equity including noncontrolling interests leaves out temporary equity (redeemable shares and noncontrolling
  // interests), which liabilities and equity hold: it is subtracted too where filed, as its total or its parts.
  instant("Total Liabilities", ["Liabilities"], ["Liabilities"], {
    aliases: ["liabilities"],
    dart: ["ifrs-full_Liabilities"],
    compute: {
      usGaap: {
        add: ["LiabilitiesAndStockholdersEquity"],
        subtract: ["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
        lessWhereFiled: [
          [
            "TemporaryEquityCarryingAmountIncludingPortionAttributableToNoncontrollingInterest",
            [
              "TemporaryEquityCarryingAmountAttributableToParent",
              "RedeemableNoncontrollingInterestEquityCarryingAmount",
            ],
          ],
        ],
        needs: "all",
      },
      ifrs: { add: ["EquityAndLiabilities"], subtract: ["Equity"], needs: "all" },
      dart: { add: ["ifrs-full_EquityAndLiabilities"], subtract: ["ifrs-full_Equity"], needs: "all" },
    },
  }),
  // Separate statements (OpenDART's OFS) attribute no equity apart to the parent's owners: their whole equity is
  // read, and said.
  instant("Stockholders' Equity", ["StockholdersEquity"], ["EquityAttributableToOwnersOfParent"], {
    aliases: ["shareholders equity", "stockholders equity", "equity attributable to parent"],
    dart: ["ifrs-full_EquityAttributableToOwnersOfParent", "ifrs-full_Equity"],
    notes: {
      "ifrs-full_Equity":
        "the whole equity (ifrs-full_Equity): the statement gives no share attributable to the parent's owners",
    },
  }),
  instant(
    "Total Equity",
    ["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
    ["Equity"],
    {
      aliases: ["equity"],
      dart: ["ifrs-full_Equity"],
    },
  ),
  instant("Total Liabilities and Equity", ["LiabilitiesAndStockholdersEquity"], ["EquityAndLiabilities"], {
    aliases: ["liabilities and equity"],
    dart: ["ifrs-full_EquityAndLiabilities"],
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
      dart: ["ifrs-full_CashFlowsFromUsedInOperatingActivities"],
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
      dart: [
        "ifrs-full_AdjustmentsForDepreciationAndAmortisationExpense",
        "ifrs-full_DepreciationAndAmortisationExpense",
        "ifrs-full_AdjustmentsForDepreciationExpense",
        "ifrs-full_DepreciationExpense",
      ],
      notes: {
        DepreciationAmortizationAndAccretionNet:
          "includes accretion (DepreciationAmortizationAndAccretionNet)",
        DepreciationExpense: "depreciation alone (ifrs-full DepreciationExpense)",
        "ifrs-full_AdjustmentsForDepreciationExpense":
          "depreciation alone (ifrs-full_AdjustmentsForDepreciationExpense)",
        "ifrs-full_DepreciationExpense": "depreciation alone (ifrs-full_DepreciationExpense)",
      },
      // DART's cash-flow template adds back 감가상각비 and 무형자산상각비 apart.
      compute: {
        dart: {
          add: ["dart_AdjustmentsForDepreciationExpense", "dart_AdjustmentsForAmortisationExpense"],
          needs: "any",
        },
      },
    },
  ),
  duration(
    "cash_flow",
    "Share-Based Compensation",
    ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"],
    ["AdjustmentsForSharebasedPayments"],
    {
      aliases: ["stock-based compensation", "stock based compensation", "sbc"],
      dart: ["ifrs-full_AdjustmentsForSharebasedPayments"],
    },
  ),
  // 유형자산의 취득 (ifrs-full), and the PaymentsToAcquirePropertyPlantAndEquipment tag in either namespace.
  duration(
    "cash_flow",
    "Payments to Acquire PP&E",
    ["PaymentsToAcquirePropertyPlantAndEquipment"],
    ["PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"],
    {
      aliases: ["capital expenditure", "capital expenditures", "capex"],
      dart: [
        "ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
        "ifrs-full_PaymentsToAcquirePropertyPlantAndEquipment",
        "dart_PaymentsToAcquirePropertyPlantAndEquipment",
      ],
    },
  ),
  duration(
    "cash_flow",
    "Payments to Acquire Productive Assets",
    ["PaymentsToAcquireProductiveAssets"],
    [
      "PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets",
    ],
    {
      dart: [
        "ifrs-full_PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets",
      ],
      notes: {
        PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets:
          "property, plant and equipment, intangible assets and other noncurrent assets together",
        "ifrs-full_PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets":
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
    {
      aliases: ["investing cash flow", "cash from investing"],
      dart: ["ifrs-full_CashFlowsFromUsedInInvestingActivities"],
    },
  ),
  duration(
    "cash_flow",
    "Net Cash from Financing Activities",
    [
      "NetCashProvidedByUsedInFinancingActivities",
      "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations",
    ],
    ["CashFlowsFromUsedInFinancingActivities"],
    {
      aliases: ["financing cash flow", "cash from financing"],
      dart: ["ifrs-full_CashFlowsFromUsedInFinancingActivities"],
    },
  ),
  duration(
    "cash_flow",
    "Dividends Paid",
    ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock", "PaymentsOfOrdinaryDividends"],
    ["DividendsPaidClassifiedAsFinancingActivities", "DividendsPaid"],
    {
      aliases: ["dividends"],
      dart: ["ifrs-full_DividendsPaidClassifiedAsFinancingActivities", "ifrs-full_DividendsPaid"],
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
    {
      aliases: ["buybacks", "share repurchases", "stock repurchases"],
      // 자기주식의 취득: dart_AcquisitionOfTreasuryShares in DART's cash-flow template.
      dart: [
        "ifrs-full_PaymentsToAcquireOrRedeemEntitysShares",
        "ifrs-full_PurchaseOfTreasuryShares",
        "dart_AcquisitionOfTreasuryShares",
      ],
    },
  ),
  duration(
    "cash_flow",
    "Interest Paid, Excluding Capitalized Interest, Operating Activities",
    ["InterestPaidNet"],
    ["InterestPaidClassifiedAsOperatingActivities"],
    { aliases: ["interest paid"], dart: ["ifrs-full_InterestPaidClassifiedAsOperatingActivities"] },
  ),
  // Kept apart from the line above: interest a filer classifies as financing is not in its operating cash
  // flow, so the dcf tool (which adds after-tax interest paid back to operating cash flow) must not read it.
  duration(
    "cash_flow",
    "Interest Paid, Financing Activities",
    [],
    ["InterestPaidClassifiedAsFinancingActivities"],
    { dart: ["ifrs-full_InterestPaidClassifiedAsFinancingActivities"] },
  ),
  duration(
    "cash_flow",
    "Income Taxes Paid",
    ["IncomeTaxesPaidNet"],
    [
      "IncomeTaxesPaidRefundClassifiedAsOperatingActivities",
      "IncomeTaxesPaidClassifiedAsOperatingActivities",
    ],
    {
      aliases: ["taxes paid", "cash taxes"],
      dart: [
        "ifrs-full_IncomeTaxesPaidRefundClassifiedAsOperatingActivities",
        "ifrs-full_IncomeTaxesPaidClassifiedAsOperatingActivities",
      ],
    },
  ),
];

/** The lines of one statement, in the order it shows them. */
export function linesOf(statement: StatementKind): CatalogLine[] {
  return LINES.filter((line) => line.statement === statement);
}

/** The concepts of formula terms, each once, in order. */
function termConcepts(terms: readonly FormulaTerm[]): string[] {
  return [...new Set(terms.flatMap((term) => (typeof term === "string" ? [term] : term.flat())))];
}

/**
 * Every concept a formula reads; `required` leaves out the terms subtracted only where filed, whose filing alone
 * gives no value.
 */
export function formulaConcepts(formula: LineFormula | undefined, required = false): string[] {
  if (!formula) return [];
  return termConcepts([
    ...formula.add,
    ...(formula.subtract ?? []),
    ...(required ? [] : (formula.lessWhereFiled ?? [])),
  ]);
}

/** Every concept a line may be read from, per taxonomy (its own, its formula's, and dei's). */
export function conceptsOf(line: CatalogLine): { usGaap: string[]; ifrs: string[]; dei: string[] } {
  return {
    usGaap: [...line.usGaap, ...formulaConcepts(line.compute?.usGaap)],
    ifrs: [...line.ifrs, ...formulaConcepts(line.compute?.ifrs)],
    dei: line.dei ? [line.dei] : [],
  };
}

/** A formula's value, with each concept it used and what was filed for it. */
export type FormulaValue<T> = {
  value: number;
  added: (readonly [string, T])[];
  subtracted: (readonly [string, T])[];
};

/** What one term uses of what is filed: its first alternative filed, or of a sum the concepts filed. */
function termValue<T>(
  term: FormulaTerm,
  filed: (concept: string) => T | undefined,
): (readonly [string, T])[] {
  for (const alternative of typeof term === "string" ? [term] : term) {
    const parts: (readonly [string, T])[] = [];
    for (const concept of typeof alternative === "string" ? [alternative] : alternative) {
      const found = filed(concept);
      if (found !== undefined) parts.push([concept, found]);
    }
    if (parts.length) return parts;
  }
  return [];
}

/**
 * A formula's value from what is filed for each concept (`filed` gives undefined where nothing is), or undefined
 * when what it needs is not filed.
 */
export function evaluateFormula<T>(
  formula: LineFormula,
  filed: (concept: string) => T | undefined,
  amountOf: (found: T) => number,
): FormulaValue<T> | undefined {
  const added = formula.add.map((term) => termValue(term, filed));
  const subtracted = (formula.subtract ?? []).map((term) => termValue(term, filed));
  const complete =
    formula.needs === "any"
      ? added.some((parts) => parts.length > 0)
      : [...added, ...subtracted].every((parts) => parts.length > 0);
  if (!complete) return undefined;
  const plus = added.flat();
  const less = [
    ...subtracted,
    ...(formula.lessWhereFiled ?? []).map((term) => termValue(term, filed)),
  ].flat();
  const sum = (list: readonly (readonly [string, T])[]) =>
    list.reduce((total, [, found]) => total + amountOf(found), 0);
  return { value: sum(plus) - sum(less), added: plus, subtracted: less };
}

/** How a formula's value was derived: "A + B", or "A less B and C". */
export function formulaWords(value: FormulaValue<unknown>): string {
  const added = value.added.map(([concept]) => concept).join(" + ");
  const less = value.subtracted.map(([concept]) => concept);
  if (!less.length) return added;
  const listed = less.length > 1 ? `${less.slice(0, -1).join(", ")} and ${less.at(-1)}` : less[0];
  return `${added} less ${listed}`;
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
