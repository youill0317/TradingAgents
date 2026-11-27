// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of OpenDART for the Korean filings' tests (test/fork/data/dart-filings*.test.ts), which read them from
 * test/fork/fixtures/dart-filings/ (FOLDER), each request as the OpenDART client (src/fork/data/sources/dart.ts)
 * sends it with DART_API_KEY, which comes from the settings (the environment, else credentials.json's "data")
 * when a case runs, never from here; it travels in the query as crtfc_key and is removed from what is written:
 *
 * - list-00126380.json: list.json, Samsung Electronics' filings of every type received from 2024-01-01 to
 *   2026-11-26, newest first, the first page (100 filings, the most a page holds);
 * - list-00126380-a001.json, -a002, -a003, -b001 and -i: the same by report type (pblntf_detail_ty: annual,
 *   half-year and quarterly reports, the major events report) and group (pblntf_ty I: the exchange's
 *   disclosures), as the provider asks for them when filings are filtered by form;
 * - list-00258689.json: JYP Entertainment's (a KOSDAQ listing) filings received in the same days;
 * - document-00126380-annual.zip and document-00126380-quarterly.zip: document.xml, the documents of Samsung
 *   Electronics' latest annual report (A001) and latest quarterly report (A003) received by 2026-11-26, found
 *   by list.json (their final versions).
 *
 * The tests answer each window of receipt days the provider asks list.json for from these answers, as list.json
 * answers it (by receipt day and page: LIST_FIXTURES and listAnswerFrom, exported for them). The insider reports,
 * the company outline and the company list they read too are the OpenDART client's fixtures
 * (fixture-cases/dart.ts: dart/elestock-00126380.json, dart/company-00126380.json, dart/corp-codes.zip).
 *
 * The recorder writes a case's files to test/fork/fixtures/<source>/, one folder named by the source, so these
 * cases (source "dart-filings") write to test/fork/fixtures/dart-filings/ (FOLDER), where the tests read them.
 * Without DART_API_KEY no case has an address or a reading that sends anything: each
 * fails, unsent. Every fixture in the repository is hand-made in OpenDART's documented format: no OpenDART answer
 * has been seen from the session that built them. Recording replaces them with OpenDART's own (other receipt
 * numbers, names and texts), and the golden texts of the tests that read them then need bringing up to date.
 */
import { resolvePaths } from "../../../src/config/paths.js";
import { type PublicDataConfig, publicDataConfig } from "../../../src/fork/data/config.js";
import { FORK_REQUEST_MS, type Http } from "../../../src/fork/data/http.js";
import { DART_API, DART_PAGE_COUNT } from "../../../src/fork/data/sources/dart.js";
import type { FixtureCase, Recorded } from "../record-fixtures.ts";
import { NO_DART_KEY } from "./dart.js";

/** Where the tests read these fixtures, under test/fork/fixtures. */
export const FOLDER = "dart-filings";

/** The cases' source, the folder the recorder writes them to under test/fork/fixtures. */
export const SOURCE = "dart-filings";

/** Samsung Electronics' and JYP Entertainment's corp_code. */
const SAMSUNG = "00126380";
const JYP = "00258689";

/** The receipt days the lists hold. */
const DAYS = { bgn_de: "20240101", end_de: "20261126" } as const;

/** The settings as the app reads them: the key is taken from them when a case runs, never at import. */
async function dartKey(): Promise<string | undefined> {
  return (await publicDataConfig(process.env, resolvePaths(process.env))).config.dartKey;
}

/** An OpenDART address with the key first, as the client writes it. */
function addressOf(service: string, key: string, params: Readonly<Record<string, string>>): string {
  return `${DART_API}/${service}?${new URLSearchParams({ crtfc_key: key, ...params })}`;
}

/** list.json's first page of `corp`'s filings received in DAYS, newest first, of the types `filter` asks for. */
const list =
  (corp: string, filter: Readonly<Record<string, string>> = {}) =>
  (config: PublicDataConfig): string =>
    config.dartKey
      ? addressOf("list.json", config.dartKey, {
          corp_code: corp,
          ...DAYS,
          ...filter,
          sort: "date",
          sort_mth: "desc",
          page_no: "1",
          page_count: String(DART_PAGE_COUNT),
        })
      : NO_DART_KEY;

/**
 * The documents of Samsung Electronics' latest report of type `detail` received in DAYS (its final version), as
 * list.json lists it first, read by document.xml; it fails when OpenDART lists none or answers no archive.
 */
export async function readLatestDocument(
  http: Http,
  key: string | undefined,
  detail: "A001" | "A003",
): Promise<Recorded> {
  if (!key) throw new Error(NO_DART_KEY);
  const listed = (await http.json(
    addressOf("list.json", key, {
      corp_code: SAMSUNG,
      ...DAYS,
      last_reprt_at: "Y",
      pblntf_ty: "A",
      pblntf_detail_ty: detail,
      sort: "date",
      sort_mth: "desc",
      page_no: "1",
      page_count: String(DART_PAGE_COUNT),
    }),
    { source: "OpenDART", redirect: "same-origin" },
  )) as { status?: unknown; list?: { rcept_no?: unknown }[] };
  const receipt = listed.list?.[0]?.rcept_no;
  if (listed.status !== "000" || typeof receipt !== "string" || !/^\d{14}$/.test(receipt)) {
    throw new Error(`OpenDART listed no ${detail} report of ${SAMSUNG} (status ${String(listed.status)})`);
  }
  const url = addressOf("document.xml", key, { rcept_no: receipt });
  const answer = await http.get(url, {
    source: "OpenDART",
    timeoutMs: FORK_REQUEST_MS.bulk,
    redirect: "same-origin",
  });
  const body = await answer.bytes();
  if (body[0] !== 0x50 || body[1] !== 0x4b)
    throw new Error("OpenDART answered something other than an archive");
  return { body, status: answer.status, url, contentType: "application/zip" };
}

/** Which list fixture (in FOLDER) holds a company's filings of a type (pblntf_detail_ty) or group (pblntf_ty). */
export const LIST_FIXTURES: readonly { corp: string; group?: string; detail?: string; file: string }[] = [
  { corp: SAMSUNG, file: "list-00126380.json" },
  { corp: SAMSUNG, group: "A", detail: "A001", file: "list-00126380-a001.json" },
  { corp: SAMSUNG, group: "A", detail: "A002", file: "list-00126380-a002.json" },
  { corp: SAMSUNG, group: "A", detail: "A003", file: "list-00126380-a003.json" },
  { corp: SAMSUNG, group: "B", detail: "B001", file: "list-00126380-b001.json" },
  { corp: SAMSUNG, group: "I", file: "list-00126380-i.json" },
  { corp: JYP, file: "list-00258689.json" },
];

/** A row of list.json, as OpenDART writes it. */
type ListRow = { rcept_dt?: unknown; rcept_no?: unknown } & Record<string, unknown>;

/**
 * list.json's answer to `url` from `answer`, an answer of list.json holding the filings asked for over more
 * days: its rows received from bgn_de to end_de (YYYYMMDD), by receipt day and number in sort_mth's order, page
 * page_no of page_count (10 when not given, as OpenDART takes it), with total_count and total_page; status 013
 * when the page holds none, as OpenDART answers it.
 */
export function listAnswerFrom(answer: { list?: readonly ListRow[] }, url: URL): Record<string, unknown> {
  const asked = url.searchParams;
  const from = asked.get("bgn_de") ?? asked.get("end_de") ?? "";
  const through = asked.get("end_de") ?? "99991231";
  const ascending = asked.get("sort_mth") === "asc";
  const page = Number(asked.get("page_no") ?? "1");
  const count = Number(asked.get("page_count") ?? "10");
  const keyOf = (row: ListRow) => `${String(row.rcept_dt)}|${String(row.rcept_no)}`;
  const rows = (answer.list ?? [])
    .filter((row) => String(row.rcept_dt) >= from && String(row.rcept_dt) <= through)
    .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0) * (ascending ? 1 : -1));
  const list = rows.slice((page - 1) * count, page * count);
  if (!list.length) return { status: "013", message: "조회된 데이타가 없습니다." };
  return {
    status: "000",
    message: "정상",
    page_no: page,
    page_count: count,
    total_count: rows.length,
    total_page: Math.ceil(rows.length / count),
    list,
  };
}

export const cases: FixtureCase[] = [
  { source: SOURCE, name: "list-00126380", file: "list-00126380.json", url: list(SAMSUNG) },
  {
    source: SOURCE,
    name: "list-00126380-a001",
    file: "list-00126380-a001.json",
    url: list(SAMSUNG, { pblntf_ty: "A", pblntf_detail_ty: "A001" }),
  },
  {
    source: SOURCE,
    name: "list-00126380-a002",
    file: "list-00126380-a002.json",
    url: list(SAMSUNG, { pblntf_ty: "A", pblntf_detail_ty: "A002" }),
  },
  {
    source: SOURCE,
    name: "list-00126380-a003",
    file: "list-00126380-a003.json",
    url: list(SAMSUNG, { pblntf_ty: "A", pblntf_detail_ty: "A003" }),
  },
  {
    source: SOURCE,
    name: "list-00126380-b001",
    file: "list-00126380-b001.json",
    url: list(SAMSUNG, { pblntf_ty: "B", pblntf_detail_ty: "B001" }),
  },
  {
    source: SOURCE,
    name: "list-00126380-i",
    file: "list-00126380-i.json",
    url: list(SAMSUNG, { pblntf_ty: "I" }),
  },
  { source: SOURCE, name: "list-00258689", file: "list-00258689.json", url: list(JYP) },
  {
    source: SOURCE,
    name: "document-00126380-annual",
    file: "document-00126380-annual.zip",
    read: async (http) => readLatestDocument(http, await dartKey(), "A001"),
  },
  {
    source: SOURCE,
    name: "document-00126380-quarterly",
    file: "document-00126380-quarterly.zip",
    read: async (http) => readLatestDocument(http, await dartKey(), "A003"),
  },
];
