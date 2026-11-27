// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * OpenDART, the disclosure API of Korea's Financial Supervisory Service (https://opendart.fss.or.kr/api/),
 * read with DART_API_KEY: the one client every DART part of the fork reads through (instrument search,
 * statements, filings and their text, insider reports). Without the key nothing is read, and each reading
 * answers not_configured, naming DART_API_KEY.
 *
 * The key travels in the query as `crtfc_key`. Every message is scrubbed of it (deps.http.redact, as the HTTP
 * client scrubs its own), cache keys are built from what a request is about (a corp_code, a receipt number),
 * never from a URL, and every link answered is DART's public page of a filing
 * (https://dart.fss.or.kr/dsaf001/main.do?rcpNo=<rcept_no>), never an API address.
 *
 * What is read, each row under OpenDART's own field names, dates as YYYY-MM-DD, amounts as numbers, and a value
 * OpenDART leaves empty (or writes as "-") null:
 *
 * - corpCode.xml (고유번호): a ZIP holding CORPCODE.xml, one `<list>` per company: corp_code (8 digits),
 *   corp_name, corp_eng_name (when given), stock_code (6 characters for a listed company, a blank otherwise)
 *   and modify_date. About 100,000 companies make an XML text of about 27 MB (about 270 bytes a company),
 *   under util/zip.ts's 256 MiB bound on an entry, and an archive of a few MB, under the HTTP client's
 *   16 MiB (ANSWER_BYTES) on an answer; each `<list>` is read with util/xml.ts on its own, so the whole
 *   document is never held as a tree. Kept a day, on disk too, and served past its day when OpenDART cannot
 *   be read (`corpList`). Lookups by stock_code, by corp_code and by name (`search`: Korean and English
 *   names, compared without spacing, case, punctuation or a legal form such as 주식회사, (주), Co., Ltd.;
 *   listed companies first, then the name itself, the names starting with the words searched, and the
 *   others holding them); a listing's key read as its company (`company`: unsupported for a key that names
 *   no Korean listing, or a code the list does not hold, so the router asks the next source).
 * - list.json (공시검색): filings by corp_code, receipt dates (bgn_de, end_de), type (pblntf_ty,
 *   pblntf_detail_ty), final reports only (last_reprt_at) and class (corp_cls), DART_PAGE_COUNT a page (the
 *   most page_count takes), page after page until total_count is read. Pages are asked oldest first so a
 *   filing made while they are read cannot move a row between pages; they are answered in the order asked.
 * - fnlttSinglAcntAll.json (단일회사 전체 재무제표): one company's every statement line for one business year
 *   (bsns_year, from 2015), report (reprt_code: 11013 first quarter, 11012 half year, 11014 third quarter,
 *   11011 annual) and basis (fs_div: CFS consolidated, OFS separate); status 013 (none) is null.
 * - elestock.json (임원ㆍ주요주주 소유보고): the reports of officers and major shareholders: reporter, their
 *   registration and position, major-shareholder relation, shares held, their change, the ratio held and
 *   its change, receipt number and date.
 * - company.json (기업개황): the company's outline: names, CEO, class (corp_cls: Y KOSPI, K KOSDAQ, N KONEX,
 *   E other), registration numbers, address, sites, industry code, founding date and the month its fiscal
 *   year ends (acc_mt), which places a fiscal year's periods.
 * - document.xml (공시서류원본파일): a ZIP of a filing's documents in DART's XML (the main document
 *   <rcept_no>.xml and attachments such as the audit report <rcept_no>_<n>.xml), each read by its name and
 *   decoded from the encoding it declares (UTF-8, EUC-KR and the rest TextDecoder reads; a byte-order mark
 *   first). Kept a week, on disk only: a receipt number's documents do not change.
 *
 * majorstock.json (대량보유 상황보고, holders of 5% or more) is not read: the only holders the tools serve are
 * one quarter's institutional (13F) holdings, which the ownership tool names as such (a quarter, a value in
 * dollars, investment discretion); a 5% holder's report has none of these.
 *
 * OpenDART answers HTTP 200 with a status (the guide's message table), each the DataError kind it calls for
 * (DART_STATUS): 000 normal; 013 no data (an empty answer: no filings, no statement lines, no reports); 014 no
 * such file (no_data); 010 a key not registered, 011 a key suspended, 012 an address not allowed, 901 a key
 * whose holder's records expired (rejected); 020 the request limit reached (quota: OpenDART counts each key's
 * requests, generally 20,000 a day); 021 more companies than one request takes (100) and 100, 101 a field or
 * an access it does not accept (invalid); 800 maintenance and 900 an error it does not define (unavailable).
 * corpCode.xml and document.xml answer a failure as XML (<result><status/><message/></result>) instead of a
 * ZIP. A status this list lacks is unavailable.
 *
 * The limits OpenDART publishes, each its own to enforce: page_count at most 100 (list.json, read to its
 * total), three months of receipts a search without corp_code, 100 companies a request (021), and each key's
 * requests, generally 20,000 a day (020). Its guide states no rate a second or a minute, so the HTTP client
 * keeps none for it.
 */
import { NOTICE } from "../../../contracts/index.js";
import type { Call } from "../../../data/capabilities.js";
import { DataError, type DataErrorDetails, type DataErrorKind } from "../../../data/errors.js";
import type { ForkDeps } from "../deps.js";
import { type Answer, FORK_REQUEST_MS, unreadable } from "../http.js";
import { type KoreanMarket, parseListing } from "../listings.js";
import { child, find, parseXml, textOf, valueAt } from "../util/xml.js";
import { readZip, type ZipEntry, ZipError, zipEntry } from "../util/zip.js";

/** The name answers give OpenDART. */
export const DART_SOURCE = "OpenDART";

/** Where OpenDART's services are. */
export const DART_API = "https://opendart.fss.or.kr/api";

/** Where a key is had, free: OpenDART's site. */
export const DART_KEY_PAGE = "https://opendart.fss.or.kr/";

/** DART's public page of a filing, by its receipt number. */
export const DART_VIEWER = "https://dart.fss.or.kr/dsaf001/main.do";

/** Filings asked for in one list.json page: the most page_count takes. */
export const DART_PAGE_COUNT = 100;

/** The company list's key in the cache, and how long it is kept: OpenDART updates it daily. */
export const DART_CORP_CODES_KEY = "dart:corp-codes";
export const DART_CORP_CODES_TTL_MS = 86_400_000;

/**
 * fnlttSinglAcntAll's reports (reprt_code), in the order of the business year: each one's name, the months of
 * the business year it covers, and where those months end in a business year ending in December.
 */
export const DART_REPORTS = {
  "11013": { name: "1분기보고서", months: 3, end: "03-31" },
  "11012": { name: "반기보고서", months: 6, end: "06-30" },
  "11014": { name: "3분기보고서", months: 9, end: "09-30" },
  "11011": { name: "사업보고서", months: 12, end: "12-31" },
} as const;
export type DartReportCode = keyof typeof DART_REPORTS;

/** fs_div: consolidated (CFS) or separate (OFS) statements. */
export type DartStatementBasis = "CFS" | "OFS";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Statuses ---------------------------------------------------------------------------------------

/**
 * OpenDART's statuses (the guide's message table), each the kind it calls for, and what it means. 013 is an
 * empty answer where a reading has one (list.json, fnlttSinglAcntAll.json, elestock.json), no_data elsewhere.
 */
export const DART_STATUS: Readonly<Record<string, { kind: DataErrorKind | "ok"; means: string }>> = {
  "000": { kind: "ok", means: "normal" },
  "010": { kind: "rejected", means: "a key OpenDART has not registered" },
  "011": { kind: "rejected", means: "a key OpenDART has suspended" },
  "012": { kind: "rejected", means: "an address OpenDART does not take requests from" },
  "013": { kind: "no_data", means: "no data for the request" },
  "014": { kind: "no_data", means: "no such file" },
  "020": { kind: "quota", means: "the key's request limit reached" },
  "021": { kind: "invalid", means: "more companies than one request takes (100)" },
  "100": { kind: "invalid", means: "a field's value OpenDART does not take" },
  "101": { kind: "invalid", means: "an access OpenDART does not take" },
  "800": { kind: "unavailable", means: "OpenDART's maintenance" },
  "900": { kind: "unavailable", means: "an error OpenDART does not define" },
  "901": { kind: "rejected", means: "a key whose holder's records OpenDART no longer keeps" },
};

/** The kind a status calls for: ok for 000, unavailable for a status the guide does not list. */
export function dartStatusKind(status: string): DataErrorKind | "ok" {
  return DART_STATUS[status]?.kind ?? "unavailable";
}

/** A status as OpenDART writes it: three digits ("000", "013"); undefined when it is not one. */
export function statusOf(value: unknown): string | undefined {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return /^\d{1,3}$/.test(text) ? text.padStart(3, "0") : undefined;
}

/** The failure for a request that needs DART_API_KEY when it is not set; its message is shown as it is. */
export function dartKeyNeeded(what: string): DataError {
  return new DataError(
    "not_configured",
    `${what} needs DART_API_KEY (a free key from OpenDART, ${DART_KEY_PAGE}), set in the environment or under "data" in credentials.json.`,
    { source: DART_SOURCE, code: NOTICE.capabilityUnavailable, retry: "never" },
  );
}

/**
 * OpenDART's answer to a request it did not serve, as a DataError of the kind its status means, with its own
 * words (`said`) scrubbed of every key and cut to one line; `none` says what there is none of (no_data).
 */
export function dartFailure(
  deps: Pick<ForkDeps, "http">,
  status: string,
  said: string | undefined,
  none = "data for the request",
): DataError {
  const words = deps.http
    .redact((said ?? "").replace(/\s+/g, " ").trim())
    .slice(0, 200)
    .trim();
  const detail = `${status}${words ? `: ${words}` : ""}`;
  const kind = dartStatusKind(status);
  const details: DataErrorDetails = { source: DART_SOURCE, code: status };
  switch (kind) {
    case "rejected":
      return new DataError(
        "rejected",
        status === "012"
          ? `${DART_SOURCE} does not take requests from this address (${detail}).`
          : `${DART_SOURCE} refused DART_API_KEY (${detail}). A free key comes from ${DART_KEY_PAGE}.`,
        { source: DART_SOURCE, code: NOTICE.capabilityUnavailable },
      );
    case "quota":
      return new DataError(
        "quota",
        `${DART_SOURCE}'s request limit for DART_API_KEY is reached (${detail}).`,
        details,
      );
    case "invalid":
      return new DataError("invalid", `${DART_SOURCE} did not take the request (${detail}).`, {
        ...details,
        retry: "change_request",
      });
    case "no_data":
      return new DataError("no_data", `${DART_SOURCE} has no ${none} (${detail}).`, details);
    default:
      return new DataError("unavailable", `${DART_SOURCE} could not answer (${detail}).`, details);
  }
}

// Values -----------------------------------------------------------------------------------------

/** A text value, trimmed; null when empty or OpenDART's "-" for none. */
export function dartText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" || text === "-" ? null : text;
}

/** An amount as OpenDART writes one ("67779062000000", "-1,234", "0.25"); null for an empty value or "-". */
export function dartAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim().replaceAll(",", "");
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return null;
  const amount = Number(text);
  return Object.is(amount, -0) ? 0 : amount;
}

/** A date as OpenDART writes one (20260310 or 2026-03-10) as YYYY-MM-DD, when it is a day on the calendar. */
export function dartDate(value: unknown): string | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(text);
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? date : null;
}

/**
 * The market a company's listing is on, one rule for every OpenDART answer: OpenDART's class of the company
 * (corp_cls: Y KOSPI, K KOSDAQ) when it gives one (N, KONEX, and E, other, are no market a key names), else the
 * market of the key asked with.
 */
export function dartMarketOf(corpCls: string | null, fromKey: KoreanMarket | null): KoreanMarket | null {
  if (corpCls === "Y") return "XKRX";
  if (corpCls === "K") return "XKOS";
  return corpCls ? null : fromKey;
}

/** A date YYYY-MM-DD as OpenDART's requests take it: YYYYMMDD. */
function compactDate(date: string): string {
  return date.replaceAll("-", "");
}

/** DART's public page of the filing with receipt number `rceptNo`. */
export function dartFilingUrl(rceptNo: string): string {
  return `${DART_VIEWER}?rcpNo=${encodeURIComponent(rceptNo)}`;
}

/** A record of an answer, or undefined. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The records in an answer's list, those that are records. */
function rowsOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const row of value as unknown[]) {
    const record = recordOf(row);
    if (record) rows.push(record);
  }
  return rows;
}

const CORP_CODE = /^\d{8}$/;
const RECEIPT = /^\d{14}$/;
const STOCK_CODE = /^[0-9][0-9A-Z]{5}$/;

// Text of an XML document ------------------------------------------------------------------------

/** Encodings named otherwise than TextDecoder knows them (Microsoft's names for EUC-KR's superset). */
const ENCODING_ALIASES: Readonly<Record<string, string>> = {
  cp949: "euc-kr",
  ms949: "euc-kr",
  uhc: "euc-kr",
  "x-windows-949": "euc-kr",
};

/**
 * The text of an XML document from its bytes, decoded as it declares: a byte-order mark first (UTF-8, UTF-16
 * little or big endian), else the declaration's encoding (`<?xml version="1.0" encoding="euc-kr"?>`), else
 * UTF-8, XML's default. The mark is left out of the text. An Error when the declared encoding is one
 * TextDecoder does not read.
 */
export function decodeXml(bytes: Uint8Array): { text: string; encoding: string } {
  const decode = (label: string, from = 0) => {
    // Any label: TextDecoder refuses one it does not know.
    const decoder = new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0]);
    return { text: decoder.decode(bytes.subarray(from)), encoding: decoder.encoding };
  };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return decode("utf-8", 3);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decode("utf-16le", 2);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decode("utf-16be", 2);
  // A declaration written in UTF-16 without a mark (XML's appendix F): `<?` as two-byte characters.
  if (bytes[0] === 0x3c && bytes[1] === 0x00 && bytes[2] === 0x3f && bytes[3] === 0x00)
    return decode("utf-16le");
  if (bytes[0] === 0x00 && bytes[1] === 0x3c && bytes[2] === 0x00 && bytes[3] === 0x3f)
    return decode("utf-16be");
  let head = "";
  for (const byte of bytes.subarray(0, 1_024)) head += String.fromCharCode(byte);
  const declared = /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(head)?.[1];
  if (!declared) return decode("utf-8");
  const label = ENCODING_ALIASES[declared.toLowerCase()] ?? declared;
  try {
    return decode(label);
  } catch {
    throw new Error(`it declares the encoding ${declared}, which this app does not read`);
  }
}

/** Whether `bytes` start as a ZIP archive does (a local header, or the end record of an empty one). */
function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);
}

/** The status and message of a failure OpenDART answered in XML or JSON in place of a file. */
function failureIn(bytes: Uint8Array): { status: string; message: string | undefined } | undefined {
  let text: string;
  try {
    text = decodeXml(bytes).text.trim();
  } catch {
    return undefined;
  }
  if (text.startsWith("{")) {
    try {
      const body = recordOf(JSON.parse(text));
      const status = statusOf(body?.status);
      return status ? { status, message: dartText(body?.message) ?? undefined } : undefined;
    } catch {
      return undefined;
    }
  }
  if (!text.startsWith("<")) return undefined;
  const result = find(parseXml(text), "result");
  const status = result ? statusOf(valueAt(result, "status")) : undefined;
  return result && status ? { status, message: valueAt(result, "message") } : undefined;
}

// The company list --------------------------------------------------------------------------------

/** A company of OpenDART's list (CORPCODE.xml). */
export type DartCompany = {
  /** 8 digits: the company in every other request. */
  corp_code: string;
  corp_name: string;
  corp_eng_name: string | null;
  /** The listing's 6 characters, for a listed company; null otherwise. */
  stock_code: string | null;
  /** When OpenDART last changed the row, YYYY-MM-DD. */
  modify_date: string | null;
};

/** How well a company's name answers a search: the name itself, one starting with it, one holding it. */
export type DartNameTier = "exact" | "prefix" | "contains";

export type DartNameMatch = { company: DartCompany; tier: DartNameTier; listed: boolean };

/** OpenDART's company list, as read, with its lookups. */
export type DartCorpList = {
  companies: readonly DartCompany[];
  /** When it was read (epoch ms), and whether it is past its day (served because reading it again failed). */
  storedAt: number;
  stale: boolean;
  /** The company listed under a 6-character code (005930), its latest row when several carry it. */
  byStockCode(code: string): DartCompany | undefined;
  /** The company with an 8-digit corp_code. */
  byCorpCode(corpCode: string): DartCompany | undefined;
  /** Companies by name, Korean or English, best first: listed ones first; see the top of this file. */
  search(name: string): DartNameMatch[];
};

/** One company from a `<list>` element's text, or undefined when it has no corp_code or name. */
function companyOf(element: ReturnType<typeof parseXml>): DartCompany | undefined {
  const list = child(element, "list");
  if (!list) return undefined;
  const corpCode = valueAt(list, "corp_code") ?? "";
  const name = valueAt(list, "corp_name") ?? "";
  if (!CORP_CODE.test(corpCode) || !name) return undefined;
  const stock = textOf(child(list, "stock_code")).trim().toUpperCase();
  return {
    corp_code: corpCode,
    corp_name: name.replace(/\s+/g, " "),
    corp_eng_name: valueAt(list, "corp_eng_name")?.replace(/\s+/g, " ") ?? null,
    stock_code: STOCK_CODE.test(stock) ? stock : null,
    modify_date: dartDate(valueAt(list, "modify_date")),
  };
}

/**
 * The companies of CORPCODE.xml's text, in its order: each `<list>` read on its own (util/xml.ts), so the
 * document is never held whole as a tree. Unreadable (unavailable) when the text holds no `<result>` or no
 * company: a list without companies is not one to keep for a day.
 */
export function parseCorpCodes(text: string): DartCompany[] {
  if (!/<result[\s>]/.test(text)) throw unreadable(DART_SOURCE, "its company list");
  const companies: DartCompany[] = [];
  let at = 0;
  for (;;) {
    const start = nextList(text, at);
    if (start < 0) break;
    const end = text.indexOf("</list>", start);
    const stop = end < 0 ? text.length : end + "</list>".length;
    const company = companyOf(parseXml(text.slice(start, stop)));
    if (company) companies.push(company);
    at = stop;
  }
  if (!companies.length) throw unreadable(DART_SOURCE, "its company list");
  return companies;
}

/** Where the next `<list>` start tag is at or after `from`, or -1. */
function nextList(text: string, from: number): number {
  let at = from;
  for (;;) {
    const found = text.indexOf("<list", at);
    if (found < 0) return -1;
    const after = text.charCodeAt(found + 5);
    // `<list>` or `<list ...>`, not `<listing>`.
    if (after === 62 || after === 32 || after === 9 || after === 10 || after === 13) return found;
    at = found + 5;
  }
}

/** Korean legal forms a name may carry anywhere: (주) (and ㈜, which NFKC writes so), 주식회사, (유), 유한회사... */
const KOREAN_FORMS = /\((주|유|합|재|사)\)|주식회사|유한책임회사|유한회사|합자회사|합명회사/g;

/** Words at the end of an English name that say only its legal form ("CO,.LTD" is co, ltd). */
const ENGLISH_FORMS = new Set([
  "co",
  "corp",
  "corporation",
  "inc",
  "incorporated",
  "ltd",
  "limited",
  "company",
  "plc",
  "llc",
  "sa",
  "ag",
  "nv",
]);

/**
 * The words of a name or a search as names are compared: NFKC, lower case, a Korean legal form dropped, `&`
 * and apostrophes between letters dropped (C&T, KT&G), anything that is not a letter or a digit a break, and
 * English legal forms at the end dropped.
 */
export function nameWords(value: string): string[] {
  const words = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(KOREAN_FORMS, " ")
    .replace(/(\p{L})[&'’](\p{L})/gu, "$1$2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
  while (words.length > 1 && ENGLISH_FORMS.has(words.at(-1) as string)) words.pop();
  return words;
}

/** A name or a search with its spacing left out: its words run together ("삼성 전자" is 삼성전자). */
export function compactName(value: string): string {
  return nameWords(value).join("");
}

/** Text in a script other than the Latin one (digits, punctuation and spaces are of every script). */
const OTHER_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

/** A list's lookups, built once per list read. */
type Index = {
  byStock: Map<string, DartCompany>;
  byCorp: Map<string, DartCompany>;
  /** Each company's names with their spacing left out: Korean, English. */
  compact: [string, string][];
};
const INDEXES = new WeakMap<readonly DartCompany[], Index>();

function indexOf(companies: readonly DartCompany[]): Index {
  let index = INDEXES.get(companies);
  if (index) return index;
  index = { byStock: new Map(), byCorp: new Map(), compact: [] };
  for (const company of companies) {
    index.byCorp.set(company.corp_code, company);
    if (company.stock_code) {
      const known = index.byStock.get(company.stock_code);
      // Rows sharing a code (a company relisted): the one OpenDART changed last.
      if (!known || (company.modify_date ?? "") > (known.modify_date ?? "")) {
        index.byStock.set(company.stock_code, company);
      }
    }
    index.compact.push([compactName(company.corp_name), compactName(company.corp_eng_name ?? "")]);
  }
  INDEXES.set(companies, index);
  return index;
}

const TIERS: readonly DartNameTier[] = ["exact", "prefix", "contains"];

/**
 * How well a name answers a search in the Latin script, by words: the same words (spacing aside: exact),
 * its words starting with the search's (the last one a word's start: prefix), or holding every word
 * searched (contains).
 */
function wordTier(name: string, compactSearch: string, words: readonly string[]): DartNameTier | undefined {
  const own = nameWords(name);
  if (!own.length) return undefined;
  if (own.join("") === compactSearch) return "exact";
  const last = words.length - 1;
  if (
    own.length >= words.length &&
    words.every((word, at) => (at < last ? own[at] === word : (own[at] as string).startsWith(word)))
  ) {
    return "prefix";
  }
  return words.every((word) => own.includes(word)) ? "contains" : undefined;
}

/** How well a name with its spacing left out answers a search in another script: equal, its start, inside. */
function compactTier(name: string, search: string): DartNameTier | undefined {
  if (!name) return undefined;
  if (name === search) return "exact";
  if (name.startsWith(search)) return "prefix";
  return name.includes(search) ? "contains" : undefined;
}

/** Companies by name: see DartCorpList.search. */
function searchNames(companies: readonly DartCompany[], query: string): DartNameMatch[] {
  const search = compactName(query);
  if (!search) return [];
  const index = indexOf(companies);
  const latin = !OTHER_SCRIPT.test(query);
  const words = nameWords(query);
  const found: (DartNameMatch & { rank: number; at: number })[] = [];
  for (const [at, company] of companies.entries()) {
    const [korean, english] = index.compact[at] as [string, string];
    let best: DartNameTier | undefined;
    if (latin) {
      // Every word searched is somewhere in a name, else neither name can answer it.
      if (!words.every((word) => korean.includes(word) || english.includes(word))) continue;
      for (const name of [company.corp_name, company.corp_eng_name ?? ""]) {
        const tier = wordTier(name, search, words);
        if (tier && (!best || TIERS.indexOf(tier) < TIERS.indexOf(best))) best = tier;
      }
    } else {
      best = compactTier(korean, search);
    }
    if (!best) continue;
    const listed = company.stock_code !== null;
    found.push({ company, tier: best, listed, rank: (listed ? 0 : 3) + TIERS.indexOf(best), at });
  }
  return found
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map(({ company, tier, listed }) => ({ company, tier, listed }));
}

/** The lookups over a list of companies (as read, or given by a test). */
export function dartCorpList(
  companies: readonly DartCompany[],
  { storedAt = 0, stale = false }: { storedAt?: number; stale?: boolean } = {},
): DartCorpList {
  return {
    companies,
    storedAt,
    stale,
    byStockCode: (code) => indexOf(companies).byStock.get(code.trim().toUpperCase()),
    byCorpCode: (corpCode) => indexOf(companies).byCorp.get(corpCode.trim()),
    search: (name) => searchNames(companies, name),
  };
}

// Filings: list.json ----------------------------------------------------------------------------------

/**
 * What list.json is asked, under OpenDART's parameter names, dates as YYYY-MM-DD. Without bgn_de OpenDART
 * searches end_de alone; without end_de, today. Without corp_code OpenDART searches at most three months.
 */
export type DartFilingQuery = {
  corp_code?: string;
  bgn_de?: string;
  end_de?: string;
  /** A: periodic, B: major events, C: issues, D: shareholdings, E: other, F: audits, G: funds, H: securitization, I: the exchange's, J: the FTC's. */
  pblntf_ty?: string;
  /** A001 annual report, A002 half-year, A003 quarterly, B001 major events, D002 officers' holdings... */
  pblntf_detail_ty?: string;
  /** Only the final version of a corrected filing. */
  last_reprt_at?: boolean;
  /** Y KOSPI, K KOSDAQ, N KONEX, E other. */
  corp_cls?: "Y" | "K" | "N" | "E";
  /** date (receipt date, the default), crp (company name), rpt (report name). */
  sort?: "date" | "crp" | "rpt";
  /** desc (the default) or asc. */
  sort_mth?: "asc" | "desc";
};

/** A filing, as list.json lists it. */
export type DartFiling = {
  corp_code: string;
  corp_name: string;
  stock_code: string | null;
  /** Y KOSPI, K KOSDAQ, N KONEX, E other. */
  corp_cls: string | null;
  /** The report's name with what OpenDART adds before it ([기재정정], [첨부정정]...) and its period ("(2025.12)"). */
  report_nm: string;
  /** 14 digits: the filing in document.xml and on DART's pages. */
  rcept_no: string;
  /** The filer. */
  flr_nm: string | null;
  rcept_dt: string;
  /** OpenDART's remarks, letters run together: 유 KOSPI, 코 KOSDAQ, 넥 KONEX, 채 bonds, 연 consolidated, 정 corrected later, 철 withdrawn, 공 the FTC's. */
  rm: string | null;
  /** DART's public page of the filing. */
  url: string;
};

function filingOf(row: Record<string, unknown>): DartFiling | undefined {
  const rcept = dartText(row.rcept_no) ?? "";
  const corp = dartText(row.corp_code) ?? "";
  const date = dartDate(row.rcept_dt);
  const report = dartText(row.report_nm);
  if (!RECEIPT.test(rcept) || !CORP_CODE.test(corp) || !date || !report) return undefined;
  const stock = dartText(row.stock_code)?.toUpperCase() ?? null;
  return {
    corp_code: corp,
    corp_name: dartText(row.corp_name) ?? "",
    stock_code: stock && STOCK_CODE.test(stock) ? stock : null,
    corp_cls: dartText(row.corp_cls),
    report_nm: report.replace(/\s+/g, " "),
    rcept_no: rcept,
    flr_nm: dartText(row.flr_nm),
    rcept_dt: date,
    rm: dartText(row.rm),
    url: dartFilingUrl(rcept),
  };
}

// Statements: fnlttSinglAcntAll.json -----------------------------------------------------------------

/** A statement line of fnlttSinglAcntAll.json. */
export type DartAccount = {
  rcept_no: string;
  reprt_code: string;
  bsns_year: string;
  corp_code: string;
  /** BS balance sheet, IS income statement, CIS comprehensive income, CF cash flows, SCE changes in equity. */
  sj_div: string;
  sj_nm: string | null;
  /** The XBRL standard id (ifrs-full_Revenue, dart_OperatingIncomeLoss); null where OpenDART says none is used. */
  account_id: string | null;
  account_nm: string;
  /** The changes in equity's component ("자본 [member]|지배기업 소유주지분"); null elsewhere. */
  account_detail: string | null;
  /** This period's name and amount; in a quarterly or half-year income statement the three months, with the year to date in thstrm_add_amount. */
  thstrm_nm: string | null;
  thstrm_amount: number | null;
  thstrm_add_amount: number | null;
  /** The year before: its amount, its quarter's (frmtrm_q_*) and its year to date. */
  frmtrm_nm: string | null;
  frmtrm_amount: number | null;
  frmtrm_q_nm: string | null;
  frmtrm_q_amount: number | null;
  frmtrm_add_amount: number | null;
  /** Two years before. */
  bfefrmtrm_nm: string | null;
  bfefrmtrm_amount: number | null;
  ord: number | null;
  currency: string | null;
};

function accountOf(row: Record<string, unknown>): DartAccount | undefined {
  const rcept = dartText(row.rcept_no) ?? "";
  const statement = dartText(row.sj_div);
  const name = dartText(row.account_nm);
  if (!RECEIPT.test(rcept) || !statement || !name) return undefined;
  const id = dartText(row.account_id);
  return {
    rcept_no: rcept,
    reprt_code: dartText(row.reprt_code) ?? "",
    bsns_year: dartText(row.bsns_year) ?? "",
    corp_code: dartText(row.corp_code) ?? "",
    sj_div: statement.toUpperCase(),
    sj_nm: dartText(row.sj_nm),
    // "-표준계정코드 미사용-": no standard id is used for the line.
    account_id: id && !id.includes("미사용") ? id : null,
    account_nm: name,
    account_detail: dartText(row.account_detail),
    thstrm_nm: dartText(row.thstrm_nm),
    thstrm_amount: dartAmount(row.thstrm_amount),
    thstrm_add_amount: dartAmount(row.thstrm_add_amount),
    frmtrm_nm: dartText(row.frmtrm_nm),
    frmtrm_amount: dartAmount(row.frmtrm_amount),
    frmtrm_q_nm: dartText(row.frmtrm_q_nm),
    frmtrm_q_amount: dartAmount(row.frmtrm_q_amount),
    frmtrm_add_amount: dartAmount(row.frmtrm_add_amount),
    bfefrmtrm_nm: dartText(row.bfefrmtrm_nm),
    bfefrmtrm_amount: dartAmount(row.bfefrmtrm_amount),
    ord: dartAmount(row.ord),
    currency: dartText(row.currency),
  };
}

// Insider reports: elestock.json -----------------------------------------------------------------------

/** A report of an officer or major shareholder's holdings (임원ㆍ주요주주 소유보고). */
export type DartInsiderReport = {
  rcept_no: string;
  rcept_dt: string;
  corp_code: string;
  corp_name: string | null;
  /** The reporter. */
  repror: string;
  /** Registered officer or not (등기임원, 비등기임원). */
  isu_exctv_rgist_at: string | null;
  /** Their position (대표이사, 전무...). */
  isu_exctv_ofcps: string | null;
  /** Their relation as a major shareholder (최대주주, 10%이상주주...). */
  isu_main_shrholdr: string | null;
  /** Shares held after the report (specified securities), their change, the percent held and its change. */
  sp_stock_lmp_cnt: number | null;
  sp_stock_lmp_irds_cnt: number | null;
  sp_stock_lmp_rate: number | null;
  sp_stock_lmp_irds_rate: number | null;
  url: string;
};

function insiderOf(row: Record<string, unknown>): DartInsiderReport | undefined {
  const rcept = dartText(row.rcept_no) ?? "";
  const date = dartDate(row.rcept_dt);
  const reporter = dartText(row.repror);
  if (!RECEIPT.test(rcept) || !date || !reporter) return undefined;
  return {
    rcept_no: rcept,
    rcept_dt: date,
    corp_code: dartText(row.corp_code) ?? "",
    corp_name: dartText(row.corp_name),
    repror: reporter,
    isu_exctv_rgist_at: dartText(row.isu_exctv_rgist_at),
    isu_exctv_ofcps: dartText(row.isu_exctv_ofcps),
    isu_main_shrholdr: dartText(row.isu_main_shrholdr),
    sp_stock_lmp_cnt: dartAmount(row.sp_stock_lmp_cnt),
    sp_stock_lmp_irds_cnt: dartAmount(row.sp_stock_lmp_irds_cnt),
    sp_stock_lmp_rate: dartAmount(row.sp_stock_lmp_rate),
    sp_stock_lmp_irds_rate: dartAmount(row.sp_stock_lmp_irds_rate),
    url: dartFilingUrl(rcept),
  };
}

// The company outline: company.json -------------------------------------------------------------------

/** A company's outline (기업개황). */
export type DartCompanyOutline = {
  corp_code: string;
  corp_name: string;
  corp_name_eng: string | null;
  /** The listing's short name, or the company's short name when it is not listed. */
  stock_name: string | null;
  stock_code: string | null;
  ceo_nm: string | null;
  /** Y KOSPI, K KOSDAQ, N KONEX, E other. */
  corp_cls: string | null;
  /** Corporate registration and business registration numbers. */
  jurir_no: string | null;
  bizr_no: string | null;
  adres: string | null;
  hm_url: string | null;
  ir_url: string | null;
  phn_no: string | null;
  fax_no: string | null;
  induty_code: string | null;
  est_dt: string | null;
  /** The month the fiscal year ends, 1 to 12. */
  acc_mt: number | null;
};

function outlineOf(body: Record<string, unknown>, corpCode: string): DartCompanyOutline | undefined {
  const name = dartText(body.corp_name);
  if (!name) return undefined;
  const stock = dartText(body.stock_code)?.toUpperCase() ?? null;
  const month = dartAmount(body.acc_mt);
  return {
    corp_code: dartText(body.corp_code) ?? corpCode,
    corp_name: name,
    corp_name_eng: dartText(body.corp_name_eng),
    stock_name: dartText(body.stock_name),
    stock_code: stock && STOCK_CODE.test(stock) ? stock : null,
    ceo_nm: dartText(body.ceo_nm),
    corp_cls: dartText(body.corp_cls),
    jurir_no: dartText(body.jurir_no),
    bizr_no: dartText(body.bizr_no),
    adres: dartText(body.adres),
    hm_url: dartText(body.hm_url),
    ir_url: dartText(body.ir_url),
    phn_no: dartText(body.phn_no),
    fax_no: dartText(body.fax_no),
    induty_code: dartText(body.induty_code),
    est_dt: dartDate(body.est_dt),
    acc_mt: month !== null && Number.isInteger(month) && month >= 1 && month <= 12 ? month : null,
  };
}

// A filing's documents: document.xml ------------------------------------------------------------------

/** One XML document of a filing, decoded. */
export type DartDocument = { name: string; encoding: string; text: string };

/** A filing's archive of documents (document.xml). */
export type DartArchive = {
  rcept_no: string;
  /** Every entry's name, in the archive's order. */
  names: readonly string[];
  /** The main document: <rcept_no>.xml (or the archive's first XML document). */
  main(): DartDocument | undefined;
  /** The XML document named `name` (exactly, else ignoring case), decoded from its declared encoding. */
  document(name: string): DartDocument | undefined;
  /** Every XML document, in the archive's order. */
  documents(): DartDocument[];
};

// The client -------------------------------------------------------------------------------------------

export type DartSource = {
  /** OpenDART's company list with its lookups (kept a day, on disk too; served past its day when OpenDART fails). */
  corpList(call?: Call): Promise<DartCorpList>;
  /**
   * The company OpenDART's list holds for a Korean listing (XKRX:005930, XKOS:035900, 005930.KS, a bare code):
   * unsupported for any other key, and for a code the list does not hold (a fund, a preferred share), so the
   * router asks the next source.
   */
  company(key: string, call?: Call): Promise<DartCompany>;
  /** Every filing list.json answers for `query`, every page read, in the order asked (newest first by default). */
  filings(query: DartFilingQuery, call?: Call): Promise<DartFiling[]>;
  /** One report's statement lines on one basis; null when OpenDART has none (status 013). */
  accounts(
    corpCode: string,
    year: number | string,
    report: DartReportCode,
    basis: DartStatementBasis,
    call?: Call,
  ): Promise<DartAccount[] | null>;
  /** Every report of the company's officers and major shareholders, as elestock.json answers them. */
  insiders(corpCode: string, call?: Call): Promise<DartInsiderReport[]>;
  /** The company's outline; undefined when OpenDART has none (status 013). */
  outline(corpCode: string, call?: Call): Promise<DartCompanyOutline | undefined>;
  /** A filing's documents; no_data when OpenDART holds none for the receipt number. */
  archive(rceptNo: string, call?: Call): Promise<DartArchive>;
  /** `text` with DART_API_KEY (and every other configured key) removed. */
  scrub(text: string): string;
};

/** The calendar day in Seoul at `instant`, YYYY-MM-DD: the day OpenDART dates receipts by. */
function seoulDay(instant: Date): string {
  return new Date(instant.getTime() + 9 * HOUR_MS).toISOString().slice(0, 10);
}

/** `date` (YYYY-MM-DD) moved by `days`. */
function shifted(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function invalid(text: string): DataError {
  return new DataError("invalid", text, { source: DART_SOURCE, retry: "change_request" });
}

function corpCodeChecked(corpCode: string): string {
  if (!CORP_CODE.test(corpCode)) throw invalid(`${corpCode} is not an OpenDART corp_code (8 digits)`);
  return corpCode;
}

/** What a request is for: what needs the key, and what there is none of when OpenDART has none. */
type Asked = { what: string; none: string };

/** OpenDART over `deps` (its key: deps.config.dartKey). */
export function dartSource(deps: ForkDeps): DartSource {
  const scrub = (text: string) => deps.http.redact(text);

  const keyFor = (what: string): string => {
    const key = deps.config.dartKey;
    if (!key) throw dartKeyNeeded(what);
    return key;
  };

  /** One request to `service` with `params` (the key first); a 404 is OpenDART's failure, or its service not there. */
  const ask = async (
    service: string,
    params: Readonly<Record<string, string>>,
    asked: Asked,
    call: Call | undefined,
    timeoutMs?: number,
  ): Promise<{ status: number; bytes: Uint8Array }> => {
    const key = keyFor(asked.what);
    const url = `${DART_API}/${service}?${new URLSearchParams({ crtfc_key: key, ...params })}`;
    let answer: Answer;
    try {
      answer = await deps.http.get(url, {
        source: DART_SOURCE,
        signal: call?.signal,
        ...(timeoutMs ? { timeoutMs } : {}),
        // OpenDART says why in its body: read it.
        accept: [400, 404],
        // The key is in the address: a redirect elsewhere is not followed.
        redirect: "same-origin",
      });
    } catch (error) {
      if (error instanceof DataError) throw new DataError(error.kind, scrub(error.message), error.details);
      throw error;
    }
    const bytes = await answer.bytes();
    if (answer.status === 404 && !failureIn(bytes)) {
      throw new DataError("unavailable", `${DART_SOURCE}'s ${service} is not at its address (HTTP 404).`, {
        source: DART_SOURCE,
        status: 404,
      });
    }
    return { status: answer.status, bytes };
  };

  /** The failure an answer that is not what was asked for calls for: its status's, else its HTTP status's. */
  const failureOf = (service: string, status: number, bytes: Uint8Array, asked: Asked): DataError => {
    const failure = failureIn(bytes);
    if (failure && failure.status !== "000") {
      return dartFailure(deps, failure.status, failure.message, asked.none);
    }
    if (status >= 400) {
      return new DataError("unavailable", `${DART_SOURCE} answered HTTP ${status}.`, {
        source: DART_SOURCE,
        status,
      });
    }
    return unreadable(DART_SOURCE, `its ${service}`);
  };

  /** A JSON service's answer: its body when the status is 000, null for 013, else the status's failure. */
  const askJson = async (
    service: string,
    params: Readonly<Record<string, string>>,
    asked: Asked,
    call: Call | undefined,
  ): Promise<Record<string, unknown> | null> => {
    const { status, bytes } = await ask(service, params, asked, call);
    let body: Record<string, unknown> | undefined;
    try {
      body = recordOf(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      body = undefined;
    }
    const said = statusOf(body?.status);
    if (said === "000" && body && status < 400) return body;
    if (said === "013") return null;
    if (said) throw dartFailure(deps, said, dartText(body?.message) ?? undefined, asked.none);
    throw failureOf(service, status, bytes, asked);
  };

  /** A file service's answer (a ZIP), or the failure OpenDART answered in its place. */
  const askFile = async (
    service: string,
    params: Readonly<Record<string, string>>,
    asked: Asked,
    call: Call | undefined,
  ): Promise<Uint8Array> => {
    const { status, bytes } = await ask(service, params, asked, call, FORK_REQUEST_MS.bulk);
    if (status < 400 && isZip(bytes)) return bytes;
    throw failureOf(service, status, bytes, asked);
  };

  /** The entries of an archive OpenDART answered, or unavailable when it cannot be read. */
  const entriesOf = (bytes: Uint8Array, what: string): ZipEntry[] => {
    try {
      return readZip(bytes);
    } catch (error) {
      if (!(error instanceof ZipError)) throw error;
      throw new DataError(
        "unavailable",
        scrub(`${DART_SOURCE} answered ${what} in an archive this app cannot read (${error.message}).`),
        { source: DART_SOURCE },
      );
    }
  };

  /** An entry's text, decoded from its declared encoding; unavailable when it cannot be read. */
  const textOfEntry = (entry: ZipEntry, what: string): { text: string; encoding: string } => {
    try {
      return decodeXml(entry.bytes());
    } catch (error) {
      throw new DataError(
        "unavailable",
        scrub(`${DART_SOURCE}'s ${what} ${entry.name} cannot be read: ${(error as Error).message}.`),
        { source: DART_SOURCE },
      );
    }
  };

  // The company list.

  const CORP_LIST: Asked = { what: "OpenDART's company list", none: "company list" };

  const readCorpCodes = async (call: Call | undefined): Promise<DartCompany[]> => {
    const bytes = await askFile("corpCode.xml", {}, CORP_LIST, call);
    const entries = entriesOf(bytes, "its company list");
    const entry =
      zipEntry(entries, "CORPCODE.xml") ??
      entries.find((one) => !one.directory && one.name.toLowerCase().endsWith(".xml"));
    if (!entry) throw unreadable(DART_SOURCE, "its company list");
    return parseCorpCodes(textOfEntry(entry, "company list").text);
  };

  const corpList = async (call?: Call): Promise<DartCorpList> => {
    keyFor(CORP_LIST.what);
    const kept = await deps.cache.keep(
      DART_CORP_CODES_KEY,
      DART_CORP_CODES_TTL_MS,
      () => readCorpCodes(call),
      { disk: "json", staleOnError: true, signal: call?.signal },
    );
    return dartCorpList(kept.value, { storedAt: kept.storedAt, stale: kept.stale });
  };

  const company = async (key: string, call?: Call): Promise<DartCompany> => {
    const listing = parseListing(key);
    if (listing.kind !== "kr") {
      throw new DataError(
        "unsupported",
        `${DART_SOURCE} serves Korean listings, and ${key.trim()} is not one`,
        {
          source: DART_SOURCE,
        },
      );
    }
    const found = (await corpList(call)).byStockCode(listing.code);
    if (!found) {
      throw new DataError(
        "unsupported",
        `${DART_SOURCE}'s company list holds no company listed under ${listing.code}`,
        { source: DART_SOURCE },
      );
    }
    return found;
  };

  // Filings.

  const FILINGS: Asked = { what: "OpenDART's filings", none: "filings for the request" };

  const stoppedAt = (got: number, total: number) =>
    new DataError("unavailable", `${DART_SOURCE}'s filings stopped at ${got} of the ${total} it counts.`, {
      source: DART_SOURCE,
    });

  const readFilings = async (query: DartFilingQuery, call: Call | undefined): Promise<DartFiling[]> => {
    const sort = query.sort ?? "date";
    // By date, pages are read oldest first, so a filing made while they are read cannot move a row between them.
    const order = sort === "date" ? "asc" : (query.sort_mth ?? "desc");
    const params: Record<string, string> = {};
    if (query.corp_code) params.corp_code = query.corp_code;
    if (query.bgn_de) params.bgn_de = compactDate(query.bgn_de);
    if (query.end_de) params.end_de = compactDate(query.end_de);
    if (query.last_reprt_at !== undefined) params.last_reprt_at = query.last_reprt_at ? "Y" : "N";
    if (query.pblntf_ty) params.pblntf_ty = query.pblntf_ty;
    if (query.pblntf_detail_ty) params.pblntf_detail_ty = query.pblntf_detail_ty;
    if (query.corp_cls) params.corp_cls = query.corp_cls;
    params.sort = sort;
    params.sort_mth = order;
    const found = new Map<string, DartFiling>();
    // Rows that are not a filing (no receipt number, no date): counted, not kept.
    let other = 0;
    let read = 0;
    let total: number | undefined;
    for (let page = 1; ; page++) {
      const body = await askJson(
        "list.json",
        { ...params, page_no: String(page), page_count: String(DART_PAGE_COUNT) },
        FILINGS,
        call,
      );
      if (body === null) {
        // 013: no filing at all, or none past the last page read.
        if (total === undefined || read >= total) break;
        throw stoppedAt(found.size + other, total);
      }
      const count = dartAmount(body.total_count);
      if (count === null || !Number.isInteger(count) || count < 0)
        throw unreadable(DART_SOURCE, "its filings");
      total = count;
      const rows = rowsOf(body.list);
      for (const row of rows) {
        const filing = filingOf(row);
        if (filing) found.set(filing.rcept_no, filing);
        else other++;
      }
      read += rows.length;
      if (read >= total) {
        // Pages that repeated rows reach the count without all of them.
        if (found.size + other < total) throw stoppedAt(found.size + other, total);
        break;
      }
      if (!rows.length) throw stoppedAt(found.size + other, total);
    }
    const filings = [...found.values()];
    if (sort === "date" && (query.sort_mth ?? "desc") === "desc") filings.reverse();
    return filings;
  };

  const filings = async (query: DartFilingQuery, call?: Call): Promise<DartFiling[]> => {
    keyFor(FILINGS.what);
    if (query.corp_code !== undefined) corpCodeChecked(query.corp_code);
    for (const date of [query.bgn_de, query.end_de]) {
      if (date !== undefined && dartDate(date) !== date) throw invalid(`${date} is not a date as YYYY-MM-DD`);
    }
    const today = seoulDay(deps.clock());
    // A window ended a week before today in Seoul no longer changes: kept a day, on disk too.
    const settled = query.end_de !== undefined && query.end_de < shifted(today, -7);
    const key = [
      "dart:list",
      query.corp_code ?? "",
      query.bgn_de ?? "",
      query.end_de ?? today,
      query.pblntf_ty ?? "",
      query.pblntf_detail_ty ?? "",
      query.last_reprt_at === undefined ? "" : query.last_reprt_at ? "Y" : "N",
      query.corp_cls ?? "",
      query.sort ?? "date",
      query.sort_mth ?? "desc",
    ].join(":");
    return deps.cache.remember(key, settled ? DAY_MS : 15 * MINUTE_MS, () => readFilings(query, call), {
      signal: call?.signal,
      ...(settled ? { disk: "json" as const } : {}),
    });
  };

  // Statements.

  const ACCOUNTS: Asked = {
    what: "OpenDART's financial statements",
    none: "statement lines for the request",
  };

  const accounts = async (
    corpCode: string,
    year: number | string,
    report: DartReportCode,
    basis: DartStatementBasis,
    call?: Call,
  ): Promise<DartAccount[] | null> => {
    keyFor(ACCOUNTS.what);
    corpCodeChecked(corpCode);
    const bsnsYear = String(year).trim();
    if (!/^\d{4}$/.test(bsnsYear)) throw invalid(`${bsnsYear} is not a business year (four digits)`);
    if (!Object.hasOwn(DART_REPORTS, report)) {
      throw invalid(`${report} is not a report code (${Object.keys(DART_REPORTS).join(", ")})`);
    }
    if (basis !== "CFS" && basis !== "OFS") throw invalid(`${basis} is not a basis (CFS or OFS)`);
    // A report whose period ended 120 days before today (past its filing's due date) is settled: kept a day.
    const settled = shifted(`${bsnsYear}-${DART_REPORTS[report].end}`, 120) < seoulDay(deps.clock());
    return deps.cache.remember(
      `dart:accounts:${corpCode}:${bsnsYear}:${report}:${basis}`,
      settled ? DAY_MS : HOUR_MS,
      async () => {
        const body = await askJson(
          "fnlttSinglAcntAll.json",
          { corp_code: corpCode, bsns_year: bsnsYear, reprt_code: report, fs_div: basis },
          ACCOUNTS,
          call,
        );
        return body === null ? null : rowsOf(body.list).flatMap((row) => accountOf(row) ?? []);
      },
      { signal: call?.signal, ...(settled ? { disk: "json" as const } : {}) },
    );
  };

  // Insider reports.

  const INSIDERS: Asked = { what: "OpenDART's insider reports", none: "insider reports for the company" };

  const insiders = async (corpCode: string, call?: Call): Promise<DartInsiderReport[]> => {
    keyFor(INSIDERS.what);
    corpCodeChecked(corpCode);
    return deps.cache.remember(
      `dart:elestock:${corpCode}`,
      HOUR_MS,
      async () => {
        const body = await askJson("elestock.json", { corp_code: corpCode }, INSIDERS, call);
        return body === null ? [] : rowsOf(body.list).flatMap((row) => insiderOf(row) ?? []);
      },
      { signal: call?.signal },
    );
  };

  // The company's outline.

  const OUTLINE: Asked = { what: "OpenDART's company outline", none: "outline of the company" };

  const outline = async (corpCode: string, call?: Call): Promise<DartCompanyOutline | undefined> => {
    keyFor(OUTLINE.what);
    corpCodeChecked(corpCode);
    const kept = await deps.cache.remember(
      `dart:company:${corpCode}`,
      DAY_MS,
      async () => {
        const body = await askJson("company.json", { corp_code: corpCode }, OUTLINE, call);
        if (body === null) return null;
        const found = outlineOf(body, corpCode);
        if (!found) throw unreadable(DART_SOURCE, "its company outline");
        return found;
      },
      { signal: call?.signal, disk: "json" },
    );
    return kept ?? undefined;
  };

  // A filing's documents.

  const archive = async (rceptNo: string, call?: Call): Promise<DartArchive> => {
    const asked: Asked = {
      what: "OpenDART's filing documents",
      none: `document for receipt number ${rceptNo}`,
    };
    keyFor(asked.what);
    if (!RECEIPT.test(rceptNo)) throw invalid(`${rceptNo} is not an OpenDART receipt number (14 digits)`);
    const bytes = await deps.cache.remember(
      `dart:document:${rceptNo}`,
      7 * DAY_MS,
      () => askFile("document.xml", { rcept_no: rceptNo }, asked, call),
      { signal: call?.signal, disk: "bytes", memory: false },
    );
    const entries = entriesOf(bytes, `the documents of ${rceptNo}`);
    const xml = entries.filter((entry) => !entry.directory && entry.name.toLowerCase().endsWith(".xml"));
    const decoded = new Map<ZipEntry, DartDocument>();
    const open = (entry: ZipEntry): DartDocument => {
      let document = decoded.get(entry);
      if (!document) {
        const { text, encoding } = textOfEntry(entry, `document of ${rceptNo},`);
        document = { name: entry.name, encoding, text };
        decoded.set(entry, document);
      }
      return document;
    };
    return {
      rcept_no: rceptNo,
      names: entries.map((entry) => entry.name),
      main: () => {
        const entry = zipEntry(xml, `${rceptNo}.xml`) ?? xml[0];
        return entry ? open(entry) : undefined;
      },
      document: (name) => {
        const entry = zipEntry(xml, name);
        return entry ? open(entry) : undefined;
      },
      documents: () => xml.map(open),
    };
  };

  return { corpList, company, filings, accounts, insiders, outline, archive, scrub };
}
