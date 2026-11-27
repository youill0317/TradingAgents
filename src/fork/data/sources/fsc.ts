// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The Financial Services Commission's stock prices on data.go.kr (DATA_GO_KR_API_KEY), as the FSC provider
 * reads them: getStockPriceInfo, KRX's official end-of-day prices of every KOSPI, KOSDAQ and KONEX share, one
 * row a share a session, published after 13:00 on the next business day. A row holds basDt (YYYYMMDD), srtnCd
 * (the six-character code), isinCd, itmsNm (the Korean name), mrktCtg (KOSPI, KOSDAQ, KONEX), clpr (the
 * close), vs and fltRt (the change and its percent against the exchange's base price, the previous close
 * adjusted on a corporate action's day), mkp, hipr, lopr (open, high, low), trqu (shares traded), trPrc (won
 * traded), lstgStCnt (shares listed) and mrktTotAmt (clpr times lstgStCnt), every value a string. Prices are
 * as traded, not adjusted; on a session the share did not trade (a halt) the open, high, low and volume are 0
 * and the close is the previous one.
 *
 * - Addresses (FSC_ADDRESSES): the dataset's page names GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2;
 *   keys approved before it are registered for /service/GetStockSecuritiesInfoService/getStockPriceInfo, and
 *   data.go.kr refuses a key at an address it is not registered for (returnReasonCode 30) or not approved for
 *   (20, no approved application for that service). The first address is asked; when it says the key is not
 *   registered or approved for it, that it has no such service (12), or is not there (HTTP 404), the other is
 *   asked, and the address that answered is asked first from then on.
 * - serviceKey: data.go.kr gives each key in two spellings, "Encoding" (percent-encoded) and "Decoding" (as
 *   it is). Either may be configured; it is sent encoded once (`serviceKeyParam`), and both spellings are kept
 *   out of everything said here (`keySpellings`).
 * - One share's rows (`likeSrtnCd`: a code of six characters containing six given characters is that code),
 *   from `beginBasDt` (included) to `endBasDt` (left out), FSC_PAGE_ROWS a page (the most the FSC publishes
 *   for numOfRows), page after page until totalCount is read; a page shorter than asked while rows remain is
 *   the gateway's own page size, which the following pages are asked in.
 * - Answers: JSON `{response: {header: {resultCode, resultMsg}, body: {numOfRows, pageNo, totalCount, items:
 *   {item: [...]}}}}` (`item` one object for one row; `items` empty or "" for none), or the same in XML. The
 *   gateway answers its own failures in XML, `<OpenAPI_ServiceResponse><cmmMsgHeader>` with errMsg,
 *   returnAuthMsg and returnReasonCode, even when JSON is asked, with HTTP 200 or a 4xx; each code is the
 *   DataError kind it calls for (REASONS): the daily quota spent (22) quota, a key or a caller refused (20,
 *   21, 29, 30-33) rejected, a request it cannot read (10, 11) invalid, the service failing (1, 2, 4, 5, 99)
 *   unavailable; its "no data" (3) is an answer without rows. Its words are quoted with the key removed
 *   before they are cut to length; a failure body in another form (JSON, HTML) is not quoted.
 *
 * Kept: a window still being published 15 minutes, a settled one (ended a week before today in Seoul) a day,
 * on disk too. No key reaches a cache key, a message or a note.
 */
import { addDays } from "../../../contracts/index.js";
import type { Call } from "../../../data/capabilities.js";
import { DataError, type DataErrorDetails, type DataErrorKind } from "../../../data/errors.js";
import type { ForkDeps } from "../deps.js";
import { type Answer, retryAfterMs, unreadable } from "../http.js";
import { REDACTED, redact } from "../redact.js";
import { child, children, find, parseXml, textOf, valueAt, type XmlElement } from "../util/xml.js";

export const FSC_SOURCE = "FSC";

/** getStockPriceInfo's addresses: the one the dataset's page names first, then the one older keys are registered for. */
export const FSC_ADDRESSES = [
  "https://apis.data.go.kr/1160100/GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2",
  "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo",
] as const;

/** Rows a page: the most numOfRows the FSC publishes for its data.go.kr services. */
export const FSC_PAGE_ROWS = 10_000;

/** How long a window still being published is kept (a session's prices appear after 13:00 the next business day). */
const OPEN_KEEP_MS = 15 * 60_000;
/** How long a settled window is kept: its rows no longer change. */
const SETTLED_KEEP_MS = 86_400_000;
/** A window ending this many days before today in Seoul is settled. */
const SETTLED_AFTER_DAYS = 7;

/** One share's prices for one session, as the FSC gives them (a value it leaves empty is null). */
export type FscRow = {
  /** basDt as YYYY-MM-DD. */
  date: string;
  code: string;
  isin: string | null;
  name: string | null;
  /** mrktCtg as given: KOSPI, KOSDAQ or KONEX. */
  market: string | null;
  close: number | null;
  /** vs and fltRt: against the exchange's base price for the session. */
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  /** trPrc: won traded. */
  traded: number | null;
  /** lstgStCnt: shares listed. */
  shares: number | null;
  /** mrktTotAmt: the close times the shares listed, in won. */
  marketCap: number | null;
};

/** A window of sessions: from `from` (included) to `until` (left out), each a YYYY-MM-DD date; open-ended when absent. */
export type FscWindow = { from?: string | undefined; until?: string | undefined };

/** The FSC's stock prices, over one setup's deps: the address that answers is remembered here. */
export type FscSource = {
  /** Every row of the share `code` in `window`, oldest first, one a session. */
  rows(code: string, window: FscWindow, call?: Call): Promise<FscRow[]>;
  /** How many rows of the share `code` the FSC holds in `window` (one request of one row). */
  count(code: string, window: FscWindow, call?: Call): Promise<number>;
  /** `text` with the key removed in either spelling (and every other configured secret). */
  scrub(text: string): string;
};

// The key -----------------------------------------------------------------------------------------

/** The key as data.go.kr's "Decoding" spelling writes it: an "Encoding" spelling (percent escapes) decoded once. */
export function decodedKey(key: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(key)) return key;
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

/** The serviceKey parameter's value: the key encoded once, whichever spelling was configured. */
export function serviceKeyParam(key: string): string {
  return encodeURIComponent(decodedKey(key));
}

/** Every spelling of the key that must never be said: as configured, decoded, and as sent. */
export function keySpellings(key: string): string[] {
  return [...new Set([key, decodedKey(key), serviceKeyParam(key)])];
}

/** `text` with whatever follows each serviceKey= removed: a key in an address data.go.kr quotes, however spelled. */
export function withoutServiceKey(text: string): string {
  return text.replace(/(serviceKey=)[^\s&"'<>]+/gi, `$1${REDACTED}`);
}

// Errors ----------------------------------------------------------------------------------------

/** data.go.kr's result and failure codes (returnReasonCode, or resultCode), each as the kind it calls for. */
const REASONS: Readonly<Record<string, { name: string; kind: DataErrorKind | "empty"; address?: true }>> = {
  "1": { name: "APPLICATION_ERROR", kind: "unavailable" },
  "2": { name: "DB_ERROR", kind: "unavailable" },
  "3": { name: "NODATA_ERROR", kind: "empty" },
  "4": { name: "HTTP_ERROR", kind: "unavailable" },
  "5": { name: "SERVICETIMEOUT_ERROR", kind: "unavailable" },
  "10": { name: "INVALID_REQUEST_PARAMETER_ERROR", kind: "invalid" },
  "11": { name: "NO_MANDATORY_REQUEST_PARAMETERS_ERROR", kind: "invalid" },
  "12": { name: "NO_OPENAPI_SERVICE_ERROR", kind: "unavailable", address: true },
  // No approved application for this service: a key approved for the other address is asked there.
  "20": { name: "SERVICE_ACCESS_DENIED_ERROR", kind: "rejected", address: true },
  "21": { name: "TEMPORARILY_DISABLE_THE_SERVICEKEY_ERROR", kind: "rejected" },
  "22": { name: "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR", kind: "quota" },
  "23": { name: "LIMITED_NUMBER_OF_SERVICE_REQUESTS_PER_SECOND_EXCEEDS_ERROR", kind: "rate_limited" },
  "29": { name: "BLACKLIST_IP_ACCESS_ERROR", kind: "rejected" },
  "30": { name: "SERVICE_KEY_IS_NOT_REGISTERED_ERROR", kind: "rejected", address: true },
  "31": { name: "DEADLINE_HAS_EXPIRED_ERROR", kind: "rejected" },
  "32": { name: "UNREGISTERED_IP_ERROR", kind: "rejected" },
  "33": { name: "UNSIGNED_CALL_ERROR", kind: "rejected" },
  "99": { name: "UNKNOWN_ERROR", kind: "unavailable" },
};

/** What each kind of failure says, before the code and data.go.kr's own words. */
const SAID: Readonly<Partial<Record<DataErrorKind, string>>> = {
  quota: "data.go.kr's daily requests for this key are spent",
  rate_limited: "data.go.kr is limiting requests",
  rejected: "data.go.kr refused DATA_GO_KR_API_KEY for the FSC's stock prices",
  invalid: "the FSC's stock prices refused the request",
  unavailable: "the FSC's stock prices failed",
};

/** A failure that asks for the other address: the key not registered or approved at this one, no such service, nothing there. */
class WrongAddress extends Error {
  constructor(readonly failure: DataError) {
    super(failure.message);
  }
}

/** One page of an answer: the rows it holds and the count of all of them. */
type Page = { total: number; items: Record<string, unknown>[] };

/** A record of an answer, or undefined. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A code as data.go.kr writes it ("00", "03", "30"), without its leading zeros ("0", "3", "30"). */
function codeOf(value: unknown): string | undefined {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,4}$/.test(text)) return undefined;
  return String(Number(text));
}

/** A whole count, given as a number or a text of digits. */
function countOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d{1,12}$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** A number as the FSC writes one ("84000", "-.39", ".48", "1.2"); null for an empty or other value. */
export function amountOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim().replaceAll(",", "");
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return null;
  return Number(text);
}

/** A text value, trimmed, or null. */
function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** basDt (YYYYMMDD) as YYYY-MM-DD, when it is a day on the calendar. */
function dateOf(value: unknown): string | undefined {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (!match) return undefined;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? date : undefined;
}

/** A row of an answer, or undefined when it has no session date or no code. */
export function rowOf(item: Record<string, unknown>): FscRow | undefined {
  const date = dateOf(item.basDt);
  const written = textValue(item.srtnCd);
  // A code written with KRX's "A" before it is the same six characters.
  const code = written && /^A[0-9][0-9A-Z]{5}$/.test(written) ? written.slice(1) : written;
  if (!date || !code) return undefined;
  return {
    date,
    code,
    isin: textValue(item.isinCd),
    name: textValue(item.itmsNm),
    market: textValue(item.mrktCtg),
    close: amountOf(item.clpr),
    change: amountOf(item.vs),
    changePercent: amountOf(item.fltRt),
    open: amountOf(item.mkp),
    high: amountOf(item.hipr),
    low: amountOf(item.lopr),
    volume: amountOf(item.trqu),
    traded: amountOf(item.trPrc),
    shares: amountOf(item.lstgStCnt),
    marketCap: amountOf(item.mrktTotAmt),
  };
}

// The source ----------------------------------------------------------------------------------------

/** The FSC's stock prices over `deps` (its key: deps.config.dataGoKrKey). */
export function fscSource(deps: ForkDeps): FscSource {
  const key = deps.config.dataGoKrKey ?? "";
  const spellings = key ? keySpellings(key) : [];
  const scrub = (text: string) => withoutServiceKey(redact(deps.http.redact(text), spellings));
  /** The address asked first: the one that last answered. */
  let preferred = 0;

  const fail = (kind: DataErrorKind, text: string, more: Omit<DataErrorDetails, "source"> = {}) =>
    new DataError(kind, scrub(text), {
      ...more,
      source: FSC_SOURCE,
      ...(kind === "invalid" ? { retry: "change_request" as const } : {}),
    });

  /**
   * The failure a data.go.kr code calls for (with data.go.kr's own words, and the wait a 429 asks for), or a
   * page without rows for its "no data".
   */
  const coded = (code: string, words: (string | null | undefined)[], answer: Answer): Page => {
    const reason = REASONS[code];
    const said = wordsOf(reason?.name, words, scrub);
    const { status } = answer;
    if (!reason) {
      throw fail("unavailable", `the FSC's stock prices answered code ${code}${said ? `: ${said}` : ""}.`, {
        status,
      });
    }
    if (reason.kind === "empty") return { total: 0, items: [] };
    const wait = status === 429 ? retryAfterMs(answer.headers.get("retry-after")) : undefined;
    const failure = fail(
      reason.kind,
      `${SAID[reason.kind]} (${reason.name}, code ${code}${said ? `: ${said}` : ""}).`,
      {
        status,
        ...(wait !== undefined && reason.kind === "rate_limited" ? { retryAfterMs: wait } : {}),
      },
    );
    if (reason.address) throw new WrongAddress(failure);
    throw failure;
  };

  /** An answer in XML: the gateway's failure, or the service's answer written in XML. */
  const fromXml = (text: string, answer: Answer): Page => {
    const document = parseXml(text);
    const envelope = find(document, "OpenAPI_ServiceResponse");
    if (envelope) {
      const code = codeOf(valueAt(envelope, "cmmMsgHeader/returnReasonCode"));
      if (code === undefined) throw unreadable(FSC_SOURCE, "a failure");
      const words = [
        valueAt(envelope, "cmmMsgHeader/returnAuthMsg"),
        valueAt(envelope, "cmmMsgHeader/errMsg"),
      ];
      return coded(code, words, answer);
    }
    const response = find(document, "response");
    const result = codeOf(response ? valueAt(response, "header/resultCode") : undefined);
    if (!response || result === undefined) throw unreadable(FSC_SOURCE, "its stock prices");
    if (result !== "0") return coded(result, [valueAt(response, "header/resultMsg")], answer);
    const content = child(response, "body");
    const items = content ? child(content, "items") : undefined;
    const total = countOf(content ? valueAt(content, "totalCount") : undefined);
    if (total === undefined) throw unreadable(FSC_SOURCE, "its stock prices");
    return { total, items: items ? children(items, "item").map(itemOfXml) : [] };
  };

  /** An answer in JSON: the service's answer, or the gateway's failure wrapped in JSON. */
  const fromJson = (parsed: unknown, answer: Answer): Page => {
    const root = recordOf(parsed);
    const envelope = recordOf(root?.OpenAPI_ServiceResponse);
    if (envelope) {
      const header = recordOf(envelope.cmmMsgHeader);
      const code = codeOf(header?.returnReasonCode);
      if (code === undefined) throw unreadable(FSC_SOURCE, "a failure");
      return coded(code, [textValue(header?.returnAuthMsg), textValue(header?.errMsg)], answer);
    }
    const response = recordOf(root?.response);
    const header = recordOf(response?.header);
    const result = codeOf(header?.resultCode);
    if (!response || result === undefined) throw unreadable(FSC_SOURCE, "its stock prices");
    if (result !== "0") return coded(result, [textValue(header?.resultMsg)], answer);
    const body = recordOf(response.body);
    const total = countOf(body?.totalCount);
    if (!body || total === undefined) throw unreadable(FSC_SOURCE, "its stock prices");
    // `items` is {item: [...]} for rows, {item: {...}} for one, and empty ("" or {}) for none.
    const listed = recordOf(body.items)?.item;
    const items = Array.isArray(listed) ? listed : listed === undefined || listed === null ? [] : [listed];
    return { total, items: items.map(recordOf).filter((item) => item !== undefined) };
  };

  /** One request to `address`, read. */
  const askAt = async (address: string, query: URLSearchParams, call: Call | undefined): Promise<Page> => {
    const url = `${address}?serviceKey=${serviceKeyParam(key)}&${query}`;
    let answer: Answer;
    try {
      answer = await deps.http.get(url, {
        source: FSC_SOURCE,
        signal: call?.signal,
        headers: { Accept: "application/json" },
        // The gateway says why in its body: read it.
        accept: [400, 401, 403, 404, 429],
        // The key is in the address: a redirect elsewhere is not followed.
        redirect: "same-origin",
      });
    } catch (error) {
      if (error instanceof DataError) throw fail(error.kind, error.message, error.details);
      throw error;
    }
    const { status } = answer;
    const body = (await answer.text()).trim();
    if (body.startsWith("<") && (status < 400 || /OpenAPI_ServiceResponse/.test(body))) {
      return fromXml(body, answer);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && (status < 400 || recordOf(parsed)?.OpenAPI_ServiceResponse)) {
      return fromJson(parsed, answer);
    }
    // A failure in words of the gateway's, or none: its status says what it is. Only plain text is quoted: an
    // HTML page says nothing to quote, and JSON of another form may hold anything, a key written with escapes too.
    const words = body.startsWith("<") || parsed !== undefined ? "" : wordsOf(undefined, [body], scrub);
    const said = words ? ` (HTTP ${status}: ${words})` : ` (HTTP ${status})`;
    if (status === 404) {
      throw new WrongAddress(fail("unavailable", `the FSC's stock prices are not at their address${said}.`));
    }
    if (status === 401 || status === 403) throw fail("rejected", `${SAID.rejected}${said}.`, { status });
    if (status === 429) {
      const wait = retryAfterMs(answer.headers.get("retry-after"));
      throw fail("rate_limited", `${SAID.rate_limited}${said}.`, {
        status,
        ...(wait !== undefined ? { retryAfterMs: wait } : {}),
      });
    }
    if (status >= 400) throw fail("unavailable", `${SAID.unavailable}${said}.`, { status });
    throw unreadable(FSC_SOURCE, "its stock prices");
  };

  /** One request, at the address that last answered, then the other when this one is the wrong one. */
  const ask = async (query: URLSearchParams, call: Call | undefined): Promise<Page> => {
    const first = preferred;
    let refused: WrongAddress | undefined;
    for (const index of [first, 1 - first]) {
      try {
        const page = await askAt(FSC_ADDRESSES[index] as string, query, call);
        preferred = index;
        return page;
      } catch (error) {
        if (!(error instanceof WrongAddress)) throw error;
        refused ??= error;
      }
    }
    const { failure } = refused as WrongAddress;
    throw new DataError(
      failure.kind,
      scrub(
        `${failure.message.replace(/\.$/, "")}, at both of its addresses (getStockPriceInfo_V2 and getStockPriceInfo).`,
      ),
      failure.details,
    );
  };

  /** The request's parameters: the share, the window, the page. */
  const queryOf = (code: string, window: FscWindow, rows: number, page: number) => {
    const query = new URLSearchParams({ numOfRows: String(rows), pageNo: String(page), resultType: "json" });
    query.set("likeSrtnCd", code);
    if (window.from) query.set("beginBasDt", window.from.replaceAll("-", ""));
    if (window.until) query.set("endBasDt", window.until.replaceAll("-", ""));
    return query;
  };

  /** How long a window's answer is kept, and whether on disk too: a settled window's rows no longer change. */
  const keeping = (window: FscWindow) => {
    const today = seoulDay(deps.clock());
    const settled = window.until !== undefined && window.until <= addDays(today, -SETTLED_AFTER_DAYS);
    return settled
      ? { ttl: SETTLED_KEEP_MS, disk: { disk: "json" as const } }
      : { ttl: OPEN_KEEP_MS, disk: {} };
  };

  const readRows = async (code: string, window: FscWindow, call: Call | undefined): Promise<FscRow[]> => {
    const found = new Map<string, FscRow>();
    // Rows the answer holds that are not a session of the share (another code, no date): counted, not kept.
    let other = 0;
    let size = FSC_PAGE_ROWS;
    let pageNo = 1;
    let read = 0;
    const stopped = (total: number) =>
      fail(
        "unavailable",
        `the FSC's stock prices of ${code} stopped at ${found.size + other} of the ${total} rows they count.`,
      );
    for (;;) {
      const page = await ask(queryOf(code, window, size, pageNo), call);
      for (const item of page.items) {
        const row = rowOf(item);
        if (row && row.code === code) found.set(row.date, row);
        else other++;
      }
      read += page.items.length;
      if (read >= page.total) {
        // Pages that repeated rows reach the count without all of them.
        if (found.size + other < page.total) throw stopped(page.total);
        break;
      }
      if (!page.items.length || (page.items.length < size && pageNo !== 1)) throw stopped(page.total);
      // A first page shorter than asked, with rows left, is the gateway's page size: the next pages are asked in it.
      if (page.items.length < size) size = page.items.length;
      pageNo = read / size + 1;
    }
    return [...found.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  };

  return {
    rows: async (code, window, call) => {
      const { ttl, disk } = keeping(window);
      return deps.cache.remember(
        `fsc:rows:${code}:${window.from ?? ""}:${window.until ?? ""}`,
        ttl,
        () => readRows(code, window, call),
        { signal: call?.signal, ...disk },
      );
    },
    count: async (code, window, call) => {
      const { ttl, disk } = keeping(window);
      return deps.cache.remember(
        `fsc:count:${code}:${window.from ?? ""}:${window.until ?? ""}`,
        ttl,
        async () => (await ask(queryOf(code, window, 1, 1), call)).total,
        { signal: call?.signal, ...disk },
      );
    },
    scrub,
  };
}

/**
 * data.go.kr's own words about a failure, on one line, each said once and not when it only repeats the code's
 * name; `scrub` removes the key before the words are cut, so no part of it is left at the cut.
 */
function wordsOf(
  name: string | undefined,
  words: readonly (string | null | undefined)[],
  scrub: (text: string) => string,
): string {
  const said = new Set<string>();
  for (const word of words) {
    const line = scrub((word ?? "").replace(/\s+/g, " ").trim()).slice(0, 160);
    if (line && line.toUpperCase() !== name) said.add(line);
  }
  return [...said].join(", ");
}

/** An XML `<item>` as the record its JSON form is: each child element's text by its name. */
function itemOfXml(item: XmlElement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of children(item)) if (field.name !== "__proto__") out[field.name] = textOf(field).trim();
  return out;
}

const SEOUL = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The calendar day in Seoul at `instant`, YYYY-MM-DD: the day KRX's sessions are dated by. */
export function seoulDay(instant: Date): string {
  return SEOUL.format(instant);
}
