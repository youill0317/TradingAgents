// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Korea's macro series through macro_series, the router and the ToolRegistry (the statistics provider with the
 * Bank of Korea's ECOS and Statistics Korea's KOSIS), on hand-made fixtures in their documented JSON: the names a
 * Korean analysis uses, in English and Hangul, taken at once and answered with every field the tool reads (golden
 * texts); keys outside the catalog, typed in any case; ECOS's and KOSIS's own searches; each cycle's and period's
 * labels, a period answered without a value and one missing between two; every failure as the router's kinds;
 * the same with no key (not_configured, naming the variable, with nothing sent) and nothing else changed; and the
 * keys in no payload, text, error, cache key or cache file. No request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DataProvider } from "../../../src/data/capabilities.js";
import { statisticsProvider } from "../../../src/fork/data/providers/statistics.js";
import { buildTools, type FixtureRoute, testDeps, testProviders } from "./harness.js";
import {
  ECOS_KEY,
  ECOS_ROUTES,
  ecosPath,
  KOSIS_KEY,
  KOSIS_ROUTES,
  kosisQuery,
} from "./statistics-korea-routes.test.js";

const KEYS = { ecosKey: ECOS_KEY, kosisKey: KOSIS_KEY };

/** KOSIS's search for other words: no table (err 30). */
const NO_TABLES: FixtureRoute = {
  match: kosisQuery("statisticsSearch.do", { method: "getList" }),
  body: JSON.stringify({ err: "30", errMsg: "데이터가 존재하지 않습니다." }),
  headers: { "content-type": "application/json;charset=UTF-8" },
};

/** The statistics provider alone over the Korean fixtures (and `routes` before them), and its tools. */
function setup(
  config: { ecosKey?: string; kosisKey?: string; fredKey?: string; cacheDir?: string } = KEYS,
  routes: readonly FixtureRoute[] = [],
) {
  const { deps, fetch, clock } = testDeps(config, [...routes, ...ECOS_ROUTES, ...KOSIS_ROUTES, NO_TABLES]);
  const statistics = statisticsProvider(deps);
  return { ...buildTools({ statistics }, { clock, check: true }), statistics, fetch, deps };
}

/** The text the model reads, compared whole with the golden one. */
function golden(name: string, text: string): void {
  if (GOLDEN[name] === undefined) console.log(`GOLDEN ${name}:\n${text}\n`);
  expect(GOLDEN[name]).toBeDefined();
  expect(text).toBe(GOLDEN[name] as string);
}

/** An answer written inline (hand-made, in its source's documented JSON). */
const inline = (match: FixtureRoute["match"], body: unknown): FixtureRoute => ({
  match,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json;charset=UTF-8" },
});

/** An ECOS StatisticSearch answer of one series of table 999Y001 (hand-made). */
const ecosAnswer = (cycle: string, rows: [string, string][], unit = "십억원") => ({
  StatisticSearch: {
    list_total_count: rows.length,
    row: rows.map(([time, value]) => ({
      STAT_CODE: "999Y001",
      STAT_NAME: "9.9.9. 시험 통계표",
      ITEM_CODE1: "A",
      ITEM_NAME1: "시험 항목",
      ITEM_CODE2: null,
      ITEM_NAME2: null,
      ITEM_CODE3: null,
      ITEM_NAME3: null,
      ITEM_CODE4: null,
      ITEM_NAME4: null,
      UNIT_NAME: unit,
      WGT: null,
      TIME: time,
      DATA_VALUE: value,
      CYCLE: cycle,
    })),
  },
});

/** An ECOS item list of table 999Y001: item A in `cycles`. */
const itemList = (cycles: string[], unit = "십억원") => ({
  StatisticItemList: {
    list_total_count: cycles.length,
    row: cycles.map((cycle) => ({
      STAT_CODE: "999Y001",
      STAT_NAME: "9.9.9. 시험 통계표",
      GRP_CODE: "Group1",
      GRP_NAME: "항목",
      ITEM_CODE: "A",
      ITEM_NAME: "시험 항목",
      P_ITEM_CODE: null,
      P_ITEM_NAME: null,
      CYCLE: cycle,
      START_TIME: "2000",
      END_TIME: "2026",
      DATA_CNT: 10,
      UNIT_NAME: unit,
      WEIGHT: null,
    })),
  },
});

describe("what the statistics provider declares", () => {
  test("macro series in every setup, with or without Korea's keys, built without a request", () => {
    for (const config of [{}, KEYS, { ecosKey: ECOS_KEY }, { kosisKey: KOSIS_KEY }]) {
      const { statistics, fetch } = setup(config);
      expect(statistics.name).toBe("Public statistics");
      expect(
        Object.fromEntries(
          Object.entries((statistics as DataProvider).capabilities).map(([name, methods]) => [
            name,
            Object.keys(methods as object).sort(),
          ]),
        ),
      ).toEqual({ macroSeries: ["observations", "search"] });
      expect(fetch.requests).toEqual([]);
    }
  });

  test("through every fork provider, a Korean series answers from Public statistics", async () => {
    const { providers, clock } = testProviders(KEYS, [...ECOS_ROUTES, ...KOSIS_ROUTES]);
    const { runTool } = buildTools(providers, { clock });
    const run = await runTool("macro_series", { series: "Bank of Korea base rate" });
    expect(run.failure, run.text).toBeUndefined();
    expect(run.source).toBe("Public statistics");
  });
});

/** The names a Korean analysis asks for, and the series each must be. */
const ASKED: readonly [string, string][] = [
  ["Bank of Korea base rate", "kr.ecos.722y001.0101000"],
  ["BOK base rate", "kr.ecos.722y001.0101000"],
  ["한국은행 기준금리", "kr.ecos.722y001.0101000"],
  ["기준금리", "kr.ecos.722y001.0101000"],
  ["Korea CPI", "kr.ecos.901y009.0"],
  ["소비자물가지수", "kr.ecos.901y009.0"],
  ["Korea semiconductor production index", "kr.kosis.dt_1f02011.t10.e"],
  ["Korea semiconductor shipment index", "kr.kosis.dt_1f02011.t11.e"],
  ["반도체 재고지수", "kr.kosis.dt_1f02011.t12.e"],
];

describe("the names a Korean analysis uses, through macro_series", () => {
  for (const [name, key] of ASKED) {
    test(`"${name}" is taken at once as ${key}, every field the tool reads supplied`, async () => {
      const { runTool, fetch } = setup();
      const run = await runTool("macro_series", { series: name });
      expect(run.failure, run.text).toBeUndefined();
      expect(run.payload).toMatchObject({ key });
      expect((run.payload as { periods: unknown[] }).periods).toHaveLength(13);
      expect(run.reads.missing()).toEqual([]);
      expect(fetch.unmatched).toEqual([]);
    });
  }

  test("the Bank of Korea's base rate, daily, from ECOS", async () => {
    const run = await setup().runTool("macro_series", { series: "Bank of Korea base rate" });
    golden("base rate", run.text);
    expect(run.provenance).toMatchObject({ source: "Public statistics", subject: "kr.ecos.722y001.0101000" });
    const periods = (run.payload as { periods: { known_from: unknown; status: unknown }[] }).periods;
    expect(periods.every((period) => period.known_from === null && period.status === null)).toBe(true);
  });

  test("Korea's CPI, monthly, from ECOS", async () => {
    golden("cpi", (await setup().runTool("macro_series", { series: "Korea CPI" })).text);
  });

  test("the semiconductor production index, monthly, from KOSIS", async () => {
    golden(
      "semiconductors",
      (await setup().runTool("macro_series", { series: "Korea semiconductor production index" })).text,
    );
  });

  test("each Korean answer says its source keeps no vintages: known_from null, status null", async () => {
    const { statistics } = setup();
    for (const key of ["kr.ecos.722y001.0101000", "kr.kosis.dt_1f02011.t10.e"]) {
      const answer = await (statistics as DataProvider).capabilities.macroSeries?.observations?.(key, {
        limit: 13,
      });
      expect(answer?.coverage?.complete_reason, key).toMatch(
        /^(Bank of Korea ECOS|Statistics Korea KOSIS) keeps no vintages: each value is the one it publishes now, without the day it became known$/,
      );
      expect(answer?.observations).toHaveLength(13);
      for (const one of answer?.observations ?? []) {
        expect([one.known_from, one.status, one.evidence], key).toEqual([null, null, null]);
      }
    }
  });
});

describe("keys outside the catalog", () => {
  test("an ECOS key typed in upper case: its cycle from the table's item list, its name from ECOS's rows", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("macro_series", { series: "KR.ECOS.817Y002.010200000", periods: 5 });
    expect(run.failure, run.text).toBeUndefined();
    golden("ecos key", run.text);
    expect(run.reads.missing()).toEqual([]);
    expect(fetch.requests.map((request) => new URL(request.url).pathname.split("/")[2])).toEqual([
      "StatisticItemList",
      "StatisticSearch",
    ]);
  });

  test("an ECOS key naming an item its table lacks, or too few item codes, is invalid", async () => {
    const { runTool } = setup();
    const unknown = await runTool("macro_series", { series: "kr.ecos.817y002.099999999" });
    expect([unknown.failure, unknown.text]).toEqual([
      "data_invalid",
      "Bank of Korea ECOS cannot answer this request as asked: series:kr.ecos.817y002.099999999: ECOS table 817Y002 has no item 099999999 in its item group 1",
    ]);
    const extra = await runTool("macro_series", { series: "kr.ecos.817y002.010200000.a" });
    expect(extra.text).toBe(
      "Bank of Korea ECOS cannot answer this request as asked: series:kr.ecos.817y002.010200000.a: ECOS table 817Y002 has 1 item group, and its key names an item of each, in order",
    );
  });

  test("ECOS's searches: its table list in English or Korean, then the tables' items", async () => {
    const { runTool, fetch } = setup();
    const english = await runTool("macro_series", { series: "Korea market interest rates" });
    golden("ecos search", english.text);
    expect(english.reads.missing()).toEqual([]);
    const korean = await runTool("macro_series", { series: "시장금리" });
    expect((korean.payload as { candidates: string[] }).candidates).toEqual(
      (english.payload as { candidates: string[] }).candidates.map((line) =>
        line.replace(" (Market Interest Rates (Daily))", ""),
      ),
    );
    expect(fetch.unmatched).toEqual([]);
  });

  test("KOSIS's search names its tables' series; a key it named is read in the period the table answers in", async () => {
    const { runTool, fetch } = setup(KEYS, [
      // Three periods back from 2026-11: the same rows serve, the window starting 2026-03.
      {
        match: kosisQuery("Param/statisticsParameterData.do", { tblId: "DT_1DA7102S", startPrdDe: "202603" }),
        file: "kosis/data-dt-1da7102s-t80-0-00-202505.json",
      },
    ]);
    const search = await runTool("macro_series", { series: "실업률" });
    golden("kosis search", search.text);
    const read = await runTool("macro_series", { series: "kr.kosis.dt_1da7102s.t80.0.00" });
    golden("kosis key", read.text);
    expect(read.reads.missing()).toEqual([]);
    // A period answered without a value is listed with the source's reason.
    const payload = read.payload as { periods: { label: string; value: unknown; notes?: string }[] };
    expect(payload.periods.find((period) => period.label === "2025-12")).toMatchObject({
      value: null,
      notes: "value: Statistics Korea KOSIS published this period without a value",
    });
    // Read again: the table's period is kept, so no other period is asked for.
    const again = await runTool("macro_series", { series: "kr.kosis.dt_1da7102s.t80.0.00", periods: 3 });
    expect((again.payload as { periods: { label: string }[] }).periods.map((one) => one.label)).toEqual([
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    const periods = fetch.requests
      .filter((request) => request.url.includes("statisticsParameterData"))
      .map((request) => new URL(request.url).searchParams.get("prdSe"));
    expect(periods).toEqual(["M", "M"]);
  });

  test("a table of the catalog's, with another item or classification, is read with the catalog's organization", async () => {
    // DT_1F02011's C1 "3" (office, communication equipment and semiconductors), a code of the table's
    // classification as the owner verified it; the rows hand-made in KOSIS's documented JSON.
    const rows = ["202608", "202609", "202610"].map((period, index) => ({
      ORG_ID: "101",
      TBL_ID: "DT_1F02011",
      TBL_NM: "산업별 생산·출하·재고 지수(2020=100)",
      C1: "3",
      C1_NM: "사무회계·통신기기·반도체(C26A, C263, C264)",
      C1_OBJ_NM: "산업별",
      ITM_ID: "T10",
      ITM_NM: "산업생산지수(원지수)",
      UNIT_NM: "2020=100",
      PRD_SE: "M",
      PRD_DE: period,
      DT: (141.5 + index).toFixed(1),
      LST_CHN_DE: "20261031",
    }));
    const { runTool, fetch } = setup(KEYS, [
      inline(
        kosisQuery("Param/statisticsParameterData.do", {
          orgId: "101",
          tblId: "DT_1F02011",
          itmId: "T10",
          objL1: "3",
          prdSe: "M",
        }),
        rows,
      ),
    ]);
    const run = await runTool("macro_series", { series: "kr.kosis.dt_1f02011.t10.3" });
    expect(run.failure, run.text).toBeUndefined();
    const payload = run.payload as { periods: { label: string; value: unknown }[] };
    expect(payload.periods.map((period) => `${period.label} ${period.value}`)).toEqual([
      "2026-08 141.5",
      "2026-09 142.5",
      "2026-10 143.5",
    ]);
    // No search was needed for the table's organization.
    expect(fetch.requests.some((request) => request.url.includes("statisticsSearch"))).toBe(false);
  });

  test("a KOSIS table no search has named: invalid, pointing to the search", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("macro_series", { series: "kr.kosis.dt_9z99999.t1.0" });
    expect([run.failure, run.text]).toEqual([
      "data_invalid",
      "Statistics Korea KOSIS cannot answer this request as asked: series:kr.kosis.dt_9z99999.t1.0: KOSIS table DT_9Z99999 is not in this app's catalog, and no KOSIS search has named the organization that publishes it; search macro_series for the series by name, which names its key",
    ]);
    expect(fetch.requests).toEqual([]);
  });

  test("a key naming no series of its source is invalid", async () => {
    const { runTool } = setup();
    expect((await runTool("macro_series", { series: "kr.ecos.722y001" })).text).toBe(
      "Bank of Korea ECOS cannot answer this request as asked: series:kr.ecos.722y001 names no series: an ECOS key is kr.ecos.<stat_code>.<item_code>..., an item code for each of the table's item groups",
    );
    expect((await runTool("macro_series", { series: "kr.kosis.dt_1f02011" })).text).toBe(
      "Statistics Korea KOSIS cannot answer this request as asked: series:kr.kosis.dt_1f02011 names no series: a KOSIS key is kr.kosis.<tbl_id>.<itm_id>.<obj_code>..., a code for each of the table's classifications",
    );
  });
});

describe("periods and units, by cycle", () => {
  const read = async (cycle: string, rows: [string, string][], periods: number, unit?: string) => {
    const { runTool } = setup(KEYS, [
      inline(ecosPath("StatisticItemList", "kr/1/1000/999Y001"), itemList([cycle], unit)),
      inline(
        (url) =>
          url.hostname === "ecos.bok.or.kr" &&
          url.pathname.includes("/StatisticSearch/") &&
          url.pathname.includes("/999Y001/"),
        ecosAnswer(cycle, rows, unit),
      ),
    ]);
    return runTool("macro_series", { series: "kr.ecos.999y001.a", periods });
  };

  test("quarters, with one missing between two ECOS answers, and an amount in billions of won", async () => {
    const run = await read(
      "Q",
      [
        ["2025Q2", "580,123.4"],
        ["2025Q4", "601,002.7"],
        ["2026Q1", "596,880.1"],
        ["2026Q2", "612,430.9"],
        ["2026Q3", "620,015.2"],
      ],
      5,
    );
    golden("quarters", run.text);
    expect(run.reads.missing()).toEqual([]);
  });

  test("half years, years and half months as their labels", async () => {
    const half = await read(
      "S",
      [
        ["2025S2", "1.5"],
        ["2026S1", "1.7"],
      ],
      2,
      "%",
    );
    expect((half.payload as { periods: { label: string; start: string }[] }).periods).toEqual([
      expect.objectContaining({ label: "2025-H2", start: "2025-07-01" }),
      expect.objectContaining({ label: "2026-H1", start: "2026-01-01" }),
    ]);
    const year = await read(
      "A",
      [
        ["2024", "2.5"],
        ["2025", "2.0"],
      ],
      2,
      "%",
    );
    expect((year.payload as { periods: { label: string }[] }).periods.map((one) => one.label)).toEqual([
      "2024",
      "2025",
    ]);
    const halfMonth = await read(
      "SM",
      [
        ["202610S2", "1"],
        ["202611S1", "2"],
        ["202611S2", "3"],
      ],
      3,
      "%",
    );
    expect((halfMonth.payload as { periods: { label: string; start: string }[] }).periods).toEqual([
      expect.objectContaining({ label: "2026-10 second half", start: "2026-10-16" }),
      expect.objectContaining({ label: "2026-11 first half", start: "2026-11-01" }),
      expect.objectContaining({ label: "2026-11 second half", start: "2026-11-16" }),
    ]);
    expect(halfMonth.text).toContain(
      "Latest: 3 for 2026-11 second half; change from the period before: +1.00 percentage points",
    );
  });

  test("a day ECOS answers without a value is no period of a daily series", async () => {
    const run = await read(
      "D",
      [
        ["20261120", "1.1"],
        ["20261123", ""],
        ["20261124", "1.2"],
        ["20261125", "1.3"],
      ],
      5,
      "%",
    );
    expect((run.payload as { periods: { label: string }[] }).periods.map((one) => one.label)).toEqual([
      "2026-11-20",
      "2026-11-24",
      "2026-11-25",
    ]);
    expect((run.payload as { missing: string[]; continue_end: unknown }).missing).toEqual([]);
  });

  test("KOSIS's quarters, half years, years and days, each in the period the table answers in", async () => {
    const kosisRows = (times: string[]) =>
      times.map((time, index) => ({
        ORG_ID: "101",
        TBL_ID: "DT_TEST",
        TBL_NM: "시험 통계표",
        ITM_ID: "T1",
        ITM_NM: "시험 항목",
        UNIT_NM: "천명",
        PRD_DE: time,
        DT: String(1000 + index),
      }));
    for (const [period, times, labels] of [
      ["Q", ["202601", "202602", "202603"], ["2026-Q1", "2026-Q2", "2026-Q3"]],
      ["H", ["202502", "202601"], ["2025-H2", "2026-H1"]],
      ["Y", ["2024", "2025"], ["2024", "2025"]],
      ["D", ["20261124", "20261125"], ["2026-11-24", "2026-11-25"]],
    ] as const) {
      const { runTool, deps } = setup(KEYS, [
        inline(kosisQuery("statisticsSearch.do", { searchNm: "시험" }), [
          { ORG_ID: "101", ORG_NM: "통계청", TBL_ID: "DT_TEST", TBL_NM: "시험 통계표", STAT_NM: "시험" },
        ]),
        inline(kosisQuery("statisticsData.do", { tblId: "DT_TEST" }), [
          {
            OBJ_ID: "ITEM",
            OBJ_NM: "항목",
            OBJ_ID_SN: "0",
            ITM_ID: "T1",
            ITM_NM: "시험 항목",
            UNIT_NM: "천명",
          },
        ]),
        inline(
          kosisQuery("Param/statisticsParameterData.do", { tblId: "DT_TEST", prdSe: period }),
          kosisRows([...times]),
        ),
        inline(kosisQuery("Param/statisticsParameterData.do", { tblId: "DT_TEST" }), {
          err: "30",
          errMsg: "없음",
        }),
      ]);
      // The search names the table's organization; the key then reads in the first period the table answers.
      await runTool("macro_series", { series: "시험" });
      const run = await runTool("macro_series", { series: "kr.kosis.dt_test.t1", periods: times.length });
      expect(run.failure, `${period}: ${run.text}`).toBeUndefined();
      expect(
        (run.payload as { periods: { label: string }[] }).periods.map((one) => one.label),
        period,
      ).toEqual([...labels]);
      expect((run.payload as { series: string }).series, period).toBe(
        `시험 통계표: 시험 항목 (key kr.kosis.dt_test.t1), 천명, ${{ Q: "quarterly", H: "semiannual", Y: "annual", D: "daily" }[period]} (KOSIS period ${period})`,
      );
      expect(run.reads.missing(), period).toEqual([]);
      void deps;
    }
  });
});

describe("failures, as the router's kinds", () => {
  const BASE_RATE = ecosPath("StatisticSearch", "kr/1/1000/722Y001/D/20261016/20261125/0101000");
  const T10 = kosisQuery("Param/statisticsParameterData.do", { tblId: "DT_1F02011", itmId: "T10" });

  test("ECOS refusing the key: not available with it, naming ECOS_API_KEY", async () => {
    const { runTool } = setup(KEYS, [
      inline(BASE_RATE, { RESULT: { CODE: "INFO-100", MESSAGE: "인증키가 유효하지 않습니다." } }),
    ]);
    const run = await runTool("macro_series", { series: "Bank of Korea base rate" });
    expect([run.failure, run.text]).toEqual([
      "data_rejected",
      "Bank of Korea ECOS refused ECOS_API_KEY (INFO-100: 인증키가 유효하지 않습니다). A free key comes from https://ecos.bok.or.kr/api/.",
    ]);
  });

  test("ECOS limiting calls, having no data, not taking the request, failing", async () => {
    const fail = async (code: string, message: string) => {
      const { runTool } = setup(KEYS, [inline(BASE_RATE, { RESULT: { CODE: code, MESSAGE: message } })]);
      return runTool("macro_series", { series: "Bank of Korea base rate" });
    };
    const limited = await fail("ERROR-602", "과도한 OpenAPI호출로 이용이 제한되었습니다.");
    expect([limited.failure, limited.text]).toEqual([
      "data_rate_limited",
      "Bank of Korea ECOS is rate limiting requests; this is not a fact about the market. Try again later or use another tool.",
    ]);
    const none = await fail("INFO-200", "해당하는 데이터가 없습니다.");
    expect([none.failure, none.text]).toEqual([
      "data_no_data",
      "Bank of Korea ECOS has no data for this request: Bank of Korea ECOS has no Bank of Korea base rate value for a period starting on or before 2026-11-25.",
    ]);
    const refused = await fail("ERROR-101", "주기와 다른 형식의 날짜 형식입니다.");
    expect([refused.failure, refused.text]).toEqual([
      "data_invalid",
      "Bank of Korea ECOS cannot answer this request as asked: Bank of Korea ECOS did not take the request (ERROR-101: 주기와 다른 형식의 날짜 형식입니다)",
    ]);
    const failed = await fail("ERROR-500", "서버 오류입니다.");
    expect([failed.failure, failed.text]).toEqual([
      "data_unavailable",
      "Bank of Korea ECOS could not be reached or answered unreadably; this is not a fact about the market. Bank of Korea ECOS could not answer (ERROR-500: 서버 오류입니다).",
    ]);
  });

  test("ECOS's server failing twice: unavailable, after one retry", async () => {
    const { runTool, fetch } = setup(KEYS, [{ match: BASE_RATE, body: "error", status: 500 }]);
    const run = await runTool("macro_series", { series: "Bank of Korea base rate" });
    expect([run.failure, run.text]).toEqual([
      "data_unavailable",
      "Bank of Korea ECOS could not be reached or answered unreadably; this is not a fact about the market. Bank of Korea ECOS answered HTTP 500.",
    ]);
    expect(fetch.requests).toHaveLength(2);
  });

  test("KOSIS's err codes: the key, its rate, rows past what it allows, no data, a request it does not take", async () => {
    const fail = async (err: string, errMsg: string) => {
      const { runTool } = setup(KEYS, [inline(T10, { err, errMsg })]);
      return runTool("macro_series", { series: "Korea semiconductor production index" });
    };
    const key = await fail("11", "유효하지 않은 인증KEY입니다.");
    expect([key.failure, key.text]).toEqual([
      "data_rejected",
      "Statistics Korea KOSIS refused KOSIS_API_KEY (err 11: 유효하지 않은 인증KEY입니다). A free key comes from https://kosis.kr/openapi/.",
    ]);
    expect((await fail("40", "호출가능건수 제한")).failure).toBe("data_rate_limited");
    const quota = await fail("41", "호출가능 ROW수 제한");
    expect([quota.failure, quota.text]).toEqual([
      "data_quota",
      "Statistics Korea KOSIS is out of quota; this is not a fact about the market.",
    ]);
    const none = await fail("30", "데이터가 존재하지 않습니다.");
    expect([none.failure, none.text]).toEqual([
      "data_no_data",
      "Statistics Korea KOSIS has no data for this request: Statistics Korea KOSIS has no Korea semiconductor production index value for a period starting on or before 2026-11-25.",
    ]);
    expect((await fail("21", "잘못된 요청변수")).failure).toBe("data_invalid");
  });

  test("a search whose sources fail answers the catalog's matches, and says the failure when there are none", async () => {
    const tables = ecosPath("StatisticTableList", "kr/1/1000");
    const { runTool } = setup(KEYS, [
      inline(tables, {
        RESULT: { CODE: "ERROR-602", MESSAGE: "과도한 OpenAPI호출로 이용이 제한되었습니다." },
      }),
      inline(kosisQuery("statisticsSearch.do", {}), { err: "40", errMsg: "호출가능건수 제한" }),
    ]);
    const withCatalog = await runTool("macro_series", { series: "Korea rates" });
    expect(withCatalog.failure).toBeUndefined();
    expect((withCatalog.payload as { candidates: string[] }).candidates).toEqual([
      "Bank of Korea base rate (key kr.ecos.722y001.0101000), 연% (percent a year), daily (ECOS cycle D)",
    ]);
    const without = await runTool("macro_series", { series: "Korea exports" });
    expect(without.failure).toBe("data_rate_limited");
  });
});

describe("without Korea's keys", () => {
  test("a Korean name or key answers not_configured, naming the variable, and nothing is sent", async () => {
    const { runTool, fetch } = setup({});
    for (const [series, text] of [
      [
        "Bank of Korea base rate",
        `Bank of Korea base rate (series:kr.ecos.722y001.0101000) needs ECOS_API_KEY (a free key from the Bank of Korea's ECOS, https://ecos.bok.or.kr/api/), set in the environment or under "data" in credentials.json.`,
      ],
      [
        "한국은행 기준금리",
        `Bank of Korea base rate (series:kr.ecos.722y001.0101000) needs ECOS_API_KEY (a free key from the Bank of Korea's ECOS, https://ecos.bok.or.kr/api/), set in the environment or under "data" in credentials.json.`,
      ],
      [
        "kr.ecos.722y001.0101000",
        `Bank of Korea base rate (series:kr.ecos.722y001.0101000) needs ECOS_API_KEY (a free key from the Bank of Korea's ECOS, https://ecos.bok.or.kr/api/), set in the environment or under "data" in credentials.json.`,
      ],
      [
        "kr.ecos.817y002.010200000",
        `series:kr.ecos.817y002.010200000 needs ECOS_API_KEY (a free key from the Bank of Korea's ECOS, https://ecos.bok.or.kr/api/), set in the environment or under "data" in credentials.json.`,
      ],
      [
        "KR.ECOS.817Y002.010200000",
        `series:kr.ecos.817y002.010200000 needs ECOS_API_KEY (a free key from the Bank of Korea's ECOS, https://ecos.bok.or.kr/api/), set in the environment or under "data" in credentials.json.`,
      ],
      [
        "Korea semiconductor production index",
        `Korea semiconductor production index (series:kr.kosis.dt_1f02011.t10.e) needs KOSIS_API_KEY (a free key from Statistics Korea's KOSIS, https://kosis.kr/openapi/), set in the environment or under "data" in credentials.json.`,
      ],
      [
        "kr.kosis.dt_1da7102s.t80.0.00",
        `series:kr.kosis.dt_1da7102s.t80.0.00 needs KOSIS_API_KEY (a free key from Statistics Korea's KOSIS, https://kosis.kr/openapi/), set in the environment or under "data" in credentials.json.`,
      ],
      [
        "Korean inflation",
        `Korea CPI (series:kr.ecos.901y009.0), which "Korean inflation" finds, needs ECOS_API_KEY (a free key from the Bank of Korea's ECOS, https://ecos.bok.or.kr/api/), set in the environment or under "data" in credentials.json.`,
      ],
      [
        "실업률",
        `No series in this app's catalog matched "실업률"; a search of Korea's statistics needs ECOS_API_KEY (the Bank of Korea's ECOS, a free key from https://ecos.bok.or.kr/api/) or KOSIS_API_KEY (Statistics Korea's KOSIS, a free key from https://kosis.kr/openapi/), set in the environment or under "data" in credentials.json.`,
      ],
    ] as const) {
      const run = await runTool("macro_series", { series });
      expect([run.failure, run.text], series).toEqual(["data_not_configured", text]);
    }
    expect(fetch.requests).toEqual([]);
  });

  test("words that do not ask about Korea are FRED's to search, as before, though a Korean series holds them", async () => {
    const { runTool, fetch } = setup({});
    for (const series of ["semiconductor production", "chip inventory", "base rate"]) {
      const run = await runTool("macro_series", { series });
      expect([run.failure, run.text], series).toEqual([
        "data_not_configured",
        `No series in this app's catalog matched "${series}" (it holds the U.S. Treasury's yields, the New York Fed's reference rates, the ECB's key interest rates and FRED's headline series); a search of all of FRED's series needs FRED_API_KEY (a free key from https://fred.stlouisfed.org/docs/api/api_key.html), set in the environment or under "data" in credentials.json.`,
      ]);
    }
    // Words about Korea name the Korean series they find, with its key.
    expect((await runTool("macro_series", { series: "Korea semiconductor production" })).text).toStartWith(
      `Korea semiconductor production index (series:kr.kosis.dt_1f02011.t10.e), which "Korea semiconductor production" finds, needs KOSIS_API_KEY`,
    );
    expect(fetch.requests).toEqual([]);
  });

  test("with only the other source's key, a series of the one not set still names its variable", async () => {
    const ecosOnly = setup({ ecosKey: ECOS_KEY });
    expect((await ecosOnly.runTool("macro_series", { series: "반도체 재고지수" })).text).toStartWith(
      "Korea semiconductor inventory index (series:kr.kosis.dt_1f02011.t12.e) needs KOSIS_API_KEY",
    );
    const kosisOnly = setup({ kosisKey: KOSIS_KEY });
    expect((await kosisOnly.runTool("macro_series", { series: "Korea CPI" })).text).toStartWith(
      "Korea CPI (series:kr.ecos.901y009.0) needs ECOS_API_KEY",
    );
  });

  test("nothing else changes: the catalog's other series, its words and keys of publishers not served", async () => {
    const { runTool, fetch } = setup({});
    const cpi = await runTool("macro_series", { series: "central banks" });
    expect((cpi.payload as { candidates: string[] }).candidates.some((line) => line.includes("kr."))).toBe(
      false,
    );
    const other = await runTool("macro_series", { series: "jp.boj.call_rate" });
    expect([other.failure, other.text]).toEqual([
      "data_unsupported",
      "Public statistics does not cover this request (series:jp.boj.call_rate: this source serves the U.S. Treasury's, the New York Fed's, the ECB's and FRED's series (keys us.treasury.*, us.nyfed.*, ea.ecb.*, us.fred.*)); this is not a fact about the market.",
    ]);
    const unknown = await runTool("macro_series", { series: "Japan GDP" });
    expect(unknown.text).toStartWith(`No series in this app's catalog matched "Japan GDP" (it holds`);
    expect(fetch.requests).toEqual([]);
  });

  test("with the keys, a US name is the US series still, and keys of publishers not served say what is", async () => {
    const { runTool } = setup(KEYS, [
      { match: (url) => url.hostname === "fred.stlouisfed.org", file: "fred/graph-cpiaucsl.csv" },
    ]);
    const cpi = await runTool("macro_series", { series: "CPI", periods: 2 });
    expect(cpi.payload).toMatchObject({ key: "us.fred.cpiaucsl" });
    const other = await runTool("macro_series", { series: "jp.boj.call_rate" });
    expect(other.text).toBe(
      "Public statistics does not cover this request (series:jp.boj.call_rate: this source serves the U.S. Treasury's, the New York Fed's, the ECB's, FRED's, the Bank of Korea's (ECOS) and Statistics Korea's (KOSIS) series (keys us.treasury.*, us.nyfed.*, ea.ecb.*, us.fred.*, kr.ecos.*, kr.kosis.*)); this is not a fact about the market.",
    );
  });
});

describe("the keys", () => {
  test("are in no payload, text, provenance, error, cache key or cache file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fork-korea-"));
    try {
      const { runTool, fetch } = setup({ ...KEYS, cacheDir: dir }, [
        inline(ecosPath("StatisticSearch", "kr/1/1000/722Y001/D/20261028/20261125/0101000"), {
          RESULT: { CODE: "INFO-100", MESSAGE: `key ${ECOS_KEY} at /api/StatisticSearch/${ECOS_KEY}/json` },
        }),
        inline(kosisQuery("Param/statisticsParameterData.do", { itmId: "T11", startPrdDe: "202601" }), {
          err: "11",
          errMsg: `apiKey=${KOSIS_KEY} expired`,
        }),
      ]);
      const runs = [
        await runTool("macro_series", { series: "Bank of Korea base rate" }),
        await runTool("macro_series", { series: "Korea CPI" }),
        await runTool("macro_series", { series: "Korea semiconductor production index" }),
        await runTool("macro_series", { series: "KR.ECOS.817Y002.010200000", periods: 5 }),
        await runTool("macro_series", { series: "Korea market interest rates" }),
        await runTool("macro_series", { series: "실업률" }),
        await runTool("macro_series", { series: "kr.kosis.dt_1da7102s.t80.0.00" }),
        await runTool("macro_series", { series: "Bank of Korea base rate", periods: 5 }),
        await runTool("macro_series", { series: "Korea semiconductor shipment index", periods: 5 }),
      ];
      expect(runs.at(-2)?.failure).toBe("data_rejected");
      expect(runs.at(-1)?.failure).toBe("data_rejected");
      for (const run of runs) {
        const said = JSON.stringify([run.text, run.summary, run.payload, run.provenance]);
        expect(said).not.toContain(ECOS_KEY);
        expect(said).not.toContain(KOSIS_KEY);
      }
      // Sent: ECOS's in the path, KOSIS's in apiKey; and nowhere the cache keeps.
      expect(fetch.requests.some((request) => request.url.includes(`/${ECOS_KEY}/`))).toBe(true);
      expect(fetch.requests.some((request) => request.url.includes(`apiKey=${KOSIS_KEY}`))).toBe(true);
      const files = await readdir(dir);
      expect(files.length).toBeGreaterThan(5);
      for (const file of files) {
        const kept = await readFile(join(dir, file), "utf8");
        expect(kept).not.toContain(ECOS_KEY);
        expect(kept).not.toContain(KOSIS_KEY);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The golden texts, as the model reads them, on the hand-made fixtures of 2026-11-25 (TEST_DAY). Recording the
 * fixtures (scripts/fork/fixture-cases/ecos.ts and kosis.ts) changes them.
 */
const GOLDEN: Readonly<Record<string, string>> = {
  "base rate": `[e1] macro_series Bank of Korea base rate (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
Bank of Korea base rate (key kr.ecos.722y001.0101000), 연% (percent a year), daily (ECOS cycle D)
Latest: 2.5 for 2026-11-25; change from the period before: +0.00 percentage points (from 2.5 in 2026-11-24); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2026-11-25: 2.5
2026-11-24: 2.5
2026-11-23: 2.5
2026-11-20: 2.5
2026-11-19: 2.5
2026-11-18: 2.5
2026-11-17: 2.5
2026-11-16: 2.5
2026-11-13: 2.5
2026-11-12: 2.5
2026-11-11: 2.5
2026-11-10: 2.5
2026-11-09: 2.5
earlier periods: macro_series with series=kr.ecos.722y001.0101000, end=2026-11-08`,
  cpi: `[e1] macro_series Korea CPI (as of Thursday 2026-10-01; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
Korea CPI (key kr.ecos.901y009.0), 2020=100, monthly (ECOS cycle M)
Latest: 119.2 for 2026-10; change from the period before: +0.25% (from 118.9 in 2026-09); change from a year earlier: +1.83% (from 117.06 in 2025-10)
periods, newest first:
2026-10: 119.2
2026-09: 118.9
2026-08: 118.65
2026-07: 118.4
2026-06: 118.19
2026-05: 118.13
2026-04: 118.05
2026-03: 117.89
2026-02: 117.92
2026-01: 117.53
2025-12: 117.05
2025-11: 116.91
2025-10: 117.06
earlier periods: macro_series with series=kr.ecos.901y009.0, end=2025-09-30`,
  semiconductors: `[e1] macro_series Korea semiconductor production index (as of Tuesday 2026-09-01; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
Korea semiconductor production index (key kr.kosis.dt_1f02011.t10.e), 2020=100, monthly (KOSIS period M), 원지수 (original index)
Latest: 172.4 for 2026-09; change from the period before: +6.62% (from 161.7 in 2026-08); change from a year earlier: +8.84% (from 158.4 in 2025-09)
periods, newest first:
2026-09: 172.4
2026-08: 161.7
2026-07: 166
2026-06: 168.5
2026-05: 163.9
2026-04: 160.4
2026-03: 165.8
2026-02: 147.2
2026-01: 149.5
2025-12: 162.3
2025-11: 156.7
2025-10: 154.1
2025-09: 158.4
earlier periods: macro_series with series=kr.kosis.dt_1f02011.t10.e, end=2025-08-31`,
  "ecos key": `[e1] macro_series KR.ECOS.817Y002.010200000 (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
시장금리(일별): 국고채(3년) (key kr.ecos.817y002.010200000), 연%, daily (ECOS cycle D)
Latest: 2.63 for 2026-11-25; change from the period before: -0.03 percentage points (from 2.66 in 2026-11-24); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2026-11-25: 2.63
2026-11-24: 2.66
2026-11-23: 2.64
2026-11-20: 2.65
2026-11-19: 2.67
earlier periods: macro_series with series=kr.ecos.817y002.010200000, end=2026-11-18`,
  "ecos search": `[e1] macro_series Korea market interest rates (reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
"Korea market interest rates" is not certain to mean one series; call macro_series again with the key of the one you mean:
- 시장금리(일별) (Market Interest Rates (Daily)): 콜금리(1일, 전체거래) (key kr.ecos.817y002.010101000), 연%, daily (ECOS cycle D)
- 시장금리(일별) (Market Interest Rates (Daily)): KORIBOR(3개월) (key kr.ecos.817y002.010150000), 연%, daily (ECOS cycle D)
- 시장금리(일별) (Market Interest Rates (Daily)): 국고채(3년) (key kr.ecos.817y002.010200000), 연%, daily (ECOS cycle D)
- 시장금리(일별) (Market Interest Rates (Daily)): 국고채(5년) (key kr.ecos.817y002.010200001), 연%, daily (ECOS cycle D)
- 시장금리(일별) (Market Interest Rates (Daily)): 국고채(10년) (key kr.ecos.817y002.010210000), 연%, daily (ECOS cycle D)`,
  "kosis search": `[e1] macro_series 실업률 (reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
"실업률" is not certain to mean one series; call macro_series again with the key of the one you mean:
- 성/연령별 실업률: 실업률 (성별 계, 연령계층별 계) (key kr.kosis.dt_1da7102s.t80.0.00), %, frequency not stated
- 성/연령별 실업률: 실업률(계절조정) (성별 계, 연령계층별 계) (key kr.kosis.dt_1da7102s.t90.0.00), %, frequency not stated`,
  quarters: `[e1] macro_series kr.ecos.999y001.a (as of Wednesday 2026-07-01; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
시험 통계표: 시험 항목 (key kr.ecos.999y001.a), 십억원, quarterly (ECOS cycle Q)
Latest: 620015.2 for 2026-Q3; change from the period before: +1.24% (from 612430.9 in 2026-Q2); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2026-Q3: 620015.2
2026-Q2: 612430.9
2026-Q1: 596880.1
2025-Q4: 601002.7
2025-Q2: 580123.4
missing periods: 2025-Q3 (Bank of Korea ECOS has no row for this period)
earlier periods: macro_series with series=kr.ecos.999y001.a, end=2025-03-31`,
  "kosis key": `[e2] macro_series kr.kosis.dt_1da7102s.t80.0.00 (as of Thursday 2026-10-01; reference its data as {"ref":"e2","path":"<field>"})
source: Public statistics
성/연령별 실업률: 실업률 (성별 계, 연령계층별 계) (key kr.kosis.dt_1da7102s.t80.0.00), %, monthly (KOSIS period M)
Latest: 2.6 for 2026-10; change from the period before: +0.10 percentage points (from 2.5 in 2026-09); change from a year earlier: +0.20 percentage points (from 2.4 in 2025-10)
periods, newest first:
2026-10: 2.6
2026-09: 2.5
2026-08: 2.4
2026-07: 2.5
2026-06: 2.6
2026-05: 2.7
2026-04: 2.9
2026-03: 3
2026-02: 3.4
2026-01: 3.7
2025-12: no value; value: Statistics Korea KOSIS published this period without a value
2025-11: 2.6
2025-10: 2.4
earlier periods: macro_series with series=kr.kosis.dt_1da7102s.t80.0.00, end=2025-09-30`,
};
