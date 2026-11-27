// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Korean listings' filings, filing sections and insider reports from OpenDART (DART_API_KEY), through the filers
 * provider and the real filings, filing_section and ownership tools in a ToolRegistry (the harness): the text
 * the model reads and every field the tools read supplied (the read check), with SEC_USER_AGENT and without it;
 * the SEC paths beside them unchanged; without DART_API_KEY, what to set; and the provider's name and
 * declarations in each setup. Every answer is a
 * hand-made fixture in OpenDART's documented formats: list.json answered for each window of receipt days from
 * the list fixtures (test/fork/fixtures/dart-filings/, scripts/fork/fixture-cases/dart-filings.ts), the
 * documents of an annual report (UTF-8) and a quarterly report (EUC-KR), and the OpenDART client's company
 * list, insider reports and company outline (test/fork/fixtures/dart/).
 */
import { describe, expect, test } from "bun:test";
import { FOLDER, LIST_FIXTURES, listAnswerFrom } from "../../../scripts/fork/fixture-cases/dart-filings.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import {
  FILERS_WITH_DART,
  filersProvider,
  insiderNeedsSec,
  koreanFilerNeedsDart,
} from "../../../src/fork/data/providers/filers.js";
import { SEC_TICKERS_URL } from "../../../src/fork/data/sources/sec-tickers.js";
import {
  buildTools,
  type FixtureFetch,
  type FixtureRoute,
  fixture,
  fixtureFetch,
  testDeps,
} from "./harness.js";

/** A key in OpenDART's form (40 characters): it travels only in the request's query. */
const KEY = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const UA = "Test Agent test@example.com";
const DART: PublicDataConfig = { dartKey: KEY };
const BOTH: PublicDataConfig = { dartKey: KEY, secUserAgent: UA };
const SAMSUNG = "00126380";
const ANNUAL = "20260310000812";
const QUARTERLY = "20261113001877";

const text = (file: string) => new TextDecoder().decode(fixture(file));

/** OpenDART's `service` asked with every one of `params`, answered from fixture `file`. */
function dart(service: string, params: Readonly<Record<string, string>>, file: string): FixtureRoute {
  return {
    match: (url) =>
      url.hostname === "opendart.fss.or.kr" &&
      url.pathname === `/api/${service}` &&
      Object.entries(params).every(([name, value]) => url.searchParams.get(name) === value),
    file,
  };
}

const DART_ROUTES: FixtureRoute[] = [
  dart("corpCode.xml", {}, "dart/corp-codes.zip"),
  dart("elestock.json", { corp_code: SAMSUNG }, "dart/elestock-00126380.json"),
  dart("company.json", { corp_code: SAMSUNG }, "dart/company-00126380.json"),
  dart("document.xml", { rcept_no: ANNUAL }, `${FOLDER}/document-00126380-annual.zip`),
  dart("document.xml", { rcept_no: QUARTERLY }, `${FOLDER}/document-00126380-quarterly.zip`),
];

/** SEC EDGAR: its ticker list (hand-made), Apple's filing index (saved) and its 10-K (hand-made). */
const SEC_ROUTES: FixtureRoute[] = [
  { match: SEC_TICKERS_URL, file: "sec/company-tickers-exchange.json" },
  { match: "https://data.sec.gov/submissions/CIK0000320193.json", file: "sec/submissions-aapl.json" },
  {
    match: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm",
    file: "sec/document-aapl-0000320193-26-000026.html",
  },
];

/**
 * A fetch answering `routes`, and OpenDART's list.json as OpenDART answers it from the list fixtures: each
 * window of receipt days and each page from the fixture holding the company's filings of the type asked for.
 */
function openDart(routes: readonly FixtureRoute[]): FixtureFetch {
  const inner = fixtureFetch(routes);
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const address = input instanceof Request ? input.url : String(input);
    const url = new URL(address);
    const held =
      url.hostname === "opendart.fss.or.kr" && url.pathname === "/api/list.json"
        ? LIST_FIXTURES.find(
            (one) =>
              one.corp === url.searchParams.get("corp_code") &&
              (one.group ?? null) === url.searchParams.get("pblntf_ty") &&
              (one.detail ?? null) === url.searchParams.get("pblntf_detail_ty"),
          )
        : undefined;
    if (!held) return inner(input, init);
    inner.requests.push({ url: address, headers: new Headers(init?.headers) });
    const body = listAnswerFrom(JSON.parse(text(`${FOLDER}/${held.file}`)), url);
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json;charset=UTF-8" },
    });
  };
  return Object.assign(answer, { requests: inner.requests, unmatched: inner.unmatched }) as FixtureFetch;
}

/** The filers provider alone in `config`, its tools, and what it asked. */
function filers(
  config: PublicDataConfig = DART,
  routes: readonly FixtureRoute[] = [...DART_ROUTES, ...SEC_ROUTES],
) {
  const fetch = openDart(routes);
  const { deps } = testDeps(config, fetch);
  const provider = filersProvider(deps);
  return { ...buildTools({ filers: provider }, { check: true }), provider, fetch };
}

/** The requests made, OpenDART's by service and parameters (the key left out). */
function asked(fetch: FixtureFetch): string[] {
  return fetch.requests.map(({ url }) => {
    const address = new URL(url);
    if (address.hostname !== "opendart.fss.or.kr") return url;
    address.searchParams.delete("crtfc_key");
    return `${address.pathname.replace("/api/", "")}${address.search}`;
  });
}

/** Calls in one setup, each checked as the model reads it: its text, every field read supplied, nothing unanswered. */
async function goldens(calls: [tool: string, input: Record<string, unknown>, expected: string][]) {
  const setup = filers(DART);
  for (const [tool, input, expected] of calls) {
    const run = await setup.runTool(tool, input);
    expect(run.failure).toBeUndefined();
    expect(run.text).toBe(expected);
    expect(run.reads.missing()).toEqual([]);
  }
  expect(setup.fetch.unmatched).toEqual([]);
  expect(setup.fetch.requests.map((request) => request.url).join("\n")).not.toContain("sec.gov");
  return setup;
}

/** A call's text after its first line (the call and its record's id). */
const afterHead = (said: string) => said.slice(said.indexOf("\n") + 1);

/** A list.json window, as `asked` writes it: every type, or the types `filter` names. */
const windowOf = (corp: string, from: string, through: string, filter = "") =>
  `list.json?corp_code=${corp}&bgn_de=${from}&end_de=${through}${filter}&sort=date&sort_mth=asc&page_no=1&page_count=100`;

describe("Korean filings as the model reads them", () => {
  test("newest first, every type: a quarter of receipt days first, an older window when the page needs it", async () => {
    const { fetch } = await goldens([
      ["filings", { symbol: "XKRX:005930", limit: 5 }, GOLDEN.samsungFilings],
      ["filings", { symbol: "XKRX:005930", limit: 5, after: "20261020000391" }, GOLDEN.samsungFilingsMore],
    ]);
    expect(asked(fetch)).toEqual([
      "corpCode.xml",
      windowOf(SAMSUNG, "20260827", "20261126"),
      // The cursor's receipt day starts the next page's windows.
      windowOf(SAMSUNG, "20260721", "20261020"),
      windowOf(SAMSUNG, "20260118", "20260720"),
    ]);
  });

  test("10-K is the annual report (A001), corrections included; the last page reads back to 1999 and ends", async () => {
    const { fetch } = await goldens([
      ["filings", { symbol: "005930.KS", forms: ["10-K"], limit: 2 }, GOLDEN.samsungAnnual],
      [
        "filings",
        { symbol: "005930.KS", forms: ["10-K"], limit: 2, after: "20250404000548" },
        GOLDEN.samsungAnnualMore,
      ],
    ]);
    const annual = "&pblntf_ty=A&pblntf_detail_ty=A001";
    expect(asked(fetch).slice(1)).toEqual([
      windowOf(SAMSUNG, "20260827", "20261126", annual),
      windowOf(SAMSUNG, "20260224", "20260826", annual),
      windowOf(SAMSUNG, "20250221", "20260223", annual),
      // Each window older than the last twice as long, to DART's first day.
      windowOf(SAMSUNG, "20250103", "20250404", annual),
      windowOf(SAMSUNG, "20240703", "20250102", annual),
      windowOf(SAMSUNG, "20230701", "20240702", annual),
      windowOf(SAMSUNG, "20210625", "20230630", annual),
      windowOf(SAMSUNG, "20170614", "20210624", annual),
      windowOf(SAMSUNG, "20090523", "20170613", annual),
      windowOf(SAMSUNG, "19990101", "20090522", annual),
    ]);
  });

  test("10-Q is the half-year and quarterly reports (A002, A003), each window asked for both", async () => {
    const { fetch } = await goldens([
      ["filings", { symbol: "XKRX:005930", forms: ["10-Q"], limit: 3 }, GOLDEN.samsungQuarterly],
    ]);
    expect(asked(fetch)).toHaveLength(1 + 3 * 2);
  });

  test("8-K is the major events report (B001) and the exchange's disclosures (group I)", async () => {
    await goldens([["filings", { symbol: "XKRX:005930", forms: ["8-K"], limit: 4 }, GOLDEN.samsungEvents]]);
  });

  test("OpenDART's own report types are asked for as given, each type once a window, whatever names it", async () => {
    const { runTool, fetch } = await goldens([
      ["filings", { symbol: "XKRX:005930", forms: ["B001", "A001", "10-K"], limit: 2 }, GOLDEN.samsungMixed],
    ]);
    const events = "&pblntf_ty=B&pblntf_detail_ty=B001";
    const annual = "&pblntf_ty=A&pblntf_detail_ty=A001";
    expect(asked(fetch).slice(1)).toEqual([
      windowOf(SAMSUNG, "20260827", "20261126", events),
      windowOf(SAMSUNG, "20260827", "20261126", annual),
      windowOf(SAMSUNG, "20260224", "20260826", events),
      windowOf(SAMSUNG, "20260224", "20260826", annual),
      windowOf(SAMSUNG, "20250221", "20260223", events),
      windowOf(SAMSUNG, "20250221", "20260223", annual),
    ]);
    // A001 is what 10-K asks for: the same filings, in any case.
    const types = await runTool("filings", { symbol: "005930.KS", forms: ["a001"], limit: 2 });
    expect(afterHead(types.text)).toBe(afterHead(GOLDEN.samsungAnnual));
  });

  test("a bare code is named by its market, from OpenDART's class of the company (JYP on KOSDAQ)", async () => {
    await goldens([["filings", { symbol: "035900", limit: 5 }, GOLDEN.jypFilings]]);
  });
});

describe("Korean filing sections as the model reads them", () => {
  test("an annual report's chapters by title, whole, tables as tab-separated rows; its document read once", async () => {
    const { fetch } = await goldens([
      [
        "filing_section",
        { symbol: "XKRX:005930", accession: ANNUAL, section: "business" },
        GOLDEN.annualBusiness,
      ],
      [
        "filing_section",
        { symbol: "XKRX:005930", accession: ANNUAL, section: "market_risk" },
        GOLDEN.annualMarketRisk,
      ],
      [
        "filing_section",
        { symbol: "XKRX:005930", accession: ANNUAL, section: "financial_statements" },
        GOLDEN.annualStatements,
      ],
      ["filing_section", { symbol: "XKRX:005930", accession: ANNUAL, section: "mdna" }, GOLDEN.annualMdna],
    ]);
    expect(asked(fetch)).toEqual([
      "corpCode.xml",
      // The filing is found among the company's filings of its receipt day.
      windowOf(SAMSUNG, "20260310", "20260310"),
      `document.xml?rcept_no=${ANNUAL}`,
    ]);
  });

  test("a quarterly report in EUC-KR: a section pointing to the notes is by_reference; the left-out MD&A is not found, with what the report says", async () => {
    await goldens([
      [
        "filing_section",
        { symbol: "005930", accession: QUARTERLY, section: "business" },
        GOLDEN.quarterBusiness,
      ],
      [
        "filing_section",
        { symbol: "005930", accession: QUARTERLY, section: "market_risk" },
        GOLDEN.quarterMarketRisk,
      ],
      ["filing_section", { symbol: "005930", accession: QUARTERLY, section: "mdna" }, GOLDEN.quarterMdna],
    ]);
  });

  test("a section a filing has none of is no text, with why", async () => {
    await goldens([
      [
        "filing_section",
        { symbol: "XKRX:005930", accession: ANNUAL, section: "risk_factors" },
        GOLDEN.annualRiskFactors,
      ],
      [
        "filing_section",
        { symbol: "XKRX:005930", accession: "20260901000534", section: "business" },
        GOLDEN.eventBusiness,
      ],
    ]);
  });

  test("every section filings lists for a report is found in its document", async () => {
    const { runTool, provider } = filers();
    const found: Record<string, string[]> = {};
    for (const [accession, forms] of [
      [ANNUAL, ["10-K"]],
      [QUARTERLY, ["10-Q"]],
    ] as const) {
      const listed = await provider.capabilities.filings?.list?.("XKRX:005930", {
        limit: 6,
        forms: [...forms],
      });
      const filing = listed?.data.find((one) => one.accession === accession);
      for (const { section } of filing?.sections ?? []) {
        const run = await runTool("filing_section", { symbol: "XKRX:005930", accession, section });
        expect(run.failure).toBeUndefined();
        expect(run.reads.missing()).toEqual([]);
        const key = `${filing?.form} ${accession}`;
        found[key] = [...(found[key] ?? []), `${section} ${(run.payload as { state: string }).state}`];
      }
    }
    expect(found).toEqual({
      "A001 사업보고서 (2025.12) 20260310000812": [
        "business available",
        "mdna available",
        "market_risk available",
        "financial_statements available",
      ],
      "A003 분기보고서 (2026.09) 20261113001877": [
        "business available",
        "market_risk by_reference",
        "financial_statements available",
      ],
    });
  });
});

describe("Korean insider reports as the model reads them", () => {
  test("one row per report, newest first: who and their role, the change and the holding after it", async () => {
    await goldens([
      ["ownership", { symbol: "XKRX:005930", limit: 2 }, GOLDEN.samsungInsiders],
      ["ownership", { symbol: "XKRX:005930", limit: 2, after: "20261020000391" }, GOLDEN.samsungInsidersMore],
    ]);
  });

  test("dates asked before DART's electronic filings are not covered, and said to be", async () => {
    const { runTool } = filers();
    const early = await runTool("ownership", {
      symbol: "XKRX:005930",
      start: "1990-01-01",
      end: "1995-12-31",
    });
    expect(early.failure).toBeUndefined();
    expect(early.text.split("\n").slice(3)).toEqual([
      "covered: 1999-01-01 to 1995-12-31",
      "Insider filings are not available from this source before 1999-01-01, so none can be shown or ruled out for the dates asked.",
    ]);
    // Every report read (none left for a later page): covered from where DART's filings begin.
    const since = await runTool("ownership", { symbol: "XKRX:005930", start: "1990-01-01", limit: 25 });
    expect(since.text.split("\n").slice(3, 5)).toEqual([
      "covered: 1999-01-01 to 2026-11-26",
      "part of the dates asked about is before what the source covers",
    ]);
  });

  test("one rule places a listing on its market: OpenDART's class of the company, as the statements do", async () => {
    // Samsung Electronics is KOSPI's (corp_cls Y): asked as a KOSDAQ key, filings and insiders say KOSPI.
    const { runTool } = filers();
    for (const tool of ["filings", "ownership"] as const) {
      const run = await runTool(tool, { symbol: "XKOS:005930", limit: 1 });
      expect(run.failure, tool).toBeUndefined();
      expect(run.text, tool).toContain("(XKRX:005930, KOSPI, KRW)");
    }
  });

  test("dates are receipt days; a bare code takes its market from the company's outline", async () => {
    const { fetch } = await goldens([
      ["ownership", { symbol: "005930", start: "2026-10-01" }, GOLDEN.samsungInsidersSince],
    ]);
    expect(asked(fetch)).toEqual([
      "corpCode.xml",
      `elestock.json?corp_code=${SAMSUNG}`,
      `company.json?corp_code=${SAMSUNG}`,
    ]);
  });

  test("the provider's answer: a report's fields as the contract carries them, none it does not have", async () => {
    const { provider } = filers();
    const answer = await provider.capabilities.ownership?.transactions?.("XKRX:005930", {
      limit: 1,
      after: "20261020000391",
    });
    expect(answer).toEqual({
      instrument: {
        key: "XKRX:005930",
        name: "삼성전자 (SAMSUNG ELECTRONICS CO,.LTD)",
        venue: "KOSPI",
        currency: "KRW",
        price_scale: 1,
        listing: null,
      },
      filings: {
        "20260902000215": {
          form: "D002 임원ㆍ주요주주특정증권등소유상황보고서",
          accepted_at: "2026-09-02",
          owners: [
            { name: "이영희", officer_title: "특수관계인", is_director: null, is_ten_percent_owner: null },
          ],
        },
      },
      coverage: {
        from: "2026-09-02",
        through: "2026-11-26",
        complete: true,
        requested_before_window: false,
        not_yet_served: null,
        complete_after: "2026-12-03",
      },
      data: [
        {
          accession: "20260902000215",
          transaction_date: null,
          code: null,
          shares: 0,
          security_title:
            "특정증권등 (specified securities), 1.63% held after the report, a change of 0.00 points",
          derivative: null,
          conversion_or_exercise_price: null,
          underlying_shares: null,
          underlying_title: null,
          price: null,
          acquired_disposed: null,
          owned_following: 97414196,
        },
      ],
      next_cursor: null,
    });
  });
});

/** What a provider declares: its capabilities, each with its methods. */
function declared(config: PublicDataConfig) {
  const { provider, fetch } = filers(config);
  return {
    name: provider.name,
    capabilities: Object.fromEntries(
      Object.entries(provider.capabilities).map(([capability, methods]) => [
        capability,
        Object.keys(methods ?? {}).sort(),
      ]),
    ),
    requests: fetch.requests.length,
  };
}

describe("the filers provider with and without DART_API_KEY and SEC_USER_AGENT", () => {
  test("what it declares and its name in each setup; building it asks nothing", () => {
    expect(declared({})).toEqual({
      name: "SEC EDGAR",
      capabilities: { ownership: ["transactions"] },
      requests: 0,
    });
    expect(declared(DART)).toEqual({
      name: "SEC EDGAR / OpenDART",
      capabilities: { statements: ["statement"], filings: ["list", "section"], ownership: ["transactions"] },
      requests: 0,
    });
    expect(declared({ secUserAgent: UA })).toEqual({
      name: "SEC EDGAR",
      capabilities: { statements: ["statement"], filings: ["list", "section"], ownership: ["transactions"] },
      requests: 0,
    });
    expect(declared(BOTH)).toEqual({
      name: FILERS_WITH_DART,
      capabilities: { statements: ["statement"], filings: ["list", "section"], ownership: ["transactions"] },
      requests: 0,
    });
  });

  test("with both, a US listing takes the SEC paths as without DART_API_KEY, and a Korean one OpenDART's", async () => {
    const sec = filers({ secUserAgent: UA });
    const both = filers(BOTH);
    for (const [tool, input] of [
      ["filings", { symbol: "AAPL", forms: ["10-K"], limit: 2 }],
      ["filing_section", { symbol: "AAPL", accession: "0000320193-26-000026", section: "mdna" }],
    ] as const) {
      const alone = await sec.runTool(tool, input);
      const beside = await both.runTool(tool, input);
      expect(alone.failure).toBeUndefined();
      expect(beside.text.replace("source: SEC EDGAR / OpenDART", "source: SEC EDGAR")).toBe(alone.text);
      expect(beside.reads.missing()).toEqual([]);
    }
    expect(both.fetch.requests.some((request) => request.url.includes("opendart"))).toBe(false);
    const korean = await both.runTool("filings", { symbol: "XKRX:005930", limit: 5 });
    expect(afterHead(korean.text)).toBe(afterHead(GOLDEN.samsungFilings));
    expect(both.fetch.unmatched).toEqual([]);
  });

  test("with DART_API_KEY and no SEC_USER_AGENT, a US listing's filings say what to set; one elsewhere is no filer's", async () => {
    const { runTool, fetch } = filers(DART);
    const filings = await runTool("filings", { symbol: "AAPL" });
    expect(filings.failure).toBe("data_not_configured");
    expect(filings.text).toStartWith(
      "SEC filings come from SEC EDGAR, which is read only with SEC_USER_AGENT set",
    );
    expect(filings.text).toEndWith("Filings of Korean listings are served from OpenDART.");
    const section = await runTool("filing_section", {
      symbol: "AAPL",
      accession: "0000320193-26-000026",
      section: "mdna",
    });
    expect(section.failure).toBe("data_not_configured");
    const insider = await runTool("ownership", { symbol: "AAPL" });
    expect(insider.failure).toBe("data_not_configured");
    expect(insider.text).toBe(insiderNeedsSec().message);
    const london = await runTool("filings", { symbol: "XLON:VOD" });
    expect(london.failure).toBe("data_unsupported");
    expect(london.text).toContain("XLON:VOD is not a US listing");
    // Nothing was asked of anyone; the Korean listing is served.
    expect(fetch.requests).toEqual([]);
    const korean = await runTool("filings", { symbol: "XKRX:005930", limit: 5 });
    expect(afterHead(korean.text)).toBe(afterHead(GOLDEN.samsungFilings));
  });

  test("without DART_API_KEY a Korean listing's filings, sections and insider view say to set it, with SEC_USER_AGENT or without", async () => {
    const { runTool, fetch } = filers({ secUserAgent: UA });
    const filings = await runTool("filings", { symbol: "XKRX:005930" });
    expect(filings.failure).toBe("data_not_configured");
    expect(filings.text).toBe(
      `Reading XKRX:005930's filings needs DART_API_KEY (a free key from OpenDART, https://opendart.fss.or.kr/), set in the environment or under "data" in credentials.json.`,
    );
    // An OpenDART receipt number, which the tool takes: what to set, not a malformed accession.
    const section = await runTool("filing_section", {
      symbol: "XKRX:005930",
      accession: ANNUAL,
      section: "business",
    });
    expect([section.failure, section.text]).toEqual(["data_not_configured", filings.text]);
    const insider = await runTool("ownership", { symbol: "XKRX:005930", codes: ["P"] });
    expect(insider.failure).toBe("data_not_configured");
    expect(insider.text).toBe(koreanFilerNeedsDart("XKRX:005930", "insiders").message);
    // Without either key, the Korean insider view names DART_API_KEY (SEC_USER_AGENT would not serve it); a US
    // listing's names SEC_USER_AGENT as before.
    const none = filers({});
    const keyless = await none.runTool("ownership", { symbol: "XKRX:005930" });
    expect(keyless.failure).toBe("data_not_configured");
    expect(keyless.text).toBe(
      `Reading XKRX:005930's insider reports needs DART_API_KEY (a free key from OpenDART, https://opendart.fss.or.kr/), set in the environment or under "data" in credentials.json. Institutional holders are served: ownership with view=institutional.`,
    );
    expect((await none.runTool("ownership", { symbol: "AAPL" })).text).toBe(insiderNeedsSec().message);
    expect([...fetch.requests, ...none.fetch.requests]).toEqual([]);
  });
});

describe("filing_section's accession: an SEC accession or an OpenDART receipt number", () => {
  test("both forms pass the tool's input; any other is refused naming both", async () => {
    const { runTool } = filers(BOTH);
    const sec = await runTool("filing_section", {
      symbol: "AAPL",
      accession: "0000320193-26-000026",
      section: "risk_factors",
    });
    expect(sec.failure).toBeUndefined();
    const korean = await runTool("filing_section", {
      symbol: "XKRX:005930",
      accession: ANNUAL,
      section: "mdna",
    });
    expect(korean.failure).toBeUndefined();
    for (const accession of [
      "2026031000081",
      "202603100008120",
      "0000320193-26-00002",
      "000032019326000026x",
    ]) {
      const run = await runTool("filing_section", { symbol: "XKRX:005930", accession, section: "mdna" });
      expect(run.failure).toBe("invalid_arguments");
      expect(run.text).toContain(
        "an SEC accession such as 0000320193-26-000026, or an OpenDART receipt number such as 20260310000812",
      );
    }
  });
});

const GOLDEN = {
  samsungFilings: `[e1] filings XKRX:005930 (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR / OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): filings
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
기업설명회(IR)개최(안내공시) 20261120800455 filed 2026-11-20 (accepted 2026-11-20)
  no sections to read; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261120800455
A003 분기보고서 (2026.09) 20261113001877 filed 2026-11-13 (accepted 2026-11-13), period 2026-09-30
  sections: business, market_risk, financial_statements; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261113001877
D002 임원ㆍ주요주주특정증권등소유상황보고서 20261103000127 filed 2026-11-03 (accepted 2026-11-03)
  no sections to read; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261103000127
연결재무제표기준영업(잠정)실적(공정공시) 20261030800012 filed 2026-10-30 (accepted 2026-10-30)
  no sections to read; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261030800012
D002 임원ㆍ주요주주특정증권등소유상황보고서 20261020000391 filed 2026-10-20 (accepted 2026-10-20)
  no sections to read; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261020000391
more filings: filings with after=20261020000391 and the same filters`,
  samsungFilingsMore: `[e2] filings XKRX:005930 (reference its data as {"ref":"e2","path":"<field>"})
source: SEC EDGAR / OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): filings
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
연결재무제표기준영업(잠정)실적(공정공시) 20261008800221 filed 2026-10-08 (accepted 2026-10-08)
  no sections to read; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261008800221
D002 임원ㆍ주요주주특정증권등소유상황보고서 20260902000215 filed 2026-09-02 (accepted 2026-09-02)
  no sections to read; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260902000215
B001 주요사항보고서(자기주식취득결정) 20260901000534 filed 2026-09-01 (accepted 2026-09-01)
  no sections to read; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260901000534
A002 반기보고서 (2026.06) 20260814002213 filed 2026-08-14 (accepted 2026-08-14), period 2026-06-30
  sections: business, market_risk, financial_statements; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260814002213
현금ㆍ현물배당결정 20260731800119 filed 2026-07-31 (accepted 2026-07-31)
  no sections to read; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260731800119
more filings: filings with after=20260731800119 and the same filters`,
  samsungAnnual: `[e1] filings 005930.KS 10-K (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR / OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): filings
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
A001 사업보고서 (2025.12) 20260310000812 filed 2026-03-10 (accepted 2026-03-10), period 2025-12-31
  sections: business, mdna, market_risk, financial_statements; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260310000812
A001 [기재정정]사업보고서 (2024.12) 20250404000548 filed 2025-04-04 (accepted 2025-04-04), period 2024-12-31
  sections: business, mdna, market_risk, financial_statements; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20250404000548
more filings: filings with after=20250404000548 and the same filters`,
  samsungAnnualMore: `[e2] filings 005930.KS 10-K (reference its data as {"ref":"e2","path":"<field>"})
source: SEC EDGAR / OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): filings
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
A001 사업보고서 (2024.12) 20250311001085 filed 2025-03-11 (accepted 2025-03-11), period 2024-12-31
  sections: business, mdna, market_risk, financial_statements; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20250311001085
A001 사업보고서 (2023.12) 20240312000736 filed 2024-03-12 (accepted 2024-03-12), period 2023-12-31
  sections: business, mdna, market_risk, financial_statements; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20240312000736`,
  samsungQuarterly: `[e1] filings XKRX:005930 10-Q (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR / OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): filings
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
A003 분기보고서 (2026.09) 20261113001877 filed 2026-11-13 (accepted 2026-11-13), period 2026-09-30
  sections: business, market_risk, financial_statements; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261113001877
A002 반기보고서 (2026.06) 20260814002213 filed 2026-08-14 (accepted 2026-08-14), period 2026-06-30
  sections: business, market_risk, financial_statements; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260814002213
A003 분기보고서 (2026.03) 20260515001740 filed 2026-05-15 (accepted 2026-05-15), period 2026-03-31
  sections: business, market_risk, financial_statements; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260515001740
more filings: filings with after=20260515001740 and the same filters`,
  samsungEvents: `[e1] filings XKRX:005930 8-K (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR / OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): filings
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
기업설명회(IR)개최(안내공시) 20261120800455 filed 2026-11-20 (accepted 2026-11-20)
  no sections to read; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261120800455
연결재무제표기준영업(잠정)실적(공정공시) 20261030800012 filed 2026-10-30 (accepted 2026-10-30)
  no sections to read; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261030800012
연결재무제표기준영업(잠정)실적(공정공시) 20261008800221 filed 2026-10-08 (accepted 2026-10-08)
  no sections to read; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261008800221
B001 주요사항보고서(자기주식취득결정) 20260901000534 filed 2026-09-01 (accepted 2026-09-01)
  no sections to read; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260901000534
more filings: filings with after=20260901000534 and the same filters`,
  samsungMixed: `[e1] filings XKRX:005930 B001,A001,10-K (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR / OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): filings
history before CIK 00126380 is not linked by the source, so any earlier predecessor's filings are not included
B001 주요사항보고서(자기주식취득결정) 20260901000534 filed 2026-09-01 (accepted 2026-09-01)
  no sections to read; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260901000534
A001 사업보고서 (2025.12) 20260310000812 filed 2026-03-10 (accepted 2026-03-10), period 2025-12-31
  sections: business, mdna, market_risk, financial_statements; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260310000812
more filings: filings with after=20260310000812 and the same filters`,
  jypFilings: `[e1] filings 035900 (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR / OpenDART
제이와이피엔터테인먼트 (JYP Entertainment Corporation) (XKOS:035900, KOSDAQ, KRW): filings
history before CIK 00258689 is not linked by the source, so any earlier predecessor's filings are not included
A003 분기보고서 (2026.09) 20261113000384 filed 2026-11-13 (accepted 2026-11-13), period 2026-09-30
  sections: business, market_risk, financial_statements; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261113000384
기업설명회(IR)개최(안내공시) 20261015900112 filed 2026-10-15 (accepted 2026-10-15)
  no sections to read; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261015900112
A002 반기보고서 (2026.06) 20260813000531 filed 2026-08-13 (accepted 2026-08-13), period 2026-06-30
  sections: business, market_risk, financial_statements; https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260813000531`,
  annualBusiness: `[e1] filing_section XKRX:005930 A001 사업보고서 (2025.12) business, Mar … (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR / OpenDART
A001 사업보고서 (2025.12) 20260310000812 (accepted 2026-03-10), section business: available; 610 characters in all; this part 0-610 of this page
  II. 사업의 내용
  
  1. 사업의 개요
  
  당사는 DX(Device eXperience) 부문과 DS(Device Solutions) 부문으로 나누어 경영하고 있습니다.
  
  DX 부문은 TV, 모니터, 스마트폰과 가전제품을 생산ㆍ판매하며, DS 부문은 메모리, 시스템LSI와 파운드리 사업을 영위하고 있습니다.
  
  2. 주요 제품 및 서비스
  
  부 문	주요 제품	매출액	비중
  DX 부문	TV, 모니터, 스마트폰 가전제품	181,312,904	57.6%
  DS 부문	DRAM, NAND Flash, 모바일AP	133,199,989	42.4%
  
  ※ 매출액은 부문간 내부거래를 제외한 금액이며, 단위는 백만원입니다.
  
  5. 위험관리 및 파생거래
  
  당사는 환율, 이자율과 주가의 변동에 따른 시장위험, 신용위험과 유동성위험에 노출되어 있으며, 재무위험관리 정책에 따라 이를 관리하고 있습니다.
  
  (단위 : 백만원)
  구 분	10% 상승시	10% 하락시
  USD	1,250,318	(1,250,318)
  EUR	212,476	(212,476)
  
  ※ 환율 변동이 법인세비용차감전순이익에 미치는 영향입니다.
  
  6. 주요계약 및 연구개발활동
  
  당사의 R&D 비용은 35조 2,155억원으로 매출액 대비 11.2%입니다.
end of section`,
  annualMarketRisk: `[e2] filing_section XKRX:005930 A001 사업보고서 (2025.12) market risk, M… (reference its data as {"ref":"e2","path":"<field>"})
source: SEC EDGAR / OpenDART
A001 사업보고서 (2025.12) 20260310000812 (accepted 2026-03-10), section market_risk: available; 210 characters in all; this part 0-210 of this page
  5. 위험관리 및 파생거래
  
  당사는 환율, 이자율과 주가의 변동에 따른 시장위험, 신용위험과 유동성위험에 노출되어 있으며, 재무위험관리 정책에 따라 이를 관리하고 있습니다.
  
  (단위 : 백만원)
  구 분	10% 상승시	10% 하락시
  USD	1,250,318	(1,250,318)
  EUR	212,476	(212,476)
  
  ※ 환율 변동이 법인세비용차감전순이익에 미치는 영향입니다.
end of section`,
  annualStatements: `[e3] filing_section XKRX:005930 A001 사업보고서 (2025.12) financial stat… (reference its data as {"ref":"e3","path":"<field>"})
source: SEC EDGAR / OpenDART
A001 사업보고서 (2025.12) 20260310000812 (accepted 2026-03-10), section financial_statements: available; 571 characters in all; this part 0-571 of this page
  III. 재무에 관한 사항
  
  1. 요약재무정보
  
  (단위 : 백만원)
  구 분	제57기	제56기
  자산총계	538,416,725	514,531,948
  부채총계	108,291,377	112,339,878
  자본총계	430,125,348	402,192,070
  매출액	314,512,893	300,870,903
  영업이익	43,601,051	32,725,961
  당기순이익	37,914,385	34,451,351
  
  2. 연결재무제표
  
  연결 재무상태표
  
  과 목	제57기	제56기
  유동자산	238,562,514	227,062,266
  현금및현금성자산	54,129,331	53,705,579
  자산총계	538,416,725	514,531,948
  부채총계	108,291,377	112,339,878
  자본총계	430,125,348	402,192,070
  
  3. 연결재무제표 주석
  
  연결재무제표 주석은 'XII. 상세표'의 '4. 연결재무제표 주석'을 참조하시기 바랍니다.
  
  6. 배당에 관한 사항
  
  당사는 제57기에 보통주 1주당 1,446원, 우선주 1주당 1,447원의 현금배당을 실시하였습니다.
  
  8. 기타 재무에 관한 사항
  
  해당사항 없습니다.
end of section`,
  annualMdna: `[e4] filing_section XKRX:005930 A001 사업보고서 (2025.12) mdna, Mar 10 (reference its data as {"ref":"e4","path":"<field>"})
source: SEC EDGAR / OpenDART
A001 사업보고서 (2025.12) 20260310000812 (accepted 2026-03-10), section mdna: available; 237 characters in all; this part 0-237 of this page
  IV. 이사의 경영진단 및 분석의견
  
  1. 개요
  
  2025년 매출은 314조 5,129억원으로 전년 대비 4.5% 증가하였습니다.
  
  영업이익은 메모리 가격 상승과 고부가 제품 판매 확대에 힘입어 43조 6,011억원으로 전년 대비 33.2% 증가하였습니다.
  
  2. 영업실적
  
  구 분	제57기	제56기	증감률
  매출액	314,512,893	300,870,903	4.5%
  영업이익	43,601,051	32,725,961	33.2%
end of section`,
  annualRiskFactors: `[e1] filing_section XKRX:005930 A001 사업보고서 (2025.12) risk factors, … (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR / OpenDART
A001 사업보고서 (2025.12) 20260310000812 (accepted 2026-03-10), section risk_factors: not_found; no text to read (content: section_not_found: a 사업보고서 (2025.12) has no risk_factors section that this source reads, settled).`,
  eventBusiness: `[e2] filing_section XKRX:005930 B001 주요사항보고서(자기주식취득결정) business, Se… (reference its data as {"ref":"e2","path":"<field>"})
source: SEC EDGAR / OpenDART
B001 주요사항보고서(자기주식취득결정) 20260901000534 (accepted 2026-09-01), section business: not_found; no text to read (content: section_not_found: a 주요사항보고서(자기주식취득결정) has no business section that this source reads, settled).`,
  quarterBusiness: `[e1] filing_section 005930 A003 분기보고서 (2026.09) business, Nov 13 (reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR / OpenDART
A003 분기보고서 (2026.09) 20261113001877 (accepted 2026-11-13), section business: available; 183 characters in all; this part 0-183 of this page
  II. 사업의 내용
  
  1. 사업의 개요
  
  당사는 DX 부문과 DS 부문으로 나누어 경영하고 있으며, 2026년 3분기 누적 매출은 245조 3,118억원입니다.
  
  5. 위험관리 및 파생거래
  
  위험관리 및 파생거래에 관한 사항은 'III. 재무에 관한 사항'의 '3. 연결재무제표 주석' 중 '재무위험관리'를 참조하시기 바랍니다.
end of section`,
  quarterMarketRisk: `[e2] filing_section 005930 A003 분기보고서 (2026.09) market risk, Nov 13 (reference its data as {"ref":"e2","path":"<field>"})
source: SEC EDGAR / OpenDART
A003 분기보고서 (2026.09) 20261113001877 (accepted 2026-11-13), section market_risk: by_reference; 92 characters in all; this part 0-92 of this page
  5. 위험관리 및 파생거래
  
  위험관리 및 파생거래에 관한 사항은 'III. 재무에 관한 사항'의 '3. 연결재무제표 주석' 중 '재무위험관리'를 참조하시기 바랍니다.
end of section`,
  quarterMdna: `[e3] filing_section 005930 A003 분기보고서 (2026.09) mdna, Nov 13 (reference its data as {"ref":"e3","path":"<field>"})
source: SEC EDGAR / OpenDART
A003 분기보고서 (2026.09) 20261113001877 (accepted 2026-11-13), section mdna: not_found; no text to read (content: section_not_found: half-year and quarterly reports leave out "이사의 경영진단 및 분석의견" (the directors' discussion and analysis), which annual reports give; in its place this one says: 기업공시서식 작성기준에 따라 분기보고서에 기재하지 않습니다, settled).`,
  samsungInsiders: `[e1] ownership XKRX:005930 (as of Thursday 2026-11-26; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR / OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): insider transactions
covered: 2026-09-03 to 2026-11-26
complete only after 2026-12-03
? ? 10,000 특정증권등 (specified securities), 0.00% held after the report, a change of 0.00 points (acquired), holding after 30,000; 홍길동 (대표이사, 등기임원); D002 임원ㆍ주요주주특정증권등소유상황보고서 20261103000127 accepted 2026-11-03
? ? 1,000 특정증권등 (specified securities), 0.00% held after the report, a change of 0.00 points (disposed), holding after 4,512; 김철수 (부사장, 비등기임원); D002 임원ㆍ주요주주특정증권등소유상황보고서 20261020000391 accepted 2026-10-20
more: ownership with after=20261020000391 and the same filters`,
  samsungInsidersMore: `[e2] ownership XKRX:005930 (as of Thursday 2026-11-26; reference its data as {"ref":"e2","path":"<field>"})
source: SEC EDGAR / OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): insider transactions
covered: 2026-09-02 to 2026-11-26
complete only after 2026-12-03
? ? 0 특정증권등 (specified securities), 1.63% held after the report, a change of 0.00 points (?), holding after 97,414,196; 이영희 (특수관계인); D002 임원ㆍ주요주주특정증권등소유상황보고서 20260902000215 accepted 2026-09-02`,
  samsungInsidersSince: `[e1] ownership 005930 Oct 1 (as of Thursday 2026-11-26; reference its data as {"ref":"e1","path":"<field>"})
source: SEC EDGAR / OpenDART
삼성전자 (SAMSUNG ELECTRONICS CO,.LTD) (XKRX:005930, KOSPI, KRW): insider transactions
covered: 2026-10-01 to 2026-11-26
complete only after 2026-12-03
? ? 10,000 특정증권등 (specified securities), 0.00% held after the report, a change of 0.00 points (acquired), holding after 30,000; 홍길동 (대표이사, 등기임원); D002 임원ㆍ주요주주특정증권등소유상황보고서 20261103000127 accepted 2026-11-03
? ? 1,000 특정증권등 (specified securities), 0.00% held after the report, a change of 0.00 points (disposed), holding after 4,512; 김철수 (부사장, 비등기임원); D002 임원ㆍ주요주주특정증권등소유상황보고서 20261020000391 accepted 2026-10-20`,
};
