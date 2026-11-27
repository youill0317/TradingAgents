// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The Bank of Korea's ECOS (Economic Statistics System) Open API, read with ECOS_API_KEY:
 *
 * - StatisticSearch, one series' values:
 *   `/StatisticSearch/<key>/json/kr/<from>/<to>/<stat_code>/<cycle>/<start>/<end>/<item_code1>/...`. Rows are
 *   asked for by number, ECOS_PAGE_ROWS a page, until `list_total_count` rows are read. A row holds STAT_CODE,
 *   STAT_NAME, ITEM_CODE1-4, ITEM_NAME1-4, UNIT_NAME, TIME (written by the cycle: 20261125 a day, 202611S1
 *   a half month, 202611 a month, 2026Q3 a quarter, 2026S2 a half year, 2026 a year) and DATA_VALUE.
 * - StatisticItemList, a table's items: `/StatisticItemList/<key>/json/kr/<from>/<to>/<stat_code>`, each item
 *   of each item group (GRP_CODE Group1 onward) once per cycle it is published in, with its first and last
 *   period and its unit.
 * - StatisticTableList, every table: `/StatisticTableList/<key>/json/<kr|en>/<from>/<to>`, its code, name
 *   (in Korean or English), parent, cycle and whether it holds values (SRCH_YN).
 *
 * ECOS answers a failure with HTTP 200 and `{"RESULT": {"CODE": ..., "MESSAGE": ...}}`: INFO-200 is no data
 * (an empty answer); INFO-100 a key it does not accept (rejected, naming ECOS_API_KEY); ERROR-100, ERROR-101,
 * ERROR-200, ERROR-300 and ERROR-301 a request it does not take (invalid); ERROR-400 its 60-second limit on one
 * search, which asks for the request to be narrowed: a series' window it is answered for is asked again in
 * halves, by period, and only a single period's is a failure (unavailable), as are ERROR-500, ERROR-600 and
 * ERROR-601, its own failures; ERROR-602 calls it is limiting (rate_limited). A code not written as ECOS writes
 * its codes is an answer in no form it documents. ECOS publishes no request rate. The key travels in the path:
 * the HTTP client keeps it out of every message, and cache keys are built from the codes asked for, never from
 * a URL.
 */
import { NOTICE } from "../../../contracts/index.js";
import type { Call } from "../../../data/capabilities.js";
import { DataError, type DataErrorKind } from "../../../data/errors.js";
import type { EcosCycle } from "../catalog/series.js";
import type { ForkDeps } from "../deps.js";
import { unreadable } from "../http.js";

export const ECOS_SOURCE = "Bank of Korea ECOS";
export const ECOS_API = "https://ecos.bok.or.kr/api";
/** Where an ECOS key is had, free: the Open API service's page. */
export const ECOS_KEY_PAGE = "https://ecos.bok.or.kr/api/";
/** Rows asked for in one request; a longer list is read on, page after page, to its total. */
export const ECOS_PAGE_ROWS = 1_000;

/** ECOS's cycles, the shortest period first. */
export const ECOS_CYCLES: readonly EcosCycle[] = ["D", "SM", "M", "Q", "S", "A"];

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The failure for a request that needs ECOS_API_KEY when it is not set; its message is shown as it is. */
export function ecosKeyNeeded(what: string): DataError {
  return new DataError(
    "not_configured",
    `${what} needs ECOS_API_KEY (a free key from the Bank of Korea's ECOS, ${ECOS_KEY_PAGE}), set in the environment or under "data" in credentials.json.`,
    { source: ECOS_SOURCE, code: NOTICE.capabilityUnavailable, retry: "never" },
  );
}

/** What each RESULT code ECOS answers with means; INFO-200 (no data) is an empty answer, not a failure. */
export const ECOS_RESULT_KINDS: Readonly<Record<string, DataErrorKind>> = {
  "INFO-100": "rejected",
  "ERROR-100": "invalid",
  "ERROR-101": "invalid",
  "ERROR-200": "invalid",
  "ERROR-300": "invalid",
  "ERROR-301": "invalid",
  "ERROR-400": "unavailable",
  "ERROR-500": "unavailable",
  "ERROR-600": "unavailable",
  "ERROR-601": "unavailable",
  "ERROR-602": "rate_limited",
};

/** A RESULT code as ECOS writes one: INFO- or ERROR- and three digits. */
const ECOS_CODE = /^(INFO|ERROR)-\d{3}$/;

/**
 * ECOS's answer to a request it did not serve, as a DataError of the kind its code means; a code not written
 * as ECOS writes its codes is an answer in no form it documents, and is not quoted.
 */
export function ecosFailure(deps: ForkDeps, code: string, said: string): DataError {
  if (!ECOS_CODE.test(code)) return unreadable(ECOS_SOURCE, "a failure");
  const text = deps.http
    .redact(said.replace(/\s+/g, " ").trim())
    .slice(0, 200)
    .replace(/[.\s]+$/, "");
  const detail = `${code}${text ? `: ${text}` : ""}`;
  switch (ECOS_RESULT_KINDS[code] ?? "unavailable") {
    case "rejected":
      return new DataError(
        "rejected",
        `${ECOS_SOURCE} refused ECOS_API_KEY (${detail}). A free key comes from ${ECOS_KEY_PAGE}.`,
        { source: ECOS_SOURCE, code: NOTICE.capabilityUnavailable },
      );
    case "invalid":
      return new DataError("invalid", `${ECOS_SOURCE} did not take the request (${detail})`, {
        source: ECOS_SOURCE,
        code,
        retry: "change_request",
      });
    case "rate_limited":
      return new DataError("rate_limited", `${ECOS_SOURCE} is limiting calls (${detail}).`, {
        source: ECOS_SOURCE,
        code,
        retry: "later",
      });
    default:
      return new DataError("unavailable", `${ECOS_SOURCE} could not answer (${detail}).`, {
        source: ECOS_SOURCE,
        code,
      });
  }
}

type Row = Record<string, unknown>;

const isRecord = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** A value as ECOS writes it ("3.25", "1,940,726.2"); null for an empty or a non-numeric one. */
export function ecosNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const written = text(value).replaceAll(",", "");
  if (!written || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(written)) return null;
  return Number(written);
}

/**
 * One page of a service's list: its rows and `list_total_count`, or "none" when ECOS has no data (INFO-200).
 * Any other RESULT is the failure its code means.
 */
async function page(
  deps: ForkDeps,
  service: string,
  path: readonly string[],
  call: Call | undefined,
): Promise<{ total: number; rows: Row[] } | "none"> {
  const key = deps.config.ecosKey;
  if (!key) throw ecosKeyNeeded("The Bank of Korea's ECOS");
  const url = `${ECOS_API}/${service}/${encodeURIComponent(key)}/json/${path.map(encodeURIComponent).join("/")}`;
  const body = await deps.http.json(url, {
    source: ECOS_SOURCE,
    signal: call?.signal,
    headers: { Accept: "application/json" },
    // The key is in the address: a redirect elsewhere is not followed.
    redirect: "same-origin",
  });
  if (!isRecord(body)) throw unreadable(ECOS_SOURCE, `its ${service} list`);
  const list = body[service];
  const result = isRecord(body.RESULT)
    ? body.RESULT
    : isRecord(list) && isRecord(list.RESULT)
      ? list.RESULT
      : undefined;
  const code = text(result?.CODE);
  if (code === "INFO-200") return "none";
  if (code && code !== "INFO-000") throw ecosFailure(deps, code, text(result?.MESSAGE));
  if (!isRecord(list) || !Array.isArray(list.row)) throw unreadable(ECOS_SOURCE, `its ${service} list`);
  const total = Number(list.list_total_count);
  if (!Number.isInteger(total) || total < 0) throw unreadable(ECOS_SOURCE, `its ${service} list`);
  return { total, rows: list.row.filter(isRecord) };
}

/**
 * Every row of a service's list, read a page at a time (rows `before`'s path, then the row numbers, then
 * `after`'s) until `list_total_count` rows are read; none when ECOS has no data.
 */
async function everyRow(
  deps: ForkDeps,
  service: string,
  before: readonly string[],
  after: readonly string[],
  call: Call | undefined,
): Promise<Row[]> {
  const rows: Row[] = [];
  let total = 1;
  while (rows.length < total) {
    const from = rows.length + 1;
    const read = await page(
      deps,
      service,
      [...before, String(from), String(from + ECOS_PAGE_ROWS - 1), ...after],
      call,
    );
    if (read === "none") {
      // No data at all; a later page ECOS no longer has is a list that changed while it was read.
      if (!rows.length) return rows;
      throw unreadable(ECOS_SOURCE, `its ${service} list, shorter than the total it gave,`);
    }
    total = read.total;
    if (!read.rows.length) {
      if (rows.length < total)
        throw unreadable(ECOS_SOURCE, `its ${service} list, shorter than the total it gave,`);
      break;
    }
    rows.push(...read.rows);
  }
  return rows;
}

// Periods -----------------------------------------------------------------------------------------------

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Every period of `cycle` from the one holding `start` to the one holding `end` (YYYY-MM-DD), as ECOS writes
 * them in a request; none when `start` is after `end`.
 */
export function ecosTimes(cycle: EcosCycle, start: string, end: string): string[] {
  const times: string[] = [];
  if (start > end) return times;
  if (cycle === "D") {
    for (let day = new Date(`${start}T00:00:00Z`); day.toISOString().slice(0, 10) <= end; ) {
      times.push(ecosTime("D", day.toISOString().slice(0, 10)));
      day.setUTCDate(day.getUTCDate() + 1);
    }
    return times;
  }
  if (cycle === "SM") {
    // Half months begin on the 1st and the 16th.
    let at = `${start.slice(0, 8)}${Number(start.slice(8, 10)) <= 15 ? "01" : "16"}`;
    while (at <= end) {
      times.push(ecosTime("SM", at));
      if (at.endsWith("-01")) at = `${at.slice(0, 8)}16`;
      else {
        const month = Number(at.slice(0, 4)) * 12 + Number(at.slice(5, 7));
        at = `${Math.floor(month / 12)}-${pad((month % 12) + 1)}-01`;
      }
    }
    return times;
  }
  const months = { M: 1, Q: 3, S: 6, A: 12 }[cycle];
  const first = Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1;
  const last = Number(end.slice(0, 4)) * 12 + Number(end.slice(5, 7)) - 1;
  for (let at = first - (first % months); at <= last; at += months) {
    times.push(ecosTime(cycle, `${Math.floor(at / 12)}-${pad((at % 12) + 1)}-01`));
  }
  return times;
}

/** The period of `cycle` holding `date` (YYYY-MM-DD), as ECOS writes it in a request. */
export function ecosTime(cycle: EcosCycle, date: string): string {
  const year = date.slice(0, 4);
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  switch (cycle) {
    case "D":
      return `${year}${pad(month)}${pad(day)}`;
    case "SM":
      return `${year}${pad(month)}S${day <= 15 ? 1 : 2}`;
    case "M":
      return `${year}${pad(month)}`;
    case "Q":
      return `${year}Q${Math.floor((month - 1) / 3) + 1}`;
    case "S":
      return `${year}S${month <= 6 ? 1 : 2}`;
    case "A":
      return year;
  }
}

/**
 * A period as answers give it: its kind (calendar_day, half_month, month, quarter, half_year, year), its first
 * day and its label (2026-11-25, 2026-11 first half, 2026-11, 2026-Q3, 2026-H2, 2026).
 */
export type EcosPeriod = { kind: string; start: string; label: string };

/** The period ECOS's TIME `time` names in `cycle`; undefined when it is not written as that cycle writes. */
export function ecosPeriod(cycle: EcosCycle, time: string): EcosPeriod | undefined {
  const written = time.trim();
  let match: RegExpExecArray | null;
  switch (cycle) {
    case "D": {
      match = /^(\d{4})(\d{2})(\d{2})$/.exec(written);
      if (!match) return undefined;
      const start = `${match[1]}-${match[2]}-${match[3]}`;
      return validDay(start) ? { kind: "calendar_day", start, label: start } : undefined;
    }
    case "SM": {
      match = /^(\d{4})(\d{2})S([12])$/.exec(written);
      if (!match || !validMonth(Number(match[2]))) return undefined;
      const first = match[3] === "1";
      return {
        kind: "half_month",
        start: `${match[1]}-${match[2]}-${first ? "01" : "16"}`,
        label: `${match[1]}-${match[2]} ${first ? "first" : "second"} half`,
      };
    }
    case "M":
      match = /^(\d{4})(\d{2})$/.exec(written);
      if (!match || !validMonth(Number(match[2]))) return undefined;
      return { kind: "month", start: `${match[1]}-${match[2]}-01`, label: `${match[1]}-${match[2]}` };
    case "Q": {
      match = /^(\d{4})Q([1-4])$/.exec(written);
      if (!match) return undefined;
      const quarter = Number(match[2]);
      return {
        kind: "quarter",
        start: `${match[1]}-${pad(quarter * 3 - 2)}-01`,
        label: `${match[1]}-Q${quarter}`,
      };
    }
    case "S": {
      match = /^(\d{4})S([12])$/.exec(written);
      if (!match) return undefined;
      const half = Number(match[2]);
      return {
        kind: "half_year",
        start: `${match[1]}-${half === 1 ? "01" : "07"}-01`,
        label: `${match[1]}-H${half}`,
      };
    }
    case "A":
      match = /^(\d{4})$/.exec(written);
      return match ? { kind: "year", start: `${match[1]}-01-01`, label: match[1] as string } : undefined;
  }
}

const validMonth = (month: number) => month >= 1 && month <= 12;

function validDay(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === date;
}

// A series' values ----------------------------------------------------------------------------------------

/** One series ECOS answered: its table, items and unit as ECOS names them, and its values oldest first. */
export type EcosSeries = {
  stat: string;
  statName: string;
  items: { code: string; name: string }[];
  unit: string;
  values: { time: string; value: number | null }[];
};

/** What to read: a table, a cycle, the item codes (one per item group), and the days the periods hold. */
export type EcosQuery = {
  stat: string;
  cycle: EcosCycle;
  items: readonly string[];
  /** The first and last days (YYYY-MM-DD) of the periods to read: those holding them are read too. */
  start: string;
  end: string;
};

/**
 * The values of one series from `start` to `end`, every row ECOS has for them (read page by page to its
 * total), oldest first; undefined when ECOS has none. Item codes that leave an item group open name more than
 * one series, which is invalid. Kept an hour.
 */
export async function ecosSeries(
  deps: ForkDeps,
  query: EcosQuery,
  call?: Call,
): Promise<EcosSeries | undefined> {
  const signal = call?.signal;
  const start = ecosTime(query.cycle, query.start);
  const end = ecosTime(query.cycle, query.end);
  const times = ecosTimes(query.cycle, query.start, query.end);
  const series = await deps.cache.remember(
    `ecos:series:${query.stat}:${query.cycle}:${query.items.join("/")}:${start}:${end}`,
    HOUR_MS,
    async () => seriesOf(query, await searchRows(deps, query, times.length ? times : [start, end], call)),
    { disk: "json", signal },
  );
  return series ?? undefined;
}

/**
 * StatisticSearch's rows of `query` over `times` (consecutive periods), read to its total. A window ECOS answers
 * ERROR-400 for (its 60-second limit on one search: "adjust the request and ask again") is asked again in halves,
 * by period; a single period's ERROR-400 is the failure.
 */
async function searchRows(
  deps: ForkDeps,
  query: EcosQuery,
  times: readonly string[],
  call: Call | undefined,
): Promise<Row[]> {
  const first = times[0] as string;
  const last = times.at(-1) as string;
  try {
    return await everyRow(
      deps,
      "StatisticSearch",
      ["kr"],
      [query.stat, query.cycle, first, last, ...query.items],
      call,
    );
  } catch (error) {
    if (!(error instanceof DataError) || error.details.code !== "ERROR-400" || times.length < 2) throw error;
    const half = Math.ceil(times.length / 2);
    const earlier = await searchRows(deps, query, times.slice(0, half), call);
    return [...earlier, ...(await searchRows(deps, query, times.slice(half), call))];
  }
}

/** StatisticSearch's rows as one series; null for none. */
function seriesOf(query: EcosQuery, rows: readonly Row[]): EcosSeries | null {
  const first = rows[0];
  if (!first) return null;
  const items: { code: string; name: string }[] = [];
  for (let group = 1; group <= 4; group++) {
    const code = text(first[`ITEM_CODE${group}`]);
    if (code) items.push({ code, name: text(first[`ITEM_NAME${group}`]) });
  }
  const values = new Map<string, number | null>();
  for (const row of rows) {
    const time = text(row.TIME);
    if (!time) continue;
    if (values.has(time)) {
      throw new DataError(
        "invalid",
        `ECOS table ${query.stat} answered more than one series for ${query.items.length ? `item codes ${query.items.join(", ")}` : "no item code"}: give an item code for each of the table's item groups`,
        { source: ECOS_SOURCE, retry: "change_request" },
      );
    }
    values.set(time, ecosNumber(row.DATA_VALUE));
  }
  return {
    stat: text(first.STAT_CODE) || query.stat,
    statName: text(first.STAT_NAME),
    items,
    unit: text(first.UNIT_NAME),
    values: [...values]
      .map(([time, value]) => ({ time, value }))
      .sort((a, b) => a.time.localeCompare(b.time)),
  };
}

// A table's items -------------------------------------------------------------------------------------------

/** One item of a table, in one cycle it is published in. */
export type EcosItem = {
  /** Its item group (Group1 onward), its group's name, its code and name, and its parent item's code. */
  group: string;
  groupName: string;
  code: string;
  name: string;
  parent: string | null;
  cycle: string;
  /** Its first and last periods, as ECOS writes them. */
  start: string | null;
  end: string | null;
  unit: string;
};

/** Table `stat`'s items, in ECOS's order (every page read); kept a day. */
export async function ecosItems(deps: ForkDeps, stat: string, call?: Call): Promise<EcosItem[]> {
  const signal = call?.signal;
  return deps.cache.remember(
    `ecos:items:${stat}`,
    DAY_MS,
    async () =>
      (await everyRow(deps, "StatisticItemList", ["kr"], [stat], call)).flatMap((row) => {
        const code = text(row.ITEM_CODE);
        if (!code) return [];
        return [
          {
            group: text(row.GRP_CODE) || "Group1",
            groupName: text(row.GRP_NAME),
            code,
            name: text(row.ITEM_NAME),
            parent: text(row.P_ITEM_CODE) || null,
            cycle: text(row.CYCLE),
            start: text(row.START_TIME) || null,
            end: text(row.END_TIME) || null,
            unit: text(row.UNIT_NAME),
          },
        ];
      }),
    { disk: "json", signal },
  );
}

// Every table -------------------------------------------------------------------------------------------------

/** One of ECOS's tables, as its list names it in one language. */
export type EcosTable = {
  code: string;
  name: string;
  parent: string | null;
  cycle: string | null;
  /** Whether it holds values (SRCH_YN Y), not only other tables. */
  values: boolean;
};

/** Every table ECOS lists, named in Korean (`kr`) or English (`en`), every page read; kept a week. */
export async function ecosTables(deps: ForkDeps, lang: "kr" | "en", call?: Call): Promise<EcosTable[]> {
  const signal = call?.signal;
  return deps.cache.remember(
    `ecos:tables:${lang}`,
    7 * DAY_MS,
    async () =>
      (await everyRow(deps, "StatisticTableList", [lang], [], call)).flatMap((row) => {
        const code = text(row.STAT_CODE);
        if (!code) return [];
        return [
          {
            code,
            name: text(row.STAT_NAME),
            parent: text(row.P_STAT_CODE) || null,
            cycle: text(row.CYCLE) || null,
            values: text(row.SRCH_YN).toUpperCase() === "Y",
          },
        ];
      }),
    { disk: "json", signal },
  );
}
