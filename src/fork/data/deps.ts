// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * What every fork data provider is built from (`ForkDeps`): the settings, the HTTP client and cache they
 * share, the engine's clock, elapsed time, and the one yahoo-finance2 client every Yahoo read goes
 * through. Tests build these with `forkDeps` from a fixture fetch, a fixed clock and a fake timer.
 */
import YahooFinance from "yahoo-finance2";
import type { Clock } from "../../contracts/index.js";
import { answeredOrThrown } from "../../data/yahoo/provider.js";
import { type Cache, createCache } from "./cache.js";
import { type PublicDataConfig, secretsOf } from "./config.js";
import { createHttp, type Http, type Pacer } from "./http.js";
import { REAL_TIMER, type Timer } from "./timer.js";

/** yahoo-finance2's client, every module of it (quote, chart, quoteSummary, search, screener, ...). */
export type YahooFinanceClient = InstanceType<typeof YahooFinance>;

export type ForkDeps = {
  config: PublicDataConfig;
  /** The fetch every request goes through (a fixture fetch in tests). */
  fetch: typeof globalThis.fetch;
  /** The engine's clock: what day it is (tests fix it). */
  clock: Clock;
  /** Elapsed time, for pacing and waits. */
  timer: Timer;
  /** Every non-Yahoo request (http.ts). */
  http: Http;
  cache: Cache;
  /** Every Yahoo request, with the library's own User-Agent (Yahoo refuses others). */
  yahoo: YahooFinanceClient;
};

/** What a setup may give in place of the defaults. */
export type ForkOptions = {
  fetch?: typeof globalThis.fetch;
  clock?: Clock;
  timer?: Timer;
  /** A yahoo-finance2 client to share instead of a new one. */
  yahoo?: YahooFinanceClient;
  /** A cache to share instead of a new one (over `config.cacheDir`). */
  cache?: Cache;
  /** Where the published rates' turns are kept (tests give each their own). */
  pacer?: Pacer;
  /** The User-Agent non-SEC hosts get: the app's name and version unless given (the fixture recorder gives its own). */
  userAgent?: string;
};

/** The deps for `config`: the defaults, or what `options` gives. */
export function forkDeps(config: PublicDataConfig, options: ForkOptions = {}): ForkDeps {
  const fetchImpl = options.fetch ?? fetch;
  const timer = options.timer ?? REAL_TIMER;
  const secrets = secretsOf(config);
  return {
    config,
    fetch: fetchImpl,
    clock: options.clock ?? (() => new Date()),
    timer,
    http: createHttp({
      fetch: fetchImpl,
      timer,
      secrets,
      secUserAgent: config.secUserAgent,
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      ...(options.pacer ? { pacer: options.pacer } : {}),
    }),
    cache: options.cache ?? createCache({ dir: config.cacheDir, secrets }),
    yahoo: options.yahoo ?? yahooClient(fetchImpl),
  };
}

/**
 * A yahoo-finance2 client configured as upstream's Yahoo provider configures its own: the library's
 * User-Agent, its notices about surveys and removed modules suppressed, a silent logger, and every request
 * bounded and its failures turned into errors with their status by upstream's `answeredOrThrown`. Beyond
 * upstream's: an answer that fails the library's schema is not logged, which also stops the library from
 * asking npm's registry for its latest version (a request of its own, through the global fetch, unbounded).
 */
export function yahooClient(fetchImpl: typeof globalThis.fetch): YahooFinanceClient {
  const silent = { info() {}, warn() {}, error() {}, debug() {}, dir() {} };
  return new YahooFinance({
    suppressNotices: ["yahooSurvey", "ripHistorical"],
    logger: silent,
    fetch: answeredOrThrown(fetchImpl),
    versionCheck: false,
    validation: { logErrors: false },
  });
}
