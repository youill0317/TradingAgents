// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Wikipedia's S&P 500, 400 and 600 lists as the sector screen reads them (sources/wikipedia.ts): the wikitext
 * reader on the quirks the three pages hold (excerpts of their answers saved before, test/fork/fixtures/wikipedia,
 * CC BY-SA 4.0, attributed in their meta), each list's companies, the three as one universe, the pages read one
 * after another and kept a week; and the reader's pieces on hostile input, in time proportional to it. On the three
 * whole pages saved with the planning samples the reader gives the 503, 400 and 603 rows the planning's own parser
 * gave, row for row (checked when it was written; those pages are not fixtures).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cases, excerpt } from "../../../scripts/fork/fixture-cases/wikipedia.js";
import {
  additionsOf,
  combineLists,
  dateOf,
  gridOf,
  type ParsedList,
  parseSpList,
  plainText,
  SP_LISTS,
  type SpList,
  splitOutside,
  spUniverse,
  symbolOf,
  tableById,
  tickerOf,
  wikiTables,
  wikitextOf,
  wikitextUrl,
  withoutNoise,
} from "../../../src/fork/data/sources/wikipedia.js";
import { FIXTURES, type FixtureRoute, testDeps } from "./harness.js";

const [SP500, SP400, SP600] = SP_LISTS as [SpList, SpList, SpList];

/** A list's wikitext, from its fixture. */
function wikitext(list: SpList): string {
  return wikitextOf(
    list,
    JSON.parse(readFileSync(join(FIXTURES, `wikipedia/${list.key}-wikitext.json`), "utf8")),
  );
}

const parsed = (list: SpList) => parseSpList(list, wikitext(list));
const company = (list: ParsedList, ticker: string) => list.companies.find((one) => one.ticker === ticker);

describe("the S&P lists", () => {
  test("the parse API's address for each page, as Wikipedia was asked", () => {
    expect(wikitextUrl(SP500.page)).toBe(
      "https://en.wikipedia.org/w/api.php?action=parse&page=List_of_S%26P_500_companies&prop=wikitext&format=json&formatversion=2",
    );
  });

  test("the S&P 500: cells after '||', share classes with a dot, a ticker template of Cboe's, a reference with pipes inside", () => {
    const list = parsed(SP500);
    expect([list.companies.length, list.skipped]).toEqual([30, 0]);
    expect(company(list, "MMM")).toEqual({
      ticker: "MMM",
      name: "3M",
      sector: "Industrials",
      listed_sector: null,
      sub_industry: "Industrial Conglomerates",
      industry_group: "Capital Goods",
      industry: "Industrial Conglomerates",
      cik: "0000066740",
      added: "1957-03-04",
    });
    // {{NyseSymbol|BRK.B}} <!-- DO NOT CHANGE THIS TICKER TO BRK-B ... -->: read as SEC and Yahoo write it.
    expect(company(list, "BRK-B")).toMatchObject({ name: "Berkshire Hathaway", cik: "0001067983" });
    expect(company(list, "CBOE")).toMatchObject({
      sector: "Financials",
      sub_industry: "Financial Exchanges & Data",
    });
    // Northrop Grumman's headquarters cell holds a reference with templates, links and a comment: the columns
    // after it are read as they stand.
    expect(company(list, "NOC")).toMatchObject({
      sector: "Industrials",
      sub_industry: "Aerospace & Defense",
      cik: "0001133421",
      added: "1957-03-04",
    });
    // Two share classes are two rows of one CIK; the screen makes them one company.
    expect([company(list, "GOOGL")?.cik, company(list, "GOOG")?.cik]).toEqual(["0001652044", "0001652044"]);
    expect(company(list, "GOOG")?.name).toBe("Alphabet Inc. (Class C)");
  });

  test("the S&P 400: attributes before a lone pipe, CIKs only where its filings link gives a number, additions from its changes table", () => {
    const list = parsed(SP400);
    expect([list.companies.length, list.skipped]).toEqual([10, 0]);
    expect(company(list, "AAL")).toMatchObject({ name: "American Airlines Group", cik: "0000006201" });
    // CIK=AA and CIK=ACM: the screen finds these companies in SEC's ticker list.
    expect([company(list, "AA")?.cik, company(list, "ACM")?.cik]).toEqual([null, null]);
    expect(
      Object.fromEntries(
        ["CHYM", "GKOS", "FORM", "CORT", "EAT", "AAL"].map((t) => [t, company(list, t)?.added]),
      ),
    ).toEqual({
      CHYM: "2026-11-18",
      GKOS: "2026-11-04",
      FORM: "2026-10-06",
      CORT: "2026-09-21",
      // Removed in 2020 and added again: the latest addition counts.
      EAT: "2026-09-21",
      AAL: "2024-09-23",
    });
    // A company the changes table does not name has no date.
    expect(company(list, "ACM")?.added).toBeNull();
    // A date written once for ten rows (rowspan=10) is each of those rows' date.
    const additions = additionsOf(wikiTables(wikitext(SP400)));
    expect(["ADS", "JWN", "GBCI"].map((ticker) => additions.get(ticker))).toEqual([
      "2020-06-22",
      "2020-06-22",
      "2020-06-22",
    ]);
  });

  test("the S&P 600: an anchor, a Lua-made link, a leading space, a stray '||', and sectors read from their sub-industries", () => {
    const list = parsed(SP600);
    expect([list.companies.length, list.skipped]).toEqual([21, 0]);
    expect(company(list, "AAMI")).toMatchObject({ name: "Acadian Asset Management Inc.", cik: "0001748824" });
    expect(company(list, "PRK")).toMatchObject({ name: "Park National Corp.", sector: "Financials" });
    expect(company(list, "EFOR")).toMatchObject({ sector: "Information Technology" });
    expect(company(list, "GEO")).toMatchObject({
      sector: "Industrials",
      sub_industry: "Environmental & Facilities Services",
    });
    // GICS's tree places these sub-industries elsewhere than the page's sector column does.
    expect(
      Object.fromEntries(
        ["PMT", "ALRM", "NSIT", "LNN", "SCHL"].map((t) => [
          t,
          [company(list, t)?.listed_sector, company(list, t)?.sector],
        ]),
      ),
    ).toEqual({
      PMT: ["Real Estate", "Financials"],
      ALRM: ["Financials", "Information Technology"],
      NSIT: ["Industrials", "Information Technology"],
      LNN: ["Materials", "Industrials"],
      SCHL: ["Consumer Discretionary", "Communication Services"],
    });
    expect(company(list, "PMT")).toMatchObject({
      industry_group: "Financial Services",
      industry: "Mortgage Real Estate Investment Trusts (REITs)",
    });
    expect(company(list, "EAT")?.added).toBe("2020-06-25");
    expect(company(list, "CORT")?.added).toBeNull();
  });

  test("the three as one: a ticker on two lists kept from the list that added it most recently, and said", () => {
    const { members, duplicates } = combineLists([parsed(SP500), parsed(SP400), parsed(SP600)]);
    expect(members).toHaveLength(30 + 10 + 21 - 4);
    expect(duplicates).toEqual([
      {
        ticker: "CORT",
        kept: "S&P 400",
        dropped: ["S&P 600"],
        reason: "the S&P 400 list added it most recently (2026-09-21)",
      },
      {
        ticker: "EAT",
        kept: "S&P 400",
        dropped: ["S&P 600"],
        reason: "the S&P 400 list added it most recently (2026-09-21)",
      },
      {
        ticker: "FORM",
        kept: "S&P 400",
        dropped: ["S&P 600"],
        reason: "the S&P 400 list added it most recently (2026-10-06)",
      },
      {
        ticker: "GKOS",
        kept: "S&P 400",
        dropped: ["S&P 600"],
        reason: "the S&P 400 list added it most recently (2026-11-04)",
      },
    ]);
    expect(members.find((member) => member.ticker === "EAT")).toMatchObject({
      index: "S&P 400",
      also: [{ index: "S&P 600", added: "2020-06-25" }],
    });
  });

  test("lists that date an addition alike, or not at all, keep the list read first", () => {
    const one = (index: "S&P 400" | "S&P 600", added: string | null): ParsedList => ({
      index,
      page: "",
      skipped: 0,
      companies: [
        {
          ticker: "XYZ",
          name: index,
          sector: "Energy",
          listed_sector: null,
          sub_industry: null,
          industry_group: null,
          industry: null,
          cik: null,
          added,
        },
      ],
    });
    for (const [a, b] of [
      [null, null],
      ["2026-01-02", "2026-01-02"],
    ] as const) {
      const { members, duplicates } = combineLists([one("S&P 400", a), one("S&P 600", b)]);
      expect(members.map((member) => member.index)).toEqual(["S&P 400"]);
      expect(duplicates[0]?.reason).toBe(
        "neither list dates its addition apart, so the S&P 400 list is kept",
      );
    }
    // A later date wins whichever list was read first.
    expect(combineLists([one("S&P 400", "2020-01-01"), one("S&P 600", "2021-01-01")]).members[0]?.index).toBe(
      "S&P 600",
    );
  });
});

describe("reading the lists from Wikipedia", () => {
  const routes: FixtureRoute[] = SP_LISTS.map((list) => ({
    match: wikitextUrl(list.page),
    file: `wikipedia/${list.key}-wikitext.json`,
  }));

  test("the three pages one after another, kept a week: a second reading asks nothing", async () => {
    const { deps, fetch } = testDeps({}, routes);
    const universe = spUniverse(deps);
    const first = await universe.read();
    expect(fetch.requests.map((request) => request.url)).toEqual(
      SP_LISTS.map((list) => wikitextUrl(list.page)),
    );
    expect([first.members.length, first.stale, first.read_at]).toEqual([
      57,
      false,
      "2026-11-25T22:00:00.000Z",
    ]);
    await universe.read();
    expect(fetch.requests).toHaveLength(3);
  });

  test("each page asked only once the one before it has answered", async () => {
    const order: string[] = [];
    const { deps } = testDeps(
      {},
      routes.map((route) => ({
        ...route,
        match: (url: URL) => {
          const matched = url.href === route.match;
          if (matched) order.push(`${url.searchParams.get("page")}`);
          return matched;
        },
      })),
    );
    await spUniverse(deps).read();
    expect(order).toEqual([
      "List_of_S&P_500_companies",
      "List_of_S&P_400_companies",
      "List_of_S&P_600_companies",
    ]);
  });
});

describe("the recorder's cases (scripts/fork/fixture-cases/wikipedia.ts), over a fixture fetch", () => {
  test("a page's excerpt keeps what the tests read: cutting the fixture again gives the same companies", () => {
    for (const list of SP_LISTS) {
      const body = JSON.parse(readFileSync(join(FIXTURES, `wikipedia/${list.key}-wikitext.json`), "utf8"));
      const again = parseSpList(list, wikitextOf(list, excerpt(list, body, "2026-11-26T00:00:00Z")));
      expect(again.companies).toEqual(parsed(list).companies);
    }
  });

  test("each case reads its page as the app does and records the excerpt, with its attribution at the head", async () => {
    const { deps, fetch } = testDeps(
      {},
      SP_LISTS.map((list) => ({
        match: wikitextUrl(list.page),
        file: `wikipedia/${list.key}-wikitext.json`,
      })),
    );
    const recorded = await cases[0]?.read?.(deps.http, {} as never);
    expect(fetch.requests.map((request) => request.url)).toEqual([wikitextUrl(SP500.page)]);
    expect([recorded?.status, recorded?.url]).toEqual([200, wikitextUrl(SP500.page)]);
    const text = wikitextOf(SP500, JSON.parse(recorded?.body as string));
    expect(text).toStartWith(
      '<!-- An excerpt of the English Wikipedia article "List of S&P 500 companies" as read on ',
    );
    expect(text).toContain("Creative Commons Attribution-ShareAlike 4.0");
    expect(parseSpList(SP500, text).companies).toEqual(parsed(SP500).companies);
  });
});

describe("the wikitext reader's pieces", () => {
  test("comments and references go, a comment inside a reference included; an unclosed comment hides the rest", () => {
    expect(withoutNoise("a<!-- x --> b<ref>{{cite web|url=u|title=t}}<!-- y --></ref> c")).toBe("a b c");
    expect(withoutNoise('d<ref name="n" /> e<ref name=m/>f')).toBe("d ef");
    expect(withoutNoise("kept<references/> g<!-- open")).toBe("kept<references/> g");
    expect(withoutNoise("h<ref>never closed")).toBe("hnever closed");
  });

  test("splits only outside templates and links", () => {
    expect(splitOutside("a || {{t|b||c}} || [[d|e]] || f", ["||"])).toEqual([
      "a ",
      " {{t|b||c}} ",
      " [[d|e]] ",
      " f",
    ]);
    expect(splitOutside("}} unbalanced || x", ["||"])).toEqual(["}} unbalanced ", " x"]);
  });

  test("cells spanning rows and columns stand in each place they cover", () => {
    const [table] = wikiTables(
      '{| id="t"\n|-\n! rowspan="2" | A !! colspan="2" | B\n|-\n! b1 !! b2\n|-\n| rowspan=2 | 1 || x || y\n|-\n| z || w\n|}',
    );
    expect(table && tableById([table], "t")).toBe(table);
    const grid = table ? gridOf(table).map((row) => row.map((cell) => cell.text)) : [];
    expect(grid).toEqual([
      ["A", "B", "B"],
      ["A", "b1", "b2"],
      ["1", "x", "y"],
      ["1", "z", "w"],
    ]);
  });

  test("a table inside a cell stays in that cell; a caption is not a row", () => {
    const tables = wikiTables('{| id="outer"\n|+ caption\n|-\n| a\n{|\n| inner\n|}\n| b\n|}');
    expect(tables).toHaveLength(1);
    const grid = tables[0] ? gridOf(tables[0]).map((row) => row.map((cell) => cell.text)) : [];
    expect(grid).toEqual([["a\n{|\n| inner\n|}", "b"]]);
  });

  test("what a reader sees of a cell", () => {
    expect(plainText("[[Alarm.com|Alarm.Com, Inc.]]")).toBe("Alarm.Com, Inc.");
    expect(plainText("[[Alphabet Inc.]] (Class A)")).toBe("Alphabet Inc. (Class A)");
    expect(plainText("[https://www.sec.gov/edgar/browse/?CIK=0001748824 view]")).toBe("view");
    expect(plainText("[{{#invoke:Stock tickers/NYSE|GetURL|PRK|exchange=AMEX}} PRK]")).toBe("PRK");
    expect(plainText("{{Anchor|A}}AT&amp;T&nbsp;Inc.")).toBe(
      `AT&T${String.fromCharCode(0xa0)}Inc.`.replace(/\s+/g, " "),
    );
    expect(plainText("'''Bold''' <small>note</small><br/>line")).toBe("Bold note line");
  });

  test("tickers and dates as cells write them", () => {
    expect(symbolOf("{{NyseSymbol|BRK.B}}")).toBe("BRK-B");
    expect(symbolOf("{{NyseSymbol| EFOR}}")).toBe("EFOR");
    expect(symbolOf("{{BZX link|CBOE}}")).toBe("CBOE");
    expect(symbolOf("{{Anchor|A}}{{NasdaqSymbol|AAMI}}")).toBe("AAMI");
    expect(symbolOf("[{{#invoke:Stock tickers/NYSE|GetURL|TMP|exchange=AMEX}} TMP]")).toBe("TMP");
    expect(symbolOf(" CHYM ")).toBe("CHYM");
    expect([tickerOf("mog.a"), tickerOf("not a ticker"), tickerOf("")]).toEqual([
      "MOG-A",
      undefined,
      undefined,
    ]);
    expect(dateOf("1957-03-04 ")).toBe("1957-03-04");
    expect(dateOf("November 18, 2026")).toBe("2026-11-18");
    expect(dateOf("Sept. 3, 2024")).toBe("2024-09-03");
    expect(dateOf("4 November 2026")).toBe("2026-11-04");
    expect([dateOf("February 30, 2026"), dateOf("2026-13-01"), dateOf("soon")]).toEqual([null, null, null]);
  });

  test("hostile input is read in time proportional to it", () => {
    const started = performance.now();
    withoutNoise("<ref>".repeat(200_000));
    withoutNoise("<!--".repeat(200_000));
    splitOutside("{{[[".repeat(200_000), ["||"]);
    plainText("{{".repeat(200_000));
    plainText("[[".repeat(200_000));
    plainText("[x".repeat(200_000));
    plainText("[https://a ".repeat(100_000));
    plainText("<a".repeat(200_000));
    plainText("[{{#invoke:".repeat(100_000));
    symbolOf(`{{NyseSymbol|${" ".repeat(400_000)}`);
    symbolOf("[{{#invoke:a|GetURL|".repeat(50_000));
    dateOf(`Sep${" ".repeat(400_000)}`);
    wikiTables(`{| id="constituents"\n${"|-\n| a || b || c\n".repeat(50_000)}|}`);
    gridOf({
      attributes: "",
      rows: Array.from({ length: 2_000 }, () => [{ header: false, text: "x", rowspan: 2_000, colspan: 64 }]),
    });
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
