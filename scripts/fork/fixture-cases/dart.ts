// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of OpenDART for the DART client's tests (test/fork/data/dart-source*.test.ts) and the instrument
 * search's (test/fork/data/instruments-dart.test.ts), written to test/fork/fixtures/dart/, each request as the
 * client (src/fork/data/sources/dart.ts) sends it with DART_API_KEY, which comes from the settings (the
 * environment, else credentials.json's "data") when a case runs, never from here; it travels in the query as
 * crtfc_key and is removed from what is written:
 *
 * - corp-codes.zip: corpCode.xml, OpenDART's company list, cut to the companies the tests read (CORP_EXCERPT:
 *   by stock code, corp_code and name, each `<list>` kept as OpenDART wrote it) and zipped again as the one
 *   CORPCODE.xml OpenDART zips: the whole list holds about 100,000 companies, and the tests need a dozen;
 * - list-00126380-periodic.json: list.json, Samsung Electronics' periodic reports (pblntf_ty A) received from
 *   2025-01-01 to 2026-11-25, its first page as the client asks for it (oldest first, 100 a page);
 * - accounts-00126380-2025-11011-cfs.json: fnlttSinglAcntAll.json, the consolidated lines of its 2025 annual
 *   report;
 * - elestock-00126380.json and company-00126380.json: its officers' and major shareholders' reports, and its
 *   outline;
 * - document-00126380-annual.zip: document.xml, the documents of its latest annual report (the first final
 *   A001 report list.json answers from 2025-01-01 to 2026-11-25, newest first), whole.
 *
 * Without DART_API_KEY no case has an address or a reading that sends anything: each fails, unsent. Every
 * fixture in the repository is hand-made in OpenDART's documented format: no OpenDART answer has been seen
 * from the session that built them. Recording replaces them with OpenDART's own, and the golden texts of the
 * tests that read them then need bringing up to date. OpenDART answers its failures with a status in the body
 * (020 for a spent daily limit, 010 for a key it does not know): a JSON case it refuses writes that status, so
 * read what was written; a ZIP case it refuses fails.
 *
 * `zipOf` and `corpCodesExcerpt` are exported for the tests, which build archives of their own with them.
 */
import { crc32, deflateRawSync } from "node:zlib";
import { resolvePaths } from "../../../src/config/paths.js";
import { type PublicDataConfig, publicDataConfig } from "../../../src/fork/data/config.js";
import { FORK_REQUEST_MS, type Http } from "../../../src/fork/data/http.js";
import { DART_API, DART_PAGE_COUNT, decodeXml, parseCorpCodes } from "../../../src/fork/data/sources/dart.js";
import { readZip, zipEntry } from "../../../src/fork/data/util/zip.js";
import type { FixtureCase, Recorded } from "../record-fixtures.ts";

/** What a case reads without DART_API_KEY: no address, so it fails without a request. */
export const NO_DART_KEY = "DART_API_KEY is not set";

/** Samsung Electronics' corp_code, the company most fixtures are of. */
const SAMSUNG = "00126380";

/** The companies corp-codes.zip keeps of OpenDART's list: by stock code, by corp_code, by name. */
export const CORP_EXCERPT = {
  // Samsung Electronics, Samsung SDI, Samsung Electro-Mechanics, Samsung C&T, SK hynix, Kakao (KOSPI) and
  // JYP Entertainment (KOSDAQ).
  stockCodes: ["005930", "006400", "009150", "028260", "000660", "035720", "035900"],
  // Daco, the guide's own example of a company without a listing.
  corpCodes: ["00434003"],
  // Unlisted companies whose names start with a listed one's, and the issuer of the KODEX funds.
  names: ["삼성전자서비스", "삼성전자판매", "삼성전자로지텍", "삼성자산운용"],
} as const;

/** The settings as the app reads them: the key is taken from them when a case runs, never at import. */
async function dartKey(): Promise<string | undefined> {
  return (await publicDataConfig(process.env, resolvePaths(process.env))).config.dartKey;
}

/** An OpenDART address with the key first, as the client writes it. */
function addressOf(service: string, key: string, params: Readonly<Record<string, string>>): string {
  return `${DART_API}/${service}?${new URLSearchParams({ crtfc_key: key, ...params })}`;
}

/** A case's address from the settings, or NO_DART_KEY. */
const dart =
  (service: string, params: Readonly<Record<string, string>>) =>
  (config: PublicDataConfig): string =>
    config.dartKey ? addressOf(service, config.dartKey, params) : NO_DART_KEY;

/**
 * An archive of `entries`, each deflated, as a ZIP writer lays one out (local headers and data, the central
 * directory, its end), with no time stamps, so the same entries make the same archive.
 */
export function zipOf(entries: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const packed = new Uint8Array(deflateRawSync(entry.data, { level: 9 }));
    const checksum = crc32(entry.data) >>> 0;
    // Names outside ASCII are flagged as UTF-8 (bit 11).
    const flags = /^[\x20-\x7e]*$/.test(entry.name) ? 0 : 0x800;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, 8, true);
    local.setUint32(14, checksum, true);
    local.setUint32(18, packed.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, packed);
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, flags, true);
    record.setUint16(10, 8, true);
    record.setUint32(16, checksum, true);
    record.setUint32(20, packed.length, true);
    record.setUint32(24, entry.data.length, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), name);
    offset += 30 + name.length + packed.length;
  }
  const directory = concat(central);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directory.length, true);
  end.setUint32(16, offset, true);
  return concat([...parts, directory, new Uint8Array(end.buffer)]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * corpCode.xml's archive cut to the companies CORP_EXCERPT names, in the list's order, each `<list>` as written,
 * zipped again under the entry's own name; it throws when the archive holds no company list.
 */
export function corpCodesExcerpt(archive: Uint8Array): Uint8Array {
  const entries = readZip(archive);
  const entry =
    zipEntry(entries, "CORPCODE.xml") ??
    entries.find((one) => !one.directory && one.name.toLowerCase().endsWith(".xml"));
  if (!entry) throw new Error("the archive holds no CORPCODE.xml");
  const text = decodeXml(entry.bytes()).text;
  const stockCodes = new Set<string>(CORP_EXCERPT.stockCodes);
  const corpCodes = new Set<string>(CORP_EXCERPT.corpCodes);
  const names = new Set<string>(CORP_EXCERPT.names);
  const kept: string[] = [];
  let at = 0;
  for (;;) {
    const start = text.indexOf("<list>", at);
    if (start < 0) break;
    const end = text.indexOf("</list>", start);
    if (end < 0) break;
    const chunk = text.slice(start, end + "</list>".length);
    at = end + "</list>".length;
    let company: ReturnType<typeof parseCorpCodes>[number] | undefined;
    try {
      [company] = parseCorpCodes(`<result>${chunk}</result>`);
    } catch {
      company = undefined;
    }
    if (!company) continue;
    if (
      (company.stock_code && stockCodes.has(company.stock_code)) ||
      corpCodes.has(company.corp_code) ||
      names.has(company.corp_name)
    ) {
      kept.push(`    ${chunk}`);
    }
  }
  if (!kept.length) throw new Error("the company list holds none of the companies the tests read");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<result>\n${kept.join("\n")}\n</result>\n`;
  return zipOf([{ name: entry.name, data: new TextEncoder().encode(xml) }]);
}

/** corpCode.xml read and cut to CORP_EXCERPT (see the top of this file). */
export async function readCorpCodes(http: Http, key: string | undefined): Promise<Recorded> {
  if (!key) throw new Error(NO_DART_KEY);
  const url = addressOf("corpCode.xml", key, {});
  const answer = await http.get(url, {
    source: "OpenDART",
    timeoutMs: FORK_REQUEST_MS.bulk,
    redirect: "same-origin",
  });
  return {
    body: corpCodesExcerpt(await answer.bytes()),
    status: answer.status,
    url,
    contentType: "application/zip",
  };
}

/** The documents of Samsung Electronics' latest final annual report: found by list.json, read by document.xml. */
export async function readAnnualDocument(http: Http, key: string | undefined): Promise<Recorded> {
  if (!key) throw new Error(NO_DART_KEY);
  const listed = (await http.json(
    addressOf("list.json", key, {
      corp_code: SAMSUNG,
      bgn_de: "20250101",
      end_de: "20261125",
      last_reprt_at: "Y",
      pblntf_detail_ty: "A001",
      sort: "date",
      sort_mth: "desc",
      page_no: "1",
      page_count: String(DART_PAGE_COUNT),
    }),
    { source: "OpenDART", redirect: "same-origin" },
  )) as { status?: unknown; list?: { rcept_no?: unknown }[] };
  const receipt = listed.list?.[0]?.rcept_no;
  if (listed.status !== "000" || typeof receipt !== "string" || !/^\d{14}$/.test(receipt)) {
    throw new Error(`OpenDART listed no annual report of ${SAMSUNG} (status ${String(listed.status)})`);
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

export const cases: FixtureCase[] = [
  {
    source: "dart",
    name: "corp-codes",
    file: "corp-codes.zip",
    read: async (http) => readCorpCodes(http, await dartKey()),
  },
  {
    source: "dart",
    name: "list-00126380-periodic",
    file: "list-00126380-periodic.json",
    url: dart("list.json", {
      corp_code: SAMSUNG,
      bgn_de: "20250101",
      end_de: "20261125",
      pblntf_ty: "A",
      sort: "date",
      sort_mth: "asc",
      page_no: "1",
      page_count: String(DART_PAGE_COUNT),
    }),
  },
  {
    source: "dart",
    name: "accounts-00126380-2025-11011-cfs",
    file: "accounts-00126380-2025-11011-cfs.json",
    url: dart("fnlttSinglAcntAll.json", {
      corp_code: SAMSUNG,
      bsns_year: "2025",
      reprt_code: "11011",
      fs_div: "CFS",
    }),
  },
  {
    source: "dart",
    name: "elestock-00126380",
    file: "elestock-00126380.json",
    url: dart("elestock.json", { corp_code: SAMSUNG }),
  },
  {
    source: "dart",
    name: "company-00126380",
    file: "company-00126380.json",
    url: dart("company.json", { corp_code: SAMSUNG }),
  },
  {
    source: "dart",
    name: "document-00126380-annual",
    file: "document-00126380-annual.zip",
    read: async (http) => readAnnualDocument(http, await dartKey()),
  },
];
