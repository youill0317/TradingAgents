// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * How the frames provider fails, offline: without SEC_USER_AGENT it declares nothing and asks nothing; Wikipedia
 * limiting requests is waited out when its Retry-After fits the request's deadline, said as rate_limited when it
 * does not, and a list kept before is served past its week meanwhile; SEC failing, refusing, answering nothing or
 * something unreadable gives the DataError kind the router acts on (the source's failure never passed off as a fact
 * about the market; a year no filer has a value for, or a line to change, said as such); the SEC User-Agent (it
 * names a person) is never said. Every answer is a fixture or written inline in the source's format.
 */
import { describe, expect, test } from "bun:test";
import { DataError } from "../../../src/data/errors.js";
import { createCache } from "../../../src/fork/data/cache.js";
import { framesProvider, MISSING, UNIVERSE } from "../../../src/fork/data/providers/frames.js";
import { frameUrl } from "../../../src/fork/data/sources/sec-frames.js";
import { SEC_TICKERS_URL } from "../../../src/fork/data/sources/sec-tickers.js";
import { SP_LISTS, wikitextUrl } from "../../../src/fork/data/sources/wikipedia.js";
import { buildTools, type FixtureRoute, type TestOptions, testDeps } from "./harness.js";

const UA = "Test Agent test@example.com";
const json = { "content-type": "application/json" };
const SP500 = wikitextUrl(SP_LISTS[0]?.page ?? "");
const SP400 = wikitextUrl(SP_LISTS[1]?.page ?? "");

const WIKIPEDIA: FixtureRoute[] = SP_LISTS.map((list) => ({
  match: wikitextUrl(list.page),
  file: `wikipedia/${list.key}-wikitext.json`,
}));
/** The revenue frames of fiscal year 2025 that the tests hold, and SEC's 404 page for any other. */
const REVENUE: FixtureRoute[] = [
  { match: frameUrl("Revenues", "USD", "CY2024"), file: "frames/revenues-cy2024.json" },
  { match: frameUrl("Revenues", "USD", "CY2025"), file: "frames/revenues-cy2025.json" },
  {
    match: frameUrl("RevenueFromContractWithCustomerExcludingAssessedTax", "USD", "CY2024"),
    file: "frames/rfcceat-cy2024.json",
  },
  {
    match: frameUrl("RevenueFromContractWithCustomerExcludingAssessedTax", "USD", "CY2025"),
    file: "frames/rfcceat-cy2025.json",
  },
];
const NO_FRAME: FixtureRoute = {
  match: /^https:\/\/data\.sec\.gov\/api\/xbrl\/frames\//,
  file: "frames/no-such-frame.xml",
};
const TICKERS: FixtureRoute = { match: SEC_TICKERS_URL, file: "sec/company-tickers-exchange.json" };
const ROUTES: FixtureRoute[] = [...WIKIPEDIA, ...REVENUE, NO_FRAME, TICKERS];

const IT_REVENUE = { sector: "information_technology", line: "Revenue", fiscal_year: 2025 } as const;

/** The frames provider alone over `routes`, its tools, what it asked, and its timer. */
function frames(
  routes: readonly FixtureRoute[],
  config: { secUserAgent?: string } = { secUserAgent: UA },
  extra: TestOptions = {},
) {
  const { deps, fetch, timer } = testDeps(config, routes, extra);
  const provider = framesProvider(deps);
  return { ...buildTools({ frames: provider }, { check: true }), provider, fetch, timer };
}

/** The DataError a provider call rejects with. */
async function failure(promise: Promise<unknown> | undefined): Promise<DataError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error("it answered");
}

const read = (provider: ReturnType<typeof framesProvider>, fiscalYear = 2025) =>
  provider.capabilities.crossSections?.financials?.({
    sector: "information_technology",
    line: "Revenue",
    fiscalYear,
    maxPages: 20,
  });

describe("without SEC_USER_AGENT", () => {
  test("nothing is declared, so the screen says it is not available here, and nothing is asked", async () => {
    const { provider, runTool, fetch, available } = frames(ROUTES, {});
    expect(provider).toEqual({ name: "SEC EDGAR", capabilities: {} });
    expect(available.size).toBe(0);
    const run = await runTool("screen", IT_REVENUE);
    expect(run.text).toBe("Sector screens: not available in this setup.");
    expect(fetch.requests).toEqual([]);
  });

  test("with it set, sector screens are declared, and nothing else", () => {
    const { provider } = frames([]);
    expect(
      Object.fromEntries(
        Object.entries(provider.capabilities).map(([name, methods]) => [name, Object.keys(methods ?? {})]),
      ),
    ).toEqual({ crossSections: ["financials"] });
  });
});

describe("Wikipedia limiting requests", () => {
  /** Wikipedia's saved 429 for the first request of `url`, with the wait it asks for; its list after that. */
  const limited = (url: string, wait: string): FixtureRoute => {
    let asked = 0;
    return {
      match: (address) => address.href === url && asked++ === 0,
      file: "wikipedia/rate-limited.txt",
      headers: { "retry-after": wait },
    };
  };

  test("a Retry-After the request's deadline fits is waited out, and the list asked for again", async () => {
    const { runTool, fetch, timer } = frames([limited(SP500, "8"), ...ROUTES]);
    const run = await runTool("screen", IT_REVENUE);
    expect(run.failure).toBeUndefined();
    expect(timer.slept).toContain(8_000);
    expect(fetch.requests.filter((request) => request.url === SP500)).toHaveLength(2);
  });

  test("one longer than the deadline is rate_limited at once, with Wikipedia's wait, and the next lists are not asked", async () => {
    const { provider, runTool, fetch } = frames([limited(SP500, "45"), ...ROUTES]);
    const error = await failure(read(provider));
    expect(error.kind).toBe("rate_limited");
    expect(error.details.retryAfterMs).toBe(45_000);
    expect(error.message).toBe("Wikipedia asked to wait 45 s before the next request (HTTP 429).");
    expect(fetch.requests.map((request) => request.url)).toEqual([SP500]);
    // The pause holds for every later request to Wikipedia: the tool's call fails at once, unsent.
    const run = await runTool("screen", IT_REVENUE);
    expect(run.failure).toBe("data_rate_limited");
    expect(fetch.requests).toHaveLength(1);
  });

  test("a list kept from before is served past its week while Wikipedia asks to wait, and the answer says when it was read", async () => {
    let now = Date.parse("2026-11-25T22:00:00Z");
    const cache = createCache({ now: () => now });
    const fresh = frames(ROUTES, { secUserAgent: UA }, { cache });
    expect((await read(fresh.provider))?.incomplete_because).toBe(
      `${UNIVERSE}; FORM on two lists, counted as S&P 400 (added there most recently)`,
    );
    now += 8 * 86_400_000;
    const later = frames(
      [
        {
          match: (url) => url.hostname === "en.wikipedia.org",
          file: "wikipedia/rate-limited.txt",
          headers: { "retry-after": "45" },
        },
        ...ROUTES,
      ],
      { secUserAgent: UA },
      { cache, now: "2026-12-03T22:00:00Z" },
    );
    const answer = await read(later.provider);
    expect(answer?.incomplete_because).toBe(
      `${UNIVERSE}; FORM on two lists, counted as S&P 400 (added there most recently); lists as read 2026-11-25`,
    );
    expect(answer?.rows.filter((row) => row.value !== null)).toHaveLength(10);
  });
});

describe("Wikipedia answering something else", () => {
  const instead = (body: string, status = 200): FixtureRoute[] => [
    { match: SP500, body, status, headers: json },
    ...ROUTES,
  ];

  test("an error answer, a page without the list's table, an answer without wikitext, a 404: unavailable", async () => {
    const cases: [FixtureRoute[], string][] = [
      [
        instead(
          JSON.stringify({ error: { code: "missingtitle", info: "The page you specified doesn't exist." } }),
        ),
        'Wikipedia answered "missingtitle" for its S&P 500 list.',
      ],
      [
        instead(
          JSON.stringify({ parse: { title: "List of S&P 500 companies", pageid: 1, wikitext: "No table." } }),
        ),
        `Wikipedia's S&P 500 list could not be read: the page has no table with the id "constituents".`,
      ],
      [
        instead(JSON.stringify({ parse: { title: "List of S&P 500 companies" } })),
        "Wikipedia's S&P 500 list could not be read: the answer holds no wikitext.",
      ],
      [instead("<html>busy</html>"), "Wikipedia answered with something other than JSON."],
      [instead("Not Found", 404), "Wikipedia's S&P 500 list could not be read: the API answered HTTP 404."],
    ];
    for (const [routes, message] of cases) {
      const { provider, runTool } = frames(routes);
      const error = await failure(read(provider));
      expect([error.kind, error.message]).toEqual(["unavailable", message]);
      expect((await runTool("screen", IT_REVENUE)).failure).toBe("data_unavailable");
    }
  });

  test("a table whose rows name no company this app can read is unavailable, not an empty sector", async () => {
    const wikitext =
      '{| class="wikitable" id="constituents"\n|-\n! Symbol !! Security !! GICS Sector\n|-\n| ??? || Nothing || Nowhere\n|}';
    const { provider } = frames([
      { match: SP400, body: JSON.stringify({ parse: { wikitext } }), headers: json },
      ...ROUTES,
    ]);
    const error = await failure(read(provider));
    expect([error.kind, error.message]).toEqual([
      "unavailable",
      "Wikipedia's S&P 400 list could not be read: its table lists no company this app can read.",
    ]);
  });
});

describe("SEC failing, refusing or answering nothing", () => {
  const frameRoute = (body: string, status = 200): FixtureRoute => ({
    match: frameUrl("Revenues", "USD", "CY2024"),
    body,
    status,
    headers: json,
  });

  test("a 503 asked again once, then unavailable: not a fact about the market", async () => {
    const { runTool, fetch, timer } = frames([frameRoute("busy", 503), ...ROUTES]);
    const run = await runTool("screen", IT_REVENUE);
    expect(run.failure).toBe("data_unavailable");
    expect(run.text).toBe(
      "SEC EDGAR could not be reached or answered unreadably; this is not a fact about the market. SEC EDGAR answered HTTP 503.",
    );
    expect(
      fetch.requests.filter((request) => request.url === frameUrl("Revenues", "USD", "CY2024")),
    ).toHaveLength(2);
    expect(timer.slept).toContain(1_000);
  });

  test("a 403 is refused: SEC's User-Agent rule said in the error, never the User-Agent itself", async () => {
    const { provider, runTool } = frames([frameRoute("Forbidden", 403), ...ROUTES]);
    const error = await failure(read(provider));
    expect(error.kind).toBe("rejected");
    expect(error.message).toContain("SEC_USER_AGENT");
    expect(error.message).not.toContain(UA);
    const run = await runTool("screen", IT_REVENUE);
    expect(run.failure).toBe("data_rejected");
    expect(run.text).not.toContain(UA);
  });

  test("a frame that is not JSON, or JSON without its rows, is unavailable", async () => {
    for (const [body, message] of [
      ["<html>maintenance</html>", "SEC EDGAR answered with something other than JSON."],
      [
        '{"taxonomy":"us-gaap","tag":"Revenues"}',
        "SEC EDGAR answered the frame of Revenues for CY2024 in a form this app does not read.",
      ],
    ] as const) {
      const { provider } = frames([frameRoute(body), ...ROUTES]);
      const error = await failure(read(provider));
      expect([error.kind, error.message]).toEqual(["unavailable", message]);
    }
  });

  test("frames without a row for the year, or no frame at all, are no_data: no filer has a value yet", async () => {
    const empty = JSON.stringify({
      taxonomy: "us-gaap",
      tag: "Revenues",
      ccp: "CY2025",
      uom: "USD",
      pts: 0,
      data: [],
    });
    const { provider: emptyFrames } = frames([
      { match: /^https:\/\/data\.sec\.gov\/api\/xbrl\/frames\//, body: empty, headers: json },
      ...WIKIPEDIA,
    ]);
    const nothing = await failure(read(emptyFrames));
    expect([nothing.kind, nothing.message]).toEqual([
      "no_data",
      "SEC EDGAR's XBRL frames hold no Revenue of any filer for a fiscal year ending in 2025.",
    ]);
    // A year SEC has made no frame for yet: every frame answers its 404 page.
    const { provider, runTool } = frames(ROUTES);
    const future = await failure(read(provider, 2030));
    expect([future.kind, future.message]).toEqual([
      "no_data",
      "SEC EDGAR's XBRL frames hold no Revenue of any filer for a fiscal year ending in 2030.",
    ]);
    expect((await runTool("screen", { ...IT_REVENUE, fiscal_year: 2030 })).failure).toBe("data_no_data");
  });

  test("SEC's ticker list failing: the companies it was needed for say so, the rest are read", async () => {
    const { provider, fetch } = frames([{ match: SEC_TICKERS_URL, body: "busy", status: 500 }, ...ROUTES]);
    const answer = await provider.capabilities.crossSections?.financials?.({
      sector: "industrials",
      line: "Revenue",
      fiscalYear: 2025,
      maxPages: 20,
    });
    // AECOM: the S&P 400 list gives its ticker, not its CIK.
    expect(answer?.rows.find((row) => row.symbols.includes("ACM"))).toMatchObject({
      ciks: [],
      value: null,
      missing_because: MISSING.noTickerList,
    });
    expect(answer?.rows.filter((row) => row.value !== null)).toHaveLength(10);
    // Asked once, and again after a pause (a 5xx is asked again once); not for every company.
    expect(fetch.requests.filter((request) => request.url === SEC_TICKERS_URL)).toHaveLength(2);
  });
});
