// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The macro series catalog (src/fork/data/catalog/series.ts), offline: every name the skills, agents and tool
 * texts ask macro_series for is a series' own name, found first and exactly; names and other names are unique
 * however they are spelled; keys are what macro_series' key pattern takes and never name a price series; and a
 * search finds the series a category word or a code means.
 */
import { describe, expect, test } from "bun:test";
import { PRICE_SERIES, PRICE_SERIES_FAMILIES } from "../../../src/fork/data/catalog/instruments.js";
import {
  catalogByCode,
  catalogSeries,
  exactName,
  namesOf,
  SERIES,
  searchCatalog,
} from "../../../src/fork/data/catalog/series.js";
import { parseListing } from "../../../src/fork/data/listings.js";

/** macro_series' own key pattern (src/tools/macro.ts): a key it reads without a search. */
const MACRO_KEY = /^(series:)?[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/**
 * The names the skills, agents and tool texts ask for (specs/skills/*, specs/agents/*, src/tools/macro.ts,
 * src/tools/series.ts, src/tools/valuation.ts), with the series each must be.
 */
const ASKED: Readonly<Record<string, string>> = {
  CPI: "us.fred.cpiaucsl",
  "core CPI": "us.fred.cpilfesl",
  "unemployment rate": "us.fred.unrate",
  UNRATE: "us.fred.unrate",
  payrolls: "us.fred.payems",
  "nonfarm payrolls": "us.fred.payems",
  GDP: "us.fred.gdpc1",
  "10-year Treasury yield": "us.treasury.par_10y",
  "Treasury bill yield": "us.treasury.par_3m",
  "3-month Treasury bill yield": "us.treasury.par_3m",
  "2-year Treasury yield": "us.treasury.par_2y",
  "effective federal funds rate": "us.nyfed.effr",
  "fed funds rate": "us.nyfed.effr",
  "fed funds": "us.nyfed.effr",
  SOFR: "us.nyfed.sofr",
  "10-year breakeven inflation": "us.treasury.breakeven_10y",
  "2s10s spread": "us.treasury.spread_10y_2y",
  "ECB deposit facility rate": "ea.ecb.dfr",
};

describe("the names asked for", () => {
  for (const [name, key] of Object.entries(ASKED)) {
    test(`"${name}" names ${key} exactly, first, in any case`, () => {
      for (const spelling of [name, name.toLowerCase(), name.toUpperCase(), ` ${name} `]) {
        const [first] = searchCatalog(spelling);
        expect(first?.entry.key, spelling).toBe(key);
        expect(first?.exact, spelling).toBe(true);
      }
    });
  }

  test("a canonical name is the series' own name, never another name of it", () => {
    for (const name of [
      "CPI",
      "core CPI",
      "unemployment rate",
      "payrolls",
      "GDP",
      "10-year Treasury yield",
    ]) {
      expect(catalogSeries(ASKED[name] as string)?.name).toBe(name);
    }
    expect(catalogSeries("us.treasury.par_3m")?.name).toBe("Treasury bill yield");
    expect(catalogSeries("us.nyfed.effr")?.name).toBe("effective federal funds rate");
  });

  test("spelled without punctuation, with U.S. before it, or as a key, a name still names its series", () => {
    expect(searchCatalog("10 year treasury yield")[0]?.entry.key).toBe("us.treasury.par_10y");
    expect(searchCatalog("U.S. CPI")[0]).toMatchObject({ exact: true, entry: { key: "us.fred.cpiaucsl" } });
    expect(searchCatalog("US unemployment rate")[0]?.exact).toBe(true);
    expect(searchCatalog("series:us.fred.cpiaucsl")[0]).toMatchObject({ exact: true });
    expect(searchCatalog("SERIES:US.TREASURY.PAR_10Y")[0]).toMatchObject({
      exact: true,
      entry: { key: "us.treasury.par_10y" },
    });
  });

  test("FRED's code for nominal GDP is not taken from GDP, which is real GDP here", () => {
    expect(searchCatalog("GDP")[0]?.entry.key).toBe("us.fred.gdpc1");
    expect(catalogByCode("GDP")?.key).toBe("us.fred.gdp");
    expect(searchCatalog("nominal GDP")[0]?.entry.key).toBe("us.fred.gdp");
  });

  test("the codes FRED gives the Treasury's own series name the Treasury's", () => {
    expect(catalogByCode("DGS10")?.key).toBe("us.treasury.par_10y");
    expect(catalogByCode("dgs3mo")?.key).toBe("us.treasury.par_3m");
    expect(catalogByCode("T10YIE")?.key).toBe("us.treasury.breakeven_10y");
    expect(catalogByCode("T10Y2Y")?.key).toBe("us.treasury.spread_10y_2y");
    expect(catalogByCode("CPIAUCSL")?.key).toBe("us.fred.cpiaucsl");
    expect(catalogByCode("ECBDFR")?.key).toBe("ea.ecb.dfr");
    expect(catalogByCode("EFFR")?.key).toBe("us.nyfed.effr");
    expect(catalogByCode("NOSUCHCODE")).toBeUndefined();
  });

  test("a name that is not one of FRED's codes never stands for one: FRED's PCE is spending, not the price index", () => {
    expect(catalogByCode("PCE")).toBeUndefined();
    expect(catalogByCode("NFP")).toBeUndefined();
    expect(searchCatalog("PCE").some((match) => match.exact)).toBe(false);
    expect(searchCatalog("PCE")[0]?.entry.key).toBe("us.fred.pcepi");
  });
});

describe("the catalog's names and keys", () => {
  test("every name and other name is one series' only, however it is spelled", () => {
    const owners = new Map<string, string>();
    const clashes: string[] = [];
    for (const entry of SERIES) {
      for (const name of namesOf(entry)) {
        const form = exactName(name);
        const owner = owners.get(form);
        if (owner && owner !== entry.key) clashes.push(`${name}: ${owner} and ${entry.key}`);
        owners.set(form, owners.get(form) ?? entry.key);
      }
    }
    // The one deliberate clash: FRED's code GDP, nominal GDP's at FRED, is real GDP's name here.
    expect(clashes).toEqual(["GDP: us.fred.gdpc1 and us.fred.gdp"]);
  });

  test("every key is lower case, `<area>.<publisher>.<code>`, read by macro_series without a search, and unique", () => {
    const keys = SERIES.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key, key).toMatch(MACRO_KEY);
      expect(`series:${key}`, key).toMatch(MACRO_KEY);
      expect(key.split("."), key).toHaveLength(3);
      expect(key.split(".")[1], key).toBe(
        (SERIES.find((entry) => entry.key === key)?.origin.publisher ?? "") as string,
      );
    }
  });

  test("no key is a price series' key or in a price series' family, so the price tools send it to macro_series", () => {
    for (const entry of SERIES) {
      expect(PRICE_SERIES[entry.key], entry.key).toBeUndefined();
      expect(PRICE_SERIES_FAMILIES.has(entry.key.split(".")[1] ?? ""), entry.key).toBe(false);
      expect(parseListing(`series:${entry.key}`).kind, entry.key).toBe("value_series");
    }
  });

  test("every series has a unit macro_series compares by, and a period kind it reads", () => {
    for (const entry of SERIES) {
      expect(
        ["percent", "percentage_points", "index", "index_points", "currency", "count", "quantity", "ratio"],
        entry.key,
      ).toContain(entry.unit.kind);
      // macro_series compares month, quarter, half_year and year by date; never calendar_year.
      expect(["calendar_day", "week", "month", "quarter", "half_year", "year"], entry.key).toContain(
        entry.period,
      );
      expect(entry.as_published.unit, entry.key).toBeTruthy();
    }
  });

  test("rates and yields are percents, spreads percentage points, so their changes read as points", () => {
    const kinds = Object.fromEntries(SERIES.map((entry) => [entry.key, entry.unit.kind]));
    expect(kinds).toMatchObject({
      "us.treasury.par_10y": "percent",
      "us.treasury.par_3m": "percent",
      "us.treasury.real_10y": "percent",
      "us.treasury.breakeven_10y": "percent",
      "us.treasury.spread_10y_2y": "percentage_points",
      "us.nyfed.effr": "percent",
      "ea.ecb.dfr": "percent",
      "us.fred.unrate": "percent",
      "us.fred.cpiaucsl": "index",
      "us.fred.payems": "count",
      "us.fred.gdpc1": "currency",
      "us.fred.bamlh0a0hym2": "percentage_points",
    });
  });
});

describe("a broader search", () => {
  const keys = (query: string) => searchCatalog(query).map((match) => match.entry.key);

  test("the category words the tool and the agents use each find series, headline ones first", () => {
    for (const word of [
      "inflation",
      "employment",
      "rates",
      "growth",
      "money",
      "sentiment",
      "housing",
      "labor",
      "central banks",
      "the yield curve",
      "credit",
    ]) {
      expect(keys(word).length, word).toBeGreaterThan(0);
      expect(
        searchCatalog(word).some((match) => match.exact),
        word,
      ).toBe(false);
    }
    expect(keys("inflation").slice(0, 2)).toEqual(["us.fred.cpiaucsl", "us.fred.cpilfesl"]);
    expect(keys("employment").slice(0, 2)).toEqual(["us.fred.unrate", "us.fred.payems"]);
    expect(keys("central banks")).toEqual([
      "us.nyfed.effr",
      "ea.ecb.dfr",
      "us.fred.fedfunds",
      "ea.ecb.mrr_fr",
      "ea.ecb.mlfr",
      "us.fred.irstcb01jpm156n",
      "us.fred.irstcb01inm156n",
    ]);
  });

  test("words in another order, or plurals, find the same series; a word no series has finds none", () => {
    expect(keys("treasury yields").slice(0, 3)).toEqual([
      "us.treasury.par_10y",
      "us.treasury.par_3m",
      "us.treasury.par_2y",
    ]);
    expect(keys("yield treasury 10-year")[0]).toBe("us.treasury.par_10y");
    expect(keys("breakevens")[0]).toBe("us.treasury.breakeven_10y");
    expect(keys("Japan GDP")).toEqual([]);
    expect(keys("")).toEqual([]);
  });

  test("a name the catalog holds is answered whole, never cut to a count", () => {
    const yields = searchCatalog("Treasury yield").filter((match) =>
      match.entry.key.startsWith("us.treasury.par_"),
    );
    expect(yields).toHaveLength(14);
  });
});
