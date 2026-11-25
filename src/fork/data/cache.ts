// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Answers worth keeping for a while (a ticker list, a company's facts, a week's index membership), in
 * memory and, when the setup names a directory (config.ts: under the XDG cache directory, or
 * <home>/cache/fork-data with TRADINGAGENTS_HOME), on disk across runs.
 *
 * - `remember(key, ttl, load)` answers a fresh kept value, else loads it; callers asking for the same key
 *   while it loads share that one load (a caller whose load was cancelled under it loads for itself).
 * - A failed load is never kept. With `staleOnError`, a value past its time is served instead (and said
 *   to be stale) when reloading it fails for a reason of the source's (unavailable, rate_limited, quota).
 * - A key holding any configured secret is refused: a key is written in each disk entry, so a URL with
 *   its key in it can never be one.
 * - Disk entries are written whole or not at all (a temporary file renamed over the old one); one that
 *   cannot be read is a miss, and one that cannot be written leaves the value in memory only.
 *
 * Nothing limits how much is kept; entries past their time are dropped from memory as they are found,
 * and from disk once they are a month past it.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DataError } from "../../data/errors.js";
import { writeAtomic } from "../../store/index.js";
import { holdsSecret } from "./redact.js";

/** How a value is written to disk: as JSON (plain data only), text or bytes. */
export type DiskKind = "json" | "text" | "bytes";

export type KeepOptions = {
  /** Keep it on disk too (when the cache has a directory), written as this kind. */
  disk?: DiskKind;
  /** Keep it in memory (true unless given): false keeps a large value on disk only. */
  memory?: boolean;
  /** Serve the value past its time when reloading it fails for a reason of the source's. */
  staleOnError?: boolean;
};

/** A kept value, when it was stored (epoch ms), and whether it is past its time. */
export type Kept<T> = { value: T; storedAt: number; stale: boolean };

/** Values kept are shared by every caller that asks for them: read them, never change them. */
export type Cache = {
  /** The value kept under `key` while fresh, else what `load` gives, kept for `ttlMs`. */
  remember<T>(key: string, ttlMs: number, load: () => Promise<T>, options?: KeepOptions): Promise<T>;
  /** As `remember`, with when the value was stored and whether it is stale. */
  keep<T>(key: string, ttlMs: number, load: () => Promise<T>, options?: KeepOptions): Promise<Kept<T>>;
  /** Drop what is kept under `key`, in memory and on disk. */
  forget(key: string): Promise<void>;
};

export type CacheOptions = {
  /** Where entries are kept on disk; memory only when unset. */
  dir?: string | undefined;
  /** Wall-clock time (epoch ms): entries outlive the process. */
  now?: () => number;
  /** Every configured key: a cache key holding one is refused. */
  secrets?: readonly string[];
};

/** How long past its time a disk entry stays for `staleOnError` before it is swept. */
const DISK_KEPT_PAST_MS = 30 * 86_400_000;

/** Entries memory holds, by key, and what to sweep. */
type Held = { value: unknown; storedAt: number; expires: number; stale: boolean };

/** The first line of a disk entry. */
type Header = { v: 1; key: string; storedAt: number; expires: number; kind: DiskKind };

/** The kinds of failure after which a stale value is served. */
const SOURCE_FAILURES = new Set(["unavailable", "rate_limited", "quota"]);

export function createCache(options: CacheOptions = {}): Cache {
  const now = options.now ?? Date.now;
  const secrets = options.secrets ?? [];
  const { dir } = options;
  const memory = new Map<string, Held>();
  const loading = new Map<string, Promise<Kept<unknown>>>();
  let swept = false;

  const pathOf = (key: string) =>
    join(dir as string, `${createHash("sha256").update(key).digest("hex").slice(0, 40)}.entry`);

  async function readDisk(key: string): Promise<{ header: Header; value: unknown } | undefined> {
    if (!dir) return undefined;
    let raw: Buffer;
    try {
      raw = await fs.readFile(pathOf(key));
    } catch {
      return undefined;
    }
    const newline = raw.indexOf(10);
    if (newline < 0) return undefined;
    let header: Header;
    try {
      header = JSON.parse(raw.subarray(0, newline).toString("utf8")) as Header;
    } catch {
      return undefined;
    }
    if (header?.v !== 1 || header.key !== key) return undefined;
    const body = raw.subarray(newline + 1);
    try {
      const value =
        header.kind === "bytes"
          ? new Uint8Array(body)
          : header.kind === "text"
            ? body.toString("utf8")
            : (JSON.parse(body.toString("utf8")) as unknown);
      return { header, value };
    } catch {
      return undefined;
    }
  }

  async function writeDisk(key: string, kind: DiskKind, value: unknown, storedAt: number, expires: number) {
    if (!dir) return;
    try {
      const header: Header = { v: 1, key, storedAt, expires, kind };
      const body =
        kind === "bytes"
          ? Buffer.from(value as Uint8Array)
          : Buffer.from(kind === "text" ? (value as string) : JSON.stringify(value), "utf8");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await writeAtomic(pathOf(key), Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), body]), {
        mode: 0o600,
      });
      if (!swept) {
        swept = true;
        await sweep(dir, now());
      }
    } catch {
      // A cache that cannot be written leaves the value in memory.
    }
  }

  function hold(key: string, kept: Kept<unknown>, expires: number, options: KeepOptions) {
    if (options.memory === false) return;
    memory.set(key, {
      value: kept.value,
      storedAt: kept.storedAt,
      expires,
      stale: options.staleOnError === true,
    });
    if (memory.size % 128 === 0) {
      const at = now();
      for (const [other, held] of memory) if (!held.stale && held.expires <= at) memory.delete(other);
    }
  }

  async function keep<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
    options: KeepOptions = {},
  ): Promise<Kept<T>> {
    if (holdsSecret(key, secrets)) throw new Error("a cache key may not hold a key or secret");
    const held = memory.get(key);
    if (held && held.expires > now())
      return { value: held.value as T, storedAt: held.storedAt, stale: false };
    const pending = loading.get(key);
    if (pending) {
      try {
        return (await pending) as Kept<T>;
      } catch (error) {
        // Another caller's load was cancelled under it: this one loads for itself.
        if (!isAbort(error)) throw error;
      }
    }
    const started = (async (): Promise<Kept<unknown>> => {
      const disk = options.disk ? await readDisk(key) : undefined;
      if (disk && disk.header.expires > now()) {
        const kept = { value: disk.value, storedAt: disk.header.storedAt, stale: false };
        hold(key, kept, disk.header.expires, options);
        return kept;
      }
      let value: T;
      try {
        value = await load();
      } catch (error) {
        const old = held ?? (disk ? { value: disk.value, storedAt: disk.header.storedAt } : undefined);
        if (options.staleOnError && old && isSourceFailure(error)) {
          return { value: old.value, storedAt: old.storedAt, stale: true };
        }
        throw error;
      }
      const storedAt = now();
      // A time past any date a header can carry (Infinity is not JSON) reads as the latest one that can.
      const expires = Math.min(storedAt + ttlMs, Number.MAX_SAFE_INTEGER);
      const kept = { value: value as unknown, storedAt, stale: false };
      hold(key, kept, expires, options);
      if (options.disk) await writeDisk(key, options.disk, value, storedAt, expires);
      return kept;
    })();
    loading.set(key, started);
    const done = () => {
      if (loading.get(key) === started) loading.delete(key);
    };
    started.then(done, done);
    return (await started) as Kept<T>;
  }

  return {
    keep,
    remember: async (key, ttlMs, load, options) => (await keep(key, ttlMs, load, options)).value,
    forget: async (key) => {
      memory.delete(key);
      if (dir) await fs.rm(pathOf(key), { force: true }).catch(() => {});
    },
  };
}

/** Whether `error` is a cancellation. */
function isAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "AbortError";
}

/** Whether `error` is the source failing (not the request, not an answer about the market, not a bug). */
function isSourceFailure(error: unknown): boolean {
  return error instanceof DataError && SOURCE_FAILURES.has(error.kind);
}

/** Removes the entries in `dir` that are more than DISK_KEPT_PAST_MS past their time. */
async function sweep(dir: string, at: number): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".entry")) continue;
    const path = join(dir, name);
    try {
      const handle = await fs.open(path, "r");
      let first: string;
      try {
        const buffer = Buffer.alloc(4_096);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        first = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
      } finally {
        await handle.close();
      }
      const header = JSON.parse(first) as Partial<Header>;
      if (typeof header.expires === "number" && header.expires + DISK_KEPT_PAST_MS < at) {
        await fs.rm(path, { force: true });
      }
    } catch {
      // An entry that cannot be read is left; a miss for it rewrites it.
    }
  }
}
