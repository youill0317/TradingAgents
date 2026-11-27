// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The Bank of Korea's ECOS (src/fork/data/sources/ecos.ts), offline: StatisticSearch read page by page to
 * list_total_count, every RESULT code ECOS answers mapped to the DataError kind the router acts on (INFO-200 an
 * empty answer; a window answered ERROR-400 asked again in halves), answers not in ECOS's form, each cycle's
 * periods read and written, the item and table lists, the key kept to the request's path (never in a message, a
 * cache key or a cache file), and the recorder's ECOS cases listed without sending anything. Fixtures are
 * hand-made in ECOS's documented JSON; no request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record } from "../../../scripts/fork/record-fixtures.js";
import { DataError } from "../../../src/data/errors.js";
import {
  ECOS_PAGE_ROWS,
  ECOS_RESULT_KINDS,
  ecosItems,
  ecosNumber,
  ecosPeriod,
  ecosSeries,
  ecosTables,
  ecosTime,
  ecosTimes,
} from "../../../src/fork/data/sources/ecos.js";
import { type FixtureRoute, holdsPart, testDeps } from "./harness.js";
import { ECOS_KEY, ECOS_ROUTES, ecosPath } from "./statistics-korea-routes.test.js";

/** A StatisticSearch answer holding `rows` of `total`. */
function answer(rows: { time: string; value: string }[], total = rows.length): string {
  return JSON.stringify({
    StatisticSearch: {
      list_total_count: total,
      row: rows.map(({ time, value }) => ({
        STAT_CODE: "817Y002",
        STAT_NAME: "1.3.2.1. 시장금리(일별)",
        ITEM_CODE1: "010200000",
        ITEM_NAME1: "국고채(3년)",
        ITEM_CODE2: null,
        ITEM_NAME2: null,
        ITEM_CODE3: null,
        ITEM_NAME3: null,
        ITEM_CODE4: null,
        ITEM_NAME4: null,
        UNIT_NAME: "연%",
        WGT: null,
        TIME: time,
        DATA_VALUE: value,
      })),
    },
  });
}

/** An answer written inline at `rest` (the path after the key and the form). */
const inline = (service: string, rest: string, body: string, status = 200): FixtureRoute => ({
  match: ecosPath(service, rest),
  body,
  status,
  headers: { "content-type": "application/json;charset=UTF-8" },
});

/** `count` consecutive days from 2019-01-01 as ECOS writes them, each with a value. */
function days(count: number, from = 0): { time: string; value: string }[] {
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(Date.UTC(2019, 0, 1 + from + index));
    return {
      time: day.toISOString().slice(0, 10).replaceAll("-", ""),
      value: (2 + (index % 7) / 100).toFixed(2),
    };
  });
}

const RANGE = "817Y002/D/20190101/20261125/010200000";
const QUERY = {
  stat: "817Y002",
  cycle: "D" as const,
  items: ["010200000"],
  start: "2019-01-01",
  end: "2026-11-25",
};

/** The row numbers each StatisticSearch request asked for. */
const ranges = (requests: { url: string }[]) =>
  requests.map((request) => new URL(request.url).pathname.split("/").slice(6, 8).join("/"));

describe("StatisticSearch, read to its total", () => {
  test("rows are asked for a page at a time until list_total_count are read", async () => {
    const all = days(2_060);
    const { deps, fetch } = testDeps({ ecosKey: ECOS_KEY }, [
      inline("StatisticSearch", `kr/1/1000/${RANGE}`, answer(all.slice(0, 1_000), 2_060)),
      inline("StatisticSearch", `kr/1001/2000/${RANGE}`, answer(all.slice(1_000, 2_000), 2_060)),
      inline("StatisticSearch", `kr/2001/3000/${RANGE}`, answer(all.slice(2_000), 2_060)),
    ]);
    const series = await ecosSeries(deps, QUERY);
    expect(ECOS_PAGE_ROWS).toBe(1_000);
    expect(ranges(fetch.requests)).toEqual(["1/1000", "1001/2000", "2001/3000"]);
    expect(series?.values).toHaveLength(2_060);
    expect(series?.values[0]).toEqual({ time: "20190101", value: 2 });
    expect(series?.values.at(-1)?.time).toBe(all.at(-1)?.time);
    expect(series).toMatchObject({
      stat: "817Y002",
      statName: "1.3.2.1. 시장금리(일별)",
      items: [{ code: "010200000", name: "국고채(3년)" }],
      unit: "연%",
    });
    // Kept an hour: asked again, nothing is sent.
    await ecosSeries(deps, QUERY);
    expect(fetch.requests).toHaveLength(3);
  });

  test("a page shorter than asked is read on from the row after the last one read", async () => {
    const all = days(1_500);
    const { deps, fetch } = testDeps({ ecosKey: ECOS_KEY }, [
      inline("StatisticSearch", `kr/1/1000/${RANGE}`, answer(all.slice(0, 600), 1_500)),
      inline("StatisticSearch", `kr/601/1600/${RANGE}`, answer(all.slice(600), 1_500)),
    ]);
    const series = await ecosSeries(deps, QUERY);
    expect(ranges(fetch.requests)).toEqual(["1/1000", "601/1600"]);
    expect(series?.values).toHaveLength(1_500);
  });

  test("a page without rows before the total is read is ECOS answering unreadably: unavailable", async () => {
    const { deps } = testDeps({ ecosKey: ECOS_KEY }, [
      inline("StatisticSearch", `kr/1/1000/${RANGE}`, answer(days(1_000), 1_200)),
      inline("StatisticSearch", `kr/1001/2000/${RANGE}`, answer([], 1_200)),
    ]);
    const error = (await ecosSeries(deps, QUERY).catch((caught: unknown) => caught)) as DataError;
    expect(error).toBeInstanceOf(DataError);
    expect(error.kind).toBe("unavailable");
    expect(error.message).toBe(
      "Bank of Korea ECOS answered its StatisticSearch list, shorter than the total it gave, in a form this app does not read.",
    );
  });

  test("a value ECOS answers without a number is null; the rows are put in order", async () => {
    const { deps } = testDeps({ ecosKey: ECOS_KEY }, [
      inline(
        "StatisticSearch",
        `kr/1/1000/${RANGE}`,
        answer([
          { time: "20190103", value: "2.01" },
          { time: "20190101", value: "" },
          { time: "20190102", value: "-" },
        ]),
      ),
    ]);
    expect((await ecosSeries(deps, QUERY))?.values).toEqual([
      { time: "20190101", value: null },
      { time: "20190102", value: null },
      { time: "20190103", value: 2.01 },
    ]);
  });

  test("rows of more than one series (an item group left open) are invalid", async () => {
    const { deps } = testDeps({ ecosKey: ECOS_KEY }, [
      inline(
        "StatisticSearch",
        `kr/1/1000/${RANGE}`,
        answer([
          { time: "20190101", value: "2.01" },
          { time: "20190101", value: "2.02" },
        ]),
      ),
    ]);
    const error = (await ecosSeries(deps, QUERY).catch((caught: unknown) => caught)) as DataError;
    expect([error.kind, error.message]).toEqual([
      "invalid",
      "ECOS table 817Y002 answered more than one series for item codes 010200000: give an item code for each of the table's item groups",
    ]);
  });

  test("without ECOS_API_KEY nothing is sent: not_configured, naming the variable", async () => {
    const { deps, fetch } = testDeps({}, []);
    const error = (await ecosSeries(deps, QUERY).catch((caught: unknown) => caught)) as DataError;
    expect([error.kind, error.details.code]).toEqual(["not_configured", "capability_unavailable"]);
    expect(error.message).toBe(
      `The Bank of Korea's ECOS needs ECOS_API_KEY (a free key from the Bank of Korea's ECOS, https://ecos.bok.or.kr/api/), set in the environment or under "data" in credentials.json.`,
    );
    expect(fetch.requests).toEqual([]);
  });
});

describe("ECOS's RESULT codes", () => {
  // One period: a window of one day, which ERROR-400 does not split.
  const failing = async (code: string, message = "message") => {
    const { deps } = testDeps({ ecosKey: ECOS_KEY }, [
      inline(
        "StatisticSearch",
        "kr/1/1000/817Y002/D/20261125/20261125/010200000",
        JSON.stringify({ RESULT: { CODE: code, MESSAGE: message } }),
      ),
    ]);
    return ecosSeries(deps, { ...QUERY, start: "2026-11-25" }).catch((caught: unknown) => caught);
  };

  test("INFO-200 is no data: an empty answer, for the caller to say", async () => {
    expect(await failing("INFO-200", "해당하는 데이터가 없습니다.")).toBeUndefined();
  });

  test("each code is the kind the router acts on", async () => {
    expect(ECOS_RESULT_KINDS).toEqual({
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
    });
    for (const [code, kind] of [...Object.entries(ECOS_RESULT_KINDS), ["ERROR-999", "unavailable"]]) {
      const error = (await failing(code as string)) as DataError;
      expect(error, code).toBeInstanceOf(DataError);
      expect(error.kind, code).toBe(kind as DataError["kind"]);
      expect(error.details.source, code).toBe("Bank of Korea ECOS");
    }
  });

  test("their messages, as the tool shows them", async () => {
    const said = async (code: string, message: string) =>
      ((await failing(code, message)) as DataError).message;
    expect(await said("INFO-100", "인증키가 유효하지 않습니다.")).toBe(
      "Bank of Korea ECOS refused ECOS_API_KEY (INFO-100: 인증키가 유효하지 않습니다). A free key comes from https://ecos.bok.or.kr/api/.",
    );
    expect(((await failing("INFO-100")) as DataError).details.code).toBe("capability_unavailable");
    expect(await said("ERROR-101", "주기와 다른 형식의 날짜 형식입니다.")).toBe(
      "Bank of Korea ECOS did not take the request (ERROR-101: 주기와 다른 형식의 날짜 형식입니다)",
    );
    expect(await said("ERROR-602", "과도한 OpenAPI호출로 이용이 제한되었습니다.")).toBe(
      "Bank of Korea ECOS is limiting calls (ERROR-602: 과도한 OpenAPI호출로 이용이 제한되었습니다).",
    );
    expect(await said("ERROR-400", "검색범위가 적정범위를 초과하여 60초 TIMEOUT이 발생하였습니다.")).toBe(
      "Bank of Korea ECOS could not answer (ERROR-400: 검색범위가 적정범위를 초과하여 60초 TIMEOUT이 발생하였습니다).",
    );
  });

  test("a message holding the key (an address quoted back) is said without it", async () => {
    const error = (await failing(
      "INFO-100",
      `인증키를 확인하십시오: https://ecos.bok.or.kr/api/StatisticSearch/${ECOS_KEY}/json/kr/1/10`,
    )) as DataError;
    expect(error.message).not.toContain(ECOS_KEY);
    expect(error.message).toContain("StatisticSearch/***/json");
    // Quoted where its words are cut (200 characters): removed first, so no part of it is left.
    const cut = (await failing("INFO-100", `${"x".repeat(190)} ${ECOS_KEY}`)) as DataError;
    expect(holdsPart(`${cut.message} ${JSON.stringify(cut.details)}`, ECOS_KEY)).toBe(false);
  });

  test("ERROR-400 (its 60-second limit on one search) asks for a narrower request: the window is asked again in halves, by period", async () => {
    const rows = (from: number, count: number) =>
      answer(
        Array.from({ length: count }, (_, index) => ({
          time: `202611${String(from + index).padStart(2, "0")}`,
          value: (3 + (from + index) / 100).toFixed(2),
        })),
      );
    const timeout = JSON.stringify({
      RESULT: { CODE: "ERROR-400", MESSAGE: "검색범위가 적정범위를 초과하여 60초 TIMEOUT이 발생하였습니다." },
    });
    const range = (from: string, to: string) => `kr/1/1000/817Y002/D/${from}/${to}/010200000`;
    const { deps, fetch } = testDeps({ ecosKey: ECOS_KEY }, [
      inline("StatisticSearch", range("20261120", "20261125"), timeout),
      inline("StatisticSearch", range("20261120", "20261122"), timeout),
      inline("StatisticSearch", range("20261120", "20261121"), rows(20, 2)),
      inline("StatisticSearch", range("20261122", "20261122"), rows(22, 1)),
      inline("StatisticSearch", range("20261123", "20261125"), rows(23, 3)),
    ]);
    const series = await ecosSeries(deps, { ...QUERY, start: "2026-11-20" });
    expect(series?.values.map((value) => `${value.time} ${value.value}`)).toEqual([
      "20261120 3.2",
      "20261121 3.21",
      "20261122 3.22",
      "20261123 3.23",
      "20261124 3.24",
      "20261125 3.25",
    ]);
    expect(
      fetch.requests.map((request) => new URL(request.url).pathname.split("/").slice(10, 12).join("-")),
    ).toEqual([
      "20261120-20261125",
      "20261120-20261122",
      "20261120-20261121",
      "20261122-20261122",
      "20261123-20261125",
    ]);
    expect(fetch.unmatched).toEqual([]);
    // One period answered ERROR-400 is the failure.
    const error = (await failing(
      "ERROR-400",
      "검색범위가 적정범위를 초과하여 60초 TIMEOUT이 발생하였습니다.",
    )) as DataError;
    expect([error.kind, error.details.code]).toEqual(["unavailable", "ERROR-400"]);
  });

  test("a code not written as ECOS writes its codes is not quoted: unavailable, no part of the request said", async () => {
    // A RESULT whose code echoes the path asked, the key in it.
    const path = `/api/StatisticSearch/${ECOS_KEY}/json/kr/1/1000/817Y002/D/20261125/20261125/010200000`;
    const error = (await failing(path, "x")) as DataError;
    expect(error.kind).toBe("unavailable");
    expect(error.message).toBe("Bank of Korea ECOS answered a failure in a form this app does not read.");
    expect(JSON.stringify(error.details)).not.toContain(ECOS_KEY);
  });

  test("an answer in no form of ECOS's is unavailable", async () => {
    for (const body of ["<html>오류</html>", "{}", JSON.stringify({ StatisticSearch: { row: "x" } })]) {
      const { deps } = testDeps({ ecosKey: ECOS_KEY }, [
        inline("StatisticSearch", `kr/1/1000/${RANGE}`, body),
      ]);
      const error = (await ecosSeries(deps, QUERY).catch((caught: unknown) => caught)) as DataError;
      expect(error.kind, body).toBe("unavailable");
    }
  });
});

describe("periods, by cycle", () => {
  test("every period of a window, as ECOS writes them in a request", () => {
    expect(ecosTimes("D", "2026-02-27", "2026-03-02")).toEqual([
      "20260227",
      "20260228",
      "20260301",
      "20260302",
    ]);
    expect(ecosTimes("SM", "2026-10-20", "2026-11-16")).toEqual(["202610S2", "202611S1", "202611S2"]);
    expect(ecosTimes("SM", "2026-12-16", "2027-01-01")).toEqual(["202612S2", "202701S1"]);
    expect(ecosTimes("M", "2026-11-15", "2027-01-01")).toEqual(["202611", "202612", "202701"]);
    expect(ecosTimes("Q", "2026-05-15", "2026-12-31")).toEqual(["2026Q2", "2026Q3", "2026Q4"]);
    expect(ecosTimes("S", "2026-05-15", "2027-01-01")).toEqual(["2026S1", "2026S2", "2027S1"]);
    expect(ecosTimes("A", "2024-05-15", "2026-01-01")).toEqual(["2024", "2025", "2026"]);
    expect(ecosTimes("D", "2026-11-26", "2026-11-25")).toEqual([]);
  });

  test("the period holding a day, as ECOS writes it in a request", () => {
    expect(
      [
        ["D", "2026-11-25"],
        ["SM", "2026-11-15"],
        ["SM", "2026-11-16"],
        ["M", "2026-11-25"],
        ["Q", "2026-11-25"],
        ["Q", "2026-01-01"],
        ["S", "2026-06-30"],
        ["S", "2026-07-01"],
        ["A", "2026-11-25"],
      ].map(([cycle, date]) => ecosTime(cycle as "D", date as string)),
    ).toEqual(["20261125", "202611S1", "202611S2", "202611", "2026Q4", "2026Q1", "2026S1", "2026S2", "2026"]);
  });

  test("ECOS's TIME as a period: its kind, first day and label", () => {
    expect(ecosPeriod("D", "20261125")).toEqual({
      kind: "calendar_day",
      start: "2026-11-25",
      label: "2026-11-25",
    });
    expect(ecosPeriod("SM", "202611S1")).toEqual({
      kind: "half_month",
      start: "2026-11-01",
      label: "2026-11 first half",
    });
    expect(ecosPeriod("SM", "202611S2")).toEqual({
      kind: "half_month",
      start: "2026-11-16",
      label: "2026-11 second half",
    });
    expect(ecosPeriod("M", "202611")).toEqual({ kind: "month", start: "2026-11-01", label: "2026-11" });
    expect(ecosPeriod("Q", "2026Q3")).toEqual({ kind: "quarter", start: "2026-07-01", label: "2026-Q3" });
    expect(ecosPeriod("S", "2026S2")).toEqual({ kind: "half_year", start: "2026-07-01", label: "2026-H2" });
    expect(ecosPeriod("A", "2026")).toEqual({ kind: "year", start: "2026-01-01", label: "2026" });
    // Written otherwise than the cycle writes it: no period.
    for (const [cycle, time] of [
      ["D", "20261131"],
      ["D", "202611"],
      ["SM", "202613S1"],
      ["M", "202613"],
      ["M", "2026Q1"],
      ["Q", "2026Q5"],
      ["S", "2026S3"],
      ["A", "26"],
    ]) {
      expect(ecosPeriod(cycle as "D", time as string), `${cycle} ${time}`).toBeUndefined();
    }
  });

  test("values as ECOS writes them", () => {
    expect(["3.25", "1,940,726.2", " 2.5 ", "-0.3", "", "-", "…", "1e3"].map(ecosNumber)).toEqual([
      3.25,
      1_940_726.2,
      2.5,
      -0.3,
      null,
      null,
      null,
      1_000,
    ]);
    expect(ecosNumber(3)).toBe(3);
    expect(ecosNumber(null)).toBeNull();
  });
});

describe("the item list and the table list", () => {
  test("a table's items, each with its group, cycle, periods and unit; kept a day", async () => {
    const { deps, fetch } = testDeps({ ecosKey: ECOS_KEY }, ECOS_ROUTES);
    const items = await ecosItems(deps, "817Y002");
    expect(items.map((item) => item.code)).toEqual([
      "010101000",
      "010150000",
      "010200000",
      "010200001",
      "010210000",
      "010300000",
    ]);
    expect(items[2]).toEqual({
      group: "Group1",
      groupName: "계정항목",
      code: "010200000",
      name: "국고채(3년)",
      parent: null,
      cycle: "D",
      start: "19950103",
      end: "20261125",
      unit: "연%",
    });
    await ecosItems(deps, "817Y002");
    expect(fetch.requests).toHaveLength(1);
  });

  test("every table, in Korean or English, and whether it holds values", async () => {
    const { deps } = testDeps({ ecosKey: ECOS_KEY }, ECOS_ROUTES);
    const korean = await ecosTables(deps, "kr");
    const english = await ecosTables(deps, "en");
    expect(korean).toHaveLength(9);
    expect(korean.filter((table) => table.values).map((table) => table.code)).toEqual([
      "722Y001",
      "817Y002",
      "721Y001",
      "901Y009",
      "731Y001",
    ]);
    expect(korean.find((table) => table.code === "722Y001")).toEqual({
      code: "722Y001",
      name: "1.3.1. 한국은행 기준금리 및 여수신금리",
      parent: "0000000002",
      cycle: "D",
      values: true,
    });
    expect(english.find((table) => table.code === "817Y002")?.name).toBe(
      "1.3.2.1. Market Interest Rates (Daily)",
    );
  });
});

describe("the key", () => {
  test("travels in the request's path alone: never in a cache key or a file the cache writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fork-ecos-"));
    try {
      const { deps, fetch } = testDeps({ ecosKey: ECOS_KEY, cacheDir: dir }, ECOS_ROUTES);
      await ecosSeries(deps, {
        stat: "722Y001",
        cycle: "D",
        items: ["0101000"],
        start: "2026-10-16",
        end: "2026-11-25",
      });
      await ecosItems(deps, "817Y002");
      await ecosTables(deps, "kr");
      for (const request of fetch.requests) {
        const path = new URL(request.url).pathname.split("/");
        expect(path[3], request.url).toBe(ECOS_KEY);
        expect(new URL(request.url).search).toBe("");
      }
      const files = await readdir(dir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expect(await readFile(join(dir, file), "utf8")).not.toContain(ECOS_KEY);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the recorder's ECOS cases", () => {
  const dryRun = async (env: Record<string, string>) => {
    const home = await mkdtemp(join(tmpdir(), "fork-ecos-cases-"));
    const said: string[] = [];
    const sent: string[] = [];
    try {
      const status = await record({
        argv: ["--dry-run", "--only", "ecos"],
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

  test("--dry-run lists each case and its files, the key removed from the path, and sends nothing", async () => {
    const { status, said, sent } = await dryRun({ ECOS_API_KEY: ECOS_KEY });
    expect(status).toBe(0);
    expect(sent).toEqual([]);
    expect(said).toEqual([
      "ecos/search-722y001-d-20261016.json and ecos/search-722y001-d-20261016.meta.json <- https://ecos.bok.or.kr/api/StatisticSearch/***/json/kr/1/1000/722Y001/D/20261016/20261125/0101000",
      "ecos/search-901y009-m-202505.json and ecos/search-901y009-m-202505.meta.json <- https://ecos.bok.or.kr/api/StatisticSearch/***/json/kr/1/1000/901Y009/M/202505/202611/0",
      "ecos/item-list-817y002.json and ecos/item-list-817y002.meta.json <- https://ecos.bok.or.kr/api/StatisticItemList/***/json/kr/1/1000/817Y002",
      "ecos/search-817y002-d-20261028.json and ecos/search-817y002-d-20261028.meta.json <- https://ecos.bok.or.kr/api/StatisticSearch/***/json/kr/1/1000/817Y002/D/20261028/20261125/010200000",
      "ecos/table-list-kr.json and ecos/table-list-kr.meta.json <- https://ecos.bok.or.kr/api/StatisticTableList/***/json/kr/1/1000",
      "ecos/table-list-en.json and ecos/table-list-en.meta.json <- https://ecos.bok.or.kr/api/StatisticTableList/***/json/en/1/1000",
      "ecos/error-info-200.json and ecos/error-info-200.meta.json <- https://ecos.bok.or.kr/api/StatisticSearch/***/json/kr/1/1000/722Y001/D/19900101/19900105/0101000",
    ]);
    expect(said.join("\n")).not.toContain(ECOS_KEY);
  });

  test("without ECOS_API_KEY no case has an address, so none would be sent", async () => {
    const { status, said, sent } = await dryRun({});
    expect(status).toBe(0);
    expect(sent).toEqual([]);
    expect(said.every((line) => line.endsWith("<- ECOS_API_KEY is not set"))).toBe(true);
    expect(said).toHaveLength(7);
  });

  test("the cases read what the tests read: each fixture they name is one the tests' routes serve", async () => {
    const served = ECOS_ROUTES.map((route) => route.file);
    for (const file of served) expect(file?.startsWith("ecos/"), file).toBe(true);
    const { said } = await dryRun({ ECOS_API_KEY: ECOS_KEY });
    const named = said.map((line) => line.split(" ")[0]);
    for (const file of served) expect(named, file).toContain(file as string);
  });
});
