// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of OpenDART for the Korean statements' tests (test/fork/data/dart-statements*.test.ts), which read them
 * from test/fork/fixtures/dart-statements/, each request as the client (src/fork/data/sources/dart.ts) sends it
 * for providers/dart-statements.ts, with DART_API_KEY from the settings (the environment, else credentials.json's
 * "data") when a case runs, never from here; it travels in the query as crtfc_key and is removed from what is
 * written:
 *
 * - list-00126380-periodic-2015.json: list.json, Samsung Electronics' periodic reports (pblntf_ty A) received from
 *   2015-01-01, the first page as the client asks for it (oldest first, 100 a page; the answer holds them all);
 * - accounts-00126380-<year>-<reprt_code>-cfs.json: fnlttSinglAcntAll.json, the consolidated lines of its 2023
 *   annual report and of every report of 2024 and 2025 and 2026's first three (11013 first quarter, 11012 half
 *   year, 11014 third quarter, 11011 annual);
 * - accounts-00258689-2025-11011-ofs.json: the separate lines of JYP Entertainment's 2025 annual report, which the
 *   tests read as a company whose consolidated statements OpenDART answers it has none of (status 013).
 *
 * The recorder writes a case to its source's folder, test/fork/fixtures/dart-statements/ (`folder`), where the
 * tests read it, in place of the hand-made one. Every fixture there is hand-made in OpenDART's documented format: no OpenDART answer has been seen from the session that built them.
 * Recording replaces them with OpenDART's own (with every report filed by the day it is recorded), and the golden
 * texts of the tests that read them then need bringing up to date. Without DART_API_KEY no case has an address, so
 * each fails, unsent.
 */
import { DART_API, DART_PAGE_COUNT } from "../../../src/fork/data/sources/dart.js";
import type { FixtureCase } from "../record-fixtures.ts";
import { NO_DART_KEY } from "./dart.js";

/** A case, and the folder under test/fork/fixtures its fixture is read from. */
export type StatementCase = FixtureCase & { folder: string };

/** Where the tests read these fixtures, under test/fork/fixtures. */
export const STATEMENT_FIXTURES = "dart-statements";

const SAMSUNG = "00126380";
const JYP = "00258689";

/** The reports whose consolidated lines are recorded for Samsung Electronics, newest last. */
export const SAMSUNG_REPORTS: readonly (readonly [number, "11013" | "11012" | "11014" | "11011"])[] = [
  [2023, "11011"],
  [2024, "11013"],
  [2024, "11012"],
  [2024, "11014"],
  [2024, "11011"],
  [2025, "11013"],
  [2025, "11012"],
  [2025, "11014"],
  [2025, "11011"],
  [2026, "11013"],
  [2026, "11012"],
  [2026, "11014"],
];

/** An OpenDART address from the settings, the key first as the client writes it; NO_DART_KEY without the key. */
const dart =
  (service: string, params: Readonly<Record<string, string>>) =>
  (config: { dartKey?: string }): string =>
    config.dartKey
      ? `${DART_API}/${service}?${new URLSearchParams({ crtfc_key: config.dartKey, ...params })}`
      : NO_DART_KEY;

/** One report's statement lines on one basis. */
function accounts(corp: string, year: number, code: string, basis: "CFS" | "OFS"): StatementCase {
  const name = `accounts-${corp}-${year}-${code}-${basis.toLowerCase()}`;
  return {
    source: "dart-statements",
    folder: STATEMENT_FIXTURES,
    name,
    file: `${name}.json`,
    url: dart("fnlttSinglAcntAll.json", {
      corp_code: corp,
      bsns_year: String(year),
      reprt_code: code,
      fs_div: basis,
    }),
  };
}

export const cases: StatementCase[] = [
  {
    source: "dart-statements",
    folder: STATEMENT_FIXTURES,
    name: `list-${SAMSUNG}-periodic-2015`,
    file: `list-${SAMSUNG}-periodic-2015.json`,
    url: dart("list.json", {
      corp_code: SAMSUNG,
      bgn_de: "20150101",
      pblntf_ty: "A",
      sort: "date",
      sort_mth: "asc",
      page_no: "1",
      page_count: String(DART_PAGE_COUNT),
    }),
  },
  ...SAMSUNG_REPORTS.map(([year, code]) => accounts(SAMSUNG, year, code, "CFS")),
  accounts(JYP, 2025, "11011", "OFS"),
];
