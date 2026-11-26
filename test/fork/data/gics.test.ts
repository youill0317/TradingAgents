// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * GICS's tree as revised in March 2023 (catalog/gics.ts): its size, the levels above each sub-industry, names as
 * people write them, sub-industries whose sector moved in 2023, and every sub-industry the S&P list excerpts name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SECTORS } from "../../../src/data/capabilities.js";
import {
  GICS_SECTORS,
  gicsCounts,
  gicsOf,
  gicsSector,
  SECTOR_NAMES,
} from "../../../src/fork/data/catalog/gics.js";
import { parseSpList, SP_LISTS, wikitextOf } from "../../../src/fork/data/sources/wikipedia.js";
import { FIXTURES } from "./harness.js";

describe("GICS's tree", () => {
  test("11 sectors, 25 industry groups, 74 industries and 163 sub-industries", () => {
    expect(gicsCounts()).toEqual({ sectors: 11, groups: 25, industries: 74, subIndustries: 163 });
  });

  test("each sector the screen tool takes names one of GICS's", () => {
    expect(Object.keys(SECTOR_NAMES).sort()).toEqual([...SECTORS].sort());
    expect(Object.values(SECTOR_NAMES).sort()).toEqual([...GICS_SECTORS].sort());
  });

  test("the levels above a sub-industry", () => {
    expect(gicsOf("Semiconductors")).toEqual({
      sector: "Information Technology",
      industry_group: "Semiconductors & Semiconductor Equipment",
      industry: "Semiconductors & Semiconductor Equipment",
      sub_industry: "Semiconductors",
    });
    expect(gicsOf("Broadline Retail")).toEqual({
      sector: "Consumer Discretionary",
      industry_group: "Consumer Discretionary Distribution & Retail",
      industry: "Broadline Retail",
      sub_industry: "Broadline Retail",
    });
  });

  test("names in any case, with '&' or 'and', with or without punctuation", () => {
    for (const name of [
      "hotels resorts and cruise lines",
      "Hotels, Resorts & Cruise Lines",
      "HOTELS RESORTS & CRUISE LINES",
    ]) {
      expect(gicsOf(name)?.sub_industry).toBe("Hotels, Resorts & Cruise Lines");
    }
    expect(gicsOf("soft drinks & non alcoholic beverages")?.sector).toBe("Consumer Staples");
    expect(gicsOf("Multi-Line Insurance")?.industry).toBe("Insurance");
    expect(gicsSector("information technology")).toBe("Information Technology");
    expect(gicsSector("Health care")).toBe("Health Care");
    expect(gicsSector("Technology")).toBeUndefined();
  });

  test("sub-industries GICS moved in 2023 sit where it put them; retired names find nothing", () => {
    expect(gicsOf("Mortgage REITs")?.sector).toBe("Financials");
    expect(gicsOf("Data Processing & Outsourced Services")?.sector).toBe("Industrials");
    expect(gicsOf("Transaction & Payment Processing Services")?.industry).toBe("Financial Services");
    for (const retired of [
      "Trucking",
      "Internet & Direct Marketing Retail",
      "Hypermarkets & Super Centers",
    ]) {
      expect(gicsOf(retired)).toBeUndefined();
    }
  });

  test("every sub-industry the S&P list excerpts name is in the tree", () => {
    for (const list of SP_LISTS) {
      const body = JSON.parse(readFileSync(join(FIXTURES, `wikipedia/${list.key}-wikitext.json`), "utf8"));
      for (const company of parseSpList(list, wikitextOf(list, body)).companies) {
        expect([company.ticker, company.industry !== null]).toEqual([company.ticker, true]);
      }
    }
  });
});
