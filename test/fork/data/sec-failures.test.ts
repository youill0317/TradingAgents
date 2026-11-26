// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * How the filers provider fails, offline: without SEC_USER_AGENT it declares only the insider view, which says
 * what to set, and asks nothing; SEC
 * failing, refusing, pausing, answering nothing or something unreadable gives the DataError kind the router acts
 * on (a listing elsewhere passes the call on; a request about the market, or one to change, stops it); a filing
 * document or insider report SEC lacks is said, not taken for none; and the SEC User-Agent (it names a person) is
 * never said. Every answer here is a fixture or written inline in SEC's formats; nothing reaches a network.
 */
import { describe, expect, test } from "bun:test";
import { DataError } from "../../../src/data/errors.js";
import { filersProvider } from "../../../src/fork/data/providers/filers.js";
import { SEC_TICKERS_URL } from "../../../src/fork/data/sources/sec-tickers.js";
import { buildTools, type FixtureRoute, testDeps } from "./harness.js";

const UA = "Test Agent test@example.com";
const TICKERS: FixtureRoute = { match: SEC_TICKERS_URL, file: "sec/company-tickers-exchange.json" };
const AAPL_INDEX: FixtureRoute = {
  match: "https://data.sec.gov/submissions/CIK0000320193.json",
  file: "sec/submissions-aapl.json",
};
const AAPL_OLDER: FixtureRoute = {
  match: "https://data.sec.gov/submissions/CIK0000320193-submissions-001.json",
  file: "sec/submissions-aapl-001.json",
};
const AAPL_FACTS = "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json";
const AAPL_10K = "https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm";
const json = { "content-type": "application/json" };

/** The filers provider alone over `routes`, its tools, what it asked, and its timer. */
function sec(routes: readonly FixtureRoute[], config: { secUserAgent?: string } = { secUserAgent: UA }) {
  const { deps, fetch, timer } = testDeps(config, routes);
  const provider = filersProvider(deps);
  return { ...buildTools({ filers: provider }, { check: true }), provider, fetch, timer };
}

/** The DataError `promise` rejects with. */
async function failure(promise: Promise<unknown> | undefined): Promise<DataError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error("it answered");
}

describe("without SEC_USER_AGENT", () => {
  test("statements and filings are not declared; the insider view says what to set; SEC is asked nothing", async () => {
    const { provider, runTool, fetch, available } = sec([TICKERS, AAPL_INDEX], {});
    // Ownership is offered either way (Yahoo serves its institutional view), so its insider view is declared
    // to say what it needs.
    expect(
      Object.fromEntries(
        Object.entries(provider.capabilities).map(([name, methods]) => [name, Object.keys(methods ?? {})]),
      ),
    ).toEqual({ ownership: ["transactions"] });
    expect([...available]).toEqual(["ownership"]);
    const insider = await runTool("ownership", { symbol: "AAPL" });
    expect(insider.failure).toBe("data_not_configured");
    const said = [
      (await runTool("statements", { symbol: "AAPL", statement: "income_statement" })).text,
      (await runTool("filings", { symbol: "AAPL" })).text,
      insider.text,
    ];
    expect(said).toEqual([
      "Financial statements: not available in this setup.",
      "SEC filings: not available in this setup.",
      'Insider transactions come from SEC EDGAR, which is read only with SEC_USER_AGENT set (a name and email, in the environment or under "data" in credentials.json): SEC\'s fair-access rule asks every program that reads EDGAR to name its sender. Institutional holders are served: ownership with view=institutional.',
    ]);
    expect(fetch.requests).toEqual([]);
  });

  test("with it set, statements, filings and insider transactions are declared, and nothing else", () => {
    const { provider } = sec([]);
    expect(
      Object.fromEntries(
        Object.entries(provider.capabilities).map(([name, methods]) => [name, Object.keys(methods ?? {})]),
      ),
    ).toEqual({ statements: ["statement"], filings: ["list", "section"], ownership: ["transactions"] });
  });
});

describe("SEC failing or refusing", () => {
  test("a 503 asked again once, then unavailable: not a fact about the market", async () => {
    const { runTool, timer, fetch } = sec([TICKERS, { match: AAPL_INDEX.match, body: "busy", status: 503 }]);
    const run = await runTool("filings", { symbol: "AAPL" });
    expect(run.failure).toBe("data_unavailable");
    expect(run.text).toBe(
      "SEC EDGAR could not be reached or answered unreadably; this is not a fact about the market. SEC EDGAR answered HTTP 503.",
    );
    expect(fetch.requests.filter((request) => request.url === AAPL_INDEX.match)).toHaveLength(2);
    expect(timer.slept).toContain(1_000);
  });

  test("a 403 is refused (SEC's User-Agent rule said in the error, never the User-Agent itself)", async () => {
    const { provider, runTool } = sec([
      TICKERS,
      AAPL_INDEX,
      { match: AAPL_FACTS, body: "Forbidden", status: 403 },
    ]);
    const error = await failure(
      provider.capabilities.statements?.statement?.("AAPL", {
        statement: "income_statement",
        periodType: "annual",
        limit: 1,
      }),
    );
    expect(error.kind).toBe("rejected");
    expect(error.message).toContain("SEC_USER_AGENT");
    expect(error.message).not.toContain(UA);
    const run = await runTool("statements", { symbol: "AAPL", statement: "income_statement" });
    expect(run.failure).toBe("data_rejected");
  });

  test("a pause longer than the request's deadline is rate_limited at once, with SEC's wait", async () => {
    const { provider } = sec([
      TICKERS,
      { match: AAPL_INDEX.match, body: "slow down", status: 429, headers: { "retry-after": "120" } },
    ]);
    const error = await failure(provider.capabilities.filings?.list?.("AAPL", { limit: 5 }));
    expect(error.kind).toBe("rate_limited");
    expect(error.details.retryAfterMs).toBe(120_000);
  });

  test("a document SEC fails to send is unavailable; one it does not have is said to be missing", async () => {
    const failing = sec([TICKERS, AAPL_INDEX, { match: AAPL_10K, body: "oops", status: 500 }]);
    const section = { symbol: "AAPL", accession: "0000320193-26-000026", section: "risk_factors" };
    expect((await failing.runTool("filing_section", section)).failure).toBe("data_unavailable");
    const gone = sec([
      TICKERS,
      AAPL_INDEX,
      { match: AAPL_10K, body: "<Error>NoSuchKey</Error>", status: 404 },
    ]);
    const run = await gone.runTool("filing_section", section);
    expect(run.failure).toBe("data_no_data");
    expect(run.text).toBe(
      "SEC EDGAR has no data for this request: SEC EDGAR has no document aapl-20260926.htm in filing 0000320193-26-000026.",
    );
  });
});

describe("SEC answering nothing, or something unreadable", () => {
  test("a filing index in another form, or not JSON at all, is unavailable", async () => {
    for (const body of [
      JSON.stringify({ cik: "0000320193", name: "Apple Inc." }),
      "<html>maintenance</html>",
      "",
    ]) {
      const { provider } = sec([TICKERS, { match: AAPL_INDEX.match, body, headers: json }]);
      const error = await failure(provider.capabilities.filings?.list?.("AAPL", { limit: 5 }));
      expect(error.kind).toBe("unavailable");
      expect(error.message).toMatch(
        /SEC EDGAR answered (the filing index of CIK 0000320193 in a form|with something)/,
      );
    }
  });

  test("XBRL facts in another form are unavailable; none of the lines read is no data; none at all is no data", async () => {
    const answer = (body: string, status = 200) =>
      sec([
        TICKERS,
        AAPL_INDEX,
        { match: AAPL_FACTS, body, status, headers: json },
      ]).provider.capabilities.statements?.statement?.("AAPL", {
        statement: "income_statement",
        periodType: "annual",
        limit: 1,
      });
    expect((await failure(answer(JSON.stringify({ cik: 320193, facts: [] })))).kind).toBe("unavailable");
    const empty = await failure(answer(JSON.stringify({ cik: 320193, entityName: "Apple Inc.", facts: {} })));
    expect([empty.kind, empty.message]).toEqual([
      "no_data",
      "SEC EDGAR's XBRL financial data for Apple Inc. holds none of the income statement lines this app reads.",
    ]);
    const missing = await failure(answer("<Error><Code>NoSuchKey</Code></Error>", 404));
    expect([missing.kind, missing.message]).toEqual([
      "no_data",
      "SEC EDGAR holds no XBRL financial data for CIK 0000320193.",
    ]);
  });

  test("an index with no filings answers an empty list, not a failure", async () => {
    const index = {
      cik: "0000320193",
      name: "Apple Inc.",
      tickers: ["AAPL"],
      exchanges: ["Nasdaq"],
      filings: {
        recent: {
          accessionNumber: [],
          filingDate: [],
          acceptanceDateTime: [],
          form: [],
          primaryDocument: [],
        },
        files: [],
      },
    };
    const { runTool } = sec([
      TICKERS,
      { match: AAPL_INDEX.match, body: JSON.stringify(index), headers: json },
    ]);
    const filings = await runTool("filings", { symbol: "AAPL" });
    expect(filings.failure).toBeUndefined();
    expect(filings.text.split("\n").slice(-1)).toEqual(["No filings match."]);
    const insiders = await runTool("ownership", { symbol: "AAPL" });
    expect(insiders.failure).toBeUndefined();
    expect(insiders.text).toContain("No transactions found in what is covered.");
  });

  test("a document with no Item headings has no such section, said with why", async () => {
    const { runTool } = sec([
      TICKERS,
      AAPL_INDEX,
      {
        match: AAPL_10K,
        body: "<html><body><p>Form 10-K cross-reference index</p><p>Page 41</p></body></html>",
      },
    ]);
    const run = await runTool("filing_section", {
      symbol: "AAPL",
      accession: "0000320193-26-000026",
      section: "mdna",
    });
    expect(run.failure).toBeUndefined();
    expect(run.text.split("\n").slice(-1)).toEqual([
      "10-K 0000320193-26-000026 (accepted 2026-11-03T13:05:15Z), section mdna: not_found; no text to read (content: section_not_found: no Item 7 heading found in the 10-K's primary document, settled).",
    ]);
    expect(run.reads.missing()).toEqual([]);
  });

  test("an insider report SEC lacks, or that is not ownership XML, is left out and the coverage said incomplete", async () => {
    const { runTool, provider } = sec([
      TICKERS,
      AAPL_INDEX,
      {
        match: "https://www.sec.gov/Archives/edgar/data/320193/000114036126044952/form4.xml",
        body: "<Error>NoSuchKey</Error>",
        status: 404,
      },
      {
        match: "https://www.sec.gov/Archives/edgar/data/320193/000114036126044773/form4.xml",
        body: "<html><body>Document moved</body></html>",
      },
    ]);
    const answer = await provider.capabilities.ownership?.transactions?.("AAPL", {
      limit: 5,
      start: "2026-11-18",
      end: "2026-11-25",
    });
    expect(answer?.data).toEqual([]);
    expect(answer?.coverage).toMatchObject({ from: "2026-11-18", complete: false });
    const run = await runTool("ownership", { symbol: "AAPL", start: "2026-11-18", end: "2026-11-25" });
    expect(run.text).toContain("None found, but the source's coverage of these dates is incomplete.");
  });
});

describe("requests about the market, or to change", () => {
  test("a ticker SEC lists no company under is no data; a listing elsewhere passes the call on", async () => {
    const { provider } = sec([TICKERS]);
    const unknown = await failure(provider.capabilities.filings?.list?.("ZZZZ", { limit: 5 }));
    expect([unknown.kind, unknown.message]).toEqual([
      "no_data",
      "SEC EDGAR lists no company that files under the ticker ZZZZ.",
    ]);
    // BAE Systems trades in London as BA: not Boeing, and not a company SEC's list covers.
    for (const symbol of ["XLON:BA", "XKRX:005930", "005930.KS", "CRYPTO:BTC-USD"]) {
      expect((await failure(provider.capabilities.filings?.list?.(symbol, { limit: 5 }))).kind).toBe(
        "unsupported",
      );
    }
  });

  test("an accession not in the company's index, a cursor not given out, a window backwards: requests to change", async () => {
    // Its older page is read too before an accession or a cursor is said not to be in the index.
    const { provider, fetch } = sec([TICKERS, AAPL_INDEX, AAPL_OLDER]);
    const capabilities = provider.capabilities;
    const kinds = await Promise.all([
      failure(
        capabilities.filings?.section?.(
          { symbol: "AAPL", accession: "0000104169-26-000055", section: "mdna" },
          {},
        ),
      ),
      failure(capabilities.filings?.list?.("AAPL", { limit: 5, after: "next-page" })),
      failure(capabilities.filings?.list?.("AAPL", { limit: 5, after: "0000000000-00-000000" })),
      failure(
        capabilities.ownership?.transactions?.("AAPL", { limit: 5, start: "2026-02-01", end: "2026-01-01" }),
      ),
      failure(capabilities.ownership?.transactions?.("AAPL", { limit: 5, after: "0001140361-26-044952" })),
      failure(
        capabilities.statements?.statement?.("AAPL", {
          statement: "cash_flow",
          periodType: "annual",
          limit: 1,
          after: "last year",
        }),
      ),
    ]);
    expect(kinds.map((error) => error.kind)).toEqual([
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "invalid",
    ]);
    expect(kinds[0]?.message).toBe(
      "0000104169-26-000055 is not among the filings in Apple Inc.'s index; list them with filings",
    );
    expect(fetch.unmatched).toEqual([]);
  });

  test("transaction codes for a listing outside the US are a request to change; without them it passes on", async () => {
    const { runTool } = sec([TICKERS]);
    const coded = await runTool("ownership", { symbol: "XKRX:005930", codes: ["P"] });
    expect(coded.failure).toBe("data_invalid");
    const plain = await runTool("ownership", { symbol: "XKRX:005930" });
    expect(plain.failure).toBe("data_unsupported");
  });
});

describe("what is never said", () => {
  test("the SEC User-Agent is in no answer, link, error or cache key", async () => {
    const { runTool, fetch } = sec([
      TICKERS,
      AAPL_INDEX,
      AAPL_OLDER,
      { match: AAPL_FACTS, file: "sec/companyfacts-aapl.json" },
      { match: AAPL_10K, file: "sec/document-aapl-0000320193-26-000026.html" },
    ]);
    const runs = [
      await runTool("statements", { symbol: "AAPL", statement: "balance_sheet", period_type: "annual" }),
      await runTool("filings", { symbol: "AAPL", limit: 20 }),
      await runTool("filing_section", {
        symbol: "AAPL",
        accession: "0000320193-26-000026",
        section: "business",
      }),
      await runTool("filing_section", {
        symbol: "AAPL",
        accession: "0000320193-99-000001",
        section: "business",
      }),
    ];
    expect(runs.map((run) => run.failure)).toEqual([undefined, undefined, undefined, "data_invalid"]);
    expect(fetch.unmatched).toEqual([]);
    for (const run of runs) {
      expect(run.text).not.toContain(UA);
      expect(JSON.stringify(run.payload ?? null)).not.toContain(UA);
    }
    // It is sent, to SEC's hosts only, as their fair-access rule asks.
    expect(new Set(fetch.requests.map((request) => request.headers.get("user-agent")))).toEqual(
      new Set([UA]),
    );
  });
});
