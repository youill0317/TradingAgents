// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Elapsed time, apart from the engine's clock: the engine's clock says what day it is (tests fix it),
 * while a service's pacing and a Retry-After wait need time that passes. Tests pass a timer whose sleeps
 * return at once and move its time on.
 */

export type Timer = {
  /** Milliseconds on a clock that only moves forward. */
  now(): number;
  /** Resolves after `ms`; rejects with the signal's reason when it is aborted first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

/** The process's own time. */
export const REAL_TIMER: Timer = {
  now: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const stop = () => {
        clearTimeout(timeout);
        reject(signal?.reason);
      };
      const timeout = setTimeout(
        () => {
          signal?.removeEventListener("abort", stop);
          resolve();
        },
        Math.max(0, ms),
      );
      signal?.addEventListener("abort", stop, { once: true });
    }),
};

/** `promise`, or the signal's reason as soon as it is aborted (the work itself is not stopped). */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}
