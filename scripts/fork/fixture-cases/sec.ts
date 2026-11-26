// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of SEC EDGAR, for the filers provider's tests (test/fork/data/sec-*.test.ts), recorded on the owner's
 * machine with SEC_USER_AGENT set (SEC's hosts get it; www.sec.gov answers nothing without a contact in it):
 *
 * - data.sec.gov's filing indexes (and the older pages the tests read) and XBRL facts of Apple, Walmart (a
 *   fiscal year ending in January), TSMC (a 20-F filer reporting in TWD), Berkshire Hathaway, Bank of America
 *   (whose older filings are on a page of their own) and GE (8-K recasts, filed fourth quarters);
 * - www.sec.gov's ticker list, four primary documents (a 10-K, a 10-Q and a 20-F) and the raw XML of the insider
 *   reports the tests read.
 *
 * The fixtures in the repository were made before any of this was recorded: data.sec.gov's are SEC's own answers
 * saved earlier and trimmed to what the tests read; www.sec.gov's are hand-made in SEC's documented formats.
 * Recording replaces them with SEC's whole, current answers, so the golden texts in those tests then need
 * bringing up to date (values, filings and periods move as companies file).
 */
import type { FixtureCase } from "../record-fixtures.ts";

const DATA = "https://data.sec.gov";
const ARCHIVES = "https://www.sec.gov/Archives/edgar/data";

/** A company's filing index and XBRL facts. */
const company = (name: string, cik: string): FixtureCase[] => [
  {
    source: "sec",
    name: `submissions-${name}`,
    url: `${DATA}/submissions/CIK${cik}.json`,
    file: `submissions-${name}.json`,
  },
  {
    source: "sec",
    name: `companyfacts-${name}`,
    url: `${DATA}/api/xbrl/companyfacts/CIK${cik}.json`,
    file: `companyfacts-${name}.json`,
  },
];

/** A document of a filing in EDGAR's archives. */
const archived = (
  name: string,
  cik: string,
  accession: string,
  document: string,
  extension: string,
): FixtureCase => ({
  source: "sec",
  name,
  url: `${ARCHIVES}/${cik}/${accession.replaceAll("-", "")}/${document}`,
  file: `${name}.${extension}`,
});

/** An insider report's raw XML (its primary document without the xslF345X0N/ stylesheet folder). */
const report = (company: string, cik: string, accession: string, document: string): FixtureCase =>
  archived(`form4-${company}-${accession}`, cik, accession, document, "xml");

export const cases: FixtureCase[] = [
  {
    source: "sec",
    name: "company-tickers-exchange",
    url: "https://www.sec.gov/files/company_tickers_exchange.json",
    file: "company-tickers-exchange.json",
  },
  ...company("aapl", "0000320193"),
  ...company("wmt", "0000104169"),
  ...company("tsm", "0001046179"),
  ...company("bac", "0000070858"),
  {
    source: "sec",
    name: "companyfacts-ge",
    url: `${DATA}/api/xbrl/companyfacts/CIK0000040545.json`,
    file: "companyfacts-ge.json",
  },
  {
    source: "sec",
    name: "submissions-brk",
    url: `${DATA}/submissions/CIK0001067983.json`,
    file: "submissions-brk.json",
  },
  {
    source: "sec",
    name: "submissions-aapl-001",
    url: `${DATA}/submissions/CIK0000320193-submissions-001.json`,
    file: "submissions-aapl-001.json",
  },
  {
    source: "sec",
    name: "submissions-bac-001",
    url: `${DATA}/submissions/CIK0000070858-submissions-001.json`,
    file: "submissions-bac-001.json",
  },
  archived(
    "document-aapl-0000320193-26-000026",
    "320193",
    "0000320193-26-000026",
    "aapl-20260926.htm",
    "html",
  ),
  archived(
    "document-aapl-0000320193-26-000020",
    "320193",
    "0000320193-26-000020",
    "aapl-20260627.htm",
    "html",
  ),
  archived("document-wmt-0000104169-26-000055", "104169", "0000104169-26-000055", "wmt-20260131.htm", "html"),
  archived("document-tsm-0001193125-25-083423", "1046179", "0001193125-25-083423", "d896993d20f.htm", "html"),
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
