// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The fixture routes the Korean statistics tests share (ecos.test.ts, kosis.test.ts, statistics-korea.test.ts,
 * markets-bok.test.ts); it holds no test of its own. ECOS's requests carry the key in the path and KOSIS's in
 * the query, so a route matches what follows the key (ECOS) or the parameters but the key (KOSIS). Every
 * fixture is hand-made in the source's documented JSON (test/fork/fixtures/ecos, kosis, markets).
 */
import type { FixtureRoute } from "./harness.js";

/** The keys the tests set: long enough to be removed wherever they would be said. */
export const ECOS_KEY = "ecos-test-key-0123456789";
export const KOSIS_KEY = "kosis-test-key-0123456789";

/** An ECOS request of `service` whose path after the key and the form is `rest` ("kr/1/1000/722Y001/..."). */
export const ecosPath =
  (service: string, rest: string) =>
  (url: URL): boolean =>
    url.hostname === "ecos.bok.or.kr" &&
    url.pathname.startsWith(`/api/${service}/`) &&
    url.pathname.endsWith(`/json/${rest}`) &&
    url.pathname.split("/").length === 5 + rest.split("/").length;

/** A KOSIS request of `path` ("Param/statisticsParameterData.do") with these parameters (others any). */
export const kosisQuery =
  (path: string, params: Record<string, string>) =>
  (url: URL): boolean =>
    url.hostname === "kosis.kr" &&
    url.pathname === `/openapi/${path}` &&
    Object.entries(params).every(([name, value]) => url.searchParams.get(name) === value);

/** ECOS's fixtures: the windows macro_series reads on TEST_DAY, the market rates' items, the table lists. */
export const ECOS_ROUTES: readonly FixtureRoute[] = [
  {
    match: ecosPath("StatisticSearch", "kr/1/1000/722Y001/D/20261016/20261125/0101000"),
    file: "ecos/search-722y001-d-20261016.json",
  },
  {
    match: ecosPath("StatisticSearch", "kr/1/1000/901Y009/M/202505/202611/0"),
    file: "ecos/search-901y009-m-202505.json",
  },
  { match: ecosPath("StatisticItemList", "kr/1/1000/817Y002"), file: "ecos/item-list-817y002.json" },
  {
    match: ecosPath("StatisticSearch", "kr/1/1000/817Y002/D/20261028/20261125/010200000"),
    file: "ecos/search-817y002-d-20261028.json",
  },
  { match: ecosPath("StatisticTableList", "kr/1/1000"), file: "ecos/table-list-kr.json" },
  { match: ecosPath("StatisticTableList", "en/1/1000"), file: "ecos/table-list-en.json" },
];

/** The central_banks view's: the Bank of Korea's base rate since 2024. */
export const BOK_ROUTE: FixtureRoute = {
  match: ecosPath("StatisticSearch", "kr/1/1000/722Y001/D/20240101/20261125/0101000"),
  file: "markets/ecos-722y001-d-since2024.json",
};

const DATA = "Param/statisticsParameterData.do";

/** KOSIS's fixtures: the semiconductor items, the unemployment search, its table's items and its series. */
export const KOSIS_ROUTES: readonly FixtureRoute[] = [
  ...["T10", "T11", "T12"].map((item) => ({
    match: kosisQuery(DATA, {
      orgId: "101",
      tblId: "DT_1F02011",
      itmId: item,
      objL1: "E",
      prdSe: "M",
      startPrdDe: "202505",
      endPrdDe: "202611",
    }),
    file: `kosis/data-dt-1f02011-${item.toLowerCase()}-e-202505.json`,
  })),
  {
    match: kosisQuery("statisticsSearch.do", { method: "getList", searchNm: "실업률", resultCount: "5" }),
    file: "kosis/search-unemployment.json",
  },
  {
    match: kosisQuery("statisticsData.do", {
      method: "getMeta",
      type: "ITM",
      orgId: "101",
      tblId: "DT_1DA7102S",
    }),
    file: "kosis/meta-dt-1da7102s.json",
  },
  {
    match: kosisQuery(DATA, {
      orgId: "101",
      tblId: "DT_1DA7102S",
      itmId: "T80",
      objL1: "0",
      objL2: "00",
      prdSe: "M",
      startPrdDe: "202505",
      endPrdDe: "202611",
    }),
    file: "kosis/data-dt-1da7102s-t80-0-00-202505.json",
  },
];
