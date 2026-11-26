// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The Global Industry Classification Standard's tree as revised in March 2023 (11 sectors, 25 industry groups,
 * 74 industries, 163 sub-industries), by name: which industry, industry group and sector each sub-industry
 * belongs to. Index lists name a company's sector and sub-industry; this tree gives the levels between them
 * and, where a list's sector contradicts its own sub-industry, the sector GICS places that sub-industry in
 * (Wikipedia's S&P 600 list keeps Mortgage REITs under Real Estate, where GICS had them until 2023).
 *
 * Names are matched as people write them: in any case, "&" or "and", with or without punctuation. A name that
 * is not one of the tree's (a sub-industry GICS retired, a misspelling) finds nothing.
 */
import type { SECTORS } from "../../../data/capabilities.js";

/** One sub-industry's place in the tree. */
export type GicsLevels = {
  sector: string;
  industry_group: string;
  industry: string;
  sub_industry: string;
};

type Industry = readonly [name: string, subIndustries: readonly string[]];
type Group = readonly [name: string, industries: readonly Industry[]];
type Sector = readonly [name: string, groups: readonly Group[]];

/** The tree, in GICS's order. */
const TREE: readonly Sector[] = [
  [
    "Energy",
    [
      [
        "Energy",
        [
          ["Energy Equipment & Services", ["Oil & Gas Drilling", "Oil & Gas Equipment & Services"]],
          [
            "Oil, Gas & Consumable Fuels",
            [
              "Integrated Oil & Gas",
              "Oil & Gas Exploration & Production",
              "Oil & Gas Refining & Marketing",
              "Oil & Gas Storage & Transportation",
              "Coal & Consumable Fuels",
            ],
          ],
        ],
      ],
    ],
  ],
  [
    "Materials",
    [
      [
        "Materials",
        [
          [
            "Chemicals",
            [
              "Commodity Chemicals",
              "Diversified Chemicals",
              "Fertilizers & Agricultural Chemicals",
              "Industrial Gases",
              "Specialty Chemicals",
            ],
          ],
          ["Construction Materials", ["Construction Materials"]],
          [
            "Containers & Packaging",
            ["Metal, Glass & Plastic Containers", "Paper & Plastic Packaging Products & Materials"],
          ],
          [
            "Metals & Mining",
            [
              "Aluminum",
              "Diversified Metals & Mining",
              "Copper",
              "Gold",
              "Precious Metals & Minerals",
              "Silver",
              "Steel",
            ],
          ],
          ["Paper & Forest Products", ["Forest Products", "Paper Products"]],
        ],
      ],
    ],
  ],
  [
    "Industrials",
    [
      [
        "Capital Goods",
        [
          ["Aerospace & Defense", ["Aerospace & Defense"]],
          ["Building Products", ["Building Products"]],
          ["Construction & Engineering", ["Construction & Engineering"]],
          ["Electrical Equipment", ["Electrical Components & Equipment", "Heavy Electrical Equipment"]],
          ["Industrial Conglomerates", ["Industrial Conglomerates"]],
          [
            "Machinery",
            [
              "Construction Machinery & Heavy Transportation Equipment",
              "Agricultural & Farm Machinery",
              "Industrial Machinery & Supplies & Components",
            ],
          ],
          ["Trading Companies & Distributors", ["Trading Companies & Distributors"]],
        ],
      ],
      [
        "Commercial & Professional Services",
        [
          [
            "Commercial Services & Supplies",
            [
              "Commercial Printing",
              "Environmental & Facilities Services",
              "Office Services & Supplies",
              "Diversified Support Services",
              "Security & Alarm Services",
            ],
          ],
          [
            "Professional Services",
            [
              "Human Resource & Employment Services",
              "Research & Consulting Services",
              "Data Processing & Outsourced Services",
            ],
          ],
        ],
      ],
      [
        "Transportation",
        [
          ["Air Freight & Logistics", ["Air Freight & Logistics"]],
          ["Passenger Airlines", ["Passenger Airlines"]],
          ["Marine Transportation", ["Marine Transportation"]],
          [
            "Ground Transportation",
            ["Rail Transportation", "Cargo Ground Transportation", "Passenger Ground Transportation"],
          ],
          [
            "Transportation Infrastructure",
            ["Airport Services", "Highways & Railtracks", "Marine Ports & Services"],
          ],
        ],
      ],
    ],
  ],
  [
    "Consumer Discretionary",
    [
      [
        "Automobiles & Components",
        [
          ["Automobile Components", ["Automotive Parts & Equipment", "Tires & Rubber"]],
          ["Automobiles", ["Automobile Manufacturers", "Motorcycle Manufacturers"]],
        ],
      ],
      [
        "Consumer Durables & Apparel",
        [
          [
            "Household Durables",
            [
              "Consumer Electronics",
              "Home Furnishings",
              "Homebuilding",
              "Household Appliances",
              "Housewares & Specialties",
            ],
          ],
          ["Leisure Products", ["Leisure Products"]],
          [
            "Textiles, Apparel & Luxury Goods",
            ["Apparel, Accessories & Luxury Goods", "Footwear", "Textiles"],
          ],
        ],
      ],
      [
        "Consumer Services",
        [
          [
            "Hotels, Restaurants & Leisure",
            ["Casinos & Gaming", "Hotels, Resorts & Cruise Lines", "Leisure Facilities", "Restaurants"],
          ],
          ["Diversified Consumer Services", ["Education Services", "Specialized Consumer Services"]],
        ],
      ],
      [
        "Consumer Discretionary Distribution & Retail",
        [
          ["Distributors", ["Distributors"]],
          ["Broadline Retail", ["Broadline Retail"]],
          [
            "Specialty Retail",
            [
              "Apparel Retail",
              "Computer & Electronics Retail",
              "Home Improvement Retail",
              "Other Specialty Retail",
              "Automotive Retail",
              "Homefurnishing Retail",
            ],
          ],
        ],
      ],
    ],
  ],
  [
    "Consumer Staples",
    [
      [
        "Consumer Staples Distribution & Retail",
        [
          [
            "Consumer Staples Distribution & Retail",
            ["Drug Retail", "Food Distributors", "Food Retail", "Consumer Staples Merchandise Retail"],
          ],
        ],
      ],
      [
        "Food, Beverage & Tobacco",
        [
          ["Beverages", ["Brewers", "Distillers & Vintners", "Soft Drinks & Non-alcoholic Beverages"]],
          ["Food Products", ["Agricultural Products & Services", "Packaged Foods & Meats"]],
          ["Tobacco", ["Tobacco"]],
        ],
      ],
      [
        "Household & Personal Products",
        [
          ["Household Products", ["Household Products"]],
          ["Personal Care Products", ["Personal Care Products"]],
        ],
      ],
    ],
  ],
  [
    "Health Care",
    [
      [
        "Health Care Equipment & Services",
        [
          ["Health Care Equipment & Supplies", ["Health Care Equipment", "Health Care Supplies"]],
          [
            "Health Care Providers & Services",
            [
              "Health Care Distributors",
              "Health Care Services",
              "Health Care Facilities",
              "Managed Health Care",
            ],
          ],
          ["Health Care Technology", ["Health Care Technology"]],
        ],
      ],
      [
        "Pharmaceuticals, Biotechnology & Life Sciences",
        [
          ["Biotechnology", ["Biotechnology"]],
          ["Pharmaceuticals", ["Pharmaceuticals"]],
          ["Life Sciences Tools & Services", ["Life Sciences Tools & Services"]],
        ],
      ],
    ],
  ],
  [
    "Financials",
    [
      ["Banks", [["Banks", ["Diversified Banks", "Regional Banks"]]]],
      [
        "Financial Services",
        [
          [
            "Financial Services",
            [
              "Diversified Financial Services",
              "Multi-Sector Holdings",
              "Specialized Finance",
              "Commercial & Residential Mortgage Finance",
              "Transaction & Payment Processing Services",
            ],
          ],
          ["Consumer Finance", ["Consumer Finance"]],
          [
            "Capital Markets",
            [
              "Asset Management & Custody Banks",
              "Investment Banking & Brokerage",
              "Diversified Capital Markets",
              "Financial Exchanges & Data",
            ],
          ],
          ["Mortgage Real Estate Investment Trusts (REITs)", ["Mortgage REITs"]],
        ],
      ],
      [
        "Insurance",
        [
          [
            "Insurance",
            [
              "Insurance Brokers",
              "Life & Health Insurance",
              "Multi-line Insurance",
              "Property & Casualty Insurance",
              "Reinsurance",
            ],
          ],
        ],
      ],
    ],
  ],
  [
    "Information Technology",
    [
      [
        "Software & Services",
        [
          ["IT Services", ["IT Consulting & Other Services", "Internet Services & Infrastructure"]],
          ["Software", ["Application Software", "Systems Software"]],
        ],
      ],
      [
        "Technology Hardware & Equipment",
        [
          ["Communications Equipment", ["Communications Equipment"]],
          ["Technology Hardware, Storage & Peripherals", ["Technology Hardware, Storage & Peripherals"]],
          [
            "Electronic Equipment, Instruments & Components",
            [
              "Electronic Equipment & Instruments",
              "Electronic Components",
              "Electronic Manufacturing Services",
              "Technology Distributors",
            ],
          ],
        ],
      ],
      [
        "Semiconductors & Semiconductor Equipment",
        [
          [
            "Semiconductors & Semiconductor Equipment",
            ["Semiconductor Materials & Equipment", "Semiconductors"],
          ],
        ],
      ],
    ],
  ],
  [
    "Communication Services",
    [
      [
        "Telecommunication Services",
        [
          [
            "Diversified Telecommunication Services",
            ["Alternative Carriers", "Integrated Telecommunication Services"],
          ],
          ["Wireless Telecommunication Services", ["Wireless Telecommunication Services"]],
        ],
      ],
      [
        "Media & Entertainment",
        [
          ["Media", ["Advertising", "Broadcasting", "Cable & Satellite", "Publishing"]],
          ["Entertainment", ["Movies & Entertainment", "Interactive Home Entertainment"]],
          ["Interactive Media & Services", ["Interactive Media & Services"]],
        ],
      ],
    ],
  ],
  [
    "Utilities",
    [
      [
        "Utilities",
        [
          ["Electric Utilities", ["Electric Utilities"]],
          ["Gas Utilities", ["Gas Utilities"]],
          ["Multi-Utilities", ["Multi-Utilities"]],
          ["Water Utilities", ["Water Utilities"]],
          [
            "Independent Power and Renewable Electricity Producers",
            ["Independent Power Producers & Energy Traders", "Renewable Electricity"],
          ],
        ],
      ],
    ],
  ],
  [
    "Real Estate",
    [
      [
        "Equity Real Estate Investment Trusts (REITs)",
        [
          ["Diversified REITs", ["Diversified REITs"]],
          ["Industrial REITs", ["Industrial REITs"]],
          ["Hotel & Resort REITs", ["Hotel & Resort REITs"]],
          ["Office REITs", ["Office REITs"]],
          ["Health Care REITs", ["Health Care REITs"]],
          ["Residential REITs", ["Multi-Family Residential REITs", "Single-Family Residential REITs"]],
          ["Retail REITs", ["Retail REITs"]],
          [
            "Specialized REITs",
            [
              "Other Specialized REITs",
              "Self-Storage REITs",
              "Telecom Tower REITs",
              "Timber REITs",
              "Data Center REITs",
            ],
          ],
        ],
      ],
      [
        "Real Estate Management & Development",
        [
          [
            "Real Estate Management & Development",
            [
              "Diversified Real Estate Activities",
              "Real Estate Operating Companies",
              "Real Estate Development",
              "Real Estate Services",
            ],
          ],
        ],
      ],
    ],
  ],
];

/** The 11 sectors' names, in GICS's order. */
export const GICS_SECTORS: readonly string[] = TREE.map(([name]) => name);

/** The sector each key of the screen tool's `sector` names (capabilities.ts SECTORS). */
export const SECTOR_NAMES: { readonly [Key in (typeof SECTORS)[number]]: string } = {
  energy: "Energy",
  materials: "Materials",
  industrials: "Industrials",
  consumer_discretionary: "Consumer Discretionary",
  consumer_staples: "Consumer Staples",
  health_care: "Health Care",
  financials: "Financials",
  information_technology: "Information Technology",
  communication_services: "Communication Services",
  utilities: "Utilities",
  real_estate: "Real Estate",
};

/** A name as compared: lower case, "&" read as "and", punctuation and runs of spaces as one space. */
function comparable(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const SUB_INDUSTRIES: ReadonlyMap<string, GicsLevels> = (() => {
  const found = new Map<string, GicsLevels>();
  for (const [sector, groups] of TREE) {
    for (const [group, industries] of groups) {
      for (const [industry, subs] of industries) {
        for (const sub of subs) {
          found.set(comparable(sub), { sector, industry_group: group, industry, sub_industry: sub });
        }
      }
    }
  }
  return found;
})();

const SECTORS_BY_NAME: ReadonlyMap<string, string> = new Map(
  GICS_SECTORS.map((name) => [comparable(name), name]),
);

/** The levels above a sub-industry, named as GICS names them; undefined for a name the tree does not hold. */
export function gicsOf(subIndustry: string): GicsLevels | undefined {
  return SUB_INDUSTRIES.get(comparable(subIndustry));
}

/** A sector's name as GICS writes it, from any spelling of it; undefined for a name that is not a sector. */
export function gicsSector(name: string): string | undefined {
  return SECTORS_BY_NAME.get(comparable(name));
}

/** How many sub-industries, industries and industry groups the tree holds (163, 74 and 25). */
export function gicsCounts(): { sectors: number; groups: number; industries: number; subIndustries: number } {
  const groups = TREE.flatMap(([, list]) => list);
  const industries = groups.flatMap(([, list]) => list);
  return {
    sectors: TREE.length,
    groups: groups.length,
    industries: industries.length,
    subIndustries: industries.flatMap(([, list]) => list).length,
  };
}
