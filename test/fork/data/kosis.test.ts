// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Statistics Korea's KOSIS (src/fork/data/sources/kosis.ts), offline: a window past KOSIS's published 40,000
 * cells asked for in parts, and a part KOSIS still finds too large (err 31) asked for again in halves; every err
 * code mapped to the DataError kind the router acts on (30 an empty answer); each period's PRD_DE read and
 * written; the search keeping each table's organization; a table's items and classifications; the key kept to
 * the request's apiKey (never in a message, a cache key or a cache file); the recorder's KOSIS cases listed
 * without sending anything. Fixtures are hand-made in KOSIS's documented JSON; no request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record } from "../../../scripts/fork/record-fixtures.js";
import { DataError } from "../../../src/data/errors.js";
import {
  KOSIS_CELLS,
  KOSIS_ERR_KINDS,
  kosisMeta,
  kosisNumber,
  kosisOrg,
  kosisPeriod,
  kosisSearch,
  kosisSeries,
  kosisTime,
  kosisTimes,
} from "../../../src/fork/data/sources/kosis.js";
import { type FixtureRoute, holdsPart, testDeps } from "./harness.js";
import { KOSIS_KEY, KOSIS_ROUTES, kosisQuery } from "./statistics-korea-routes.test.js";

const DATA = "Param/statisticsParameterData.do";

/** Rows of item T10 of DT_1F02011 at C1 E for these periods. */
function rows(times: readonly string[], value = (index: number) => String(100 + index)): string {
  return JSON.stringify(
    times.map((time, index) => ({
      ORG_ID: "101",
      TBL_ID: "DT_1F02011",
      TBL_NM: "산업별 생산·출하·재고 지수(2020=100)",
      C1: "E",
      C1_NM: "반도체 및 부품(C261+C262=C26A)",
      C1_OBJ_NM: "산업별",
      ITM_ID: "T10",
      ITM_NM: "산업생산지수(원지수)",
      UNIT_NM: "2020=100",
      PRD_SE: time.length === 8 ? "D" : "M",
      PRD_DE: time,
      DT: value(index),
      LST_CHN_DE: "20261030",
    })),
  );
}

/** A data request for the periods `first` to `last`, answered with `body`. */
const part = (first: string, last: string, body: string): FixtureRoute => ({
  match: kosisQuery(DATA, { tblId: "DT_1F02011", startPrdDe: first, endPrdDe: last }),
  body,
  headers: { "content-type": "application/json;charset=UTF-8" },
});

/** Every data request: KOSIS's {err, errMsg}. */
const refusing = (err: string, errMsg = "message"): FixtureRoute => ({
  match: kosisQuery(DATA, { tblId: "DT_1F02011" }),
  body: JSON.stringify({ err, errMsg }),
  headers: { "content-type": "application/json;charset=UTF-8" },
});

const MONTHLY = {
  org: "101",
  table: "DT_1F02011",
  item: "T10",
  objects: ["E"],
  period: "M" as const,
  start: "2020-01-01",
  end: "2026-12-31",
};

/** The periods each data request asked for. */
const windows = (requests: { url: string }[]) =>
  requests.map((request) => {
    const url = new URL(request.url);
    return `${url.searchParams.get("startPrdDe")}-${url.searchParams.get("endPrdDe")}`;
  });

describe("a series' values, within KOSIS's cells", () => {
  test("a window within KOSIS_CELLS is one request, every parameter as KOSIS documents it", async () => {
    const { deps, fetch } = testDeps({ kosisKey: KOSIS_KEY }, KOSIS_ROUTES);
    const series = await kosisSeries(deps, { ...MONTHLY, start: "2025-05-01", end: "2026-11-25" });
    expect(fetch.requests).toHaveLength(1);
    const url = new URL(fetch.requests[0]?.url as string);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      method: "getList",
      orgId: "101",
      tblId: "DT_1F02011",
      itmId: "T10",
      objL1: "E",
      prdSe: "M",
      startPrdDe: "202505",
      endPrdDe: "202611",
      apiKey: KOSIS_KEY,
      format: "json",
      jsonVD: "Y",
    });
    expect(series?.values).toHaveLength(17);
    expect(series?.values[0]).toEqual({ time: "202505", value: 148.2, changed: "20250630" });
    expect(series).toMatchObject({
      tableName: "산업별 생산·출하·재고 지수(2020=100)",
      item: { code: "T10", name: "산업생산지수(원지수)" },
      objects: [{ code: "E", name: "반도체 및 부품(C261+C262=C26A)", of: "산업별" }],
      unit: "2020=100",
    });
  });

  test("a window past KOSIS_CELLS periods is asked for in parts of at most that many", async () => {
    const times = kosisTimes("D", "1900-01-01", "2026-11-25");
    expect(KOSIS_CELLS).toBe(40_000);
    expect(times.length).toBeGreaterThan(KOSIS_CELLS);
    const first = times.slice(0, KOSIS_CELLS);
    const second = times.slice(KOSIS_CELLS);
    const { deps, fetch } = testDeps({ kosisKey: KOSIS_KEY }, [
      part(first[0] as string, first.at(-1) as string, rows([first[0] as string])),
      part(second[0] as string, second.at(-1) as string, rows([second.at(-1) as string])),
    ]);
    const series = await kosisSeries(deps, {
      ...MONTHLY,
      period: "D",
      start: "1900-01-01",
      end: "2026-11-25",
    });
    expect(windows(fetch.requests)).toEqual([`${first[0]}-${first.at(-1)}`, `${second[0]}-${second.at(-1)}`]);
    expect(series?.values.map((one) => one.time)).toEqual(["19000101", "20261125"]);
  });

  test("a part KOSIS finds too large (err 31) is asked for again in halves until it answers", async () => {
    const times = kosisTimes("M", MONTHLY.start, MONTHLY.end);
    expect(times).toHaveLength(84);
    // KOSIS answers 21 months at a time here: 84 -> 42 + 42 -> four parts of 21.
    const quarters = [0, 21, 42, 63].map((at) => times.slice(at, at + 21));
    const { deps, fetch } = testDeps({ kosisKey: KOSIS_KEY }, [
      ...quarters.map((months) => part(months[0] as string, months.at(-1) as string, rows(months))),
      refusing("31", "조회 결과가 4만 셀을 초과합니다."),
    ]);
    const series = await kosisSeries(deps, MONTHLY);
    expect(windows(fetch.requests)).toEqual([
      "202001-202612",
      "202001-202306",
      "202001-202109",
      "202110-202306",
      "202307-202612",
      "202307-202503",
      "202504-202612",
    ]);
    expect(series?.values.map((one) => one.time)).toEqual(times);
  });

  test("err 31 for a single period cannot be split: unavailable", async () => {
    const { deps } = testDeps({ kosisKey: KOSIS_KEY }, [refusing("31")]);
    const error = (await kosisSeries(deps, { ...MONTHLY, start: "2026-01-01", end: "2026-01-31" }).catch(
      (caught: unknown) => caught,
    )) as DataError;
    expect([error.kind, error.message]).toEqual([
      "unavailable",
      "Statistics Korea KOSIS answers more than its 40000 cells for one period of table DT_1F02011 (err 31).",
    ]);
  });

  test("rows of more than one series (a classification left open) are invalid", async () => {
    const { deps } = testDeps({ kosisKey: KOSIS_KEY }, [
      part("202601", "202601", rows(["202601", "202601"])),
    ]);
    const error = (await kosisSeries(deps, { ...MONTHLY, start: "2026-01-01", end: "2026-01-31" }).catch(
      (caught: unknown) => caught,
    )) as DataError;
    expect([error.kind, error.message]).toEqual([
      "invalid",
      "KOSIS table DT_1F02011 answered more than one series for item T10 and classification codes E: give a code for each of the table's classifications",
    ]);
  });

  test("a value KOSIS writes as a mark is null", () => {
    expect(["142.1", "1,234", " 98 ", "", "-", "x", "…", "0"].map(kosisNumber)).toEqual([
      142.1,
      1_234,
      98,
      null,
      null,
      null,
      null,
      0,
    ]);
  });
});

describe("KOSIS's err codes", () => {
  const failing = async (err: string, errMsg = "message") => {
    const { deps } = testDeps({ kosisKey: KOSIS_KEY }, [refusing(err, errMsg)]);
    return kosisSeries(deps, { ...MONTHLY, start: "2026-01-01", end: "2026-03-31" }).catch(
      (caught: unknown) => caught,
    );
  };

  test("30 is no data: an empty answer, for the caller to say", async () => {
    expect(await failing("30", "데이터가 존재하지 않습니다.")).toBeUndefined();
  });

  test("each code is the kind the router acts on", async () => {
    expect(KOSIS_ERR_KINDS).toEqual({
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
    });
    for (const [err, kind] of [
      ...Object.entries(KOSIS_ERR_KINDS).filter(([code]) => code !== "31"),
      ["99", "unavailable"],
    ]) {
      const error = (await failing(err as string)) as DataError;
      expect(error, err).toBeInstanceOf(DataError);
      expect(error.kind, err).toBe(kind as DataError["kind"]);
      expect(error.details.source, err).toBe("Statistics Korea KOSIS");
    }
  });

  test("their messages, as the tool shows them", async () => {
    const said = async (err: string, errMsg: string) => ((await failing(err, errMsg)) as DataError).message;
    expect(await said("11", "유효하지 않은 인증KEY입니다.")).toBe(
      "Statistics Korea KOSIS refused KOSIS_API_KEY (err 11: 유효하지 않은 인증KEY입니다). A free key comes from https://kosis.kr/openapi/.",
    );
    expect(((await failing("11")) as DataError).details.code).toBe("capability_unavailable");
    expect(await said("21", "잘못된 요청변수")).toBe(
      "Statistics Korea KOSIS did not take the request (err 21: 잘못된 요청변수)",
    );
    expect(await said("40", "호출가능건수 제한")).toBe(
      "Statistics Korea KOSIS is limiting calls (err 40: 호출가능건수 제한).",
    );
    expect(await said("41", "호출가능 ROW수 제한")).toBe(
      "Statistics Korea KOSIS allows no more of these requests now (err 41: 호출가능 ROW수 제한).",
    );
  });

  test("a message holding the key is said without it", async () => {
    const error = (await failing("11", `apiKey=${KOSIS_KEY} is not registered`)) as DataError;
    expect(error.message).not.toContain(KOSIS_KEY);
    expect(error.message).toContain("apiKey=***");
    // Quoted where its words are cut (200 characters): removed first, so no part of it is left.
    const cut = (await failing("11", `${"x".repeat(190)} ${KOSIS_KEY}`)) as DataError;
    expect(holdsPart(`${cut.message} ${JSON.stringify(cut.details)}`, KOSIS_KEY)).toBe(false);
  });

  test("an err not written as KOSIS writes its codes is not quoted: unavailable, no part of the request said", async () => {
    // An err echoing the query asked, the key in it (encoded as a query writes it).
    const query = `orgId=101&tblId=DT_1F02011&apiKey=${encodeURIComponent(KOSIS_KEY)}`;
    const error = (await failing(query, "x")) as DataError;
    expect(error.kind).toBe("unavailable");
    expect(error.message).toBe("Statistics Korea KOSIS answered a failure in a form this app does not read.");
    expect(JSON.stringify(error.details)).not.toContain(KOSIS_KEY);
  });

  test("an answer in no form of KOSIS's is unavailable", async () => {
    for (const body of ["<html>오류</html>", "{}", '"text"']) {
      const { deps } = testDeps({ kosisKey: KOSIS_KEY }, [
        { match: kosisQuery(DATA, { tblId: "DT_1F02011" }), body, headers: { "content-type": "text/html" } },
      ]);
      const error = (await kosisSeries(deps, { ...MONTHLY, start: "2026-01-01", end: "2026-01-31" }).catch(
        (caught: unknown) => caught,
      )) as DataError;
      expect(error.kind, body).toBe("unavailable");
    }
  });

  test("without KOSIS_API_KEY nothing is sent: not_configured, naming the variable", async () => {
    const { deps, fetch } = testDeps({}, []);
    const error = (await kosisSeries(deps, MONTHLY).catch((caught: unknown) => caught)) as DataError;
    expect([error.kind, error.details.code]).toEqual(["not_configured", "capability_unavailable"]);
    expect(error.message).toBe(
      `Statistics Korea's KOSIS needs KOSIS_API_KEY (a free key from Statistics Korea's KOSIS, https://kosis.kr/openapi/), set in the environment or under "data" in credentials.json.`,
    );
    expect(fetch.requests).toEqual([]);
  });
});

describe("periods", () => {
  test("the period holding a day, as KOSIS writes it in a request", () => {
    expect(
      [
        ["D", "2026-11-25"],
        ["M", "2026-11-25"],
        ["Q", "2026-11-25"],
        ["Q", "2026-03-31"],
        ["H", "2026-06-30"],
        ["H", "2026-07-01"],
        ["Y", "2026-11-25"],
      ].map(([period, date]) => kosisTime(period as "D", date as string)),
    ).toEqual(["20261125", "202611", "202604", "202601", "202601", "202602", "2026"]);
  });

  test("KOSIS's PRD_DE as a period: its kind, first day and label", () => {
    expect(kosisPeriod("D", "20261125")).toEqual({
      kind: "calendar_day",
      start: "2026-11-25",
      label: "2026-11-25",
    });
    expect(kosisPeriod("M", "202611")).toEqual({ kind: "month", start: "2026-11-01", label: "2026-11" });
    expect(kosisPeriod("Q", "202603")).toEqual({ kind: "quarter", start: "2026-07-01", label: "2026-Q3" });
    expect(kosisPeriod("Q", "20263")).toEqual({ kind: "quarter", start: "2026-07-01", label: "2026-Q3" });
    expect(kosisPeriod("H", "202602")).toEqual({ kind: "half_year", start: "2026-07-01", label: "2026-H2" });
    expect(kosisPeriod("Y", "2026")).toEqual({ kind: "year", start: "2026-01-01", label: "2026" });
    for (const [period, written] of [
      ["D", "20260230"],
      ["M", "202613"],
      ["Q", "202605"],
      ["H", "202603"],
      ["Y", "26"],
    ]) {
      expect(kosisPeriod(period as "D", written as string), `${period} ${written}`).toBeUndefined();
    }
  });

  test("every period of a window, from the one holding its first day to the one holding its last", () => {
    expect(kosisTimes("M", "2026-10-15", "2027-01-02")).toEqual(["202610", "202611", "202612", "202701"]);
    expect(kosisTimes("Q", "2026-02-01", "2026-11-25")).toEqual(["202601", "202602", "202603", "202604"]);
    expect(kosisTimes("H", "2025-08-01", "2026-11-25")).toEqual(["202502", "202601", "202602"]);
    expect(kosisTimes("Y", "2024-06-01", "2026-01-01")).toEqual(["2024", "2025", "2026"]);
    expect(kosisTimes("D", "2026-02-27", "2026-03-02")).toEqual([
      "20260227",
      "20260228",
      "20260301",
      "20260302",
    ]);
  });
});

describe("the search and a table's items", () => {
  test("a search's tables, each table's organization kept for the keys it names", async () => {
    const { deps, fetch } = testDeps({ kosisKey: KOSIS_KEY }, KOSIS_ROUTES);
    expect(await kosisOrg(deps, "DT_1DA7102S")).toBeUndefined();
    const tables = await kosisSearch(deps, "실업률", 5);
    expect(tables).toEqual([
      {
        org: "101",
        orgName: "통계청",
        table: "DT_1DA7102S",
        name: "성/연령별 실업률",
        survey: "경제활동인구조사",
        start: "199906",
        end: "202610",
      },
    ]);
    const url = new URL(fetch.requests[0]?.url as string);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      method: "getList",
      searchNm: "실업률",
      sort: "RANK",
      startCount: "1",
      resultCount: "5",
      apiKey: KOSIS_KEY,
      format: "json",
      jsonVD: "Y",
    });
    expect(await kosisOrg(deps, "DT_1DA7102S")).toBe("101");
    expect(await kosisOrg(deps, "DT_NOSUCHTABLE")).toBeUndefined();
  });

  test("the organization a search named is kept on disk, so a later run reads the table's keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fork-kosis-"));
    try {
      const first = testDeps({ kosisKey: KOSIS_KEY, cacheDir: dir }, KOSIS_ROUTES);
      await kosisSearch(first.deps, "실업률", 5);
      const later = testDeps({ kosisKey: KOSIS_KEY, cacheDir: dir }, []);
      expect(await kosisOrg(later.deps, "DT_1DA7102S")).toBe("101");
      expect(later.fetch.requests).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a table's items and its classifications, in KOSIS's order", async () => {
    const { deps } = testDeps({ kosisKey: KOSIS_KEY }, KOSIS_ROUTES);
    expect(await kosisMeta(deps, "101", "DT_1DA7102S")).toEqual({
      items: [
        { code: "T80", name: "실업률", unit: "%" },
        { code: "T90", name: "실업률(계절조정)", unit: "%" },
      ],
      classifications: [
        {
          id: "A",
          name: "성별",
          codes: [
            { code: "0", name: "계" },
            { code: "1", name: "남자" },
            { code: "2", name: "여자" },
          ],
        },
        {
          id: "B",
          name: "연령계층별",
          codes: [
            { code: "00", name: "계" },
            { code: "20", name: "15 - 29세" },
          ],
        },
      ],
    });
  });
});

describe("the key", () => {
  test("travels in apiKey alone: never in a cache key or a file the cache writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fork-kosis-"));
    try {
      const { deps, fetch } = testDeps({ kosisKey: KOSIS_KEY, cacheDir: dir }, KOSIS_ROUTES);
      await kosisSeries(deps, { ...MONTHLY, start: "2025-05-01", end: "2026-11-25" });
      await kosisSearch(deps, "실업률", 5);
      await kosisMeta(deps, "101", "DT_1DA7102S");
      for (const request of fetch.requests) {
        const url = new URL(request.url);
        expect(url.searchParams.get("apiKey"), request.url).toBe(KOSIS_KEY);
        expect(url.pathname, request.url).not.toContain(KOSIS_KEY);
      }
      const files = await readdir(dir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expect(await readFile(join(dir, file), "utf8")).not.toContain(KOSIS_KEY);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the recorder's KOSIS cases", () => {
  const dryRun = async (env: Record<string, string>) => {
    const home = await mkdtemp(join(tmpdir(), "fork-kosis-cases-"));
    const said: string[] = [];
    const sent: string[] = [];
    try {
      const status = await record({
        argv: ["--dry-run", "--only", "kosis"],
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
    const { status, said, sent } = await dryRun({ KOSIS_API_KEY: KOSIS_KEY });
    expect(status).toBe(0);
    expect(sent).toEqual([]);
    expect(said.map((line) => line.split(" ")[0])).toEqual([
      "kosis/data-dt-1f02011-t10-e-202505.json",
      "kosis/data-dt-1f02011-t11-e-202505.json",
      "kosis/data-dt-1f02011-t12-e-202505.json",
      "kosis/search-unemployment.json",
      "kosis/meta-dt-1da7102s.json",
      "kosis/data-dt-1da7102s-t80-0-00-202505.json",
      "kosis/error-30.json",
    ]);
    expect(said[0]).toBe(
      "kosis/data-dt-1f02011-t10-e-202505.json and kosis/data-dt-1f02011-t10-e-202505.meta.json <- https://kosis.kr/openapi/Param/statisticsParameterData.do?method=getList&orgId=101&tblId=DT_1F02011&itmId=T10&objL1=E&prdSe=M&startPrdDe=202505&endPrdDe=202611&apiKey=***&format=json&jsonVD=Y",
    );
    expect(said.join("\n")).not.toContain(KOSIS_KEY);
  });

  test("without KOSIS_API_KEY no case has an address, so none would be sent", async () => {
    const { said, sent } = await dryRun({});
    expect(sent).toEqual([]);
    expect(said).toHaveLength(7);
    expect(said.every((line) => line.endsWith("<- KOSIS_API_KEY is not set"))).toBe(true);
  });

  test("each fixture the tests' routes serve is one a case records", async () => {
    const { said } = await dryRun({ KOSIS_API_KEY: KOSIS_KEY });
    const named = said.map((line) => line.split(" ")[0]);
    for (const route of KOSIS_ROUTES) expect(named, route.file).toContain(route.file as string);
  });
});
