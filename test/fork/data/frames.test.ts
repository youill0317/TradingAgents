// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The frames provider's sector screens, through the real screen tool in a ToolRegistry (the harness): the text the
 * model reads, every field the tool reads supplied (the read check), and the rules the rows follow. On SEC's own
 * frames saved before (test/fork/fixtures/frames: SEC's answers trimmed to the rows of the saved samples, and,
 * where no frame was saved, frames assembled from SEC's companyfacts answers, marked hand-made), excerpts of
 * Wikipedia's S&P 500, 400 and 600 lists (test/fork/fixtures/wikipedia, CC BY-SA 4.0, attributed in their meta)
 * and the shared hand-made SEC ticker list. A frame these tests hold no fixture of is answered with SEC's own 404
 * page, as SEC answers a concept nobody filed for a period; the companies the excerpts name but the trimmed frames
 * leave out read as having no value, as a company SEC's frames lack would.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cases, trimmed } from "../../../scripts/fork/fixture-cases/frames.js";
import { USER_AGENT } from "../../../src/contracts/index.js";
import type { CrossSectionRow, SECTORS } from "../../../src/data/capabilities.js";
import { DataError } from "../../../src/data/errors.js";
import { createCache } from "../../../src/fork/data/cache.js";
import { forkDeps } from "../../../src/fork/data/deps.js";
import { Pacer } from "../../../src/fork/data/http.js";
import { framesProvider, MISSING, screenLine, UNIVERSE } from "../../../src/fork/data/providers/frames.js";
import { frameUrl } from "../../../src/fork/data/sources/sec-frames.js";
import { SEC_TICKERS_URL } from "../../../src/fork/data/sources/sec-tickers.js";
import { SP_LISTS, wikitextUrl } from "../../../src/fork/data/sources/wikipedia.js";
import {
  buildTools,
  FIXTURES,
  type FixtureRoute,
  fakeTimer,
  fixtureFetch,
  TEST_DAY,
  testDeps,
} from "./harness.js";

const UA = "Test Agent test@example.com";

/** Wikipedia's three lists, as the parse API answers them (excerpts). */
const WIKIPEDIA: FixtureRoute[] = SP_LISTS.map((list) => ({
  match: wikitextUrl(list.page),
  file: `wikipedia/${list.key}-wikitext.json`,
}));

const FILES: Readonly<Record<string, string>> = {
  Revenues: "revenues",
  RevenueFromContractWithCustomerExcludingAssessedTax: "rfcceat",
  Assets: "assets",
  NetIncomeLoss: "netincomeloss",
  Liabilities: "liabilities",
  LiabilitiesAndStockholdersEquity: "liabilities-and-equity",
  StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: "equity-including-nci",
  RedeemableNoncontrollingInterestEquityCarryingAmount: "redeemable-nci",
};

/** The frames these tests hold, by concept and period. */
const HELD: readonly (readonly [string, string])[] = [
  ["Revenues", "CY2023"],
  ["Revenues", "CY2024"],
  ["Revenues", "CY2025"],
  ["RevenueFromContractWithCustomerExcludingAssessedTax", "CY2023"],
  ["RevenueFromContractWithCustomerExcludingAssessedTax", "CY2024"],
  ["RevenueFromContractWithCustomerExcludingAssessedTax", "CY2025"],
  ["NetIncomeLoss", "CY2023"],
  ["NetIncomeLoss", "CY2024"],
  ["NetIncomeLoss", "CY2025"],
  ["Assets", "CY2023Q4I"],
  ["Assets", "CY2024Q1I"],
  ["Assets", "CY2024Q2I"],
  ["Assets", "CY2024Q3I"],
  ["Assets", "CY2024Q4I"],
  ["Liabilities", "CY2024Q4I"],
  ["LiabilitiesAndStockholdersEquity", "CY2024Q4I"],
  ["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "CY2024Q4I"],
  ["RedeemableNoncontrollingInterestEquityCarryingAmount", "CY2024Q4I"],
];

const FRAMES: FixtureRoute[] = HELD.map(([concept, period]) => ({
  match: frameUrl(concept, "USD", period),
  file: `frames/${FILES[concept]}-${period.toLowerCase()}.json`,
}));

/** Every other frame: SEC's 404 page for a frame it does not have. */
const NO_FRAME: FixtureRoute = {
  match: /^https:\/\/data\.sec\.gov\/api\/xbrl\/frames\//,
  file: "frames/no-such-frame.xml",
};

const TICKERS: FixtureRoute = { match: SEC_TICKERS_URL, file: "sec/company-tickers-exchange.json" };

const ROUTES: FixtureRoute[] = [...WIKIPEDIA, ...FRAMES, NO_FRAME, TICKERS];

const frames = (concept: string, ...periods: string[]) =>
  periods.map((period) => frameUrl(concept, "USD", period));
const REVENUE_TAGS = [
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "SalesRevenueNet",
  "RevenuesNetOfInterestExpense",
];

/** The frames provider alone, its tools (every answer behind the read check), what it asked, and its deps. */
function screen(routes: readonly FixtureRoute[] = ROUTES) {
  const { deps, fetch, timer } = testDeps({ secUserAgent: UA }, routes);
  const provider = framesProvider(deps);
  return { ...buildTools({ frames: provider }, { check: true }), provider, fetch, timer, deps };
}

/** One golden call: the text the model reads, every field the tool read supplied, no request unanswered. */
async function golden(input: Record<string, unknown>, expected: string) {
  const setup = screen();
  const run = await setup.runTool("screen", input);
  expect(run.failure).toBeUndefined();
  expect(run.text).toBe(expected);
  expect(run.reads.missing()).toEqual([]);
  expect(setup.fetch.unmatched).toEqual([]);
  return { run, ...setup };
}

/** The provider's own answer, for the rows the tool reduces to a ranking. */
async function rowsOf(
  query: { sector: (typeof SECTORS)[number]; line: string; fiscalYear: number },
  routes: readonly FixtureRoute[] = ROUTES,
) {
  const { provider, fetch } = screen(routes);
  const answer = await provider.capabilities.crossSections?.financials?.({
    ...query,
    maxPages: 20,
    knownAt: TEST_DAY,
  });
  if (!answer) throw new Error("no answer");
  const byTicker = (ticker: string) => answer.rows.find((row) => row.symbols.includes(ticker));
  return { answer, byTicker, fetch };
}

describe("sector screens as the model reads them", () => {
  test("a sector ranked by revenue: S&P 1500 members, the fiscal year ending in the year asked", async () => {
    const { fetch } = await golden(
      { sector: "information_technology", line: "revenue", fiscal_year: 2025 },
      GOLDEN.itRevenue,
    );
    // The three lists, one after another; then each revenue concept's two annual frames, in the catalog's order,
    // while some company has no value yet.
    expect(fetch.requests.map((request) => request.url)).toEqual([
      ...SP_LISTS.map((list) => wikitextUrl(list.page)),
      ...REVENUE_TAGS.flatMap((tag) => frames(tag, "CY2024", "CY2025")),
    ]);
    // SEC is sent SEC_USER_AGENT; Wikipedia the app's name, never the SEC User-Agent (it names a person).
    for (const request of fetch.requests) {
      expect(request.headers.get("user-agent")).toBe(request.url.includes("sec.gov") ? UA : USER_AGENT);
    }
  });

  test("a balance-sheet line at each company's fiscal year end, never a quarter's end the same frame holds", async () => {
    const { fetch, provider } = await golden(
      { sector: "information_technology", line: "total assets", fiscal_year: 2024 },
      GOLDEN.itAssets,
    );
    // The year ends from the annual frames of net income, then revenue; then the five instant frames around
    // the year's ends.
    expect(fetch.requests.map((request) => request.url).slice(3)).toEqual([
      ...frames("NetIncomeLoss", "CY2023", "CY2024"),
      ...REVENUE_TAGS.flatMap((tag) => frames(tag, "CY2023", "CY2024")),
      ...frames("Assets", "CY2023Q4I", "CY2024Q1I", "CY2024Q2I", "CY2024Q3I", "CY2024Q4I"),
    ]);
    const answer = await provider.capabilities.crossSections?.financials?.({
      sector: "information_technology",
      line: "Total Assets",
      fiscalYear: 2024,
      maxPages: 20,
    });
    const row = (ticker: string) => answer?.rows.find((one) => one.symbols.includes(ticker));
    // Apple's year ended 2024-09-28: its balance sheet then, from the frame of the third quarter's dates.
    expect(row("AAPL")).toMatchObject({
      value: 364_980_000_000,
      period_start: null,
      period_end: "2024-09-28",
    });
    // Skyworks' and Microsoft's years ended 2024-09-27 and 2024-06-30; the fourth quarter's frame holds their
    // quarterly reports' 2024-12-27 and 2024-12-31 balance sheets, which are not their fiscal years' ends.
    for (const ticker of ["SWKS", "MSFT"]) {
      expect(row(ticker)).toMatchObject({ value: null, missing_because: MISSING.notAtYearEnd });
    }
    // Western Digital's fiscal 2024 ended in June 2024, a period no frame here holds.
    expect(row("WDC")).toMatchObject({ value: null, missing_because: MISSING.noYearEnd });
  });

  test("ranked by change: the year before read as well, its universe said in the same words", async () => {
    const { run } = await golden(
      { sector: "industrials", line: "Revenue", fiscal_year: 2025, rank_by: "change" },
      GOLDEN.industrialsChange,
    );
    // Each year's read says why it is incomplete; both say it alike, so the tool's line reads one fact twice.
    expect((run.payload as { incomplete_because: string }).incomplete_because).toBe(
      `${UNIVERSE}; ${UNIVERSE}`,
    );
  });

  test("a line not filed as such is computed from the catalog's formula, said as the row's derivation", async () => {
    await golden(
      { sector: "consumer_staples", line: "Total Liabilities", fiscal_year: 2025 },
      GOLDEN.staplesLiabilities,
    );
    // Walmart's liabilities and equity less its equity and its redeemable noncontrolling interest (temporary
    // equity): 260,823,000,000 - 97,421,000,000 - 271,000,000, the sum of the liability lines it files.
    const { byTicker } = await rowsOf({
      sector: "consumer_staples",
      line: "Total Liabilities",
      fiscalYear: 2025,
    });
    expect(byTicker("WMT")).toMatchObject({ value: 163_131_000_000, period_end: "2025-01-31" });
  });
});

describe("the rows the provider answers", () => {
  test("each company's row as the contract has it: a value, or why there is none", async () => {
    const { answer, byTicker } = await rowsOf({
      sector: "information_technology",
      line: "Revenue",
      fiscalYear: 2025,
    });
    expect(byTicker("AAPL")).toEqual({
      ciks: ["0000320193"],
      name: "Apple Inc.",
      symbols: ["AAPL"],
      value: 416_161_000_000,
      unit: "USD",
      unit_group: "currency/USD/",
      period_start: "2024-09-29",
      period_end: "2025-09-27",
      derivation: "filed",
      missing_because: null,
      form: null,
      accession: "0000320193-26-000026",
    } satisfies CrossSectionRow);
    // Lam Research's fiscal 2025 ended in June 2025: SEC put it in the frame CY2024.
    expect(byTicker("LRCX")).toMatchObject({ period_start: "2024-07-01", period_end: "2025-06-29" });
    expect(byTicker("FORM")).toEqual({
      ciks: ["0001039399"],
      name: "FormFactor",
      symbols: ["FORM"],
      value: null,
      unit: null,
      unit_group: null,
      period_start: null,
      period_end: null,
      derivation: null,
      missing_because: MISSING.notInFrames,
      form: null,
      accession: null,
    });
    expect(answer).toMatchObject({
      pages: 1,
      complete: false,
      incomplete_because: `${UNIVERSE}; FORM on two lists, counted as S&P 400 (added there most recently)`,
      known_at: "2026-11-25T22:00:00Z",
    });
    // One row per company: the lists' 14 information technology members, sectors read from sub-industries
    // (Alarm.com and Insight Enterprises are listed under other sectors on the S&P 600 page).
    expect(answer.rows.map((row) => row.symbols.join("+")).sort()).toEqual([
      "AAPL",
      "ADI",
      "ALRM",
      "AMAT",
      "AMD",
      "EFOR",
      "FN",
      "FORM",
      "LRCX",
      "MSFT",
      "NSIT",
      "NSSC",
      "SWKS",
      "WDC",
    ]);
  });

  test("share classes of one CIK are one company, named without the class", async () => {
    const { byTicker, answer } = await rowsOf({
      sector: "communication_services",
      line: "Net Income",
      fiscalYear: 2025,
    });
    expect(byTicker("GOOG")).toMatchObject({
      ciks: ["0001652044"],
      name: "Alphabet Inc.",
      symbols: ["GOOGL", "GOOG"],
    });
    // Scholastic's sub-industry, Publishing, is Communication Services' (the S&P 600 page lists it elsewhere).
    expect(answer.rows.map((row) => row.symbols[0])).toEqual(["GOOGL", "SCHL"]);
  });

  test("a CIK the S&P 400 list does not give is found in SEC's ticker list by the company's ticker", async () => {
    // SEC's ticker list in its documented form, with Alcoa's row (hand-made for this test).
    const list = {
      fields: ["cik", "name", "ticker", "exchange"],
      data: [[1675149, "Alcoa Corp", "AA", "NYSE"]],
    };
    const routes = [
      ...WIKIPEDIA,
      ...FRAMES,
      NO_FRAME,
      { match: SEC_TICKERS_URL, body: JSON.stringify(list), headers: { "content-type": "application/json" } },
    ];
    const { byTicker } = await rowsOf({ sector: "materials", line: "Revenue", fiscalYear: 2025 }, routes);
    expect(byTicker("AA")).toMatchObject({
      ciks: ["0001675149"],
      value: null,
      missing_because: MISSING.notInFrames,
    });
    expect(byTicker("APD")).toMatchObject({ value: 12_037_300_000, period_end: "2025-09-30" });
    // AECOM is not in this list: it has no CIK, and says so.
    const industrials = await rowsOf({ sector: "industrials", line: "Revenue", fiscalYear: 2025 }, routes);
    expect(industrials.byTicker("ACM")).toMatchObject({
      ciks: [],
      value: null,
      missing_because: MISSING.noCik,
    });
  });

  test("line names as people and models write them; one the catalog lacks, or without a us-gaap concept, is invalid", () => {
    for (const name of [
      "Operating Income",
      "operating income (loss)",
      "OPERATING INCOME",
      "operating profit",
    ]) {
      expect(screenLine(name).label).toBe("Operating Income (Loss)");
    }
    expect(screenLine("revenue").label).toBe("Revenue");
    expect(screenLine("total assets").label).toBe("Total Assets");
    expect(screenLine("Net Income").label).toBe("Net Income (Loss)");
    const unknown = (() => {
      try {
        screenLine("EBITDA margin");
      } catch (error) {
        return error as DataError;
      }
    })();
    expect(unknown).toBeInstanceOf(DataError);
    expect(unknown?.kind).toBe("invalid");
    expect(unknown?.message).toStartWith(
      '"EBITDA margin" is not a statement line a screen reads. Lines: Revenue, ',
    );
    expect(unknown?.message).toContain("Total Assets");
    expect(() => screenLine("Interest Paid, Financing Activities")).toThrow(
      "Interest Paid, Financing Activities is not filed under a us-gaap concept SEC's frames hold.",
    );
  });

  test("an unknown line reaches the model as a request to change, naming the lines", async () => {
    const { runTool, fetch } = screen();
    const run = await runTool("screen", { sector: "energy", line: "EBITDA margin", fiscal_year: 2025 });
    expect(run.failure).toBe("data_invalid");
    expect(run.text).toContain('"EBITDA margin" is not a statement line a screen reads. Lines: Revenue, ');
    expect(fetch.requests).toEqual([]);
  });
});

describe("what is kept, and the time an answer is known at", () => {
  /** Deps whose engine clock and cache clock a test moves. */
  function moving() {
    const time = { engine: Date.parse(TEST_DAY), cache: Date.parse(TEST_DAY) };
    const fetch = fixtureFetch(ROUTES);
    const deps = forkDeps(
      { secUserAgent: UA },
      {
        fetch,
        clock: () => new Date(time.engine),
        timer: fakeTimer(),
        pacer: new Pacer(),
        cache: createCache({ now: () => time.cache }),
      },
    );
    const provider = framesProvider(deps);
    const read = () =>
      provider.capabilities.crossSections?.financials?.({
        sector: "information_technology",
        line: "Revenue",
        fiscalYear: 2025,
        maxPages: 20,
      }) as Promise<{ known_at: string | null }>;
    return { time, fetch, read };
  }
  const HOUR = 3_600_000;

  test("frames are kept a day and the lists a week; a kept frame is known as of when it was read", async () => {
    const { time, fetch, read } = moving();
    expect((await read()).known_at).toBe("2026-11-25T22:00:00Z");
    const first = fetch.requests.length;
    // Five hours later: everything comes from what was kept, known as of the first reading.
    time.engine += 5 * HOUR;
    time.cache += 5 * HOUR;
    expect((await read()).known_at).toBe("2026-11-25T22:00:00Z");
    expect(fetch.requests.length).toBe(first);
    // Two days later: the frames are read again, the lists are not.
    time.engine += 48 * HOUR;
    time.cache += 48 * HOUR;
    expect((await read()).known_at).toBe("2026-11-28T03:00:00Z");
    const again = fetch.requests.slice(first).map((request) => request.url);
    expect(again.some((url) => url.includes("wikipedia.org"))).toBe(false);
    expect(again).toHaveLength(REVENUE_TAGS.length * 2);
    // Past a week, the lists too.
    time.engine += 6 * 24 * HOUR;
    time.cache += 6 * 24 * HOUR;
    await read();
    const later = fetch.requests.slice(first + again.length).map((request) => request.url);
    expect(later.filter((url) => url.includes("wikipedia.org"))).toHaveLength(3);
  });
});

describe("the recorder's cases (scripts/fork/fixture-cases/frames.ts), over a fixture fetch", () => {
  test("every frame the tests read is a case, and SEC's 404 page for a frame it does not have", () => {
    const files = cases.map((one) => one.file);
    for (const route of FRAMES) expect(files).toContain(route.file?.replace("frames/", ""));
    expect(cases.find((one) => one.name === "no-such-frame")).toMatchObject({
      accept: [404],
      file: "no-such-frame.xml",
    });
  });

  test("a frame keeps SEC's header and the rows of the companies the lists name, with SEC's first rows", async () => {
    const saved = JSON.parse(readFileSync(join(FIXTURES, "frames/revenues-cy2024.json"), "utf8"));
    const kept = trimmed(saved, new Set([320193, 1067983])) as { pts: number; data: { cik: number }[] };
    expect(kept.pts).toBe(2514);
    expect(kept.data.map((row) => row.cik)).toEqual([
      ...saved.data.slice(0, 10).map((row: { cik: number }) => row.cik),
      1067983,
    ]);
    // A case reads its frame through the HTTP client (SEC_USER_AGENT sent) and records the rows the tests read.
    const { deps, fetch } = testDeps({ secUserAgent: UA }, FRAMES);
    const recorded = await cases[1]?.read?.(deps.http, {} as never);
    expect(fetch.requests.map((request) => [request.url, request.headers.get("user-agent")])).toEqual([
      [frameUrl("Revenues", "USD", "CY2024"), UA],
    ]);
    const body = JSON.parse(recorded?.body as string) as { data: { cik: number }[] };
    // Every row of the saved excerpt names a listed company or is among SEC's first rows.
    expect(body.data.length).toBeGreaterThan(10);
    expect(
      body.data.every(
        (row, index) => index < 10 || saved.data.some((one: { cik: number }) => one.cik === row.cik),
      ),
    ).toBe(true);
  });
});

const GOLDEN = {
  itRevenue: `[e1] screen information technology revenue 2025 (as of Saturday 2025-12-27; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
information technology: revenue, fiscal years ending in 2025, ranked by value (highest first), in USD; as known at 2026-11-25T22:00:00Z
incomplete: S&P 1500 members only (Wikipedia's S&P lists, CC BY-SA 4.0); FORM on two lists, counted as S&P 400 (added there most recently); this is not a ranking of the whole sector
14 companies read, 10 with a value, 10 of them in USD and ranked; without: 4 not in SEC's frames
fiscal years end 2025-06-27 to 2025-12-27, most in 2025-06; 1 far from that, marked
1. Apple Inc. (AAPL): 416B, year ending 2025-09-27; 0000320193-26-000026
2. Microsoft (MSFT): 282B, year ending 2025-06-30; 0001193125-26-323660
3. Advanced Micro Devices (AMD): 34.6B, year ending 2025-12-27 [off the sector's calendar]; 0000002488-26-000018
4. Applied Materials (AMAT): 28.4B, year ending 2025-10-26; 0001628280-25-056742
5. Lam Research (LRCX): 18.4B, year ending 2025-06-29; 0000707549-26-000037
6. Analog Devices (ADI): 11B, year ending 2025-11-01; 0000006281-26-000089
7. Western Digital (WDC): 9.52B, year ending 2025-06-27; 0001628280-26-057139
8. Skyworks Solutions (SWKS): 4.09B, year ending 2025-10-03; 0000004127-26-000055
9. Fabrinet (FN): 3.42B, year ending 2025-06-27; 0001408710-26-000028
10. Napco Security Technologies (NSSC): 181,621,000, year ending 2025-06-30; 0001104659-26-100081`,
  itAssets: `[e1] screen information technology total assets 2024 (as of Saturday 2024-12-28; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
information technology: total assets, fiscal years ending in 2024, ranked by value (highest first), in USD; as known at 2026-11-25T22:00:00Z
incomplete: S&P 1500 members only (Wikipedia's S&P lists, CC BY-SA 4.0); FORM on two lists, counted as S&P 400 (added there most recently); this is not a ranking of the whole sector
14 companies read, 2 with a value, 2 of them in USD and ranked; without: 5 not in SEC's frames at its fiscal year end, 7 no fiscal year end in SEC's frames
fiscal years end 2024-09-28 to 2024-12-28, most in 2024-09
1. Apple Inc. (AAPL): 365B, year ending 2024-09-28; 0000320193-25-000079
2. Advanced Micro Devices (AMD): 69.2B, year ending 2024-12-28; 0000002488-26-000018`,
  industrialsChange: `[e1] screen industrials Revenue 2025 change (as of Wednesday 2025-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
industrials: Revenue, fiscal years ending in 2025, ranked by change from the year before (highest first), in USD; as known at 2026-11-25T22:00:00Z
incomplete: S&P 1500 members only (Wikipedia's S&P lists, CC BY-SA 4.0); S&P 1500 members only (Wikipedia's S&P lists, CC BY-SA 4.0); this is not a ranking of the whole sector
16 companies read, 10 with a value, 10 of them in USD, 8 with a change to rank (not: 2 prior year missing); without: 5 not in SEC's frames, 1 no CIK for its ticker in SEC's list
fiscal years end 2025-03-01 to 2025-12-31, most in 2025-06; 4 far from that, marked
1. GE Aerospace (GE): 45.9B, +18.48% from 38.7B, year ending 2025-12-31 [off the sector's calendar]; 0000040545-26-000008
2. Howmet Aerospace (HWM): 8.25B, +11.06% from 7.43B, year ending 2025-12-31 [off the sector's calendar]; 0000004281-26-000012
3. Automatic Data Processing (ADP): 20.6B, +7.07% from 19.2B, year ending 2025-06-30; 0000008670-26-000030
4. Enerpac Tool Group (EPAC): 616,900,000, +4.65% from 589,500,000, year ending 2025-08-31; 0000006955-26-000109
5. Carpenter Technology (CRS): 2.88B, +4.25% from 2.76B, year ending 2025-06-30; 0000017843-26-000034
6. American Airlines Group (AAL): 54.6B, +0.78% from 54.2B, year ending 2025-12-31 [off the sector's calendar]; 0000006201-26-000014
7. Matson, Inc. (MATX): 3.34B, -2.26% from 3.42B, year ending 2025-12-31 [off the sector's calendar]; 0001104659-26-020944
8. Kennametal (KMT): 1.97B, -3.91% from 2.05B, year ending 2025-06-30; 0001628280-26-056143`,
  staplesLiabilities: `[e1] screen consumer staples Total Liabilities 2025 (as of Friday 2025-01-31; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
consumer staples: Total Liabilities, fiscal years ending in 2025, ranked by value (highest first), in USD; as known at 2026-11-25T22:00:00Z
incomplete: S&P 1500 members only (Wikipedia's S&P lists, CC BY-SA 4.0); this is not a ranking of the whole sector
5 companies read, 1 with a value, 1 of them in USD and ranked; without: 4 not in SEC's frames at its fiscal year end
fiscal years end 2025-01-31 to 2025-01-31, most in 2025-01; 1 values derived rather than filed, marked
1. Walmart (WMT): 163B, year ending 2025-01-31 [derived: LiabilitiesAndStockholdersEquity less StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest and RedeemableNoncontrollingInterestEquityCarryingAmount]; 0000104169-26-000055`,
};
