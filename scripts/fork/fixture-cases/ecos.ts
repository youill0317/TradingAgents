// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of the Bank of Korea's ECOS, for the statistics provider's tests (test/fork/data/ecos.test.ts,
 * statistics-korea.test.ts), written to test/fork/fixtures/ecos/, each request as the provider sends it with
 * ECOS_API_KEY (taken from the settings, never from here; it travels in the path and is removed from what is
 * written): the base rate (722Y001, item 0101000) from 2026-10-16 and the consumer price index (901Y009, item
 * 0) from 2025-05, the windows macro_series reads on 2026-11-25; the daily market rates' item list (817Y002) and
 * its 3-year Treasury bond yield from 2026-10-28; the table list in Korean and in English; and INFO-200, ECOS's
 * answer for a window without data. Without ECOS_API_KEY a case has no address and fails, unsent.
 *
 * Every fixture in the repository is hand-made in ECOS's documented JSON: no ECOS answer has been seen from the
 * session that built them. Recording replaces them with ECOS's own (the golden texts of those tests then need
 * bringing up to date). ECOS answers its failures with HTTP 200 and a RESULT (INFO-100 for the key, ERROR-602
 * for calls it limits), so a case it refuses writes that RESULT: read what was written. The table lists are
 * answered 1,000 rows a page; their first page's list_total_count says whether the tests need more pages.
 * error-info-100.json and error-602.json are not recorded (they need a key ECOS refuses, or calls it limits).
 */
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import type { FixtureCase } from "../record-fixtures.ts";

const API = "https://ecos.bok.or.kr/api";

/** What a case reads without ECOS_API_KEY: no address, so it fails without a request. */
export const NO_ECOS_KEY = "ECOS_API_KEY is not set";

/** An ECOS address, `path` after the key and the answer's form. */
const ecos =
  (service: string, path: string) =>
  (config: PublicDataConfig): string =>
    config.ecosKey ? `${API}/${service}/${encodeURIComponent(config.ecosKey)}/json/${path}` : NO_ECOS_KEY;

/** A StatisticSearch of one series over a window, rows 1 to 1,000. */
const search = (
  name: string,
  stat: string,
  cycle: string,
  start: string,
  end: string,
  item: string,
): FixtureCase => ({
  source: "ecos",
  name,
  url: ecos("StatisticSearch", `kr/1/1000/${stat}/${cycle}/${start}/${end}/${item}`),
  file: `${name}.json`,
});

export const cases: FixtureCase[] = [
  search("search-722y001-d-20261016", "722Y001", "D", "20261016", "20261125", "0101000"),
  search("search-901y009-m-202505", "901Y009", "M", "202505", "202611", "0"),
  {
    source: "ecos",
    name: "item-list-817y002",
    url: ecos("StatisticItemList", "kr/1/1000/817Y002"),
    file: "item-list-817y002.json",
  },
  search("search-817y002-d-20261028", "817Y002", "D", "20261028", "20261125", "010200000"),
  ...(["kr", "en"] as const).map((lang) => ({
    source: "ecos",
    name: `table-list-${lang}`,
    url: ecos("StatisticTableList", `${lang}/1/1000`),
    file: `table-list-${lang}.json`,
  })),
  // A window before the series starts: ECOS's INFO-200.
  search("error-info-200", "722Y001", "D", "19900101", "19900105", "0101000"),
];
