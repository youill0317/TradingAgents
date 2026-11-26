// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of SEC's XBRL frames (data.sec.gov/api/xbrl/frames), for the sector screen's tests
 * (test/fork/data/frames*.test.ts), recorded on the owner's machine with SEC_USER_AGENT set: every frame those tests
 * read, and SEC's 404 page for a frame it does not have. A frame names every filer (up to 0.84 MB measured), so
 * each case keeps SEC's header (`pts` still SEC's row count) and the rows of the companies the S&P list excerpts
 * name (test/fork/fixtures/wikipedia, read when the case runs), with SEC's first ten rows, which name companies
 * outside the lists.
 *
 * The fixtures in the repository were made before any of this was recorded: five are SEC's answers saved with the
 * SEC area's samples (cut there to their sample companies' rows); the others are assembled from SEC's companyfacts
 * answers (the facts each company's answer marks with the frame), marked hand-made. Recording replaces them with
 * SEC's current frames, so the golden texts of those tests then need bringing up to date (values and accessions
 * move as companies file).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { frameUrl } from "../../../src/fork/data/sources/sec-frames.js";
import { parseSpList, SP_LISTS, wikitextOf } from "../../../src/fork/data/sources/wikipedia.js";
import type { FixtureCase, Recorded } from "../record-fixtures.ts";

const WIKIPEDIA = join(import.meta.dir, "../../../test/fork/fixtures/wikipedia");

/** The frames the tests read: concept, periods, and the file name's stem. */
const FRAMES: readonly (readonly [concept: string, periods: readonly string[], stem: string])[] = [
  ["Revenues", ["CY2023", "CY2024", "CY2025"], "revenues"],
  ["RevenueFromContractWithCustomerExcludingAssessedTax", ["CY2023", "CY2024", "CY2025"], "rfcceat"],
  ["NetIncomeLoss", ["CY2023", "CY2024", "CY2025"], "netincomeloss"],
  ["Assets", ["CY2023Q4I", "CY2024Q1I", "CY2024Q2I", "CY2024Q3I", "CY2024Q4I"], "assets"],
  ["Liabilities", ["CY2024Q4I"], "liabilities"],
  ["LiabilitiesAndStockholdersEquity", ["CY2024Q4I"], "liabilities-and-equity"],
  [
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ["CY2024Q4I"],
    "equity-including-nci",
  ],
];

/** SEC's first rows a frame keeps besides the companies the lists name. */
const OTHERS = 10;

/** The CIKs of the companies the S&P list excerpts name. */
function listedCiks(): Set<number> {
  const ciks = new Set<number>();
  for (const list of SP_LISTS) {
    const body = JSON.parse(readFileSync(join(WIKIPEDIA, `${list.key}-wikitext.json`), "utf8"));
    for (const company of parseSpList(list, wikitextOf(list, body)).companies) {
      if (company.cik) ciks.add(Number(company.cik));
    }
  }
  return ciks;
}

/** A frame answer with only the rows the tests read. */
export function trimmed(answer: unknown, ciks: ReadonlySet<number>): unknown {
  const frame = answer as { data?: unknown };
  if (!frame || typeof frame !== "object" || !Array.isArray(frame.data)) throw new Error("not a frame");
  const rows = frame.data as { cik?: unknown }[];
  const kept = rows.filter((row, index) => index < OTHERS || ciks.has(Number(row?.cik)));
  return { ...frame, data: kept };
}

const frame = (concept: string, period: string, stem: string): FixtureCase => ({
  source: "frames",
  name: `${stem}-${period.toLowerCase()}`,
  file: `${stem}-${period.toLowerCase()}.json`,
  read: async (http): Promise<Recorded> => {
    const url = frameUrl(concept, "USD", period);
    const answer = await http.get(url, { source: "SEC EDGAR" });
    return {
      body: JSON.stringify(trimmed(await answer.json(), listedCiks())),
      status: answer.status,
      contentType: answer.headers.get("content-type") ?? "application/json",
      url,
    };
  },
});

export const cases: FixtureCase[] = [
  ...FRAMES.flatMap(([concept, periods, stem]) => periods.map((period) => frame(concept, period, stem))),
  {
    // SEC's answer for a frame it does not have: its S3 error page, recorded deliberately.
    source: "frames",
    name: "no-such-frame",
    url: frameUrl("NoSuchTagHere", "USD", "CY2024"),
    file: "no-such-frame.xml",
    accept: [404],
  },
];
