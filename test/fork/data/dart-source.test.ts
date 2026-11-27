// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The OpenDART client (src/fork/data/sources/dart.ts), offline: its company list read from corpCode.xml's ZIP
 * (the hand-made fixture test/fork/fixtures/dart/corp-codes.zip, and archives built here with node:zlib, up to
 * 100,000 companies), kept a day on disk and served past its day when OpenDART fails; its lookups by stock
 * code, corp_code, name (Hangul, English, spacing, case, legal forms; listed companies first) and a listing's
 * key (unsupported, so the router moves on, for a code the list does not hold); every status
 * OpenDART answers as the DataError kind it calls for; list.json read page after page to its total;
 * fnlttSinglAcntAll.json, elestock.json and company.json read into typed rows; document.xml's documents read by
 * name and decoded from the encoding each declares; and DART_API_KEY kept out of every message, cache key,
 * cache file, link and fixture. Every answer is a fixture or written here in OpenDART's documented form.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import {
  corpCodesExcerpt,
  cases as DART_CASES,
  NO_DART_KEY,
  readAnnualDocument,
  readCorpCodes,
  zipOf,
} from "../../../scripts/fork/fixture-cases/dart.js";
import { record, recordOne, yahooAnswerer } from "../../../scripts/fork/record-fixtures.js";
import { NOTICE } from "../../../src/contracts/index.js";
import { ANSWER_BYTES } from "../../../src/contracts/limits.js";
import { DataError } from "../../../src/data/errors.js";
import { type Cache, createCache, type KeepOptions } from "../../../src/fork/data/cache.js";
import type { PublicDataConfig } from "../../../src/fork/data/config.js";
import {
  compactName,
  DART_CORP_CODES_TTL_MS,
  DART_STATUS,
  dartAmount,
  dartCorpList,
  dartDate,
  dartFilingUrl,
  dartSource,
  dartStatusKind,
  decodeXml,
  nameWords,
  parseCorpCodes,
} from "../../../src/fork/data/sources/dart.js";
import { readZip, ZIP_ENTRY_BYTES } from "../../../src/fork/data/util/zip.js";
import {
  FIXTURES,
  type FixtureFetch,
  type FixtureRoute,
  fixture,
  fixtureFetch,
  fixtureMeta,
  holdsPart,
  testDeps,
} from "./harness.js";

// Fixture routes --------------------------------------------------------------------------------------------

/** A key in OpenDART's form (40 characters); it must never be said anywhere but in the request's query. */
const KEY = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const DART: PublicDataConfig = { dartKey: KEY };
const SAMSUNG = "00126380";
const ANNUAL = "20260310000812";
const JSON_TYPE = { "content-type": "application/json;charset=UTF-8" };

/** OpenDART's `service` asked with every one of `params` (others may be asked too), answered by `answer`. */
function dart(
  service: string,
  params: Readonly<Record<string, string>>,
  answer: Omit<FixtureRoute, "match">,
): FixtureRoute {
  return {
    match: (url) =>
      url.hostname === "opendart.fss.or.kr" &&
      url.pathname === `/api/${service}` &&
      Object.entries(params).every(([name, value]) => url.searchParams.get(name) === value),
    ...answer,
  };
}

/** OpenDART's status answered as JSON. */
function statusBody(status: string, message: string): Omit<FixtureRoute, "match"> {
  return { body: JSON.stringify({ status, message }), headers: JSON_TYPE };
}

/** OpenDART's status answered as XML, as its ZIP services answer a failure. */
function statusXml(status: string, message: string): Omit<FixtureRoute, "match"> {
  return {
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<result>\n<status>${status}</status>\n<message>${message}</message>\n</result>\n`,
    headers: { "content-type": "application/xml;charset=UTF-8" },
  };
}

const CORP_CODES = dart("corpCode.xml", {}, { file: "dart/corp-codes.zip" });
const PERIODIC = dart(
  "list.json",
  { corp_code: SAMSUNG, pblntf_ty: "A", page_no: "1" },
  { file: "dart/list-00126380-periodic.json" },
);
const ACCOUNTS = dart(
  "fnlttSinglAcntAll.json",
  { corp_code: SAMSUNG, bsns_year: "2025", reprt_code: "11011", fs_div: "CFS" },
  { file: "dart/accounts-00126380-2025-11011-cfs.json" },
);
const ELESTOCK = dart("elestock.json", { corp_code: SAMSUNG }, { file: "dart/elestock-00126380.json" });
const COMPANY = dart("company.json", { corp_code: SAMSUNG }, { file: "dart/company-00126380.json" });
const DOCUMENT = dart("document.xml", { rcept_no: ANNUAL }, { file: "dart/document-00126380-annual.zip" });

/** The OpenDART client over `routes` with DART_API_KEY (or `config`). */
function client(routes: readonly FixtureRoute[], config: PublicDataConfig = DART, cache?: Cache) {
  const { deps, fetch } = testDeps(config, routes, cache ? { cache } : {});
  return { dart: dartSource(deps), fetch, deps };
}

/** The requests made, OpenDART's by service and the parameters that tell them apart. */
function asked(fetch: FixtureFetch): string[] {
  return fetch.requests.map(({ url }) => {
    const address = new URL(url);
    const params = [...address.searchParams.entries()]
      .filter(([name]) => name !== "crtfc_key")
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    return `${address.pathname.replace("/api/", "")}${params ? `?${params}` : ""}`;
  });
}

/** The DataError a reading rejects with. */
async function failure(promise: Promise<unknown>): Promise<DataError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error("it answered");
}

/** CORPCODE.xml's text for `rows`, as OpenDART writes it. */
function corpXml(rows: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<result>\n${rows.join("\n")}\n</result>\n`;
}

/** One company's `<list>`, fields as given (an English name of null leaves its element out). */
function corpRow(
  code: string,
  name: string,
  english: string | null,
  stock: string,
  modified: string,
): string {
  return [
    "    <list>",
    `        <corp_code>${code}</corp_code>`,
    `        <corp_name>${name}</corp_name>`,
    ...(english === null ? [] : [`        <corp_eng_name>${english}</corp_eng_name>`]),
    `        <stock_code>${stock}</stock_code>`,
    `        <modify_date>${modified}</modify_date>`,
    "    </list>",
  ].join("\n");
}

/** corpCode.xml answered by an archive of `text` built here, under `name`. */
function corpArchive(text: string, name = "CORPCODE.xml"): FixtureRoute {
  return dart(
    "corpCode.xml",
    {},
    {
      body: zipOf([{ name, data: new TextEncoder().encode(text) }]),
      headers: { "content-type": "application/zip" },
    },
  );
}

// The company list --------------------------------------------------------------------------------------------

describe("OpenDART's company list (corpCode.xml)", () => {
  test("the fixture: each company as OpenDART lists it, a blank stock code read as none, an empty English name as none", async () => {
    const { dart: source, fetch } = client([CORP_CODES]);
    const list = await source.corpList();
    expect(list.stale).toBe(false);
    expect(list.companies.map((one) => one.corp_name)).toEqual([
      "다코",
      "삼성전자",
      "삼성SDI",
      "삼성전기",
      "삼성물산",
      "삼성전자서비스",
      "삼성전자판매",
      "삼성전자로지텍",
      "삼성자산운용",
      "SK하이닉스",
      "카카오",
      "제이와이피엔터테인먼트",
    ]);
    expect(list.byStockCode("005930")).toEqual({
      corp_code: SAMSUNG,
      corp_name: "삼성전자",
      corp_eng_name: "SAMSUNG ELECTRONICS CO,.LTD",
      stock_code: "005930",
      modify_date: "2025-04-14",
    });
    expect(list.byCorpCode("00434003")).toEqual({
      corp_code: "00434003",
      corp_name: "다코",
      corp_eng_name: "Daco corporation",
      stock_code: null,
      modify_date: "2017-06-30",
    });
    // An entity in the XML is read as its character.
    expect(list.byStockCode("028260")?.corp_eng_name).toBe("SAMSUNG C&T CORPORATION");
    expect(list.byCorpCode("00221522")?.corp_eng_name).toBeNull();
    expect(list.byStockCode("005935")).toBeUndefined();
    expect(list.byStockCode(" 035900 ")?.corp_code).toBe("00258689");
    // One request, the key in its query (OpenDART's only).
    expect(fetch.requests.map(({ url }) => url)).toEqual([
      `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${KEY}`,
    ]);
  });

  test("an archive built here with node:zlib: a row without corp_eng_name, rows that are not companies skipped, a code two rows share", async () => {
    const text = corpXml([
      corpRow("00126380", "삼성전자", "SAMSUNG ELECTRONICS CO,.LTD", "005930", "20250414"),
      corpRow("00999001", "옛한국상사", null, "123450", "20090105"),
      // A relisted code: the row OpenDART changed last is the listing's.
      corpRow("00999002", "새한국상사", "NEW HANKOOK TRADING CO., LTD.", "123450", "20240611"),
      // Not companies: a corp_code of 7 digits, no name.
      corpRow("0099900", "짧은코드", null, " ", "20240101"),
      corpRow("00999003", "", null, " ", "20240101"),
      // A stock code in lower case, a CDATA name, a name with an entity, spacing in names.
      "    <list><corp_code>00999004</corp_code><corp_name><![CDATA[에이&비]]></corp_name><corp_eng_name>A &amp;  B  Co.,Ltd.</corp_eng_name><stock_code>0088m0</stock_code><modify_date>2025-13-01</modify_date></list>",
    ]);
    const { dart: source } = client([corpArchive(text)]);
    const list = await source.corpList();
    expect(list.companies.map((one) => one.corp_code)).toEqual([
      "00126380",
      "00999001",
      "00999002",
      "00999004",
    ]);
    expect(list.byCorpCode("00999001")).toEqual({
      corp_code: "00999001",
      corp_name: "옛한국상사",
      corp_eng_name: null,
      stock_code: "123450",
      modify_date: "2009-01-05",
    });
    expect(list.byStockCode("123450")?.corp_code).toBe("00999002");
    expect(list.byCorpCode("00999004")).toEqual({
      corp_code: "00999004",
      corp_name: "에이&비",
      corp_eng_name: "A & B Co.,Ltd.",
      stock_code: "0088M0",
      modify_date: null,
    });
  });

  test("100,000 companies (an archive of about 27 MB of XML) are read within the client's bounds, and searched", async () => {
    const rows: string[] = [];
    for (let at = 0; at < 100_000; at++) {
      const listed = at % 37 === 0;
      rows.push(
        corpRow(
          String(10_000_000 + at),
          `회사${at}`,
          `COMPANY NUMBER ${at} CO.,LTD.`,
          listed ? String(100_000 + at).slice(-6) : " ",
          "20250102",
        ),
      );
    }
    const text = corpXml(rows);
    const archive = zipOf([{ name: "CORPCODE.xml", data: new TextEncoder().encode(text) }]);
    const [entry] = readZip(archive);
    // The archive within the HTTP client's bound on an answer, its XML within the ZIP reader's on an entry.
    expect(archive.length).toBeLessThan(ANSWER_BYTES);
    expect(entry?.size).toBeGreaterThan(20_000_000);
    expect(entry?.size).toBeLessThan(ZIP_ENTRY_BYTES);
    const started = performance.now();
    const { dart: source } = client([
      dart("corpCode.xml", {}, { body: archive, headers: { "content-type": "application/zip" } }),
    ]);
    const list = await source.corpList();
    expect(list.companies).toHaveLength(100_000);
    expect(list.search("회사99999").map((match) => match.company.corp_code)).toEqual(["10099999"]);
    expect(list.search("company number 12").length).toBeGreaterThan(1);
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 60_000);

  test("kept a day, on disk too: another client reads it from disk; past its day it is read again, and served stale when OpenDART fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fork-dart-cache-"));
    let now = Date.parse("2026-11-25T22:00:00Z");
    const config: PublicDataConfig = { ...DART, cacheDir: dir };
    const cacheOf = () => createCache({ dir, now: () => now, secrets: [KEY] });
    try {
      const first = client([CORP_CODES], config, cacheOf());
      expect((await first.dart.corpList()).companies).toHaveLength(12);
      // A new process, the same day: from disk, no request.
      const second = client([CORP_CODES], config, cacheOf());
      const kept = await second.dart.corpList();
      expect(kept.companies).toHaveLength(12);
      expect(second.fetch.requests).toEqual([]);
      // A day later, OpenDART failing: the list as it was, said to be stale.
      now += DART_CORP_CODES_TTL_MS + 1;
      const failing = client([dart("corpCode.xml", {}, { body: "", status: 500 })], config, cacheOf());
      const stale = await failing.dart.corpList();
      expect([stale.stale, stale.companies.length]).toEqual([true, 12]);
      // OpenDART answering again: read again.
      const third = client([CORP_CODES], config, cacheOf());
      expect((await third.dart.corpList()).stale).toBe(false);
      expect(asked(third.fetch)).toEqual(["corpCode.xml"]);
      // No cache file holds the key.
      for (const file of await readdir(dir)) {
        expect(await readFile(join(dir, file), "latin1")).not.toContain(KEY);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("OpenDART's failures in place of the archive, and archives this app cannot read", async () => {
    const cases: [FixtureRoute, string, string][] = [
      [
        dart("corpCode.xml", {}, statusXml("010", "등록되지 않은 키입니다.")),
        "rejected",
        "OpenDART refused DART_API_KEY (010: 등록되지 않은 키입니다.). A free key comes from https://opendart.fss.or.kr/.",
      ],
      [
        dart("corpCode.xml", {}, statusBody("020", "요청 제한을 초과하였습니다.")),
        "quota",
        "OpenDART's request limit for DART_API_KEY is reached (020: 요청 제한을 초과하였습니다.).",
      ],
      [
        dart("corpCode.xml", {}, statusXml("800", "시스템 점검으로 인한 서비스가 중지 중입니다.")),
        "unavailable",
        "OpenDART could not answer (800: 시스템 점검으로 인한 서비스가 중지 중입니다.).",
      ],
      [
        // An archive cut off before its central directory.
        dart("corpCode.xml", {}, { body: fixture("dart/corp-codes.zip").subarray(0, 200) }),
        "unavailable",
        "OpenDART answered its company list in an archive this app cannot read (no end-of-central-directory record: not a ZIP archive, or a truncated one).",
      ],
      [
        corpArchive("not a list", "readme.txt"),
        "unavailable",
        "OpenDART answered its company list in a form this app does not read.",
      ],
      [
        corpArchive("<?xml version='1.0'?><companies/>"),
        "unavailable",
        "OpenDART answered its company list in a form this app does not read.",
      ],
      [
        corpArchive(corpXml([])),
        "unavailable",
        "OpenDART answered its company list in a form this app does not read.",
      ],
      [
        dart(
          "corpCode.xml",
          {},
          { body: "<html>maintenance</html>", headers: { "content-type": "text/html" } },
        ),
        "unavailable",
        "OpenDART answered its corpCode.xml in a form this app does not read.",
      ],
      [
        dart("corpCode.xml", {}, { body: "Not Found", status: 404 }),
        "unavailable",
        "OpenDART's corpCode.xml is not at its address (HTTP 404).",
      ],
      [dart("corpCode.xml", {}, { body: "", status: 500 }), "unavailable", "OpenDART answered HTTP 500."],
      [
        dart("corpCode.xml", {}, { body: "", status: 403 }),
        "rejected",
        "OpenDART refused the request (HTTP 403).",
      ],
    ];
    for (const [route, kind, said] of cases) {
      const { dart: source } = client([route]);
      const error = await failure(source.corpList());
      expect([error.kind, error.message], said).toEqual([kind, said]);
      expect(error.details.source).toBe("OpenDART");
      expect(JSON.stringify({ ...error.details, message: error.message })).not.toContain(KEY);
    }
    // A key OpenDART refuses is said as the setting to change, as it is.
    const { dart: refused } = client([cases[0]?.[0] as FixtureRoute]);
    expect((await failure(refused.corpList())).details.code).toBe(NOTICE.capabilityUnavailable);
  });

  test("a dropped connection is unavailable, named by its code, never by a message that may quote the address", async () => {
    const { deps } = testDeps(DART, (async () => {
      throw Object.assign(
        new Error(`connect ECONNREFUSED https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${KEY}`),
        {
          code: "ECONNREFUSED",
        },
      );
    }) as unknown as FixtureFetch);
    const error = await failure(dartSource(deps).corpList());
    expect([error.kind, error.message]).toEqual([
      "unavailable",
      "OpenDART could not be reached (ECONNREFUSED).",
    ]);
  });
});

/**
 * A ZIP of one entry stored as it is (method 0), written here with node:zlib's CRC-32: the other form an
 * archive's entry may take.
 */
function storedZip(name: string, data: Uint8Array): Uint8Array {
  const file = new TextEncoder().encode(name);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 10, true);
  local.setUint32(14, crc32(data) >>> 0, true);
  local.setUint32(18, data.length, true);
  local.setUint32(22, data.length, true);
  local.setUint16(26, file.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, 10, true);
  central.setUint16(6, 10, true);
  central.setUint32(16, crc32(data) >>> 0, true);
  central.setUint32(20, data.length, true);
  central.setUint32(24, data.length, true);
  central.setUint16(28, file.length, true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + file.length, true);
  end.setUint32(16, 30 + file.length + data.length, true);
  return new Uint8Array(
    Buffer.concat([
      new Uint8Array(local.buffer),
      file,
      data,
      new Uint8Array(central.buffer),
      file,
      new Uint8Array(end.buffer),
    ]),
  );
}

describe("OpenDART's company list, stored and looked up by listing", () => {
  test("an archive whose CORPCODE.xml is stored, not deflated, written here with node:zlib's CRC-32", async () => {
    const text = corpXml([
      corpRow("00126380", "삼성전자", "SAMSUNG ELECTRONICS CO,.LTD", "005930", "20250414"),
    ]);
    const archive = storedZip("CORPCODE.xml", new TextEncoder().encode(text));
    const { dart: source } = client([
      dart("corpCode.xml", {}, { body: archive, headers: { "content-type": "application/zip" } }),
    ]);
    expect((await source.corpList()).byStockCode("005930")?.corp_code).toBe(SAMSUNG);
  });

  test("a listing's company: every Korean key's form; unsupported (the router asks the next source) for a code the list does not hold or another key", async () => {
    const { dart: source, fetch } = client([CORP_CODES]);
    for (const key of ["XKRX:005930", "005930.KS", "005930", "security:XKRX:005930"]) {
      expect((await source.company(key)).corp_code, key).toBe(SAMSUNG);
    }
    expect((await source.company("XKOS:035900")).corp_name).toBe("제이와이피엔터테인먼트");
    const missing = await failure(source.company("XKRX:005935"));
    expect([missing.kind, missing.message]).toEqual([
      "unsupported",
      "OpenDART's company list holds no company listed under 005935",
    ]);
    expect((await failure(source.company("XKRX:069500"))).kind).toBe("unsupported");
    // The list is read once, and not at all for a key that names no Korean listing.
    expect(fetch.requests).toHaveLength(1);
    const { dart: other, fetch: none } = client([CORP_CODES]);
    for (const key of ["AAPL", "XNAS:AAPL", "fx:USDKRW", "series:kr.equity_index.kospi"]) {
      const error = await failure(other.company(key));
      expect([error.kind, error.message], key).toEqual([
        "unsupported",
        `OpenDART serves Korean listings, and ${key} is not one`,
      ]);
    }
    expect(none.requests).toEqual([]);
  });
});

// Names ---------------------------------------------------------------------------------------------------

describe("companies by name", () => {
  const list = dartCorpList(
    parseCorpCodes(new TextDecoder().decode(readZip(fixture("dart/corp-codes.zip"))[0]?.bytes())),
  );
  const found = (query: string) =>
    list
      .search(query)
      .map((match) => `${match.company.corp_name} ${match.tier}${match.listed ? "" : " unlisted"}`);

  test("Hangul: the name, spacing and legal forms aside; then names starting with it; then names holding it; listed companies first", () => {
    expect(found("삼성전자")).toEqual([
      "삼성전자 exact",
      "삼성전자서비스 prefix unlisted",
      "삼성전자판매 prefix unlisted",
      "삼성전자로지텍 prefix unlisted",
    ]);
    for (const query of [
      "삼성 전자",
      " 삼성전자 ",
      "(주)삼성전자",
      "㈜삼성전자",
      "삼성전자 주식회사",
      "주식회사 삼성전자",
    ]) {
      expect(found(query)[0], query).toBe("삼성전자 exact");
    }
    expect(found("삼성")).toEqual([
      "삼성전자 prefix",
      "삼성SDI prefix",
      "삼성전기 prefix",
      "삼성물산 prefix",
      "삼성전자서비스 prefix unlisted",
      "삼성전자판매 prefix unlisted",
      "삼성전자로지텍 prefix unlisted",
      "삼성자산운용 prefix unlisted",
    ]);
    expect(found("전자")).toEqual([
      "삼성전자 contains",
      "삼성전자서비스 contains unlisted",
      "삼성전자판매 contains unlisted",
      "삼성전자로지텍 contains unlisted",
    ]);
    expect(found("하이닉스")).toEqual(["SK하이닉스 contains"]);
    expect(found("sk하이닉스")).toEqual(["SK하이닉스 exact"]);
    expect(found("LG전자")).toEqual([]);
  });

  test("English (and Korean names in the Latin script): the same words, spacing, case and legal forms aside; then names starting with the words; then names holding them", () => {
    expect(found("SAMSUNG ELECTRONICS")).toEqual([
      "삼성전자 exact",
      "삼성전자서비스 prefix unlisted",
      "삼성전자판매 prefix unlisted",
    ]);
    for (const query of [
      "Samsung Electronics",
      "samsung electronics co., ltd.",
      "SAMSUNG ELECTRONICS CO,.LTD",
      "SamsungElectronics",
    ]) {
      expect(found(query)[0], query).toBe("삼성전자 exact");
    }
    expect(found("Samsung Elec")).toEqual([
      "삼성전자 prefix",
      "삼성전기 prefix",
      "삼성전자서비스 prefix unlisted",
      "삼성전자판매 prefix unlisted",
    ]);
    expect(found("SK hynix")).toEqual(["SK하이닉스 exact"]);
    expect(found("skhynix")).toEqual(["SK하이닉스 exact"]);
    expect(found("Samsung C&T")).toEqual(["삼성물산 exact"]);
    expect(found("C&T")).toEqual(["삼성물산 contains"]);
    expect(found("JYP")).toEqual(["제이와이피엔터테인먼트 prefix"]);
    expect(found("kakao corporation")).toEqual(["카카오 exact"]);
    expect(found("daco")).toEqual(["다코 exact unlisted"]);
    expect(found("Apple")).toEqual([]);
    expect(found("&/")).toEqual([]);
  });

  test("names as searches compare them", () => {
    expect(nameWords("SAMSUNG ELECTRONICS CO,.LTD")).toEqual(["samsung", "electronics"]);
    expect(nameWords("KT&G Corporation")).toEqual(["ktg"]);
    expect(nameWords("(주)카카오")).toEqual(["카카오"]);
    expect(compactName("삼성 전자 주식회사")).toBe("삼성전자");
    expect(compactName("ＳＫ하이닉스")).toBe("sk하이닉스");
  });
});

// Statuses --------------------------------------------------------------------------------------------------

describe("OpenDART's statuses, each the kind it calls for", () => {
  test("the guide's message table", () => {
    expect(
      Object.fromEntries(Object.entries(DART_STATUS).map(([status, { kind }]) => [status, kind])),
    ).toEqual({
      "000": "ok",
      "010": "rejected",
      "011": "rejected",
      "012": "rejected",
      "013": "no_data",
      "014": "no_data",
      "020": "quota",
      "021": "invalid",
      "100": "invalid",
      "101": "invalid",
      "800": "unavailable",
      "900": "unavailable",
      "901": "rejected",
    });
    expect(dartStatusKind("999")).toBe("unavailable");
  });

  test("every status a JSON service answers: 000 its rows, 013 none, the others their failures, OpenDART's words kept and the key never", async () => {
    const said: Record<string, string> = {
      "010": "등록되지 않은 키입니다.",
      "011":
        "사용할 수 없는 키입니다. 오픈API에 등록되었으나, 일시적으로 사용 중지된 키를 통하여 검색하는 경우 발생합니다.",
      "012": "접근할 수 없는 IP입니다.",
      "014": "파일이 존재하지 않습니다.",
      "020": "요청 제한을 초과하였습니다.",
      "021": "조회 가능한 회사 개수가 초과하였습니다.(최대 100건)",
      "100": "필드의 부적절한 값입니다. 필드 설명에 없는 값을 사용한 경우에 발생하는 메시지입니다.",
      "101": "부적절한 접근입니다.",
      "800": "시스템 점검으로 인한 서비스가 중지 중입니다.",
      "900": "정의되지 않은 오류가 발생하였습니다.",
      "901": `사용자 계정의 개인정보 보유기간이 만료되어 사용할 수 없는 키입니다. (${KEY})`,
      "999": "새로운 상태입니다.",
    };
    const outcomes: Record<string, string> = {};
    for (const [status, words] of Object.entries(said)) {
      const { dart: source } = client([dart("elestock.json", {}, statusBody(status, words))]);
      const error = await failure(source.insiders(SAMSUNG));
      expect(error.message).not.toContain(KEY);
      expect(error.details.source).toBe("OpenDART");
      outcomes[status] = `${error.kind}: ${error.message}`;
    }
    // The key quoted where OpenDART's words are cut (200 characters): removed first, so no part of it is left.
    const { dart: cutting } = client([
      dart("elestock.json", {}, statusBody("901", `${"x".repeat(190)} ${KEY}`)),
    ]);
    const cut = await failure(cutting.insiders(SAMSUNG));
    expect(holdsPart(`${cut.message} ${JSON.stringify(cut.details)}`, KEY)).toBe(false);
    expect(outcomes).toEqual({
      "010":
        "rejected: OpenDART refused DART_API_KEY (010: 등록되지 않은 키입니다.). A free key comes from https://opendart.fss.or.kr/.",
      "011":
        "rejected: OpenDART refused DART_API_KEY (011: 사용할 수 없는 키입니다. 오픈API에 등록되었으나, 일시적으로 사용 중지된 키를 통하여 검색하는 경우 발생합니다.). A free key comes from https://opendart.fss.or.kr/.",
      "012": "rejected: OpenDART does not take requests from this address (012: 접근할 수 없는 IP입니다.).",
      "014": "no_data: OpenDART has no insider reports for the company (014: 파일이 존재하지 않습니다.).",
      "020":
        "quota: OpenDART's request limit for DART_API_KEY is reached (020: 요청 제한을 초과하였습니다.).",
      "021":
        "invalid: OpenDART did not take the request (021: 조회 가능한 회사 개수가 초과하였습니다.(최대 100건)).",
      "100":
        "invalid: OpenDART did not take the request (100: 필드의 부적절한 값입니다. 필드 설명에 없는 값을 사용한 경우에 발생하는 메시지입니다.).",
      "101": "invalid: OpenDART did not take the request (101: 부적절한 접근입니다.).",
      "800": "unavailable: OpenDART could not answer (800: 시스템 점검으로 인한 서비스가 중지 중입니다.).",
      "900": "unavailable: OpenDART could not answer (900: 정의되지 않은 오류가 발생하였습니다.).",
      "901":
        "rejected: OpenDART refused DART_API_KEY (901: 사용자 계정의 개인정보 보유기간이 만료되어 사용할 수 없는 키입니다. (***)). A free key comes from https://opendart.fss.or.kr/.",
      "999": "unavailable: OpenDART could not answer (999: 새로운 상태입니다.).",
    });
    // 013 is an empty answer where a reading has one.
    const { dart: none } = client([
      dart("elestock.json", {}, statusBody("013", "조회된 데이타가 없습니다.")),
    ]);
    expect(await none.insiders(SAMSUNG)).toEqual([]);
  });

  test("the kinds the router passes on (rejected, quota, unavailable) and those that end the call (no_data, invalid)", async () => {
    const kinds = new Map<string, string>();
    for (const status of ["010", "020", "021", "100", "800"]) {
      const { dart: source } = client([dart("company.json", {}, statusBody(status, "-"))]);
      kinds.set(status, (await failure(source.outline(SAMSUNG))).kind);
    }
    expect(Object.fromEntries(kinds)).toEqual({
      "010": "rejected",
      "020": "quota",
      "021": "invalid",
      "100": "invalid",
      "800": "unavailable",
    });
    // An invalid answer asks for another request; a refused key is said as the setting to change.
    const { dart: source } = client([
      dart("company.json", {}, statusBody("100", "필드의 부적절한 값입니다.")),
    ]);
    expect((await failure(source.outline(SAMSUNG))).details.retry).toBe("change_request");
  });

  test("an answer without a status, a status in a 400, an HTML page: each read for what it says", async () => {
    const cases: [Omit<FixtureRoute, "match">, string][] = [
      [
        { body: JSON.stringify({ list: [] }), headers: JSON_TYPE },
        "OpenDART answered its elestock.json in a form this app does not read.",
      ],
      [
        { body: "<html>오류</html>", headers: { "content-type": "text/html" } },
        "OpenDART answered its elestock.json in a form this app does not read.",
      ],
      [
        { ...statusBody("100", "필드의 부적절한 값입니다."), status: 400 },
        "OpenDART did not take the request (100: 필드의 부적절한 값입니다.).",
      ],
      [{ body: "Bad Request", status: 400 }, "OpenDART answered HTTP 400."],
    ];
    for (const [answer, said] of cases) {
      const { dart: source } = client([dart("elestock.json", {}, answer)]);
      expect((await failure(source.insiders(SAMSUNG))).message).toBe(said);
    }
  });
});

// Filings -----------------------------------------------------------------------------------------------------

/** A list.json page of `rows` filings numbered from `first`, of `total`. */
function listPage(first: number, rows: number, total: number, page: number): string {
  return JSON.stringify({
    status: "000",
    message: "정상",
    page_no: page,
    page_count: 100,
    total_count: total,
    total_page: Math.ceil(total / 100),
    list: Array.from({ length: rows }, (_, at) => {
      const n = first + at;
      const day = `2026${String(1 + (Math.floor(n / 28) % 12)).padStart(2, "0")}${String(1 + (n % 28)).padStart(2, "0")}`;
      return {
        corp_code: SAMSUNG,
        corp_name: "삼성전자",
        stock_code: "005930",
        corp_cls: "Y",
        report_nm: "임원ㆍ주요주주특정증권등소유상황보고서",
        rcept_no: `${day}${String(n).padStart(6, "0")}`,
        flr_nm: "홍길동",
        rcept_dt: day,
        rm: "",
      };
    }),
  });
}

describe("filings (list.json)", () => {
  test("the fixture: each filing as listed, newest first, dates as YYYY-MM-DD, linked to DART's public page", async () => {
    const { dart: source, fetch } = client([PERIODIC]);
    const filings = await source.filings({
      corp_code: SAMSUNG,
      bgn_de: "2025-01-01",
      end_de: "2026-11-25",
      pblntf_ty: "A",
    });
    expect(filings.map((one) => `${one.rcept_dt} ${one.report_nm} ${one.rcept_no}`)).toEqual([
      "2026-11-13 분기보고서 (2026.09) 20261113001877",
      "2026-08-14 반기보고서 (2026.06) 20260814002213",
      "2026-05-15 분기보고서 (2026.03) 20260515001740",
      "2026-03-10 사업보고서 (2025.12) 20260310000812",
      "2025-11-14 분기보고서 (2025.09) 20251114002447",
      "2025-08-14 반기보고서 (2025.06) 20250814002456",
      "2025-05-15 분기보고서 (2025.03) 20250515001922",
      "2025-03-11 사업보고서 (2024.12) 20250311001085",
    ]);
    expect(filings[3]).toEqual({
      corp_code: SAMSUNG,
      corp_name: "삼성전자",
      stock_code: "005930",
      corp_cls: "Y",
      report_nm: "사업보고서 (2025.12)",
      rcept_no: ANNUAL,
      flr_nm: "삼성전자",
      rcept_dt: "2026-03-10",
      rm: "연",
      url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260310000812",
    });
    // Asked as the recorder's case asks: oldest first, 100 a page; the meta's address is the request's, keyless.
    const sent = fetch.requests[0]?.url ?? "";
    expect(sent.replace(KEY, "***")).toBe(fixtureMeta("dart/list-00126380-periodic.json")?.url as string);
    // Asked again: the kept answer.
    await source.filings({ corp_code: SAMSUNG, bgn_de: "2025-01-01", end_de: "2026-11-25", pblntf_ty: "A" });
    expect(fetch.requests).toHaveLength(1);
  });

  test("every page to total_count: 250 filings, three pages of at most 100", async () => {
    const pages = [1, 2, 3].map((page) =>
      dart(
        "list.json",
        { corp_code: SAMSUNG, page_no: String(page), page_count: "100", sort_mth: "asc" },
        { body: listPage((page - 1) * 100, page === 3 ? 50 : 100, 250, page), headers: JSON_TYPE },
      ),
    );
    const { dart: source, fetch } = client(pages);
    const filings = await source.filings({ corp_code: SAMSUNG, bgn_de: "2026-01-01", end_de: "2026-11-25" });
    expect(filings).toHaveLength(250);
    expect(new Set(filings.map((one) => one.rcept_no)).size).toBe(250);
    expect(asked(fetch).map((line) => /page_no=(\d+)/.exec(line)?.[1])).toEqual(["1", "2", "3"]);
    // Newest first, as asked by default; oldest first when asked so.
    expect((filings[0]?.rcept_dt ?? "") >= (filings.at(-1)?.rcept_dt ?? "")).toBe(true);
    const { dart: again } = client(pages);
    const oldest = await again.filings({
      corp_code: SAMSUNG,
      bgn_de: "2026-01-01",
      end_de: "2026-11-25",
      sort_mth: "asc",
    });
    expect(oldest.map((one) => one.rcept_no)).toEqual([...filings.map((one) => one.rcept_no)].reverse());
  });

  test("pages that stop short of the total, or repeat rows: unavailable, saying how many of how many", async () => {
    const short = [
      dart("list.json", { page_no: "1" }, { body: listPage(0, 100, 250, 1), headers: JSON_TYPE }),
      dart("list.json", { page_no: "2" }, { body: listPage(100, 0, 250, 2), headers: JSON_TYPE }),
    ];
    const error = await failure(client(short).dart.filings({ corp_code: SAMSUNG, bgn_de: "2026-01-01" }));
    expect([error.kind, error.message]).toEqual([
      "unavailable",
      "OpenDART's filings stopped at 100 of the 250 it counts.",
    ]);
    const repeated = [
      dart("list.json", { page_no: "1" }, { body: listPage(0, 100, 150, 1), headers: JSON_TYPE }),
      dart("list.json", { page_no: "2" }, { body: listPage(50, 50, 150, 2), headers: JSON_TYPE }),
    ];
    expect((await failure(client(repeated).dart.filings({ corp_code: SAMSUNG }))).message).toBe(
      "OpenDART's filings stopped at 100 of the 150 it counts.",
    );
    const ended = [
      dart("list.json", { page_no: "1" }, { body: listPage(0, 100, 150, 1), headers: JSON_TYPE }),
      dart("list.json", { page_no: "2" }, statusBody("013", "조회된 데이타가 없습니다.")),
    ];
    expect((await failure(client(ended).dart.filings({ corp_code: SAMSUNG }))).message).toBe(
      "OpenDART's filings stopped at 100 of the 150 it counts.",
    );
  });

  test("013 on the first page: no filing; parameters OpenDART takes as written; a corp_code or date not in its form is invalid, unsent", async () => {
    const { dart: source, fetch } = client([
      dart("list.json", {}, statusBody("013", "조회된 데이타가 없습니다.")),
    ]);
    expect(
      await source.filings({
        corp_code: SAMSUNG,
        bgn_de: "2026-11-01",
        end_de: "2026-11-25",
        pblntf_detail_ty: "B001",
        last_reprt_at: true,
        corp_cls: "Y",
        sort: "crp",
      }),
    ).toEqual([]);
    expect(asked(fetch)).toEqual([
      "list.json?corp_code=00126380&bgn_de=20261101&end_de=20261125&last_reprt_at=Y&pblntf_detail_ty=B001&corp_cls=Y&sort=crp&sort_mth=desc&page_no=1&page_count=100",
    ]);
    const { dart: refused, fetch: none } = client([]);
    for (const query of [{ corp_code: "126380" }, { bgn_de: "20261101" }, { end_de: "2026-02-30" }]) {
      const error = await failure(refused.filings(query));
      expect([error.kind, error.details.retry]).toEqual(["invalid", "change_request"]);
    }
    expect(none.requests).toEqual([]);
  });
});

// Statements, insider reports, the outline ---------------------------------------------------------------------

describe("statement lines (fnlttSinglAcntAll.json), insider reports (elestock.json), the outline (company.json)", () => {
  test("statement lines: amounts as numbers, a line without a standard id, the changes in equity's component", async () => {
    const { dart: source, fetch } = client([ACCOUNTS]);
    const lines = (await source.accounts(SAMSUNG, 2025, "11011", "CFS")) ?? [];
    expect(
      lines.map(
        (line) => `${line.sj_div} ${line.account_id ?? "-"} ${line.account_nm} ${line.thstrm_amount}`,
      ),
    ).toEqual([
      "BS ifrs-full_CurrentAssets 유동자산 238562514000000",
      "BS ifrs-full_CashAndCashEquivalents 현금및현금성자산 54129331000000",
      "BS ifrs-full_Assets 자산총계 538416725000000",
      "BS ifrs-full_Liabilities 부채총계 108291377000000",
      "BS ifrs-full_Equity 자본총계 430125348000000",
      "IS ifrs-full_Revenue 수익(매출액) 314512893000000",
      "IS dart_OperatingIncomeLoss 영업이익 43601051000000",
      "IS - 지분법손익 1103218000000",
      "IS ifrs-full_ProfitLoss 당기순이익(손실) 37914385000000",
      "CIS ifrs-full_ComprehensiveIncome 총포괄손익 43182117000000",
      "CF ifrs-full_CashFlowsFromUsedInOperatingActivities 영업활동현금흐름 71832516000000",
      "CF ifrs-full_CashFlowsFromUsedInInvestingActivities 투자활동현금흐름 -55210446000000",
      "SCE ifrs-full_Equity 기말자본 418627013000000",
    ]);
    expect(lines[2]).toEqual({
      rcept_no: ANNUAL,
      reprt_code: "11011",
      bsns_year: "2025",
      corp_code: SAMSUNG,
      sj_div: "BS",
      sj_nm: "재무상태표",
      account_id: "ifrs-full_Assets",
      account_nm: "자산총계",
      account_detail: null,
      thstrm_nm: "제 57 기",
      thstrm_amount: 538416725000000,
      thstrm_add_amount: null,
      frmtrm_nm: "제 56 기",
      frmtrm_amount: 514531948000000,
      frmtrm_q_nm: null,
      frmtrm_q_amount: null,
      frmtrm_add_amount: null,
      bfefrmtrm_nm: "제 55 기",
      bfefrmtrm_amount: 455905980000000,
      ord: 3,
      currency: "KRW",
    });
    // The balance sheet the fixture states adds up.
    const at = (name: string) => lines.find((line) => line.account_nm === name)?.thstrm_amount ?? 0;
    expect(at("부채총계") + at("자본총계")).toBe(at("자산총계"));
    expect(lines.at(-1)?.account_detail).toBe("자본 [member]|지배기업의 소유주에게 귀속되는 자본 [member]");
    expect(asked(fetch)).toEqual([
      "fnlttSinglAcntAll.json?corp_code=00126380&bsns_year=2025&reprt_code=11011&fs_div=CFS",
    ]);
  });

  test("no consolidated statements (013): null, so the caller asks for the separate ones; a request not in OpenDART's form is invalid, unsent", async () => {
    const { dart: source, fetch } = client([
      dart("fnlttSinglAcntAll.json", { fs_div: "CFS" }, statusBody("013", "조회된 데이타가 없습니다.")),
      dart(
        "fnlttSinglAcntAll.json",
        { fs_div: "OFS" },
        { file: "dart/accounts-00126380-2025-11011-cfs.json" },
      ),
    ]);
    expect(await source.accounts("00999001", "2025", "11014", "CFS")).toBeNull();
    expect(await source.accounts("00999001", "2025", "11014", "OFS")).toHaveLength(13);
    expect(fetch.requests).toHaveLength(2);
    for (const call of [
      () => source.accounts("126380", 2025, "11011", "CFS"),
      () => source.accounts(SAMSUNG, 25, "11011", "CFS"),
      () => source.accounts(SAMSUNG, 2025, "11015" as "11011", "CFS"),
      () => source.accounts(SAMSUNG, 2025, "11011", "XFS" as "CFS"),
    ]) {
      expect((await failure(call())).kind).toBe("invalid");
    }
    expect(fetch.requests).toHaveLength(2);
  });

  test("insider reports: reporter, registration, position, relation, shares held and their change, the ratio, each linked", async () => {
    const { dart: source } = client([ELESTOCK]);
    const reports = await source.insiders(SAMSUNG);
    expect(reports).toHaveLength(3);
    expect(reports[1]).toEqual({
      rcept_no: "20261020000391",
      rcept_dt: "2026-10-20",
      corp_code: SAMSUNG,
      corp_name: "삼성전자",
      repror: "김철수",
      isu_exctv_rgist_at: "비등기임원",
      isu_exctv_ofcps: "부사장",
      isu_main_shrholdr: null,
      sp_stock_lmp_cnt: 4512,
      sp_stock_lmp_irds_cnt: -1000,
      sp_stock_lmp_rate: 0,
      sp_stock_lmp_irds_rate: 0,
      url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261020000391",
    });
    expect(reports[2]?.sp_stock_lmp_cnt).toBe(97_414_196);
    expect(reports[2]?.sp_stock_lmp_rate).toBe(1.63);
  });

  test("the outline: the month the fiscal year ends, its class, its registration numbers; empty values none", async () => {
    const { dart: source } = client([COMPANY]);
    expect(await source.outline(SAMSUNG)).toEqual({
      corp_code: SAMSUNG,
      corp_name: "삼성전자(주)",
      corp_name_eng: "SAMSUNG ELECTRONICS CO,.LTD",
      stock_name: "삼성전자",
      stock_code: "005930",
      ceo_nm: "홍길동",
      corp_cls: "Y",
      jurir_no: "1301110006246",
      bizr_no: "1248100998",
      adres: "경기도 수원시 영통구  삼성로 129 (매탄동)",
      hm_url: "www.samsung.com/sec",
      ir_url: null,
      phn_no: "031-200-1114",
      fax_no: null,
      induty_code: "264",
      est_dt: "1969-01-13",
      acc_mt: 12,
    });
    const { dart: none } = client([dart("company.json", {}, statusBody("013", "조회된 데이타가 없습니다."))]);
    expect(await none.outline("00999001")).toBeUndefined();
  });

  test("values as OpenDART writes them", () => {
    expect(["67779062000000", "-1,234", "0.25", "", "-", " 12 ", "1e5", null].map(dartAmount)).toEqual([
      67_779_062_000_000,
      -1234,
      0.25,
      null,
      null,
      12,
      null,
      null,
    ]);
    expect(["20260310", "2026-03-10", "2026-02-30", "202603", 20260310].map(dartDate)).toEqual([
      "2026-03-10",
      "2026-03-10",
      null,
      null,
      "2026-03-10",
    ]);
    expect(dartFilingUrl(ANNUAL)).toBe("https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260310000812");
  });
});

// A filing's documents ---------------------------------------------------------------------------------------------

/** `text` in EUC-KR (KS X 1001), for the characters a test writes: ASCII as it is, each other one by its code. */
function eucKr(text: string): Uint8Array {
  const table = new Map<string, number[]>();
  const decoder = new TextDecoder("euc-kr");
  for (let lead = 0xa1; lead <= 0xfe; lead++) {
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      const char = decoder.decode(new Uint8Array([lead, trail]));
      if (char.length === 1 && !table.has(char)) table.set(char, [lead, trail]);
    }
  }
  const out: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 0x80) out.push(code);
    else {
      const bytes = table.get(char);
      if (!bytes) throw new Error(`${char} is not in KS X 1001`);
      out.push(...bytes);
    }
  }
  return new Uint8Array(out);
}

describe("a filing's documents (document.xml)", () => {
  test("the fixture: every document by its name, the main one first, each decoded from the encoding it declares", async () => {
    const { dart: source, fetch } = client([DOCUMENT]);
    const archive = await source.archive(ANNUAL);
    expect(archive.names).toEqual([`${ANNUAL}.xml`, `${ANNUAL}_00760.xml`, `${ANNUAL}_00761.xml`]);
    const main = archive.main();
    expect([main?.name, main?.encoding]).toEqual([`${ANNUAL}.xml`, "utf-8"]);
    expect(main?.text).toStartWith('<?xml version="1.0" encoding="utf-8"?>');
    for (const title of [
      "I. 회사의 개요",
      "II. 사업의 내용",
      "III. 재무에 관한 사항",
      "IV. 이사의 경영진단 및 분석의견",
    ]) {
      expect(main?.text).toContain(`>${title}</TITLE>`);
    }
    expect(archive.document(`${ANNUAL}_00760.xml`)?.text).toContain(
      '<DOCUMENT-NAME ACODE="00760">감사보고서</DOCUMENT-NAME>',
    );
    expect(archive.document(`${ANNUAL}_00761.XML`)?.name).toBe(`${ANNUAL}_00761.xml`);
    expect(archive.document("missing.xml")).toBeUndefined();
    expect(archive.documents().map((one) => one.name)).toEqual([...archive.names]);
    expect(asked(fetch)).toEqual([`document.xml?rcept_no=${ANNUAL}`]);
  });

  test("encodings: EUC-KR as declared (and Microsoft's name for it), a byte-order mark, UTF-16, none declared; one this app cannot read fails alone", async () => {
    const body = "<DOCUMENT><DOCUMENT-NAME>감사보고서</DOCUMENT-NAME><P>삼성전자 재무제표</P></DOCUMENT>";
    const declared = (encoding: string) => `<?xml version="1.0" encoding="${encoding}"?>\n${body}`;
    const utf16 = (text: string, bigEndian: boolean) => {
      const out = new Uint8Array(2 + text.length * 2);
      out.set(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]);
      for (let at = 0; at < text.length; at++) {
        const code = text.charCodeAt(at);
        out[2 + at * 2] = bigEndian ? code >> 8 : code & 0xff;
        out[3 + at * 2] = bigEndian ? code & 0xff : code >> 8;
      }
      return out;
    };
    const receipt = "20000331000123";
    const archive = zipOf([
      { name: `${receipt}.xml`, data: eucKr(declared("euc-kr")) },
      { name: `${receipt}_00760.xml`, data: eucKr(declared("CP949")) },
      { name: `${receipt}_00761.xml`, data: eucKr(declared("ks_c_5601-1987")) },
      {
        name: "bom.xml",
        data: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(declared("euc-kr"))]),
      },
      { name: "utf16le.xml", data: utf16(declared("UTF-16"), false) },
      { name: "utf16be.xml", data: utf16(declared("UTF-16"), true) },
      { name: "plain.xml", data: new TextEncoder().encode(body) },
      { name: "other.xml", data: new TextEncoder().encode(declared("x-unknown-1")) },
      { name: "image.jpg", data: new Uint8Array([0xff, 0xd8, 0xff]) },
    ]);
    const { dart: source } = client([
      dart(
        "document.xml",
        { rcept_no: receipt },
        { body: archive, headers: { "content-type": "application/zip" } },
      ),
    ]);
    const read = await source.archive(receipt);
    expect(read.names).toHaveLength(9);
    const decoded = (name: string) => {
      const document = read.document(name);
      return [document?.encoding, document?.text.includes("<P>삼성전자 재무제표</P>")];
    };
    expect(read.main()?.name).toBe(`${receipt}.xml`);
    expect(decoded(`${receipt}.xml`)).toEqual(["euc-kr", true]);
    expect(decoded(`${receipt}_00760.xml`)).toEqual(["euc-kr", true]);
    expect(decoded(`${receipt}_00761.xml`)).toEqual(["euc-kr", true]);
    // A byte-order mark says the encoding, whatever the declaration says; it is not part of the text.
    expect(decoded("bom.xml")).toEqual(["utf-8", true]);
    expect(read.document("bom.xml")?.text).toStartWith("<?xml");
    expect(decoded("utf16le.xml")).toEqual(["utf-16le", true]);
    expect(decoded("utf16be.xml")).toEqual(["utf-16be", true]);
    expect(decoded("plain.xml")).toEqual(["utf-8", true]);
    // Only XML documents are documents; one in an encoding this app does not read fails when it is opened.
    expect(() => read.document("image.jpg")).not.toThrow();
    expect(read.document("image.jpg")).toBeUndefined();
    let refused: unknown;
    try {
      read.document("other.xml");
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(DataError);
    expect([(refused as DataError).kind, (refused as DataError).message]).toEqual([
      "unavailable",
      `OpenDART's document of ${receipt}, other.xml cannot be read: it declares the encoding x-unknown-1, which this app does not read.`,
    ]);
    expect(decodeXml(eucKr(declared("EUC-KR"))).text).toContain("감사보고서");
  });

  test("no document for the receipt number (014, or 013): no_data naming it; a receipt number not in OpenDART's form is invalid, unsent", async () => {
    for (const status of ["014", "013"]) {
      const { dart: source } = client([
        dart("document.xml", {}, statusXml(status, "파일이 존재하지 않습니다.")),
      ]);
      const error = await failure(source.archive("20991231000001"));
      expect([error.kind, error.message]).toEqual([
        "no_data",
        `OpenDART has no document for receipt number 20991231000001 (${status}: 파일이 존재하지 않습니다.).`,
      ]);
    }
    const { dart: source, fetch } = client([]);
    for (const receipt of ["2026031000081", "rcept", "20260310-000812"]) {
      expect((await failure(source.archive(receipt))).kind).toBe("invalid");
    }
    expect(fetch.requests).toEqual([]);
  });
});

// The key ------------------------------------------------------------------------------------------------------

describe("DART_API_KEY", () => {
  test("without it nothing is read: each reading answers not_configured naming the variable, unsent", async () => {
    const { dart: source, fetch } = client([], {});
    const readings: [string, () => Promise<unknown>][] = [
      ["OpenDART's company list", () => source.corpList()],
      ["OpenDART's filings", () => source.filings({ corp_code: SAMSUNG })],
      ["OpenDART's financial statements", () => source.accounts(SAMSUNG, 2025, "11011", "CFS")],
      ["OpenDART's insider reports", () => source.insiders(SAMSUNG)],
      ["OpenDART's company outline", () => source.outline(SAMSUNG)],
      ["OpenDART's filing documents", () => source.archive(ANNUAL)],
    ];
    for (const [what, reading] of readings) {
      const error = await failure(reading());
      expect([error.kind, error.message, error.details.code]).toEqual([
        "not_configured",
        `${what} needs DART_API_KEY (a free key from OpenDART, https://opendart.fss.or.kr/), set in the environment or under "data" in credentials.json.`,
        NOTICE.capabilityUnavailable,
      ]);
    }
    expect(fetch.requests).toEqual([]);
  });

  test("never in a cache key, a link, an answer or a message: the key travels only in OpenDART's query", async () => {
    const keys: string[] = [];
    const inner = createCache();
    const watched: Cache = {
      keep: <T>(key: string, ttlMs: number, load: () => Promise<T>, options?: KeepOptions) => {
        keys.push(key);
        return inner.keep(key, ttlMs, load, options);
      },
      remember: <T>(key: string, ttlMs: number, load: () => Promise<T>, options?: KeepOptions) => {
        keys.push(key);
        return inner.remember(key, ttlMs, load, options);
      },
      forget: (key: string) => inner.forget(key),
    };
    const { dart: source, fetch } = client(
      [CORP_CODES, PERIODIC, ACCOUNTS, ELESTOCK, COMPANY, DOCUMENT],
      DART,
      watched,
    );
    const answers = [
      await source.corpList(),
      await source.filings({
        corp_code: SAMSUNG,
        bgn_de: "2025-01-01",
        end_de: "2026-11-25",
        pblntf_ty: "A",
      }),
      await source.accounts(SAMSUNG, 2025, "11011", "CFS"),
      await source.insiders(SAMSUNG),
      await source.outline(SAMSUNG),
      (await source.archive(ANNUAL)).documents(),
    ];
    expect(keys).toHaveLength(6);
    for (const key of keys) expect(key).not.toContain(KEY);
    expect(JSON.stringify(answers)).not.toContain(KEY);
    expect(JSON.stringify(answers)).not.toContain("opendart.fss.or.kr");
    // Each request carries it, in its query alone.
    for (const { url, headers } of fetch.requests) {
      expect(new URL(url).searchParams.get("crtfc_key")).toBe(KEY);
      expect(new URL(url).pathname).not.toContain(KEY);
      expect(JSON.stringify([...headers.entries()])).not.toContain(KEY);
    }
    expect(source.scrub(`https://opendart.fss.or.kr/api/list.json?crtfc_key=${KEY}`)).toBe(
      "https://opendart.fss.or.kr/api/list.json?crtfc_key=***",
    );
  });

  test("no fixture holds a key: every OpenDART address in their metas has crtfc_key=***", async () => {
    const dir = join(FIXTURES, "dart");
    for (const file of (await readdir(dir)).filter((name) => name.endsWith(".meta.json"))) {
      const meta = JSON.parse(await readFile(join(dir, file), "utf8")) as { url: string; hand_made: boolean };
      expect(new URL(meta.url).searchParams.get("crtfc_key"), file).toBe("***");
      expect(meta.hand_made, file).toBe(true);
    }
  });
});

// The recorder's cases -------------------------------------------------------------------------------------------

describe("the recorder's OpenDART cases (scripts/fork/fixture-cases/dart.ts)", () => {
  const dryRun = async (env: Record<string, string>) => {
    const home = await mkdtemp(join(tmpdir(), "fork-dart-cases-"));
    const said: string[] = [];
    const sent: string[] = [];
    try {
      const status = await record({
        argv: ["--dry-run", "--only", "dart"],
        env: { HOME: home, TRADINGAGENTS_HOME: join(home, "home"), PATH: process.env.PATH ?? "", ...env },
        fetch: (async (input: string | URL | Request): Promise<Response> => {
          sent.push(String(input));
          throw new Error("a dry run sends nothing");
        }) as typeof globalThis.fetch,
        out: (line) => said.push(line),
        err: (line) => said.push(line),
      });
      return { status, said, sent };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };

  test("--dry-run lists each case and its files, the key removed, and sends nothing", async () => {
    const { status, said, sent } = await dryRun({ DART_API_KEY: KEY });
    expect(status).toBe(0);
    expect(sent).toEqual([]);
    expect(said).toEqual([
      "dart/corp-codes.zip and dart/corp-codes.meta.json <- (its own reading)",
      "dart/list-00126380-periodic.json and dart/list-00126380-periodic.meta.json <- https://opendart.fss.or.kr/api/list.json?crtfc_key=***&corp_code=00126380&bgn_de=20250101&end_de=20261125&pblntf_ty=A&sort=date&sort_mth=asc&page_no=1&page_count=100",
      "dart/accounts-00126380-2025-11011-cfs.json and dart/accounts-00126380-2025-11011-cfs.meta.json <- https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?crtfc_key=***&corp_code=00126380&bsns_year=2025&reprt_code=11011&fs_div=CFS",
      "dart/elestock-00126380.json and dart/elestock-00126380.meta.json <- https://opendart.fss.or.kr/api/elestock.json?crtfc_key=***&corp_code=00126380",
      "dart/company-00126380.json and dart/company-00126380.meta.json <- https://opendart.fss.or.kr/api/company.json?crtfc_key=***&corp_code=00126380",
      "dart/document-00126380-annual.zip and dart/document-00126380-annual.meta.json <- (its own reading)",
    ]);
    expect(said.join("\n")).not.toContain(KEY);
  });

  test("without DART_API_KEY no case has an address, so none would be sent", async () => {
    const { status, said, sent } = await dryRun({});
    expect(status).toBe(0);
    expect(sent).toEqual([]);
    expect(said.filter((line) => line.endsWith(`<- ${NO_DART_KEY}`))).toHaveLength(4);
    const { deps } = testDeps({}, []);
    expect(await readCorpCodes(deps.http, undefined).catch((error: Error) => error.message)).toBe(
      NO_DART_KEY,
    );
    expect(await readAnnualDocument(deps.http, undefined).catch((error: Error) => error.message)).toBe(
      NO_DART_KEY,
    );
  });

  test("each case reads, offline, what its fixture holds: one case a fixture, each fixture a case", async () => {
    const top = (await readdir(join(FIXTURES, "dart"), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.name.endsWith(".meta.json"))
      .map((entry) => entry.name)
      .sort();
    expect(DART_CASES.map((one) => one.file).sort()).toEqual(top);
    const { deps } = testDeps(DART, [CORP_CODES, PERIODIC, ACCOUNTS, ELESTOCK, COMPANY, DOCUMENT]);
    const tools = { yahoo: deps.yahoo, yahooAnswer: yahooAnswerer(fixtureFetch([])) };
    for (const one of DART_CASES.filter((each) => each.url)) {
      const recorded = await recordOne(one, deps.http, tools, [KEY], DART);
      const file = `dart/${one.file}`;
      expect(recorded.meta.url, file).toBe(fixtureMeta(file)?.url as string);
      expect(new TextDecoder().decode(recorded.body), file).toBe(new TextDecoder().decode(fixture(file)));
    }
    // The company list: the fixture cut again is itself (its CORPCODE.xml as it was).
    const corp = await readCorpCodes(deps.http, KEY);
    const text = (bytes: Uint8Array) => new TextDecoder().decode(readZip(bytes)[0]?.bytes());
    expect(text(corp.body as Uint8Array)).toBe(text(fixture("dart/corp-codes.zip")));
    expect(text(corpCodesExcerpt(fixture("dart/corp-codes.zip")))).toBe(text(fixture("dart/corp-codes.zip")));
    // The annual report's documents, found by list.json.
    const annual = await readAnnualDocument(
      testDeps(DART, [
        dart(
          "list.json",
          { pblntf_detail_ty: "A001", last_reprt_at: "Y", sort_mth: "desc" },
          {
            body: JSON.stringify({
              status: "000",
              message: "정상",
              total_count: 1,
              list: [{ rcept_no: ANNUAL }],
            }),
            headers: JSON_TYPE,
          },
        ),
        DOCUMENT,
      ]).deps.http,
      KEY,
    );
    expect(annual.url?.replace(KEY, "***")).toBe(
      fixtureMeta("dart/document-00126380-annual.zip")?.url as string,
    );
    expect(annual.body).toEqual(fixture("dart/document-00126380-annual.zip"));
  });
});
