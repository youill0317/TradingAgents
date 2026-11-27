// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Statistics Korea's KOSIS (Korean Statistical Information Service) Open API, read with KOSIS_API_KEY:
 *
 * - statisticsParameterData.do, one series' values: a table (orgId, tblId), an item (itmId), one code for each
 *   of the table's classifications (objL1 onward), a period (prdSe: D, M, Q, H or Y) and the first and last
 *   periods (startPrdDe, endPrdDe, written YYYYMMDD, YYYYMM, YYYYQQ, YYYYHH or YYYY), as JSON (format=json,
 *   jsonVD=Y). A row holds TBL_NM, ITM_ID, ITM_NM, C1-C8 and C1_NM-C8_NM, UNIT_NM, PRD_SE, PRD_DE, DT (the
 *   value, as text) and LST_CHN_DE (when it last changed). KOSIS answers at most KOSIS_CELLS cells a request,
 *   as it publishes: a longer window is asked for in parts, by period, and a part KOSIS still finds too large
 *   (err 31) is asked for again in halves.
 * - statisticsSearch.do, its search for tables (searchNm): each table's organization, id, name and survey.
 * - statisticsData.do with method=getMeta&type=ITM, a table's items and classifications.
 *
 * KOSIS answers a failure with HTTP 200 and `{"err": ..., "errMsg": ...}`: 30 is no data (an empty answer);
 * 10, 11 and 12 a key it does not take (missing, not registered, expired: rejected, naming KOSIS_API_KEY); 20
 * and 21 a request it does not take (invalid); 31 an answer past its cells; 40 calls past its rate
 * (rate_limited); 41 rows past what it allows (quota); 42 a user it limits (rejected); 50 its own failure
 * (unavailable). KOSIS publishes a rate of 200 requests a minute. The key travels in the query (apiKey): the
 * HTTP client keeps it out of every message, and cache keys are built from the codes asked for.
 */
import { NOTICE } from "../../../contracts/index.js";
import type { Call } from "../../../data/capabilities.js";
import { DataError, type DataErrorKind } from "../../../data/errors.js";
import type { KosisPeriod } from "../catalog/series.js";
import type { ForkDeps } from "../deps.js";
import { unreadable } from "../http.js";

export const KOSIS_SOURCE = "Statistics Korea KOSIS";
/** Where a KOSIS key is had, free: KOSIS's Open API service. */
export const KOSIS_KEY_PAGE = "https://kosis.kr/openapi/";
export const KOSIS_DATA_URL = "https://kosis.kr/openapi/Param/statisticsParameterData.do";
export const KOSIS_SEARCH_URL = "https://kosis.kr/openapi/statisticsSearch.do";
export const KOSIS_META_URL = "https://kosis.kr/openapi/statisticsData.do";
/** The most cells KOSIS answers to one request, as it publishes. */
export const KOSIS_CELLS = 40_000;

/** KOSIS's periods in the order a series of unknown period is asked for them. */
export const KOSIS_PERIODS: readonly KosisPeriod[] = ["M", "Q", "H", "Y", "D"];

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The failure for a request that needs KOSIS_API_KEY when it is not set; its message is shown as it is. */
export function kosisKeyNeeded(what: string): DataError {
  return new DataError(
    "not_configured",
    `${what} needs KOSIS_API_KEY (a free key from Statistics Korea's KOSIS, ${KOSIS_KEY_PAGE}), set in the environment or under "data" in credentials.json.`,
    { source: KOSIS_SOURCE, code: NOTICE.capabilityUnavailable, retry: "never" },
  );
}

/** What each err code KOSIS answers with means; 30 (no data) is an empty answer, not a failure. */
export const KOSIS_ERR_KINDS: Readonly<Record<string, DataErrorKind>> = {
  "10": "rejected",
  "11": "rejected",
  "12": "rejected",
  "20": "invalid",
  "21": "invalid",
  "31": "unavailable",
  "40": "rate_limited",
  "41": "quota",
  "42": "rejected",
  "50": "unavailable",
};

/**
 * KOSIS's answer to a request it did not serve, as a DataError of the kind its err code means; an err not
 * written as KOSIS writes its codes (digits) is an answer in no form it documents, and is not quoted.
 */
export function kosisFailure(deps: ForkDeps, err: string, said: string): DataError {
  if (!/^\d{1,3}$/.test(err)) return unreadable(KOSIS_SOURCE, "a failure");
  const text = deps.http
    .redact(said.replace(/\s+/g, " ").trim())
    .slice(0, 200)
    .replace(/[.\s]+$/, "");
  const detail = `err ${err}${text ? `: ${text}` : ""}`;
  const kind = KOSIS_ERR_KINDS[err] ?? "unavailable";
  switch (kind) {
    case "rejected":
      return new DataError(
        "rejected",
        `${KOSIS_SOURCE} refused KOSIS_API_KEY (${detail}). A free key comes from ${KOSIS_KEY_PAGE}.`,
        { source: KOSIS_SOURCE, code: NOTICE.capabilityUnavailable },
      );
    case "invalid":
      return new DataError("invalid", `${KOSIS_SOURCE} did not take the request (${detail})`, {
        source: KOSIS_SOURCE,
        code: `kosis_${err}`,
        retry: "change_request",
      });
    case "rate_limited":
      return new DataError("rate_limited", `${KOSIS_SOURCE} is limiting calls (${detail}).`, {
        source: KOSIS_SOURCE,
        code: `kosis_${err}`,
        retry: "later",
      });
    case "quota":
      return new DataError("quota", `${KOSIS_SOURCE} allows no more of these requests now (${detail}).`, {
        source: KOSIS_SOURCE,
        code: `kosis_${err}`,
      });
    default:
      return new DataError("unavailable", `${KOSIS_SOURCE} could not answer (${detail}).`, {
        source: KOSIS_SOURCE,
        code: `kosis_${err}`,
      });
  }
}

type Row = Record<string, unknown>;

const isRecord = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

/** A value as KOSIS writes it ("142.1", "1,234"); null for an empty one or a mark ("-", "x", "…"). */
export function kosisNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const written = text(value).replaceAll(",", "");
  if (!written || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(written)) return null;
  return Number(written);
}

/** One request's rows, or no data (err 30); "too_many" for an answer past KOSIS's cells (err 31). */
async function request(
  deps: ForkDeps,
  base: string,
  params: Record<string, string>,
  what: string,
  call: Call | undefined,
): Promise<Row[] | "too_many"> {
  const key = deps.config.kosisKey;
  if (!key) throw kosisKeyNeeded("Statistics Korea's KOSIS");
  const query = new URLSearchParams({ ...params, apiKey: key, format: "json", jsonVD: "Y" });
  const body = await deps.http.json(`${base}?${query}`, {
    source: KOSIS_SOURCE,
    signal: call?.signal,
    headers: { Accept: "application/json" },
    // The key is in the address: a redirect elsewhere is not followed.
    redirect: "same-origin",
  });
  if (Array.isArray(body)) return body.filter(isRecord);
  if (isRecord(body) && body.err !== undefined) {
    const err = text(body.err);
    if (err === "30") return [];
    if (err === "31") return "too_many";
    throw kosisFailure(deps, err, text(body.errMsg));
  }
  throw unreadable(KOSIS_SOURCE, what);
}

// Periods ---------------------------------------------------------------------------------------------------

const pad = (value: number) => String(value).padStart(2, "0");

/** The period of `period` holding `date` (YYYY-MM-DD), as KOSIS writes it in a request. */
export function kosisTime(period: KosisPeriod, date: string): string {
  const year = date.slice(0, 4);
  const month = Number(date.slice(5, 7));
  switch (period) {
    case "D":
      return `${year}${date.slice(5, 7)}${date.slice(8, 10)}`;
    case "M":
      return `${year}${pad(month)}`;
    case "Q":
      return `${year}${pad(Math.floor((month - 1) / 3) + 1)}`;
    case "H":
      return `${year}${pad(month <= 6 ? 1 : 2)}`;
    case "Y":
      return year;
  }
}

/** A period as answers give it: its kind, first day and label (as ecosPeriod's). */
export type KosisPeriodOf = { kind: string; start: string; label: string };

/** The period KOSIS's PRD_DE `written` names for `period`; undefined when it is not written so. */
export function kosisPeriod(period: KosisPeriod, written: string): KosisPeriodOf | undefined {
  const time = written.trim();
  let match: RegExpExecArray | null;
  switch (period) {
    case "D": {
      match = /^(\d{4})(\d{2})(\d{2})$/.exec(time);
      if (!match) return undefined;
      const start = `${match[1]}-${match[2]}-${match[3]}`;
      const day = new Date(`${start}T00:00:00Z`);
      return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === start
        ? { kind: "calendar_day", start, label: start }
        : undefined;
    }
    case "M": {
      match = /^(\d{4})(\d{2})$/.exec(time);
      const month = Number(match?.[2]);
      if (!match || month < 1 || month > 12) return undefined;
      return { kind: "month", start: `${match[1]}-${match[2]}-01`, label: `${match[1]}-${match[2]}` };
    }
    case "Q": {
      match = /^(\d{4})0?([1-4])$/.exec(time);
      if (!match) return undefined;
      const quarter = Number(match[2]);
      return {
        kind: "quarter",
        start: `${match[1]}-${pad(quarter * 3 - 2)}-01`,
        label: `${match[1]}-Q${quarter}`,
      };
    }
    case "H": {
      match = /^(\d{4})0?([12])$/.exec(time);
      if (!match) return undefined;
      const half = Number(match[2]);
      return {
        kind: "half_year",
        start: `${match[1]}-${half === 1 ? "01" : "07"}-01`,
        label: `${match[1]}-H${half}`,
      };
    }
    case "Y":
      match = /^(\d{4})$/.exec(time);
      return match ? { kind: "year", start: `${match[1]}-01-01`, label: match[1] as string } : undefined;
  }
}

/** Every period of `period` from the one holding `start` to the one holding `end`, as KOSIS writes them. */
export function kosisTimes(period: KosisPeriod, start: string, end: string): string[] {
  const times: string[] = [];
  if (period === "D") {
    for (let day = new Date(`${start}T00:00:00Z`); day.toISOString().slice(0, 10) <= end; ) {
      times.push(kosisTime("D", day.toISOString().slice(0, 10)));
      day.setUTCDate(day.getUTCDate() + 1);
    }
    return times;
  }
  const months = { M: 1, Q: 3, H: 6, Y: 12 }[period];
  const first = Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1;
  const last = Number(end.slice(0, 4)) * 12 + Number(end.slice(5, 7)) - 1;
  for (let at = first - (first % months); at <= last; at += months) {
    times.push(kosisTime(period, `${Math.floor(at / 12)}-${pad((at % 12) + 1)}-01`));
  }
  return times;
}

// A series' values -------------------------------------------------------------------------------------------

/** What to read: a table of an organization, an item, a code per classification, a period and its days. */
export type KosisQuery = {
  org: string;
  table: string;
  item: string;
  objects: readonly string[];
  period: KosisPeriod;
  /** The first and last days (YYYY-MM-DD) of the periods to read: those holding them are read too. */
  start: string;
  end: string;
};

/**
 * One series KOSIS answered: its table, item, classification codes (each with the classification it is of)
 * and unit as KOSIS names them, oldest first.
 */
export type KosisSeries = {
  tableName: string;
  item: { code: string; name: string };
  objects: { code: string; name: string; of: string }[];
  unit: string;
  values: { time: string; value: number | null; changed: string | null }[];
};

/** The request parameters for `query` over the periods `first` to `last`. */
function dataParams(query: KosisQuery, first: string, last: string): Record<string, string> {
  return {
    method: "getList",
    orgId: query.org,
    tblId: query.table,
    itmId: query.item,
    ...Object.fromEntries(query.objects.map((code, index) => [`objL${index + 1}`, code])),
    prdSe: query.period,
    startPrdDe: first,
    endPrdDe: last,
  };
}

/**
 * The rows of `query` over `times` (consecutive periods): one request when the periods' cells are within
 * KOSIS_CELLS, else parts of at most that many; a part KOSIS finds too large is asked for again in halves.
 */
async function rowsOver(
  deps: ForkDeps,
  query: KosisQuery,
  times: readonly string[],
  call: Call | undefined,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let at = 0; at < times.length; at += KOSIS_CELLS) {
    const part = times.slice(at, at + KOSIS_CELLS);
    const read = await request(
      deps,
      KOSIS_DATA_URL,
      dataParams(query, part[0] as string, part.at(-1) as string),
      "a table's values",
      call,
    );
    if (read !== "too_many") {
      rows.push(...read);
      continue;
    }
    if (part.length === 1) {
      throw new DataError(
        "unavailable",
        `${KOSIS_SOURCE} answers more than its ${KOSIS_CELLS} cells for one period of table ${query.table} (err 31).`,
        { source: KOSIS_SOURCE, code: "kosis_31" },
      );
    }
    const half = Math.ceil(part.length / 2);
    rows.push(...(await rowsOver(deps, query, part.slice(0, half), call)));
    rows.push(...(await rowsOver(deps, query, part.slice(half), call)));
  }
  return rows;
}

/**
 * The values of one series over the periods holding `start` to `end`, oldest first; undefined when KOSIS
 * has none. Codes that leave a classification open name more than one series, which is invalid. Kept an hour.
 */
export async function kosisSeries(
  deps: ForkDeps,
  query: KosisQuery,
  call?: Call,
): Promise<KosisSeries | undefined> {
  const signal = call?.signal;
  const times = kosisTimes(query.period, query.start, query.end);
  if (!times.length) return undefined;
  const series = await deps.cache.remember(
    `kosis:series:${query.org}:${query.table}:${query.item}:${query.objects.join("/")}:${query.period}:${times[0]}:${times.at(-1)}`,
    HOUR_MS,
    async () => kosisSeriesOf(query, await rowsOver(deps, query, times, call)),
    { disk: "json", signal },
  );
  return series ?? undefined;
}

/** statisticsParameterData's rows as one series; null for none. */
function kosisSeriesOf(query: KosisQuery, rows: readonly Row[]): KosisSeries | null {
  const first = rows[0];
  if (!first) return null;
  const objects: KosisSeries["objects"] = [];
  for (let level = 1; level <= 8; level++) {
    const code = text(first[`C${level}`]);
    if (code) objects.push({ code, name: text(first[`C${level}_NM`]), of: text(first[`C${level}_OBJ_NM`]) });
  }
  const values = new Map<string, { value: number | null; changed: string | null }>();
  for (const row of rows) {
    const time = text(row.PRD_DE);
    if (!time) continue;
    if (values.has(time)) {
      throw new DataError(
        "invalid",
        `KOSIS table ${query.table} answered more than one series for item ${query.item}${query.objects.length ? ` and classification codes ${query.objects.join(", ")}` : ""}: give a code for each of the table's classifications`,
        { source: KOSIS_SOURCE, retry: "change_request" },
      );
    }
    values.set(time, { value: kosisNumber(row.DT), changed: text(row.LST_CHN_DE) || null });
  }
  return {
    tableName: text(first.TBL_NM),
    item: { code: text(first.ITM_ID) || query.item, name: text(first.ITM_NM) },
    objects,
    unit: text(first.UNIT_NM),
    values: [...values]
      .map(([time, value]) => ({ time, ...value }))
      .sort((a, b) => a.time.localeCompare(b.time)),
  };
}

// Search ---------------------------------------------------------------------------------------------------

/** A table KOSIS's search found. */
export type KosisTable = {
  org: string;
  orgName: string;
  table: string;
  name: string;
  /** The survey it belongs to. */
  survey: string;
  /** Its first and last periods, as KOSIS writes them. */
  start: string | null;
  end: string | null;
};

/** How long the organization a search named for a table is kept, so its keys read later too. */
const ORG_KEPT_MS = 365 * DAY_MS;
/** How long the period a table answered in is kept. */
const PERIOD_KEPT_MS = 30 * DAY_MS;

/** The value kept fresh under `key`, without loading one; undefined when none is. */
async function kept<T>(
  deps: ForkDeps,
  key: string,
  ttlMs: number,
  call: Call | undefined,
): Promise<T | undefined> {
  const none = new Error("nothing kept");
  try {
    return await deps.cache.remember<T>(
      key,
      ttlMs,
      async () => {
        throw none;
      },
      { disk: "json", signal: call?.signal },
    );
  } catch (error) {
    if (error === none) return undefined;
    throw error;
  }
}

/** Keeps `value` under `key` for `ttlMs` (a value kept fresh there already stays). */
async function keep<T>(
  deps: ForkDeps,
  key: string,
  ttlMs: number,
  value: T,
  call: Call | undefined,
): Promise<void> {
  await deps.cache.remember(key, ttlMs, async () => value, { disk: "json", signal: call?.signal });
}

/** The period (prdSe) a KOSIS table answered in last, when one is kept (a month). */
export function kosisKnownPeriod(
  deps: ForkDeps,
  org: string,
  table: string,
  call?: Call,
): Promise<KosisPeriod | undefined> {
  return kept<KosisPeriod>(deps, `kosis:period:${org}:${table}`, PERIOD_KEPT_MS, call);
}

/** Keeps the period (prdSe) a KOSIS table answered in, so the next read asks in it first. */
export function kosisKeepPeriod(
  deps: ForkDeps,
  org: string,
  table: string,
  period: KosisPeriod,
  call?: Call,
): Promise<void> {
  return keep(deps, `kosis:period:${org}:${table}`, PERIOD_KEPT_MS, period, call);
}

/**
 * KOSIS's search for `words`: its best `count` tables, best first; kept a day. The organization of each
 * table found is kept a year, for kosisOrg.
 */
export async function kosisSearch(
  deps: ForkDeps,
  words: string,
  count: number,
  call?: Call,
): Promise<KosisTable[]> {
  const signal = call?.signal;
  const tables = await deps.cache.remember(
    `kosis:search:${count}:${words.toLowerCase()}`,
    DAY_MS,
    async () => {
      const rows = await request(
        deps,
        KOSIS_SEARCH_URL,
        { method: "getList", searchNm: words, sort: "RANK", startCount: "1", resultCount: String(count) },
        "a search",
        call,
      );
      if (rows === "too_many") throw unreadable(KOSIS_SOURCE, "a search");
      return rows.flatMap((row): KosisTable[] => {
        const org = text(row.ORG_ID);
        const table = text(row.TBL_ID);
        if (!org || !table) return [];
        return [
          {
            org,
            orgName: text(row.ORG_NM),
            table,
            name: text(row.TBL_NM),
            survey: text(row.STAT_NM),
            start: text(row.STRT_PRD_DE) || null,
            end: text(row.END_PRD_DE) || null,
          },
        ];
      });
    },
    { disk: "json", signal },
  );
  for (const table of tables) await keep(deps, `kosis:org:${table.table}`, ORG_KEPT_MS, table.org, call);
  return tables;
}

/** The organization a KOSIS search named for `table`, when one has in the last year; undefined otherwise. */
export function kosisOrg(deps: ForkDeps, table: string, call?: Call): Promise<string | undefined> {
  return kept<string>(deps, `kosis:org:${table}`, ORG_KEPT_MS, call);
}

// A table's items and classifications ----------------------------------------------------------------------

/** A table's items and its classifications, each with its codes in KOSIS's order. */
export type KosisMeta = {
  items: { code: string; name: string; unit: string }[];
  classifications: { id: string; name: string; codes: { code: string; name: string }[] }[];
};

/**
 * Table `table`'s items and classifications (getMeta, type ITM): rows whose OBJ_ID is ITEM are items, the
 * others the codes of the classification OBJ_ID names, the classifications in their order (OBJ_ID_SN);
 * kept a day.
 */
export async function kosisMeta(deps: ForkDeps, org: string, table: string, call?: Call): Promise<KosisMeta> {
  const signal = call?.signal;
  return deps.cache.remember(
    `kosis:meta:${org}:${table}`,
    DAY_MS,
    async () => {
      const rows = await request(
        deps,
        KOSIS_META_URL,
        { method: "getMeta", type: "ITM", orgId: org, tblId: table },
        "a table's items",
        call,
      );
      if (rows === "too_many") throw unreadable(KOSIS_SOURCE, "a table's items");
      const items: KosisMeta["items"] = [];
      const classifications = new Map<string, KosisMeta["classifications"][number] & { order: number }>();
      for (const row of rows) {
        const id = text(row.OBJ_ID);
        const code = text(row.ITM_ID);
        if (!id || !code) continue;
        if (id.toUpperCase() === "ITEM") {
          items.push({ code, name: text(row.ITM_NM), unit: text(row.UNIT_NM) });
          continue;
        }
        const order = Number(text(row.OBJ_ID_SN));
        const known = classifications.get(id) ?? {
          id,
          name: text(row.OBJ_NM),
          codes: [],
          order: Number.isFinite(order) ? order : classifications.size + 1,
        };
        known.codes.push({ code, name: text(row.ITM_NM) });
        classifications.set(id, known);
      }
      return {
        items,
        classifications: [...classifications.values()]
          .sort((a, b) => a.order - b.order)
          .map(({ id, name, codes }) => ({ id, name, codes })),
      };
    },
    { disk: "json", signal },
  );
}
