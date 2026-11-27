// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The technicals capability's computations (src/fork/data/compute/technicals.ts), offline: the indicators
 * computed here (KDJ, CCI, the z-score, MFI, VWMA, PVO) against values worked by hand or by a plain second
 * computation, and the whole answer from daily bars: all 22 indicators on the tool's definitions, upstream's
 * averages checked against plain means, a short history said field by field, no volume, missing ranges.
 */
import { describe, expect, test } from "bun:test";
import { INDICATORS } from "../../../src/data/capabilities.js";
import {
  cci,
  type IndicatorBar,
  kdj,
  mfi,
  NEEDS,
  pvo,
  ROWS_NEEDED,
  technicalsOf,
  vwma,
  zScore,
} from "../../../src/fork/data/compute/technicals.js";
import { fixture } from "./harness.js";

const close = (a: number | null | undefined, b: number, digits = 9) => {
  expect(a).not.toBeNull();
  expect(a as number).toBeCloseTo(b, digits);
};

/** The plain mean of the last `n` values. */
const mean = (values: readonly number[], n: number) =>
  values.slice(-n).reduce((sum, value) => sum + value, 0) / n;

/** An EMA seeded with the mean of its first `n` values, as TA-Lib (and upstream) seed it. */
function plainEma(values: readonly number[], n: number): number {
  let level = mean(values.slice(0, n), n);
  for (const value of values.slice(n)) level += (value - level) * (2 / (n + 1));
  return level;
}

/** AAPL's daily bars from the hand-made fixture, adjusted by Yahoo's adjusted close, the gap left out. */
function aaplBars(): IndicatorBar[] {
  const answer = JSON.parse(new TextDecoder().decode(fixture("yahoo/chart-aapl-1d-600.json"))) as {
    chart: {
      result: {
        timestamp: number[];
        indicators: {
          quote: {
            open: (number | null)[];
            high: (number | null)[];
            low: (number | null)[];
            close: (number | null)[];
            volume: (number | null)[];
          }[];
          adjclose: { adjclose: (number | null)[] }[];
        };
      }[];
    };
  };
  const [result] = answer.chart.result;
  const quote = result?.indicators.quote[0];
  const adjusted = result?.indicators.adjclose[0]?.adjclose ?? [];
  const bars: IndicatorBar[] = [];
  result?.timestamp.forEach((seconds, i) => {
    const raw = quote?.close[i];
    const adj = adjusted[i];
    if (typeof raw !== "number" || typeof adj !== "number") return;
    const factor = adj / raw;
    bars.push({
      date: new Date(seconds * 1000).toISOString().slice(0, 10),
      high: (quote?.high[i] as number) * factor,
      low: (quote?.low[i] as number) * factor,
      close: adj,
      volume: quote?.volume[i] as number,
      revision: "final",
    });
  });
  const last = bars.at(-1) as IndicatorBar;
  bars[bars.length - 1] = { ...last, revision: "provisional" };
  return bars;
}

describe("the indicators computed here, against values worked by hand", () => {
  test("KDJ (n 3): RSV in the range, %K and %D smoothed from 50, carried over a range of zero", () => {
    const { k, d } = kdj({ highs: [10, 11, 12, 11], lows: [8, 9, 10, 9], closes: [9, 10, 11, 10] }, 3);
    expect(k.slice(0, 2)).toEqual([null, null]);
    // RSV (11 - 8) / (12 - 8) = 75: K = (2 x 50 + 75) / 3, D = (2 x 50 + K) / 3.
    close(k[2], 175 / 3);
    close(d[2], (100 + 175 / 3) / 3);
    // RSV (10 - 9) / (12 - 9) = 33.3...: K = (2 x 58.3... + 33.3...) / 3 = 50.
    close(k[3], 50);
    close(d[3], (2 * ((100 + 175 / 3) / 3) + 50) / 3);
    const flat = kdj({ highs: [5, 5, 5, 5], lows: [5, 5, 5, 5], closes: [5, 5, 5, 5] }, 3);
    expect(flat.k.slice(2)).toEqual([50, 50]);
    expect(flat.d.slice(2)).toEqual([50, 50]);
  });

  test("CCI (n 3): typical price less its mean over 0.015 times the mean deviation", () => {
    const values = cci({ highs: [12, 13, 14], lows: [10, 11, 12], closes: [11, 12, 13] }, 3);
    // Typical prices 11, 12, 13: mean 12, mean deviation 2/3, so (13 - 12) / (0.015 x 2/3) = 100.
    expect(values.slice(0, 2)).toEqual([null, null]);
    close(values[2], 100);
    expect(cci({ highs: [2, 2, 2], lows: [2, 2, 2], closes: [2, 2, 2] }, 3)[2]).toBeNull();
  });

  test("the z-score of the close against its last 75 sessions, population deviation", () => {
    const closes = Array.from({ length: 75 }, (_, i) => i + 1);
    const values = zScore(closes);
    expect(values[73]).toBeNull();
    // 1..75: mean 38, population variance (75^2 - 1) / 12.
    close(values[74], 37 / Math.sqrt((75 * 75 - 1) / 12));
    expect(zScore(Array.from({ length: 75 }, () => 4))[74]).toBeNull();
  });

  test("MFI (n 3): the rising typical prices' money flow over all of it", () => {
    // Typical prices 10, 11, 10.5, 12 (high = low = close), volumes 100..400.
    const prices = [10, 11, 10.5, 12];
    const values = mfi({ highs: prices, lows: prices, closes: prices }, [100, 200, 300, 400], 3);
    expect(values.slice(0, 3)).toEqual([null, null, null]);
    // Up 11 x 200 and 12 x 400, down 10.5 x 300: 100 x 7000 / 10150.
    close(values[3], (100 * 7000) / 10150);
    expect(mfi({ highs: [1, 1, 1], lows: [1, 1, 1], closes: [1, 1, 1] }, [5, 5, 5], 2)[2]).toBeNull();
  });

  test("VWMA (n 3): the closes weighted by volume", () => {
    const values = vwma([1, 2, 3], [1, 1, 2], 3);
    close(values[2], 9 / 4);
    expect(vwma([1, 2, 3], [0, 0, 0], 3)[2]).toBeNull();
  });

  test("PVO (12, 26): the volume EMAs' gap as a percent of the slow one, as TA-Lib seeds an EMA", () => {
    const volumes = Array.from({ length: 60 }, (_, i) => 1_000_000 + 250_000 * Math.sin(i / 4) + 9_000 * i);
    const values = pvo(volumes);
    expect(values[24]).toBeNull();
    const fast = plainEma(volumes, 12);
    const slow = plainEma(volumes, 26);
    close(values[59], (100 * (fast - slow)) / slow, 6);
  });
});

describe("the whole answer from daily bars", () => {
  test("about 400 sessions: all 22 indicators, upstream's averages on their definitions, the window", () => {
    const bars = aaplBars();
    const answer = technicalsOf(bars, {
      missing: [{ date: "2026-06-10", reason: "the source gives no close" }],
      priceBasis: "split_dividend_adjusted",
    });
    for (const key of INDICATORS) {
      expect(typeof answer[key], key).toBe("number");
      expect(Number.isFinite(answer[key] as number), key).toBe(true);
    }
    const closes = bars.map((bar) => bar.close as number);
    close(answer.sma_50, mean(closes, 50));
    close(answer.sma_200, mean(closes, 200));
    close(answer.bb_middle, mean(closes, 20));
    close(answer.ema_10, plainEma(closes, 10), 6);
    close(answer.roc, ((closes.at(-1) as number) / (closes.at(-2) as number)) * 100 - 100);
    const window = closes.slice(-20);
    const sd = Math.sqrt(window.reduce((sum, value) => sum + (value - mean(window, 20)) ** 2, 0) / 20);
    close(answer.bb_upper, mean(window, 20) + 2 * sd);
    close(
      answer.vwma,
      closes.slice(-20).reduce((sum, value, i) => sum + value * (bars.slice(-20)[i]?.volume as number), 0) /
        bars.slice(-20).reduce((sum, bar) => sum + (bar.volume as number), 0),
    );
    expect(answer.rsi).toBeGreaterThanOrEqual(0);
    expect(answer.rsi).toBeLessThanOrEqual(100);
    expect(answer.mfi).toBeGreaterThanOrEqual(0);
    expect(answer.mfi).toBeLessThanOrEqual(100);
    const last = closes.at(-1) as number;
    expect(answer.price_vs_sma50).toBe(last > (answer.sma_50 as number) ? "above" : "below");
    expect(answer.price_vs_sma200).toBe(last > (answer.sma_200 as number) ? "above" : "below");
    expect(answer.sma50_vs_sma200).toBe(
      (answer.sma_50 as number) > (answer.sma_200 as number) ? "above" : "below",
    );
    expect(answer).toMatchObject({
      through: "2026-11-25",
      last_value: { value: last, date: "2026-11-25" },
      window: {
        bars: bars.length,
        missing: [{ date: "2026-06-10", reason: "the source gives no close" }],
        settled_through: "2026-11-24",
      },
      price_basis: "split_dividend_adjusted",
      volume_available: true,
      field_states: null,
      history_rows: null,
      rows_needed: null,
    });
  });

  test("a short history: each indicator it holds back says what it needs, with the rows there are", () => {
    const bars = aaplBars().slice(-30);
    const answer = technicalsOf(bars);
    const short = INDICATORS.filter((key) => NEEDS[key] > 30);
    expect([...short].sort()).toEqual([
      "ema_50",
      "macd",
      "macd_histogram",
      "macd_signal",
      "sma_200",
      "sma_50",
      "z_score_75",
    ]);
    for (const key of short) {
      expect(answer[key], key).toBeNull();
      expect(answer.field_states?.[key]).toEqual({ reason: `needs ${NEEDS[key]} daily bars`, retry: null });
    }
    for (const key of INDICATORS.filter((one) => !short.includes(one)))
      expect(typeof answer[key], key).toBe("number");
    expect([answer.history_rows, answer.rows_needed]).toEqual([30, ROWS_NEEDED]);
    expect(ROWS_NEEDED).toBe(200);
    expect(answer.price_vs_sma50).toBeNull();
  });

  test("no volume (a currency pair): the volume-based indicators are not given, and it says so", () => {
    const bars = aaplBars().map((bar) => ({ ...bar, volume: 0 }));
    const answer = technicalsOf(bars);
    expect(answer.volume_available).toBe(false);
    expect([answer.mfi, answer.vwma, answer.pvo]).toEqual([null, null, null]);
    expect(typeof answer.rsi).toBe("number");
    expect(
      technicalsOf(aaplBars().map((bar, i) => (i === 5 ? { ...bar, volume: null } : bar))).volume_available,
    ).toBe(false);
  });

  test("a session without its high and low: the range indicators are not given, with the reason", () => {
    const bars = aaplBars().map((bar, i) => (i === 100 ? { ...bar, high: null } : bar));
    const answer = technicalsOf(bars);
    for (const key of ["stochastic_k", "stochastic_d", "cci", "mfi", "atr", "atr_5", "adx"] as const) {
      expect(answer[key], key).toBeNull();
    }
    expect(answer.field_states?.cci?.reason).toBe(
      `the source gives no high or low for 1 of ${bars.length} sessions`,
    );
    expect(answer.field_states?.atr?.reason).toContain("high and low");
    expect(typeof answer.rsi).toBe("number");
    expect(typeof answer.vwma).toBe("number");
  });

  test("no bars at all: nothing is computed, and the history says so", () => {
    const answer = technicalsOf([]);
    expect(answer.through).toBeNull();
    expect(answer.window).toEqual({ bars: 0, missing: [], settled_through: null });
    expect(answer.volume_available).toBe(false);
    for (const key of INDICATORS) expect(answer[key], key).toBeNull();
    expect([answer.history_rows, answer.rows_needed]).toEqual([0, 200]);
  });
});
