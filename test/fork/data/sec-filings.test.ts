// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The filers provider's filings, filing sections and insider transactions, through the real filings,
 * filing_section and ownership tools in a ToolRegistry (the harness): the text the model reads and every field
 * the tools read supplied (the read check). On SEC's own data.sec.gov answers saved before (the filing indexes,
 * trimmed to what these read) and www.sec.gov documents hand-made in EDGAR's formats (a 10-K, a 10-Q and a 20-F
 * laid out as EDGAR's are, insider reports in SEC's ownership XML), as www.sec.gov answers only a User-Agent
 * naming a contact.
 */
import { describe, expect, test } from "bun:test";
import { filersProvider } from "../../../src/fork/data/providers/filers.js";
import { parseOwnership, rawOwnershipDocument } from "../../../src/fork/data/sources/sec-form4.js";
import { findSection, sectionsOfForm } from "../../../src/fork/data/sources/sec-sections.js";
import { SEC_TICKERS_URL } from "../../../src/fork/data/sources/sec-tickers.js";
import { buildTools, type FixtureRoute, fixture, testDeps } from "./harness.js";

const UA = "Test Agent test@example.com";

/** A document in a filing's folder in EDGAR's archives, from a fixture. */
const archived = (cik: string, accession: string, document: string, file: string): FixtureRoute => ({
  match: `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replaceAll("-", "")}/${document}`,
  file: `sec/${file}`,
});

/** An insider report's raw XML (its primary document without the stylesheet folder). */
const report = (company: string, cik: string, accession: string, document: string) =>
  archived(cik, accession, document, `form4-${company}-${accession}.xml`);

const ROUTES: FixtureRoute[] = [
  { match: SEC_TICKERS_URL, file: "sec/company-tickers-exchange.json" },
  { match: "https://data.sec.gov/submissions/CIK0000320193.json", file: "sec/submissions-aapl.json" },
  {
    match: "https://data.sec.gov/submissions/CIK0000320193-submissions-001.json",
    file: "sec/submissions-aapl-001.json",
  },
  { match: "https://data.sec.gov/submissions/CIK0000104169.json", file: "sec/submissions-wmt.json" },
  { match: "https://data.sec.gov/submissions/CIK0001046179.json", file: "sec/submissions-tsm.json" },
  { match: "https://data.sec.gov/submissions/CIK0001067983.json", file: "sec/submissions-brk.json" },
  archived("320193", "0000320193-26-000026", "aapl-20260926.htm", "document-aapl-0000320193-26-000026.html"),
  archived("320193", "0000320193-26-000020", "aapl-20260627.htm", "document-aapl-0000320193-26-000020.html"),
  archived("104169", "0000104169-26-000055", "wmt-20260131.htm", "document-wmt-0000104169-26-000055.html"),
  archived("1046179", "0001193125-25-083423", "d896993d20f.htm", "document-tsm-0001193125-25-083423.html"),
  report("aapl", "320193", "0001140361-26-044952", "form4.xml"),
  report("aapl", "320193", "0001140361-26-044773", "form4.xml"),
  report("aapl", "320193", "0001140361-26-043484", "form4.xml"),
  report("aapl", "320193", "0001140361-26-042149", "form4.xml"),
  report("aapl", "320193", "0001140361-26-041201", "form4.xml"),
  report("aapl", "320193", "0000320193-24-000102", "wk-form5_1727822122.xml"),
  report("aapl", "320193", "0000320193-22-000078", "wf-form4a_166120817922787.xml"),
  report("tsm", "1046179", "0002114032-26-000002", "wk-form4_1795172790.xml"),
  report("tsm", "1046179", "0001046179-26-000803", "wk-form4_1794999834.xml"),
  report("tsm", "1046179", "0001046179-26-000794", "wk-form4_1794310898.xml"),
  report("brk", "1067983", "0001193125-26-468887", "ownership.xml"),
  report("brk", "1067983", "0001193125-26-465872", "ownership.xml"),
];

/** The filers provider alone, its tools, and what it asked. */
function sec(routes: readonly FixtureRoute[] = ROUTES) {
  const { deps, fetch } = testDeps({ secUserAgent: UA }, routes);
  const provider = filersProvider(deps);
  return { ...buildTools({ filers: provider }, { check: true }), provider, fetch };
}

/** Calls in one setup, each checked as the model reads it: its text, every field read supplied, nothing unanswered. */
async function goldens(calls: [tool: string, input: Record<string, unknown>, expected: string][]) {
  const { runTool, fetch } = sec();
  const runs = [];
  for (const [tool, input, expected] of calls) {
    const run = await runTool(tool, input);
    expect(run.failure).toBeUndefined();
    expect(run.text).toBe(expected);
    expect(run.reads.missing()).toEqual([]);
    runs.push(run);
  }
  expect(fetch.unmatched).toEqual([]);
  return { runs, fetch };
}

const text = (file: string) => new TextDecoder().decode(fixture(file));

describe("filings as the model reads them", () => {
  test("newest accepted first, each with its acceptance time, period, link and the sections it is read by", async () => {
    await goldens([["filings", { symbol: "AAPL", limit: 4 }, GOLDEN.aaplFilings]]);
  });

  test("by exact form, paged by cursor, into the index's older page when the recent filings run out", async () => {
    const { fetch } = await goldens([
      ["filings", { symbol: "AAPL", forms: ["10-K"], limit: 2 }, GOLDEN.aaplAnnual],
      [
        "filings",
        { symbol: "AAPL", forms: ["10-K"], limit: 2, after: "0000320193-25-000079" },
        GOLDEN.aaplAnnualMore,
      ],
    ]);
    // Two pages of the recent filings need no older page.
    expect(fetch.requests.some((request) => request.url.includes("-submissions-001"))).toBe(false);
    const older = await goldens([
      [
        "filings",
        { symbol: "AAPL", forms: ["10-K"], limit: 3, after: "0001193125-15-356351" },
        GOLDEN.aaplAnnualOlder,
      ],
    ]);
    expect(older.fetch.requests.map((request) => request.url)).toContain(
      "https://data.sec.gov/submissions/CIK0000320193-submissions-001.json",
    );
  });

  test("amendments only when asked for; a filing with no primary document links its folder", async () => {
    await goldens([["filings", { symbol: "AAPL", forms: ["10-K/A"] }, GOLDEN.aaplAmendments]]);
  });

  test("a form EDGAR renamed is found by either name", async () => {
    await goldens([["filings", { symbol: "AAPL", forms: ["SC 13G"] }, GOLDEN.aaplSchedules]]);
  });

  test("a 20-F is read by the same sections as a 10-K", async () => {
    await goldens([["filings", { symbol: "TSM", forms: ["20-F"], limit: 2 }, GOLDEN.tsmAnnual]]);
  });
});

describe("filing sections as the model reads them", () => {
  test("a 10-K's sections by Item, the table of contents skipped, a mention of another Item not taken for one", async () => {
    const { fetch } = await goldens([
      [
        "filing_section",
        { symbol: "AAPL", accession: "0000320193-26-000026", section: "risk_factors" },
        GOLDEN.aaplRisk,
      ],
      [
        "filing_section",
        { symbol: "AAPL", accession: "0000320193-26-000026", section: "mdna" },
        GOLDEN.aaplMdna,
      ],
    ]);
    // The document is read once and kept.
    expect(fetch.requests.filter((request) => request.url.endsWith("aapl-20260926.htm"))).toHaveLength(1);
  });

  test("a 10-Q numbers its Items again in Part II; a section pointing elsewhere is by_reference", async () => {
    await goldens([
      [
        "filing_section",
        { symbol: "AAPL", accession: "0000320193-26-000020", section: "risk_factors" },
        GOLDEN.aaplQRisk,
      ],
      [
        "filing_section",
        { symbol: "AAPL", accession: "0000320193-26-000020", section: "market_risk" },
        GOLDEN.aaplQMarket,
      ],
      [
        "filing_section",
        { symbol: "AAPL", accession: "0000320193-26-000020", section: "financial_statements" },
        GOLDEN.aaplQStatements,
      ],
    ]);
  });

  test("a section the form has none of is no text, with why", async () => {
    await goldens([
      [
        "filing_section",
        { symbol: "AAPL", accession: "0000320193-26-000020", section: "business" },
        GOLDEN.aaplQBusiness,
      ],
    ]);
  });

  test("an Item incorporated by reference serves the filing's own pointer", async () => {
    await goldens([
      [
        "filing_section",
        { symbol: "WMT", accession: "0000104169-26-000055", section: "market_risk" },
        GOLDEN.wmtMarket,
      ],
    ]);
  });

  test("a 20-F's risk factors are the Risk Factors part of Item 3; its statements may point to the F-pages", async () => {
    await goldens([
      [
        "filing_section",
        { symbol: "TSM", accession: "0001193125-25-083423", section: "risk_factors" },
        GOLDEN.tsmRisk,
      ],
      [
        "filing_section",
        { symbol: "TSM", accession: "0001193125-25-083423", section: "financial_statements" },
        GOLDEN.tsmStatements,
      ],
    ]);
  });
});

describe("the sections filings lists, as filing_section reads them", () => {
  test("every section a 10-K, a 10-Q and a 20-F list is found in its document", async () => {
    const { runTool, provider, fetch } = sec();
    const found: Record<string, string[]> = {};
    for (const [symbol, accession, form, limit] of [
      ["AAPL", "0000320193-26-000026", "10-K", 1],
      ["AAPL", "0000320193-26-000020", "10-Q", 1],
      ["WMT", "0000104169-26-000055", "10-K", 1],
      ["TSM", "0001193125-25-083423", "20-F", 2],
    ] as const) {
      const listed = await provider.capabilities.filings?.list?.(symbol, { limit, forms: [form] });
      const filing = listed?.data.find((one) => one.accession === accession);
      for (const { section } of filing?.sections ?? []) {
        const run = await runTool("filing_section", { symbol, accession, section });
        expect(run.failure).toBeUndefined();
        expect(run.reads.missing()).toEqual([]);
        const key = `${filing?.form} ${accession}`;
        found[key] = [...(found[key] ?? []), `${section} ${(run.payload as { state: string }).state}`];
      }
    }
    expect(found).toEqual({
      "10-K 0000320193-26-000026": [
        "business available",
        "risk_factors available",
        "mdna available",
        "market_risk available",
        "financial_statements available",
      ],
      "10-Q 0000320193-26-000020": [
        "financial_statements available",
        "mdna available",
        "market_risk by_reference",
        "risk_factors available",
      ],
      "10-K 0000104169-26-000055": [
        "business available",
        "risk_factors available",
        "mdna available",
        "market_risk by_reference",
        "financial_statements available",
      ],
      "20-F 0001193125-25-083423": [
        "business available",
        "risk_factors available",
        "mdna available",
        "market_risk available",
        "financial_statements by_reference",
      ],
    });
    expect(fetch.unmatched).toEqual([]);
  });
});

describe("insider transactions as the model reads them", () => {
  test("newest first, with each report's owners and roles; a page cut inside a report continues in it", async () => {
    await goldens([
      ["ownership", { symbol: "AAPL", limit: 4 }, GOLDEN.aaplInsiders],
      ["ownership", { symbol: "AAPL", limit: 4, after: "0001140361-26-044773~2" }, GOLDEN.aaplInsidersMore],
    ]);
  });

  test("by code, through every report the index holds (its older page read too)", async () => {
    const { fetch } = await goldens([
      ["ownership", { symbol: "AAPL", codes: ["P", "S"] }, GOLDEN.aaplTrades],
    ]);
    expect(fetch.requests.map((request) => request.url)).toContain(
      "https://data.sec.gov/submissions/CIK0000320193-submissions-001.json",
    );
  });

  test("a window finds a Form 5's transactions within its fiscal year; reports outside it are not read", async () => {
    const { fetch } = await goldens([
      ["ownership", { symbol: "AAPL", start: "2024-01-01", end: "2024-12-31" }, GOLDEN.aaplYear],
    ]);
    const read = fetch.requests.filter((request) => request.url.startsWith("https://www.sec.gov/Archives/"));
    expect(read.map((request) => request.url)).toEqual([
      "https://www.sec.gov/Archives/edgar/data/320193/000032019324000102/wk-form5_1727822122.xml",
    ]);
  });

  test("a foreign issuer's insiders report from its first report on: earlier dates are said to be uncovered", async () => {
    const { fetch } = await goldens([
      ["ownership", { symbol: "TSM", start: "2025-01-01" }, GOLDEN.tsmInsiders],
    ]);
    // Its older page is dated before the window: not read.
    expect(fetch.requests.some((request) => request.url.includes("-submissions-001"))).toBe(false);
  });

  test("a report the company files as another issuer's owner is not about its shares", async () => {
    await goldens([["ownership", { symbol: "BRK.B", start: "2026-11-01" }, GOLDEN.brkInsiders]]);
  });

  test("the provider's answer: the window read, its reports and owners, every row's fields", async () => {
    const { provider } = sec();
    const answer = await provider.capabilities.ownership?.transactions?.("AAPL", { limit: 1 });
    expect(answer).toEqual({
      instrument: {
        key: "AAPL",
        name: "Apple Inc.",
        venue: "Nasdaq",
        currency: "USD",
        price_scale: 1,
        listing: null,
      },
      filings: {
        "0001140361-26-044952": {
          form: "4",
          accepted_at: "2026-11-19T23:30:21Z",
          owners: [
            {
              name: "TESTER ALEX",
              officer_title: "Senior Vice President",
              is_director: false,
              is_ten_percent_owner: false,
            },
          ],
        },
      },
      coverage: {
        from: "2026-11-20",
        through: "2026-11-25",
        complete: true,
        requested_before_window: false,
        not_yet_served: null,
        complete_after: "2026-11-27",
      },
      data: [
        {
          accession: "0001140361-26-044952",
          transaction_date: "2026-11-17",
          code: "S",
          shares: 10000,
          security_title: "Common Stock",
          derivative: false,
          conversion_or_exercise_price: null,
          underlying_shares: null,
          underlying_title: null,
          price: 271.5,
          acquired_disposed: "D",
          owned_following: 120000,
        },
      ],
      next_cursor: "0001140361-26-044952~1",
    });
  });
});

describe("the Item splitter", () => {
  test("a heading starts a line; a sentence that mentions an Item does not", () => {
    const document = [
      "TABLE OF CONTENTS",
      "Item 1.\tBusiness\t1",
      "Item 1A.\tRisk Factors\t5",
      "Item 2.\tProperties\t9",
      "PART I",
      "ITEM 1 BUSINESS",
      "We make things.",
      "Item 1A of this report, and Item 7, describe risks.",
      "Item 1A, Risk Factors, follows.",
      "ITEM 1A - RISK FACTORS",
      "Our business has risks.",
      "Item 2. Properties",
      "We own buildings.",
    ].join("\n");
    expect(findSection(document, "10-K", "business")).toEqual({
      state: "available",
      content:
        "ITEM 1 BUSINESS\nWe make things.\nItem 1A of this report, and Item 7, describe risks.\nItem 1A, Risk Factors, follows.",
    });
    expect(findSection(document, "10-K", "risk_factors")).toEqual({
      state: "available",
      content: "ITEM 1A - RISK FACTORS\nOur business has risks.",
    });
    expect(findSection(document, "10-K", "mdna")).toEqual({
      state: "not_found",
      reason: "no Item 7 heading found in the 10-K's primary document",
    });
  });

  test("a subsection's letter is not an Item of its own", () => {
    const document =
      "Item 3. Key Information\nItem 3.D Risk Factors\nRisks.\nItem 4. Information on the Company\nUs.";
    expect(findSection(document, "20-F", "risk_factors")).toEqual({
      state: "available",
      content: "Item 3.D Risk Factors\nRisks.",
    });
  });

  test("the forms read by sections, and what each lists", () => {
    expect(sectionsOfForm("10-K")).toEqual([
      "business",
      "risk_factors",
      "mdna",
      "market_risk",
      "financial_statements",
    ]);
    expect(sectionsOfForm("10-Q")).toEqual(["financial_statements", "mdna", "market_risk", "risk_factors"]);
    expect(sectionsOfForm("20-F")).toHaveLength(5);
    for (const form of ["8-K", "10-K/A", "40-F", "4", "DEF 14A"]) expect(sectionsOfForm(form)).toEqual([]);
    expect(findSection("Item 1. Business", "8-K", "business")).toEqual({
      state: "not_found",
      reason: "a 8-K is not split into sections here",
    });
  });

  test("a document of filing size is split in time proportional to it", () => {
    const paragraph = "Revenue grew in every segment, and the outlook depends on demand. ".repeat(4);
    const items = ["1", "1A", "1B", "2", "3", "4", "5", "6", "7", "7A", "8", "9"];
    const toc = items.map((item, index) => `Item ${item}.\tTitle ${item}\t${index + 1}`).join("\n");
    const body = items
      .map((item) => `Item ${item}. Title ${item}\n${`${paragraph}\n`.repeat(4_000)}`)
      .join("\n");
    const document = `${toc}\n${body}`;
    expect(document.length).toBeGreaterThan(10_000_000);
    const started = performance.now();
    const found = findSection(document, "10-K", "mdna");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(found.state).toBe("available");
    expect(found.state !== "not_found" && found.content.startsWith("Item 7. Title 7\n")).toBe(true);
  });
});

describe("insider reports in SEC's ownership XML", () => {
  test("the raw XML is the primary document without its stylesheet folder; reports before XML have none", () => {
    expect(rawOwnershipDocument("xslF345X06/form4.xml")).toBe("form4.xml");
    expect(rawOwnershipDocument("xslF345X03/wf-form4a_166120817922787.xml")).toBe(
      "wf-form4a_166120817922787.xml",
    );
    expect(rawOwnershipDocument("ownership.xml")).toBe("ownership.xml");
    expect(rawOwnershipDocument("j8739_4.htm")).toBeUndefined();
    expect(rawOwnershipDocument("")).toBeUndefined();
  });

  test("owners and their roles, both tables, codes, prices (a footnote instead of one is no price) and holdings", () => {
    const document = parseOwnership(text("sec/form4-aapl-0001140361-26-044773.xml"));
    expect(document).toMatchObject({
      documentType: "4",
      periodOfReport: "2026-11-16",
      issuerCik: "0000320193",
      issuerSymbol: "AAPL",
      rule10b5One: false,
      owners: [
        { cik: "0009900002", name: "EXAMPLE JORDAN", isDirector: true, isOfficer: false, officerTitle: null },
      ],
    });
    expect(document?.transactions).toEqual([
      expect.objectContaining({
        derivative: false,
        code: "M",
        shares: 2000,
        price: null,
        acquiredDisposed: "A",
      }),
      expect.objectContaining({
        derivative: false,
        code: "F",
        shares: 800,
        price: 270.25,
        ownedFollowing: 11200,
      }),
      expect.objectContaining({
        derivative: true,
        securityTitle: "Restricted Stock Unit",
        code: "M",
        conversionOrExercisePrice: null,
        underlyingTitle: "Common Stock",
        underlyingShares: 2000,
        ownedFollowing: 4000,
      }),
    ]);
  });

  test("anything but an ownership document is none; hostile text never throws", () => {
    expect(parseOwnership("<html><body>Not found</body></html>")).toBeUndefined();
    expect(parseOwnership("")).toBeUndefined();
    const odd = parseOwnership(
      "<ownershipDocument><issuer><issuerCik>320193</issuerCik></issuer><nonDerivativeTable><nonDerivativeTransaction><transactionDate><value>2026-11-17-05:00</value></transactionDate><transactionAmounts><transactionShares><value>1,000</value></transactionShares><transactionPricePerShare><value>n/a</value></transactionPricePerShare></transactionAmounts>",
    );
    expect(odd?.issuerCik).toBe("0000320193");
    expect(odd?.transactions[0]).toMatchObject({ date: "2026-11-17", shares: 1000, price: null, code: null });
  });
});

/** The texts the model reads, from the fixtures as saved and made. */
const GOLDEN = {
  aaplFilings: `[e1] filings AAPL (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): filings
history before CIK 0000320193 is not linked by the source, so any earlier predecessor's filings are not included
4 0001140361-26-044952 filed 2026-11-19 (accepted 2026-11-19T23:30:21Z), period 2026-11-17
  no sections to read; https://www.sec.gov/Archives/edgar/data/320193/000114036126044952/xslF345X06/form4.xml
4 0001140361-26-044773 filed 2026-11-18 (accepted 2026-11-18T23:30:10Z), period 2026-11-16
  no sections to read; https://www.sec.gov/Archives/edgar/data/320193/000114036126044773/xslF345X06/form4.xml
144 0001921094-26-001188 filed 2026-11-16 (accepted 2026-11-16T21:49:16Z)
  no sections to read; https://www.sec.gov/Archives/edgar/data/320193/000192109426001188/xsl144X01/primary_doc.xml
4 0001140361-26-043484 filed 2026-11-12 (accepted 2026-11-12T23:58:20Z), period 2026-11-10
  no sections to read; https://www.sec.gov/Archives/edgar/data/320193/000114036126043484/xslF345X06/form4.xml
more filings: filings with after=0001140361-26-043484 and the same filters`,
  aaplAnnual: `[e1] filings AAPL 10-K (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): filings
history before CIK 0000320193 is not linked by the source, so any earlier predecessor's filings are not included
10-K 0000320193-26-000026 filed 2026-11-03 (accepted 2026-11-03T13:05:15Z), period 2026-09-26
  sections: business, risk_factors, mdna, market_risk, financial_statements; https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm
10-K 0000320193-25-000079 filed 2025-10-31 (accepted 2025-10-31T10:01:26Z), period 2025-09-27
  sections: business, risk_factors, mdna, market_risk, financial_statements; https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm
more filings: filings with after=0000320193-25-000079 and the same filters`,
  aaplAnnualMore: `[e2] filings AAPL 10-K (reference its data as {"ref":"e2","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): filings
history before CIK 0000320193 is not linked by the source, so any earlier predecessor's filings are not included
10-K 0000320193-24-000123 filed 2024-11-01 (accepted 2024-11-01T10:01:36Z), period 2024-09-28
  sections: business, risk_factors, mdna, market_risk, financial_statements; https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm
10-K 0000320193-23-000106 filed 2023-11-03 (accepted 2023-11-02T22:08:27Z), period 2023-09-30
  sections: business, risk_factors, mdna, market_risk, financial_statements; https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm
more filings: filings with after=0000320193-23-000106 and the same filters`,
  aaplAnnualOlder: `[e1] filings AAPL 10-K (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): filings
history before CIK 0000320193 is not linked by the source, so any earlier predecessor's filings are not included
10-K 0001193125-14-383437 filed 2014-10-27 (accepted 2014-10-27T21:11:55Z), period 2014-09-27
  sections: business, risk_factors, mdna, market_risk, financial_statements; https://www.sec.gov/Archives/edgar/data/320193/000119312514383437/d783162d10k.htm
10-K 0001193125-13-416534 filed 2013-10-30 (accepted 2013-10-30T00:38:28Z), period 2013-09-28
  sections: business, risk_factors, mdna, market_risk, financial_statements; https://www.sec.gov/Archives/edgar/data/320193/000119312513416534/d590790d10k.htm
10-K 0001193125-12-444068 filed 2012-10-31 (accepted 2012-10-31T21:07:19Z), period 2012-09-29
  sections: business, risk_factors, mdna, market_risk, financial_statements; https://www.sec.gov/Archives/edgar/data/320193/000119312512444068/d411355d10k.htm
more filings: filings with after=0001193125-12-444068 and the same filters`,
  aaplAmendments: `[e1] filings AAPL 10-K/A (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): filings
history before CIK 0000320193 is not linked by the source, so any earlier predecessor's filings are not included
10-K/A 0001193125-10-012091 filed 2010-01-25 (accepted 2010-01-25T21:25:58Z), period 2009-09-26
  no sections to read; https://www.sec.gov/Archives/edgar/data/320193/000119312510012091/d10ka.htm
10-K/A 0001047469-98-001822 filed 1998-01-23 (accepted 1998-01-23T05:00:00Z), period 1997-09-26
  no sections to read; https://www.sec.gov/Archives/edgar/data/320193/000104746998001822/`,
  aaplSchedules: `[e1] filings AAPL SC 13G (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): filings
history before CIK 0000320193 is not linked by the source, so any earlier predecessor's filings are not included
SCHEDULE 13G 0002100119-26-000139 filed 2026-04-29 (accepted 2026-04-29T20:40:10Z)
  no sections to read; https://www.sec.gov/Archives/edgar/data/320193/000210011926000139/xslSCHEDULE_13G_X02/primary_doc.xml
SC 13G 0001193125-19-041014 filed 2019-02-14 (accepted 2019-02-14T21:42:33Z)
  no sections to read; https://www.sec.gov/Archives/edgar/data/320193/000119312519041014/d667611dsc13g.htm`,
  tsmAnnual: `[e1] filings TSM 20-F (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD (TSM, NYSE, USD): filings
history before CIK 0001046179 is not linked by the source, so any earlier predecessor's filings are not included
20-F 0001628280-26-025362 filed 2026-04-16 (accepted 2026-04-16T10:05:49Z), period 2025-12-31
  sections: business, risk_factors, mdna, market_risk, financial_statements; https://www.sec.gov/Archives/edgar/data/1046179/000162828026025362/tsm-20251231.htm
20-F 0001193125-25-083423 filed 2025-04-17 (accepted 2025-04-17T10:16:18Z), period 2024-12-31
  sections: business, risk_factors, mdna, market_risk, financial_statements; https://www.sec.gov/Archives/edgar/data/1046179/000119312525083423/d896993d20f.htm
more filings: filings with after=0001193125-25-083423 and the same filters`,
  aaplRisk: `[e1] filing_section AAPL 10-K risk factors, Nov 3 (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
10-K 0000320193-26-000026 (accepted 2026-11-03T13:05:15Z), section risk_factors: available; 897 characters in all; this part 0-897 of this page
  Item 1A. Risk Factors
  The Company’s business, reputation, results of operations, financial condition and stock price can be affected by a number of factors, whether currently known or unknown, including those described below.
  Macroeconomic and Industry Risks
  The Company’s operations and performance depend significantly on global and regional economic conditions, and adverse conditions can materially affect demand for its products and services.
  Global markets for the Company’s products and services are highly competitive, and many competitors have broad product lines, lower-priced offerings and large marketing and distribution resources.
  Business Risks
  The Company depends on component and product manufacturing and logistical services provided by outsourcing partners, many of which are located outside of the U.S., and disruptions to that supply chain can delay shipments and raise costs.
end of section`,
  aaplMdna: `[e2] filing_section AAPL 10-K mdna, Nov 3 (reference its data as {"ref":"e2","path":"<field>"})
source: SEC EDGAR
10-K 0000320193-26-000026 (accepted 2026-11-03T13:05:15Z), section mdna: available; 809 characters in all; this part 0-809 of this page
  Item 7. Management’s Discussion and Analysis of Financial Condition and Results of Operations
  The following discussion should be read in conjunction with the consolidated financial statements and accompanying notes included in Part II, Item 8 of this Form 10-K.
  Item 1A of this Form 10-K under the heading “Risk Factors” describes the risks that may affect these results.
  Fiscal 2026 Highlights
  Total net sales rose to $478.8 billion, and gross margin was 48.8% of net sales.
  
  	2026	2025
  Total net sales	$478,834	$416,161
  Gross margin	233,602	195,201
  
  Liquidity and Capital Resources
  The Company believes its balances of cash, cash equivalents and marketable securities, together with cash generated by operations and access to debt markets, will satisfy its cash requirements for at least the next 12 months.
end of section`,
  aaplQRisk: `[e1] filing_section AAPL 10-Q risk factors, Jul 31 (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
10-Q 0000320193-26-000020 (accepted 2026-07-31T10:01:02Z), section risk_factors: available; 949 characters in all; this part 0-949 of this page
  Item 1A. Risk Factors
  The Company’s business, reputation, results of operations, financial condition and stock price can be affected by a number of factors, whether currently known or unknown, including those described in Part I, Item 1A of the 2025 Form 10-K under the heading “Risk Factors.” There have been no material changes to those risk factors, except for the following, which supplement them.
  Trade policy
  New tariffs and other trade restrictions announced during the quarter may raise the cost of components and finished products imported into the U.S. and other markets, and the Company may be unable to offset those costs through pricing or changes to its supply chain.
  Digital markets regulation
  Regulators in several jurisdictions have adopted rules for large digital platforms that may require changes to the Company’s business practices, including how it distributes apps and charges commissions, which could reduce services revenue.
end of section`,
  aaplQMarket: `[e2] filing_section AAPL 10-Q market risk, Jul 31 (reference its data as {"ref":"e2","path":"<field>"})
source: SEC EDGAR
10-Q 0000320193-26-000020 (accepted 2026-07-31T10:01:02Z), section market_risk: by_reference; 318 characters in all; this part 0-318 of this page
  Item 3. Quantitative and Qualitative Disclosures About Market Risk
  There have been no material changes to the Company’s market risk during the first nine months of 2026. For a discussion of the Company’s exposure to market risk, refer to the market risk disclosures set forth in Part II, Item 7A of the 2025 Form 10-K.
end of section`,
  aaplQStatements: `[e3] filing_section AAPL 10-Q financial statements, Jul 31 (reference its data as {"ref":"e3","path":"<field>"})
source: SEC EDGAR
10-Q 0000320193-26-000020 (accepted 2026-07-31T10:01:02Z), section financial_statements: available; 343 characters in all; this part 0-343 of this page
  Item 1. Financial Statements
  CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS (Unaudited)
  
  	Three Months Ended	Nine Months Ended
  	June 27, 2026	June 28, 2025	June 27, 2026	June 28, 2025
  Total net sales	109,417	94,036	364,357	313,695
  Net income	29,789	23,434	101,464	84,544
  
  See accompanying Notes to Condensed Consolidated Financial Statements.
end of section`,
  aaplQBusiness: `[e1] filing_section AAPL 10-Q business, Jul 31 (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
10-Q 0000320193-26-000020 (accepted 2026-07-31T10:01:02Z), section business: not_found; no text to read (content: section_not_found: a 10-Q has no business section that this source reads, settled).`,
  wmtMarket: `[e1] filing_section WMT 10-K market risk, Mar 13 (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
10-K 0000104169-26-000055 (accepted 2026-03-13T20:06:24Z), section market_risk: by_reference; 231 characters in all; this part 0-231 of this page
  ITEM 7A. QUANTITATIVE AND QUALITATIVE DISCLOSURES ABOUT MARKET RISK
  
  The information concerning market risk set forth under the caption “Market Risk” in Item 7 of this Annual Report on Form 10-K is incorporated herein by reference.
end of section`,
  tsmRisk: `[e1] filing_section TSM 20-F risk factors, Apr 17 2025 (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
20-F 0001193125-25-083423 (accepted 2025-04-17T10:16:18Z), section risk_factors: available; 513 characters in all; this part 0-513 of this page
  3.D Risk Factors
  
  The risks described below could materially and adversely affect our business, financial condition and results of operations.
  
  Risks Related to Our Business and Industry
  
  Demand for our foundry services depends on the semiconductor industry, which is highly cyclical, and a downturn could reduce our revenue and utilization.
  
  We operate most of our manufacturing capacity in Taiwan, and natural disasters, power shortages or geopolitical tension affecting the region could disrupt our operations.
end of section`,
  tsmStatements: `[e2] filing_section TSM 20-F financial statements, Apr 17 2025 (reference its data as {"ref":"e2","path":"<field>"})
source: SEC EDGAR
20-F 0001193125-25-083423 (accepted 2025-04-17T10:16:18Z), section financial_statements: by_reference; 138 characters in all; this part 0-138 of this page
  ITEM 18. FINANCIAL STATEMENTS
  
  The consolidated financial statements are included at the end of this annual report, beginning on page F-1.
end of section`,
  aaplInsiders: `[e1] ownership AAPL (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): insider transactions
covered: 2026-11-19 to 2026-11-25
complete only after 2026-11-27
2026-11-17 S 10,000 Common Stock @ 271.5 (disposed), holding after 120,000; TESTER ALEX (Senior Vice President); 4 0001140361-26-044952 accepted 2026-11-19T23:30:21Z
2026-11-17 S 5,000 Common Stock @ 272.1 (disposed), holding after 115,000; TESTER ALEX (Senior Vice President); 4 0001140361-26-044952 accepted 2026-11-19T23:30:21Z
2026-11-16 M 2,000 Common Stock (acquired), holding after 12,000; EXAMPLE JORDAN (director); 4 0001140361-26-044773 accepted 2026-11-18T23:30:10Z
2026-11-16 F 800 Common Stock @ 270.25 (disposed), holding after 11,200; EXAMPLE JORDAN (director); 4 0001140361-26-044773 accepted 2026-11-18T23:30:10Z
more: ownership with after=0001140361-26-044773~2 and the same filters`,
  aaplInsidersMore: `[e2] ownership AAPL (as of Wednesday 2026-11-25; reference its data as {"ref":"e2","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): insider transactions
covered: 2024-10-02 to 2026-11-25
complete only after 2026-11-27
2026-11-16 M 2,000 Restricted Stock Unit [derivative, 2,000 Common Stock] @ 0 (disposed), holding after 4,000; EXAMPLE JORDAN (director); 4 0001140361-26-044773 accepted 2026-11-18T23:30:10Z
2026-11-10 G 1,000 Common Stock @ 0 (disposed), holding after 114,000; TESTER ALEX (Senior Vice President); 4 0001140361-26-043484 accepted 2026-11-12T23:58:20Z
2026-11-03 A 5,000 Common Stock @ 0 (acquired), holding after 25,000; SAMPLE CASEY (Chief Accounting Officer); 4 0001140361-26-042149 accepted 2026-11-05T23:30:13Z
2026-10-27 P 500 Common Stock @ 255 (acquired), holding after 10,000; EXAMPLE JORDAN (director); 4 0001140361-26-041201 accepted 2026-10-29T22:30:14Z
more: ownership with after=0001140361-26-041201~1 and the same filters`,
  aaplTrades: `[e1] ownership AAPL P,S (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): insider transactions
covered: 2022-08-22 to 2026-11-25
complete only after 2026-11-27
2026-11-17 S 10,000 Common Stock @ 271.5 (disposed), holding after 120,000; TESTER ALEX (Senior Vice President); 4 0001140361-26-044952 accepted 2026-11-19T23:30:21Z
2026-11-17 S 5,000 Common Stock @ 272.1 (disposed), holding after 115,000; TESTER ALEX (Senior Vice President); 4 0001140361-26-044952 accepted 2026-11-19T23:30:21Z
2026-10-27 P 500 Common Stock @ 255 (acquired), holding after 10,000; EXAMPLE JORDAN (director); 4 0001140361-26-041201 accepted 2026-10-29T22:30:14Z
2022-08-17 S 1,200 Common Stock @ 168 (disposed), holding after 90,000; TESTER ALEX (Senior Vice President); 4/A 0000320193-22-000078 accepted 2022-08-22T22:43:18Z`,
  aaplYear: `[e1] ownership AAPL Jan 1 2024 to Dec 31 2024 (as of Tuesday 2024-12-31; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
Apple Inc. (AAPL, Nasdaq, USD): insider transactions
covered: 2024-01-01 to 2024-12-31
2024-06-14 G 300 Common Stock @ 0 (disposed), holding after 18,000; SAMPLE CASEY (Chief Accounting Officer); 5 0000320193-24-000102 accepted 2024-10-01T22:35:29Z`,
  tsmInsiders: `[e1] ownership TSM Jan 1 2025 (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD (TSM, NYSE, USD): insider transactions
covered: 2026-03-18 to 2026-11-25
part of the dates asked about is before what the source covers
complete only after 2026-11-27
2026-11-20 S 20,000 Common Shares @ 1480 (disposed), holding after 350,000; EXAMPLE MORGAN (Senior Vice President); 4 0002114032-26-000002 accepted 2026-11-20T11:06:34Z
2026-11-17 P 3,000 Common Shares @ 1455 (acquired), holding after 45,000; SAMPLE RILEY (director); 4 0001046179-26-000803 accepted 2026-11-18T11:03:58Z
2026-11-06 A 12,000 Common Shares @ 0 (acquired), holding after 212,000; TESTER JAMIE (Vice President); 4 0001046179-26-000794 accepted 2026-11-10T11:41:42Z`,
  brkInsiders: `[e1] ownership BRK.B Nov 1 (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR
BERKSHIRE HATHAWAY INC (BRK-B, NYSE, USD): insider transactions
covered: 2026-11-01 to 2026-11-25
complete only after 2026-11-27
2026-11-17 P 100 Class B Common Stock @ 480.1 (acquired), holding after 2,100; EXAMPLE TAYLOR (director); 4 0001193125-26-468887 accepted 2026-11-19T23:15:11Z`,
};
