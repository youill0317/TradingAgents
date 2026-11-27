// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * central_banks with the Bank of Korea (src/fork/data/providers/markets.ts), through the markets tool, the router
 * and the ToolRegistry: with ECOS_API_KEY its base rate from ECOS, with the day it took effect and the rate before
 * it as the ECB's rows give theirs (golden text, every field the tool and the specs read supplied); without the
 * key the view as before, with nothing asked of ECOS; ECOS failing leaves out the Bank of Korea's row alone, with
 * ECOS's reason; a rate unchanged over the days read says since when at least. The ECOS answer is hand-made in its
 * documented JSON (test/fork/fixtures/markets/ecos-722y001-d-since2024.json); no request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import { BOK_BASE_RATE } from "../../../src/fork/data/catalog/markets.js";
import { catalogSeries } from "../../../src/fork/data/catalog/series.js";
import { buildTools, expectKeys, type FixtureRoute, readLog, testProviders } from "./harness.js";
import { marketsFetch, VIEW_KEYS } from "./markets-routes.test.js";
import { BOK_ROUTE, ECOS_KEY, ECOS_ROUTES, ecosPath } from "./statistics-korea-routes.test.js";

type Payload = {
  rows: Record<string, unknown>[];
  missing: { key: string; reason?: string | null }[];
  coverage: { requested: number | null; measured: number | null; byReason: unknown[] } | null;
};

/** The fork's providers over the market views' fixtures and the Bank of Korea's, and the tools over them. */
function setup(
  config: { ecosKey?: string } = { ecosKey: ECOS_KEY },
  routes: readonly FixtureRoute[] = [BOK_ROUTE],
) {
  const fetch = marketsFetch({ routes: [...routes, ...ECOS_ROUTES] });
  const { providers, clock } = testProviders(config, fetch);
  return { ...buildTools(providers, { clock, check: true }), fetch };
}

const SINCE_2024 = ecosPath("StatisticSearch", "kr/1/1000/722Y001/D/20240101/20261125/0101000");

/** An ECOS answer for the base rate since 2024 written inline (hand-made, in ECOS's documented JSON). */
const ecosAnswer = (body: unknown): FixtureRoute => ({
  match: SINCE_2024,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json;charset=UTF-8" },
});

const isEcos = (url: string) => new URL(url).hostname === "ecos.bok.or.kr";

describe("central_banks with ECOS_API_KEY", () => {
  test("the Bank of Korea's base rate, the day it took effect and the rate before it, after the other banks", async () => {
    const { runTool, fetch } = setup();
    const run = await runTool("markets", { view: "central_banks" });
    expect(run.failure, run.text).toBeUndefined();
    expect(run.text).toBe(GOLDEN);
    expect(run.reads.missing()).toEqual([]);
    const payload = run.payload as Payload;
    const log = readLog();
    expectKeys(payload, VIEW_KEYS.central_banks, log);
    expect(log.missing()).toEqual([]);
    expect(payload.coverage?.requested).toBe(7);
    expect(payload.rows.at(-1)).toEqual({
      bank: "Bank of Korea",
      rate: "base rate",
      key: "series:kr.ecos.722y001.0101000",
      unit: { kind: "percent" },
      latest: { value: 2.5, date: "2026-11-25", in_effect_since: "2025-05-29" },
      previous: { value: 2.75, until: "2025-05-28" },
      change: { absolute: -0.25, percent: null, absolute_unit: { kind: "percentage_points" } },
      source: "Bank of Korea ECOS",
    });
    expect(fetch.requests.filter((request) => isEcos(request.url))).toHaveLength(1);
    expect(fetch.unmatched).toEqual([]);
    expect(JSON.stringify([run.text, run.payload, run.provenance])).not.toContain(ECOS_KEY);
  });

  test("the row's key is the ECOS series macro_series reads, without a search", async () => {
    const entry = catalogSeries(BOK_BASE_RATE.key);
    expect(entry?.origin).toEqual({ publisher: "ecos", stat: "722Y001", items: ["0101000"], cycle: "D" });
    const { runTool } = setup();
    const read = await runTool("macro_series", { series: `series:${BOK_BASE_RATE.key}` });
    expect(read.failure, read.text).toBeUndefined();
    expect((read.payload as { key: string }).key).toBe(BOK_BASE_RATE.key);
  });

  test("a rate unchanged over every day read: unchanged since at least the first of them", async () => {
    const days = ["20240102", "20240103", "20261124", "20261125"];
    const { runTool } = setup({ ecosKey: ECOS_KEY }, [
      ecosAnswer({
        StatisticSearch: {
          list_total_count: days.length,
          row: days.map((time) => ({
            STAT_CODE: "722Y001",
            STAT_NAME: "1.3.1. 한국은행 기준금리 및 여수신금리",
            ITEM_CODE1: "0101000",
            ITEM_NAME1: "한국은행 기준금리",
            UNIT_NAME: "연%",
            TIME: time,
            DATA_VALUE: "2.5",
          })),
        },
      }),
    ]);
    const row = ((await runTool("markets", { view: "central_banks" })).payload as Payload).rows.at(-1);
    expect(row).toMatchObject({
      bank: "Bank of Korea",
      latest: {
        value: 2.5,
        date: "2026-11-25",
        in_effect_since: null,
        unchanged_since_at_least: "2024-01-02",
      },
      previous: null,
      change: { absolute: null, percent: null },
    });
  });

  test("ECOS failing leaves out the Bank of Korea's row alone, with ECOS's reason", async () => {
    for (const [answer, reason] of [
      [
        ecosAnswer({ RESULT: { CODE: "INFO-100", MESSAGE: "인증키가 유효하지 않습니다." } }),
        "Bank of Korea ECOS refused ECOS_API_KEY (INFO-100: 인증키가 유효하지 않습니다). A free key comes from https://ecos.bok.or.kr/api/.",
      ],
      [
        ecosAnswer({ RESULT: { CODE: "ERROR-602", MESSAGE: "과도한 OpenAPI호출로 이용이 제한되었습니다." } }),
        "Bank of Korea ECOS is limiting calls (ERROR-602: 과도한 OpenAPI호출로 이용이 제한되었습니다).",
      ],
      [
        { match: SINCE_2024, body: "error", status: 503 } as FixtureRoute,
        "Bank of Korea ECOS answered HTTP 503.",
      ],
      [
        ecosAnswer({ RESULT: { CODE: "INFO-200", MESSAGE: "해당하는 데이터가 없습니다." } }),
        "the Bank of Korea's ECOS published no base rate since 2024-01-01",
      ],
    ] as const) {
      const { runTool } = setup({ ecosKey: ECOS_KEY }, [answer]);
      const run = await runTool("markets", { view: "central_banks" });
      expect(run.failure, run.text).toBeUndefined();
      const payload = run.payload as Payload;
      expect(payload.rows.map((row) => row.bank)).toEqual([
        "Federal Reserve",
        "European Central Bank",
        "European Central Bank",
        "European Central Bank",
        "Bank of Japan",
        "Reserve Bank of India",
      ]);
      expect(payload.missing).toEqual([{ key: "series:kr.ecos.722y001.0101000", reason: null }]);
      expect(payload.coverage).toEqual({ requested: 7, measured: 6, byReason: [{ reason, count: 1 }] });
    }
  });
});

describe("central_banks without ECOS_API_KEY", () => {
  test("the view as before: no Bank of Korea row, nothing asked of ECOS", async () => {
    const { runTool, fetch } = setup({}, []);
    const run = await runTool("markets", { view: "central_banks" });
    expect(run.failure, run.text).toBeUndefined();
    const payload = run.payload as Payload;
    expect(payload.rows.map((row) => row.bank)).not.toContain("Bank of Korea");
    expect(payload.missing).toEqual([]);
    expect(payload.coverage?.requested).toBe(6);
    expect(run.text).toBe(GOLDEN.split("\n").slice(0, -1).join("\n"));
    expect(fetch.requests.filter((request) => isEcos(request.url))).toEqual([]);
  });
});

/** The view as the model reads it on the fixtures of 2026-11-25 (TEST_DAY), with ECOS_API_KEY. */
const GOLDEN = `[e1] markets central_banks (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: Market overview
central banks, through 2026-11-25
{"bank":"Federal Reserve","rate":"federal funds rate","key":"series:us.nyfed.effr","unit":{"kind":"percent"},"target_range":{"from":3.75,"to":4,"date":"2026-11-24"},"latest":{"value":3.88,"date":"2026-11-24","measure":"effective federal funds rate (EFFR)"},"source":"New York Fed"}
{"bank":"European Central Bank","rate":"deposit facility rate","key":"series:ea.ecb.dfr","unit":{"kind":"percent"},"latest":{"value":2.5,"date":"2026-11-25","in_effect_since":"2026-09-16"},"previous":{"value":2.25,"until":"2026-09-15"},"change":{"absolute":0.25,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"ECB"}
{"bank":"European Central Bank","rate":"main refinancing operations rate","key":"series:ea.ecb.mrr_fr","unit":{"kind":"percent"},"latest":{"value":2.65,"date":"2026-11-25","in_effect_since":"2026-09-16"},"previous":{"value":2.4,"until":"2026-09-15"},"change":{"absolute":0.25,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"ECB"}
{"bank":"European Central Bank","rate":"marginal lending facility rate","key":"series:ea.ecb.mlfr","unit":{"kind":"percent"},"latest":{"value":2.9,"date":"2026-11-25","in_effect_since":"2026-09-16"},"previous":{"value":2.65,"until":"2026-09-15"},"change":{"absolute":0.25,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"ECB"}
{"bank":"Bank of Japan","rate":"central bank rate (immediate rates, less than 24 hours; OECD Main Economic Indicators)","key":"series:us.fred.irstcb01jpm156n","unit":{"kind":"percent"},"frequency":"monthly","latest":{"period":"2026-09","date":"2026-09-01","value":0.75,"known_from":null},"previous":{"period":"2026-08","date":"2026-08-01","value":0.75},"change":{"absolute":0,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"FRED"}
{"bank":"Reserve Bank of India","rate":"central bank rate (immediate rates, less than 24 hours; OECD Main Economic Indicators)","key":"series:us.fred.irstcb01inm156n","unit":{"kind":"percent"},"frequency":"monthly","latest":{"period":"2026-09","date":"2026-09-01","value":5.25,"known_from":null},"previous":{"period":"2026-08","date":"2026-08-01","value":5.25},"change":{"absolute":0,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"FRED"}
{"bank":"Bank of Korea","rate":"base rate","key":"series:kr.ecos.722y001.0101000","unit":{"kind":"percent"},"latest":{"value":2.5,"date":"2026-11-25","in_effect_since":"2025-05-29"},"previous":{"value":2.75,"until":"2025-05-28"},"change":{"absolute":-0.25,"percent":null,"absolute_unit":{"kind":"percentage_points"}},"source":"Bank of Korea ECOS"}`;
