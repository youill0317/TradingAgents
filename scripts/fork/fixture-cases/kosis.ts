// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of Statistics Korea's KOSIS, for the statistics provider's tests (test/fork/data/kosis.test.ts,
 * statistics-korea.test.ts), written to test/fork/fixtures/kosis/, each request as the provider sends it with
 * KOSIS_API_KEY (taken from the settings, never from here; it travels in the query as apiKey and is removed from
 * what is written): the mining and manufacturing survey's semiconductor items (table DT_1F02011, orgId 101,
 * items T10, T11 and T12, C1 E) from 2025-05, the window macro_series reads on 2026-11-25; a search for 실업률
 * (the unemployment rate), the items and classifications of the table it names, and that table's series from
 * 2025-05; and err 30, KOSIS's answer for a window without data. Without KOSIS_API_KEY a case has no address and
 * fails, unsent.
 *
 * Every fixture in the repository is hand-made in KOSIS's documented JSON: no KOSIS answer has been seen from the
 * session that built them. Recording replaces them with KOSIS's own (the golden texts of those tests then need
 * bringing up to date, and the search's table, if KOSIS names another, the cases after it). KOSIS answers its
 * failures with HTTP 200 and {err, errMsg}, so a case it refuses writes that answer: read what was written.
 * error-31.json and error-11.json are not recorded (they need an answer past 40,000 cells, or a key KOSIS refuses).
 */
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import type { FixtureCase } from "../record-fixtures.ts";

const API = "https://kosis.kr/openapi";

/** What a case reads without KOSIS_API_KEY: no address, so it fails without a request. */
export const NO_KOSIS_KEY = "KOSIS_API_KEY is not set";

/** A KOSIS address with `params`, the key and the answer's form after them, as the provider writes them. */
const kosis =
  (path: string, params: Record<string, string>) =>
  (config: PublicDataConfig): string =>
    config.kosisKey
      ? `${API}/${path}?${new URLSearchParams({ ...params, apiKey: config.kosisKey, format: "json", jsonVD: "Y" })}`
      : NO_KOSIS_KEY;

/** One series' values from `start` to `end`, as statisticsParameterData.do answers them. */
const data = (
  name: string,
  table: string,
  item: string,
  objects: readonly string[],
  start: string,
  end: string,
): FixtureCase => ({
  source: "kosis",
  name,
  url: kosis("Param/statisticsParameterData.do", {
    method: "getList",
    orgId: "101",
    tblId: table,
    itmId: item,
    ...Object.fromEntries(objects.map((code, index) => [`objL${index + 1}`, code])),
    prdSe: "M",
    startPrdDe: start,
    endPrdDe: end,
  }),
  file: `${name}.json`,
});

export const cases: FixtureCase[] = [
  ...["T10", "T11", "T12"].map((item) =>
    data(`data-dt-1f02011-${item.toLowerCase()}-e-202505`, "DT_1F02011", item, ["E"], "202505", "202611"),
  ),
  {
    source: "kosis",
    name: "search-unemployment",
    url: kosis("statisticsSearch.do", {
      method: "getList",
      searchNm: "실업률",
      sort: "RANK",
      startCount: "1",
      resultCount: "5",
    }),
    file: "search-unemployment.json",
  },
  {
    source: "kosis",
    name: "meta-dt-1da7102s",
    url: kosis("statisticsData.do", { method: "getMeta", type: "ITM", orgId: "101", tblId: "DT_1DA7102S" }),
    file: "meta-dt-1da7102s.json",
  },
  data("data-dt-1da7102s-t80-0-00-202505", "DT_1DA7102S", "T80", ["0", "00"], "202505", "202611"),
  // A window before the survey's: KOSIS's err 30.
  data("error-30", "DT_1F02011", "T10", ["E"], "199001", "199012"),
];
