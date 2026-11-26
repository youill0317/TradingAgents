// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The technicals capability's 22 indicators (INDICATORS, src/data/capabilities.ts) at an instrument's latest
 * completed session, computed from its daily bars on the definitions the technicals tool states to the model
 * (src/tools/technicals.ts):
 *
 * - upstream's computations (src/compute/indicators.ts, TA-Lib's conventions) for RSI(14, Wilder), MACD(12,
 *   26) with its 9-session signal and histogram, SMA 50 and 200, EMA 10 and 50, Bollinger (20, 2 population
 *   standard deviations), ATR(14) and ATR(5), ADX(14), and the one-session change in percent (ROC 1);
 * - computed here, as each function below defines it: the KDJ stochastic (9, 3, 3: %K and %D), CCI(14), the
 *   z-score of the close against its last 75 sessions, and the volume-based MFI(14), VWMA(20) and
 *   PVO(12, 26).
 *
 * The answer also says where the close and the averages stand ("above" or "below"), the window read (its
 * bars, the sessions left out with the source's reason, the last session settled), and whether volume is
 * there for the volume-based ones. An indicator the history is too short for is null, with the reason in
 * `field_states` and the rows there are and the rows the longest needs (`history_rows`, `rows_needed`),
 * which the tool says as "not enough history"; those two are null when every indicator had history enough.
 */
import { type Bars, indicatorsOf, type Values } from "../../../compute/indicators.js";
import { type DailyBar, INDICATORS, type TechnicalsAnswer } from "../../../data/capabilities.js";

/** An indicator the capability serves, by its key. */
export type IndicatorKey = (typeof INDICATORS)[number];

/** A daily bar as the indicators read it: a completed session, oldest first. */
export type IndicatorBar = Pick<DailyBar, "date" | "high" | "low" | "close" | "volume" | "revision">;

/** A session the bars leave out, with the source's reason. */
export type LeftOut = { date: string; reason?: string | null };

/** The technicals answer without its instrument, which the provider describes. */
export type TechnicalsFigures = Omit<TechnicalsAnswer, "instrument">;

/** The sessions each indicator's first value needs. */
export const NEEDS: Readonly<Record<IndicatorKey, number>> = {
  rsi: 15,
  // Upstream gives the MACD line, signal and histogram together once the signal has its first value.
  macd: 34,
  macd_signal: 34,
  macd_histogram: 34,
  sma_50: 50,
  sma_200: 200,
  ema_10: 10,
  ema_50: 50,
  bb_upper: 20,
  bb_middle: 20,
  bb_lower: 20,
  atr: 15,
  atr_5: 6,
  stochastic_k: 9,
  stochastic_d: 9,
  cci: 14,
  adx: 28,
  z_score_75: 75,
  roc: 2,
  mfi: 15,
  vwma: 20,
  pvo: 26,
};

/** The sessions the longest indicator needs (SMA 200). */
export const ROWS_NEEDED = Math.max(...Object.values(NEEDS));

/** What upstream computes, requested as its indicators tool names them, and the keys each one's columns fill. */
const UPSTREAM: readonly {
  name: "rsi" | "macd" | "sma" | "ema" | "bollinger" | "atr" | "adx" | "roc";
  periods: number[];
  columns: Partial<Record<IndicatorKey, string>>;
}[] = [
  { name: "rsi", periods: [14], columns: { rsi: "rsi_14" } },
  {
    name: "macd",
    periods: [12, 26, 9],
    columns: {
      macd: "macd_12_26_9",
      macd_signal: "macd_signal_12_26_9",
      macd_histogram: "macd_histogram_12_26_9",
    },
  },
  // Each average asked alone, so a short history still gives the shorter ones.
  { name: "sma", periods: [50], columns: { sma_50: "sma_50" } },
  { name: "sma", periods: [200], columns: { sma_200: "sma_200" } },
  { name: "ema", periods: [10], columns: { ema_10: "ema_10" } },
  { name: "ema", periods: [50], columns: { ema_50: "ema_50" } },
  {
    name: "bollinger",
    periods: [20],
    columns: { bb_upper: "bb_upper_20", bb_middle: "bb_middle_20", bb_lower: "bb_lower_20" },
  },
  { name: "atr", periods: [14], columns: { atr: "atr_14" } },
  { name: "atr", periods: [5], columns: { atr_5: "atr_5" } },
  { name: "adx", periods: [14], columns: { adx: "adx_14" } },
  { name: "roc", periods: [1], columns: { roc: "roc_1" } },
];

/** Bars with the high and low of every session, which the range indicators need. */
type Ranged = { highs: readonly number[]; lows: readonly number[]; closes: readonly number[] };

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/**
 * The KDJ stochastic (9, 3, 3), as it is customarily computed: the raw stochastic value RSV is where the
 * close sits in the high-low range of the last `n` sessions (0 at the low, 100 at the high); %K is RSV
 * smoothed as K = ((m1 - 1) K' + RSV) / m1 and %D is %K smoothed as D = ((m2 - 1) D' + K) / m2, both
 * starting from 50 before the first RSV. Where the range is zero there is no RSV and %K and %D carry over.
 * (J = 3K - 2D is not served.)
 */
export function kdj(bars: Ranged, n = 9, m1 = 3, m2 = 3): { k: Values; d: Values } {
  const { highs, lows, closes } = bars;
  const k: Values = closes.map(() => null);
  const d: Values = closes.map(() => null);
  let kLevel = 50;
  let dLevel = 50;
  for (let i = n - 1; i < closes.length; i++) {
    const high = Math.max(...highs.slice(i - n + 1, i + 1));
    const low = Math.min(...lows.slice(i - n + 1, i + 1));
    if (high > low) {
      const rsv = (((closes[i] as number) - low) / (high - low)) * 100;
      kLevel = ((m1 - 1) * kLevel + rsv) / m1;
      dLevel = ((m2 - 1) * dLevel + kLevel) / m2;
    }
    k[i] = kLevel;
    d[i] = dLevel;
  }
  return { k, d };
}

/**
 * The commodity channel index (Lambert, 1980), as TA-Lib's CCI: the typical price (high + low + close) / 3
 * less its simple mean over `n` sessions, over 0.015 times the mean absolute deviation from that mean;
 * undefined where the deviation is zero.
 */
export function cci(bars: Ranged, n = 14): Values {
  const typical = bars.closes.map(
    (close, i) => ((bars.highs[i] as number) + (bars.lows[i] as number) + close) / 3,
  );
  return typical.map((price, i) => {
    if (i < n - 1) return null;
    const window = typical.slice(i - n + 1, i + 1);
    const mean = sum(window) / n;
    const deviation = window.reduce((total, value) => total + Math.abs(value - mean), 0) / n;
    return deviation === 0 ? null : (price - mean) / (0.015 * deviation);
  });
}

/**
 * The z-score of the close against its last `n` sessions (the latest included): the close less their mean,
 * over their population standard deviation; undefined where the closes did not move.
 */
export function zScore(closes: readonly number[], n = 75): Values {
  return closes.map((close, i) => {
    if (i < n - 1) return null;
    const window = closes.slice(i - n + 1, i + 1);
    const mean = sum(window) / n;
    const deviation = Math.sqrt(window.reduce((total, value) => total + (value - mean) ** 2, 0) / n);
    return deviation === 0 ? null : (close - mean) / deviation;
  });
}

/**
 * The money flow index (Quong and Soudack, 1989), as TA-Lib's MFI: the typical price times volume is the
 * session's money flow, positive when the typical price rose from the session before and negative when it
 * fell (neither when unchanged); MFI is 100 times the positive flow of the last `n` sessions over all of
 * their flow; undefined where there was none.
 */
export function mfi(bars: Ranged, volumes: readonly number[], n = 14): Values {
  const typical = bars.closes.map(
    (close, i) => ((bars.highs[i] as number) + (bars.lows[i] as number) + close) / 3,
  );
  return typical.map((_, i) => {
    if (i < n) return null;
    let positive = 0;
    let negative = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const flow = (typical[j] as number) * (volumes[j] as number);
      if ((typical[j] as number) > (typical[j - 1] as number)) positive += flow;
      else if ((typical[j] as number) < (typical[j - 1] as number)) negative += flow;
    }
    return positive + negative === 0 ? null : (100 * positive) / (positive + negative);
  });
}

/** The volume-weighted moving average of the close over `n` sessions; undefined where no volume traded. */
export function vwma(closes: readonly number[], volumes: readonly number[], n = 20): Values {
  return closes.map((_, i) => {
    if (i < n - 1) return null;
    let weighted = 0;
    let traded = 0;
    for (let j = i - n + 1; j <= i; j++) {
      weighted += (closes[j] as number) * (volumes[j] as number);
      traded += volumes[j] as number;
    }
    return traded === 0 ? null : weighted / traded;
  });
}

/**
 * The percentage volume oscillator (12, 26): the fast EMA of volume less the slow one, as a percent of the
 * slow one, with upstream's EMA (alpha 2 / (n + 1), seeded with the simple mean of the first n values, as
 * TA-Lib); undefined where the slow average is zero. (The signal line is not served.)
 */
export function pvo(volumes: readonly number[], fast = 12, slow = 26): Values {
  const dates = volumes.map((_, i) => String(i));
  const none = volumes.map(() => null);
  const { columns } = indicatorsOf(
    { dates, highs: none, lows: none, closes: volumes },
    [
      { name: "ema", periods: [fast] },
      { name: "ema", periods: [slow] },
    ],
    Math.max(0, volumes.length - 1),
  );
  const quick = columns[`ema_${fast}`];
  const steady = columns[`ema_${slow}`];
  return volumes.map((_, i) => {
    const a = quick?.[i];
    const b = steady?.[i];
    return finite(a) && finite(b) && b !== 0 ? (100 * (a - b)) / b : null;
  });
}

/** Where `a` stands against `b`; null when either is missing or they are equal. */
function side(a: number | null, b: number | null): "above" | "below" | null {
  if (a === null || b === null || a === b) return null;
  return a > b ? "above" : "below";
}

/** The last value of a column, at the latest session. */
function latest(values: Values | undefined, at: number): number | null {
  const value = values?.[at];
  return finite(value) ? value : null;
}

/**
 * The indicators at the latest of `bars` (completed sessions with a close, oldest first), and how they
 * were computed: see the top of this file. `missing` lists the sessions the bars leave out; `priceBasis` is
 * how the bars are adjusted, as their source states it.
 */
export function technicalsOf(
  bars: readonly IndicatorBar[],
  { missing = [], priceBasis = null }: { missing?: readonly LeftOut[]; priceBasis?: string | null } = {},
): TechnicalsFigures {
  const used = bars.filter((bar) => finite(bar.close));
  const dates = used.map((bar) => bar.date);
  const closes = used.map((bar) => bar.close as number);
  const highs = used.map((bar) => (finite(bar.high) ? bar.high : null));
  const lows = used.map((bar) => (finite(bar.low) ? bar.low : null));
  const at = closes.length - 1;
  const values = Object.fromEntries(INDICATORS.map((key) => [key, null])) as Record<
    IndicatorKey,
    number | null
  >;
  const states: Record<string, { reason: string; retry: string | null }> = {};

  const series: Bars = { dates, highs, lows, closes };
  const { columns, results } = indicatorsOf(series, UPSTREAM, Math.max(0, at));
  UPSTREAM.forEach((request, i) => {
    const result = results[i];
    for (const [key, column] of Object.entries(request.columns) as [IndicatorKey, string][]) {
      values[key] = latest(columns[column], at);
      if (result && "error" in result) states[key] = { reason: result.error, retry: "later" };
    }
  });

  const unranged = used.filter((bar) => !finite(bar.high) || !finite(bar.low)).length;
  if (!unranged && closes.length) {
    const ranged: Ranged = { highs: highs as number[], lows: lows as number[], closes };
    const stochastic = kdj(ranged);
    values.stochastic_k = latest(stochastic.k, at);
    values.stochastic_d = latest(stochastic.d, at);
    values.cci = latest(cci(ranged), at);
  } else if (unranged) {
    const reason = `the source gives no high or low for ${unranged} of ${closes.length} sessions`;
    for (const key of ["stochastic_k", "stochastic_d", "cci", "mfi"] as const) {
      states[key] = { reason, retry: "never" };
    }
  }
  values.z_score_75 = latest(zScore(closes), at);

  // Volume: every session's, and some traded, or none of the volume-based indicators.
  const volumes = used.map((bar) => bar.volume);
  const volume_available =
    used.length > 0 &&
    volumes.every((volume) => finite(volume) && volume >= 0) &&
    volumes.some((volume) => (volume as number) > 0);
  if (volume_available) {
    const traded = volumes as number[];
    if (!unranged)
      values.mfi = latest(mfi({ highs: highs as number[], lows: lows as number[], closes }, traded), at);
    values.vwma = latest(vwma(closes, traded), at);
    values.pvo = latest(pvo(traded), at);
  }

  // Too short a history: said for each indicator it holds back, whatever else was said of it (the tool
  // heads these with the rows there are and the rows needed, so each says only its own need).
  const short = INDICATORS.filter((key) => NEEDS[key] > closes.length);
  for (const key of short) states[key] = { reason: `needs ${NEEDS[key]} daily bars`, retry: null };

  const close = closes.length ? (closes[at] as number) : null;
  const settled = used.filter((bar) => bar.revision === "final").at(-1)?.date ?? null;
  return {
    through: dates.at(-1) ?? null,
    last_value: { value: close, date: dates.at(-1) ?? null },
    window: {
      bars: closes.length,
      missing: missing.map((left) => ({ date: left.date, reason: left.reason ?? null })),
      settled_through: settled,
    },
    price_basis: priceBasis,
    volume_available,
    ...values,
    price_vs_sma50: side(close, values.sma_50),
    price_vs_sma200: side(close, values.sma_200),
    sma50_vs_sma200: side(values.sma_50, values.sma_200),
    field_states: Object.keys(states).length ? states : null,
    history_rows: short.length ? closes.length : null,
    rows_needed: short.length ? ROWS_NEEDED : null,
  };
}
