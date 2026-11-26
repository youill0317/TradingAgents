// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The ECB's data in the fork (src/fork/data/sources/ecb.ts, providers/ecb.ts and the key interest rates in
 * providers/statistics.ts), on the ECB's own answers saved earlier (test/fork/fixtures/ecb): its CSV answers
 * read by column name (util/csv.ts, tested in csv.test.ts); euro reference rates through the real price_history
 * tool for an fx: key (a pair against the euro, its inverse, a cross through the euro, an earlier page), its
 * text compared whole and every field it reads supplied; a currency the ECB stopped quoting and one it never
 * quoted; the key interest rates through macro_series as the dates they changed, read back window by window;
 * and the failures, each with the kind the router acts on. No request reaches the network.
 */
import { describe, expect, test } from "bun:test";
import { addDays } from "../../../src/contracts/index.js";
import type { ReferenceRates } from "../../../src/data/capabilities.js";
import { DataError } from "../../../src/data/errors.js";
import { ecbProvider } from "../../../src/fork/data/providers/ecb.js";
import { statisticsProvider } from "../../../src/fork/data/providers/statistics.js";
import {
  exchangeRatesUrl,
  joinRuns,
  parseExchangeRates,
  parsePolicyDays,
  policyRateUrl,
  rateRuns,
} from "../../../src/fork/data/sources/ecb.js";
import { buildTools, type FixtureRoute, fixture, testDeps, testProviders } from "./harness.js";

const DATA = "https://data-api.ecb.europa.eu/service/data";
const csv = { "content-type": "text/csv" };

/** The ECB's reference rates of `key` ("USD", "KRW+USD") for a window `when` accepts. */
function exr(key: string, answer: Omit<FixtureRoute, "match">, when: (url: URL) => boolean = () => true) {
  return {
    match: (url: URL) => url.pathname === `/service/data/EXR/D.${key}.EUR.SP00.A` && when(url),
    ...("file" in answer ? {} : { headers: csv }),
    ...answer,
  } satisfies FixtureRoute;
}

/** The ECB's days of key interest rate `rate` from `from` (to `to`, when given). */
function fm(rate: string, from: string, to: string | undefined, answer: Omit<FixtureRoute, "match">) {
  return {
    match: (url: URL) =>
      url.pathname === `/service/data/FM/D.U2.EUR.4F.KR.${rate}.LEV` &&
      url.searchParams.get("startPeriod") === from &&
      url.searchParams.get("endPeriod") === (to ?? null),
    ...("file" in answer ? {} : { headers: csv }),
    ...answer,
  } satisfies FixtureRoute;
}

const startsOn = (date: string) => (url: URL) => url.searchParams.get("startPeriod") === date;

const SAVED: readonly FixtureRoute[] = [
  // The saved five days of USD (a full-detail answer) are the 5-day window ending 2026-11-25.
  exr("USD", { file: "ecb/exr-usd-last5.csv" }, startsOn("2026-11-19")),
  exr("USD", { file: "ecb/exr-usd-end-last5.csv" }, startsOn("2026-10-25")),
  exr("KRW+USD", { file: "ecb/exr-krw-usd-2026-11.csv" }),
  exr("KRW", { file: "ecb/exr-krw-2026-11.csv" }),
  fm("DFR", "2024-01-01", undefined, { file: "ecb/fm-dfr-since2024.csv" }),
];

/** The ECB and statistics providers alone over `routes` (then the saved answers), their tools, what they asked. */
function ecb(routes: readonly FixtureRoute[] = []) {
  const { deps, fetch } = testDeps({}, [...routes, ...SAVED]);
  const provider = ecbProvider(deps);
  const tools = buildTools({ ecb: provider, statistics: statisticsProvider(deps) }, { check: true });
  return { ...tools, provider, fetch, asked: () => fetch.requests.map((request) => request.url) };
}

const text = (file: string) => new TextDecoder().decode(fixture(file));

/** The DataError `promise` rejects with. */
async function failure(promise: Promise<unknown> | undefined): Promise<DataError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error("it answered");
}

/**
 * A hand-made FM answer in the ECB's documented `detail=dataonly` form: a row for every calendar day from `from`
 * to `to`, each the rate in effect (`level`, then each change from its date), as the ECB's own answers are.
 */
function fmDays(
  rate: string,
  from: string,
  to: string,
  level: number,
  changes: [string, number][] = [],
): string {
  const lines = [
    "KEY,FREQ,REF_AREA,CURRENCY,PROVIDER_FM,INSTRUMENT_FM,PROVIDER_FM_ID,DATA_TYPE_FM,TIME_PERIOD,OBS_VALUE",
  ];
  let value = level;
  let next = 0;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    while (next < changes.length && (changes[next] as [string, number])[0] <= day) {
      value = (changes[next] as [string, number])[1];
      next++;
    }
    lines.push(`FM.D.U2.EUR.4F.KR.${rate}.LEV,D,U2,EUR,4F,KR,${rate},LEV,${day},${value}`);
  }
  return `${lines.join("\r\n")}\r\n`;
}

describe("reading the ECB's answers", () => {
  test("reference rates: a dataonly answer and a full one read alike; an empty body has none", () => {
    expect(parseExchangeRates(text("ecb/exr-krw-usd-2026-11.csv")).slice(0, 2)).toEqual([
      { currency: "KRW", date: "2026-11-16", value: 1470.23 },
      { currency: "KRW", date: "2026-11-17", value: 1468.36 },
    ]);
    expect(parseExchangeRates(text("ecb/exr-usd-last5.csv")).at(-1)).toEqual({
      currency: "USD",
      date: "2026-11-25",
      value: 1.0935,
    });
    expect(parseExchangeRates("")).toEqual([]);
    expect(() => parseExchangeRates("<html>busy</html>")).toThrow(
      "ECB answered reference rates in a form this app does not read.",
    );
  });

  test("key interest rates: a calendar day's row each, read as the runs between changes", () => {
    const days = parsePolicyDays(text("ecb/fm-dfr-since2024.csv"), "DFR");
    expect(days).toHaveLength(1060);
    expect(rateRuns(days)).toEqual([
      { date: "2024-01-01", through: "2024-06-11", value: 4 },
      { date: "2024-06-12", through: "2024-09-17", value: 3.75 },
      { date: "2024-09-18", through: "2024-10-22", value: 3.5 },
      { date: "2024-10-23", through: "2024-12-17", value: 3.25 },
      { date: "2024-12-18", through: "2025-02-04", value: 3 },
      { date: "2025-02-05", through: "2025-03-11", value: 2.75 },
      { date: "2025-03-12", through: "2025-04-22", value: 2.5 },
      { date: "2025-04-23", through: "2025-06-10", value: 2.25 },
      { date: "2025-06-11", through: "2026-06-16", value: 2 },
      { date: "2026-06-17", through: "2026-09-15", value: 2.25 },
      { date: "2026-09-16", through: "2026-11-25", value: 2.5 },
    ]);
  });

  test("a full answer for three rates is read for the one asked; a missing day ends a run, and runs join across windows", () => {
    const mrr = parsePolicyDays(text("ecb/fm-policy-last3.csv"), "MRR_FR");
    expect(rateRuns(mrr)).toEqual([{ date: "2026-11-23", through: "2026-11-25", value: 2.65 }]);
    // The fixed rate was not set from mid-2000 to late 2008: days missing end the run before them.
    const gap = rateRuns([
      { date: "2000-06-26", value: 4.25 },
      { date: "2000-06-27", value: 4.25 },
      { date: "2008-10-15", value: 3.75 },
      { date: "2008-10-16", value: null },
      { date: "2008-10-17", value: 3.75 },
    ]);
    expect(gap.map((run) => [run.date, run.through])).toEqual([
      ["2000-06-26", "2000-06-27"],
      ["2008-10-15", "2008-10-15"],
      ["2008-10-17", "2008-10-17"],
    ]);
    expect(
      joinRuns([
        [{ date: "2023-09-20", through: "2023-12-31", value: 4 }],
        [
          { date: "2024-01-01", through: "2024-06-11", value: 4 },
          { date: "2024-06-12", through: "2024-09-17", value: 3.75 },
        ],
      ]),
    ).toEqual([
      { date: "2023-09-20", through: "2024-06-11", value: 4 },
      { date: "2024-06-12", through: "2024-09-17", value: 3.75 },
    ]);
  });

  test("the addresses", () => {
    expect(exchangeRatesUrl(["KRW", "USD"], { from: "2026-11-19", to: "2026-11-25" })).toBe(
      `${DATA}/EXR/D.KRW+USD.EUR.SP00.A?format=csvdata&detail=dataonly&startPeriod=2026-11-19&endPeriod=2026-11-25`,
    );
    expect(policyRateUrl("DFR", { from: "2016-01-01", to: "2023-12-31" })).toBe(
      `${DATA}/FM/D.U2.EUR.4F.KR.DFR.LEV?format=csvdata&detail=dataonly&startPeriod=2016-01-01&endPeriod=2023-12-31`,
    );
  });
});

describe("price_history for a currency pair: the ECB's reference rates", () => {
  test("EUR/USD as published, every field read supplied", async () => {
    const { runTool, asked } = ecb();
    const run = await runTool("price_history", { symbol: "fx:EURUSD", period: "5d" });
    expect(run.failure).toBeUndefined();
    expect(run.text).toBe(GOLDEN.eurusd);
    expect(run.reads.missing()).toEqual([]);
    expect(asked()).toEqual([
      `${DATA}/EXR/D.USD.EUR.SP00.A?format=csvdata&detail=dataonly&startPeriod=2026-11-19&endPeriod=2026-11-25`,
    ]);
  });

  test("USD/KRW: a cross through the euro from one request, said in its basis", async () => {
    const { runTool, asked } = ecb();
    const run = await runTool("price_history", { symbol: "fx:USDKRW", period: "5d" });
    expect(run.text).toBe(GOLDEN.usdkrw);
    expect(run.reads.missing()).toEqual([]);
    expect(asked()).toHaveLength(1);
    // 2026-11-25: 1471.19 KRW per EUR / 1.0935 USD per EUR.
    expect((run.payload as { rates: number[] }).rates.at(-1)).toBe(Number((1471.19 / 1.0935).toPrecision(6)));
  });

  test("USD/EUR: the inverse of the published rate", async () => {
    const { runTool } = ecb();
    const run = await runTool("price_history", { symbol: "fx:USDEUR", period: "5d" });
    expect(run.text).toBe(GOLDEN.usdeur);
  });

  test("an earlier page, and the euro's first day ending the paging", async () => {
    const { runTool, provider } = ecb([
      exr(
        "USD",
        { body: text("ecb/exr-usd-end-last5.csv").replace(/2026-10-(\d\d)/g, "1999-01-$1") },
        startsOn("1998-12-01"),
      ),
    ]);
    const run = await runTool("price_history", { symbol: "fx:EURUSD", period: "5d", end: "2026-10-31" });
    expect(run.text).toBe(GOLDEN.earlier);
    const first = (await provider.capabilities.priceHistory?.referenceRates?.("fx:EURUSD", {
      from: "1998-12-01",
      to: "1999-01-31",
    })) as ReferenceRates;
    // The window opens before the first rate: it is the series' start, so there is no earlier page.
    expect([first.rates[0]?.date, first.complete, first.earlier_end]).toEqual(["1999-01-26", false, null]);
  });

  test("a full-detail answer serves a window too, its rates as published", async () => {
    const { provider } = ecb();
    const won = (await provider.capabilities.priceHistory?.referenceRates?.("fx:EURKRW", {
      from: "2026-11-01",
      to: "2026-11-25",
    })) as ReferenceRates;
    expect(won.rates).toHaveLength(18);
    expect(won.rates[0]).toEqual({ date: "2026-11-02", value: 1506.2 });
    expect([won.basis, won.complete, won.earlier_end]).toEqual([
      "ECB euro reference rates (set daily at 14:15 CET), KRW per EUR",
      true,
      "2026-10-31",
    ]);
  });

  test("through every fork provider, a pair's rates come from the ECB: Yahoo serves no reference rates", async () => {
    const { providers, clock, fetch } = testProviders({}, SAVED);
    const { runTool } = buildTools(providers, { clock });
    const run = await runTool("price_history", { symbol: "fx:EURUSD", period: "5d" });
    expect(run.source).toBe("ECB");
    expect(fetch.requests.map((request) => new URL(request.url).hostname)).toEqual([
      "data-api.ecb.europa.eu",
    ]);
  });
});

describe("currencies the ECB does not quote now", () => {
  test("one it stopped quoting: its rates up to its last one, said to be discontinued; after it, no data unasked", async () => {
    const rouble = [
      "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
      "EXR.D.RUB.EUR.SP00.A,D,RUB,EUR,SP00,A,2022-02-28,108.68",
      "EXR.D.RUB.EUR.SP00.A,D,RUB,EUR,SP00,A,2022-03-01,117.201",
    ].join("\r\n");
    const { runTool, asked } = ecb([exr("RUB", { body: rouble })]);
    const ended = await runTool("price_history", { symbol: "fx:EURRUB", period: "5d", end: "2022-03-02" });
    expect(ended.failure).toBeUndefined();
    expect(ended.payload).toMatchObject({
      instrument: "EUR/RUB (fx:EURRUB, RUB; discontinued since 2022-03-01)",
      complete: false,
      dates: ["2022-02-28", "2022-03-01"],
      rates: [108.68, 117.201],
    });
    const after = await runTool("price_history", { symbol: "fx:EURRUB", period: "5d" });
    expect(after.failure).toBe("data_no_data");
    expect(after.text).toBe(
      "ECB has no data for this request: the ECB's last RUB reference rate was on 2022-03-01; ask for dates on or before it",
    );
    expect(asked()).toHaveLength(1);
  });

  test("one it never quoted: unsupported, naming those it does, unasked; a pair of one currency is invalid", async () => {
    const { runTool, asked } = ecb();
    const run = await runTool("price_history", { symbol: "fx:USDVND", period: "5d" });
    expect(run.failure).toBe("data_unsupported");
    expect(run.text).toBe(
      "ECB does not cover this request (the ECB sets no euro reference rate for VND; it sets one for AUD, BRL, CAD, CHF, CNY, CZK, DKK, GBP, HKD, HUF, IDR, ILS, INR, ISK, JPY, KRW, MXN, MYR, NOK, NZD, PHP, PLN, RON, SEK, SGD, THB, TRY, USD, ZAR); this is not a fact about the market.",
    );
    const same = await runTool("price_history", { symbol: "fx:EUREUR", period: "5d" });
    expect(same.failure).toBe("data_invalid");
    expect(same.text).toBe(
      "ECB cannot answer this request as asked: fx:EUREUR: a pair of one currency with itself",
    );
    expect(asked()).toEqual([]);
  });
});

describe("failures of the reference rates", () => {
  test("a window without a publication day (an empty body) and a key the ECB does not know (its 404): no data", async () => {
    const { provider } = ecb([
      exr("USD", { body: "" }, startsOn("2026-11-21")),
      exr("CNY", { file: "ecb/exr-xxx-nodata.json" }),
    ]);
    const weekend = await failure(
      provider.capabilities.priceHistory?.referenceRates?.("fx:EURUSD", {
        from: "2026-11-21",
        to: "2026-11-22",
      }),
    );
    expect([weekend.kind, weekend.message]).toEqual([
      "no_data",
      "the ECB set no EUR/USD reference rate from 2026-11-21 to 2026-11-22",
    ]);
    const unknown = await failure(
      provider.capabilities.priceHistory?.referenceRates?.("fx:EURCNY", {
        from: "2026-11-19",
        to: "2026-11-25",
      }),
    );
    expect([unknown.kind, unknown.message, unknown.details.status]).toEqual([
      "no_data",
      "the ECB has no CNY euro reference rate from 2026-11-19 to 2026-11-25",
      404,
    ]);
  });

  test("the ECB failing twice, or answering something that is not its CSV: unavailable", async () => {
    for (const answer of [{ body: "busy", status: 503 }, { body: "<html>maintenance</html>" }]) {
      const { runTool } = ecb([exr("USD", answer)]);
      const run = await runTool("price_history", { symbol: "fx:EURUSD", period: "5d" });
      expect(run.failure).toBe("data_unavailable");
    }
  });
});

describe("macro_series on the ECB's key interest rates: the dates they changed", () => {
  test("the deposit facility rate: each change from the day it took effect, the current one to the latest day", async () => {
    const { runTool, asked } = ecb();
    const run = await runTool("macro_series", { series: "ECB deposit facility rate", periods: 4 });
    expect(run.failure).toBeUndefined();
    expect(run.text).toBe(GOLDEN.dfr);
    expect(run.reads.missing()).toEqual([]);
    expect(asked()).toEqual([
      `${DATA}/FM/D.U2.EUR.4F.KR.DFR.LEV?format=csvdata&detail=dataonly&startPeriod=2024-01-01`,
    ]);
  });

  test("more changes than the newest window holds: the windows before are read, a run across their edge joined", async () => {
    // Hand-made in the ECB's dataonly form: the deposit facility rate's days of 2016-2023 at the levels the ECB
    // set, as its own answers carry them (a row for every calendar day).
    const before = fmDays("DFR", "2016-01-01", "2023-12-31", -0.3, [
      ["2016-03-16", -0.4],
      ["2019-09-18", -0.5],
      ["2022-07-27", 0],
      ["2022-09-14", 0.75],
      ["2022-11-02", 1.5],
      ["2022-12-21", 2],
      ["2023-02-08", 2.5],
      ["2023-03-22", 3],
      ["2023-05-10", 3.25],
      ["2023-06-21", 3.5],
      ["2023-08-02", 3.75],
      ["2023-09-20", 4],
    ]);
    // The oldest window, hand-made too, with illustrative levels: the ECB's own answer holds every change between.
    const oldest = fmDays("DFR", "1999-01-01", "2015-12-31", 2, [
      ["1999-01-04", 2.75],
      ["1999-01-22", 2],
      ["2015-12-09", -0.3],
    ]);
    const { runTool, asked } = ecb([
      fm("DFR", "2016-01-01", "2023-12-31", { body: before }),
      fm("DFR", "1999-01-01", "2015-12-31", { body: oldest }),
    ]);
    const run = await runTool("macro_series", { series: "ea.ecb.dfr" });
    const periods = (run.payload as { periods: { label: string; value: number; evidence: string }[] })
      .periods;
    expect(periods).toHaveLength(13);
    expect(periods.slice(0, 4)).toEqual([
      expect.objectContaining({ label: "2023-06-21", value: 3.5, evidence: "in effect to 2023-08-01" }),
      expect.objectContaining({ label: "2023-08-02", value: 3.75 }),
      // Read in two windows, one run.
      expect.objectContaining({ label: "2023-09-20", value: 4, evidence: "in effect to 2024-06-11" }),
      expect.objectContaining({ label: "2024-06-12", value: 3.75 }),
    ]);
    expect(run.payload).toMatchObject({ continue_end: "2023-06-20" });
    expect(asked()).toHaveLength(2);
    // Paging back to the oldest window, and to the series' first day: its first level is an observation, and
    // there is no page before it.
    const older = await runTool("macro_series", { series: "ea.ecb.dfr", periods: 3, end: "2016-03-15" });
    expect(older.payload).toMatchObject({
      periods: [
        { label: "1999-01-04", value: 2.75, evidence: "in effect to 1999-01-21" },
        { label: "1999-01-22", value: 2 },
        { label: "2015-12-09", value: -0.3, evidence: "in effect to 2016-03-15" },
      ],
      continue_end: "1999-01-03",
    });
    const start = await runTool("macro_series", { series: "ea.ecb.dfr", periods: 3, end: "1999-01-03" });
    expect(start.payload).toMatchObject({
      periods: [{ label: "1999-01-01", value: 2, evidence: "in effect to 1999-01-03" }],
      continue_end: null,
    });
    expect(asked()).toHaveLength(3);
  });

  test("a window the ECB has no series for (its 404) is a window without rows; the ECB failing is unavailable", async () => {
    const { runTool } = ecb([
      fm("DFR", "2016-01-01", "2023-12-31", { file: "ecb/exr-xxx-nodata.json" }),
      fm("DFR", "1999-01-01", "2015-12-31", { body: "" }),
      fm("MLFR", "2024-01-01", undefined, { body: "busy", status: 503 }),
    ]);
    const run = await runTool("macro_series", { series: "ea.ecb.dfr", periods: 13 });
    expect(run.failure).toBeUndefined();
    expect((run.payload as { periods: unknown[] }).periods).toHaveLength(10);
    const failed = await runTool("macro_series", { series: "ECB marginal lending facility rate" });
    expect(failed.failure).toBe("data_unavailable");
    expect(failed.text).toBe(
      "ECB could not be reached or answered unreadably; this is not a fact about the market. ECB answered HTTP 503.",
    );
  });
});

const GOLDEN = {
  eurusd: `[e1] price_history fx:EURUSD 5d (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: ECB
pair: fx:EURUSD
instrument: EUR/USD (fx:EURUSD, USD)
basis: ECB euro reference rates (set daily at 14:15 CET), USD per EUR
from: 2026-11-19
through: 2026-11-25
complete: true
notes:
- These are reference rates set once a day, not market prices: there is no open, high, low or volume, and they are not closes.
- change over these days: -0.52% (1.0992 on 2026-11-19 to 1.0935 on 2026-11-25)
earlier: price_history with end=2026-11-18, period=5d
dates,rates
2026-11-19,1.0992
2026-11-20,1.099
2026-11-23,1.0939
2026-11-24,1.0963
2026-11-25,1.0935`,
  usdkrw: `[e1] price_history fx:USDKRW 5d (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: ECB
pair: fx:USDKRW
instrument: USD/KRW (fx:USDKRW, KRW)
basis: ECB euro reference rates (set daily at 14:15 CET), KRW per USD; cross through EUR (derived): KRW per EUR divided by USD per EUR, to 6 significant digits
from: 2026-11-19
through: 2026-11-25
complete: true
notes:
- These are reference rates set once a day, not market prices: there is no open, high, low or volume, and they are not closes.
- change over these days: 1.28% (1328.45 on 2026-11-19 to 1345.4 on 2026-11-25)
earlier: price_history with end=2026-11-18, period=5d
dates,rates
2026-11-19,1328.45
2026-11-20,1339.44
2026-11-23,1348.85
2026-11-24,1344.51
2026-11-25,1345.4`,
  usdeur: `[e1] price_history fx:USDEUR 5d (as of Wednesday 2026-11-25; reference its data as {"ref":"e1","path":"<field>"})
source: ECB
pair: fx:USDEUR
instrument: USD/EUR (fx:USDEUR, EUR)
basis: ECB euro reference rates (set daily at 14:15 CET), EUR per USD: the inverse of the published USD per EUR, to 6 significant digits
from: 2026-11-19
through: 2026-11-25
complete: true
notes:
- These are reference rates set once a day, not market prices: there is no open, high, low or volume, and they are not closes.
- change over these days: 0.52% (0.909753 on 2026-11-19 to 0.914495 on 2026-11-25)
earlier: price_history with end=2026-11-18, period=5d
dates,rates
2026-11-19,0.909753
2026-11-20,0.909918
2026-11-23,0.91416
2026-11-24,0.912159
2026-11-25,0.914495`,
  earlier: `[e1] price_history fx:EURUSD 5d Oct 31 (as of Friday 2026-10-30; reference its data as {"ref":"e1","path":"<field>"})
source: ECB
pair: fx:EURUSD
instrument: EUR/USD (fx:EURUSD, USD)
basis: ECB euro reference rates (set daily at 14:15 CET), USD per EUR
from: 2026-10-26
through: 2026-10-30
complete: true
notes:
- These are reference rates set once a day, not market prices: there is no open, high, low or volume, and they are not closes.
- change over these days: -0.14% (1.1188 on 2026-10-26 to 1.1172 on 2026-10-30)
earlier: price_history with end=2026-10-24, period=5d
dates,rates
2026-10-26,1.1188
2026-10-27,1.115
2026-10-28,1.1133
2026-10-29,1.113
2026-10-30,1.1172`,
  dfr: `[e1] macro_series ECB deposit facility rate (as of Wednesday 2026-09-16; reference its data as {"ref":"e1","path":"<field>"})
source: Public statistics
ECB deposit facility rate (key ea.ecb.dfr), percent a year, at each change (the date it took effect)
Latest: 2.5 for 2026-09-16; change from the period before: +0.25 percentage points (from 2.25 in 2026-06-17); change from a year earlier: not available (that period is not in this answer)
periods, newest first:
2026-09-16: 2.5 (in effect on 2026-11-25, the latest day published)
2026-06-17: 2.25 (in effect to 2026-09-15)
2025-06-11: 2 (in effect to 2026-06-16)
2025-04-23: 2.25 (in effect to 2025-06-10)
earlier periods: macro_series with series=ea.ecb.dfr, end=2025-04-22`,
};
