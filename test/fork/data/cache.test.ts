// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/** The cache in memory and in a temporary directory, with a clock the tests move. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataError } from "../../../src/data/errors.js";
import { createCache } from "../../../src/fork/data/cache.js";

let dir: string;
let now = 1_000_000;
const clock = () => now;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fork-cache-"));
  now = 1_000_000;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A load that counts its calls and answers each with the next value. */
function counting<T>(...values: T[]) {
  let calls = 0;
  const load = async () => values[Math.min(calls++, values.length - 1)] as T;
  return { load, calls: () => calls };
}

describe("in memory", () => {
  test("a fresh value is kept for its time, then loaded again", async () => {
    const cache = createCache({ now: clock });
    const source = counting("first", "second");
    expect(await cache.remember("tickers", 60_000, source.load)).toBe("first");
    now += 59_999;
    expect(await cache.remember("tickers", 60_000, source.load)).toBe("first");
    now += 1;
    expect(await cache.remember("tickers", 60_000, source.load)).toBe("second");
    expect(source.calls()).toBe(2);
  });

  test("callers asking together share one load", async () => {
    const cache = createCache({ now: clock });
    let calls = 0;
    let finish = (_: string) => {};
    const load = () => {
      calls++;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    };
    const asked = [
      cache.remember("k", 1_000, load),
      cache.remember("k", 1_000, load),
      cache.remember("k", 1_000, load),
    ];
    finish("shared");
    expect(await Promise.all(asked)).toEqual(["shared", "shared", "shared"]);
    expect(calls).toBe(1);
  });

  test("a failed load is never kept: the next caller loads again", async () => {
    const cache = createCache({ now: clock });
    let calls = 0;
    const load = async () => {
      calls++;
      if (calls === 1) throw new DataError("unavailable", "down", { source: "X" });
      return "up";
    };
    await expect(cache.remember("k", 1_000, load)).rejects.toThrow("down");
    expect(await cache.remember("k", 1_000, load)).toBe("up");
    expect(calls).toBe(2);
  });

  test("a load cancelled under a waiting caller is loaded again for that caller", async () => {
    const cache = createCache({ now: clock });
    let calls = 0;
    const cancelled = () => {
      calls++;
      return Promise.reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    };
    const own = async () => {
      calls++;
      return "mine";
    };
    const first = cache.remember("k", 1_000, cancelled);
    const second = cache.remember("k", 1_000, own);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(await second).toBe("mine");
    expect(calls).toBe(2);
  });

  test("a load cancelled under its caller, whatever the reason given, is loaded again for a caller waiting on it", async () => {
    for (const reason of [
      new DOMException("The operation timed out.", "TimeoutError"),
      new Error("question cancelled"),
    ]) {
      const cache = createCache({ now: clock });
      const controller = new AbortController();
      let release = () => {};
      // The first caller's load ends when its call is cancelled, with the call's reason.
      const theirs = () =>
        new Promise<string>((_, reject) => {
          release = () => reject(controller.signal.reason);
        });
      const first = cache.remember("list", 1_000, theirs, { signal: controller.signal });
      const second = cache.remember("list", 1_000, async () => "fresh list");
      controller.abort(reason);
      release();
      await expect(first).rejects.toBe(reason);
      expect(await second).toBe("fresh list");
    }
  });

  test("a caller's own cancellation ends its wait at once; the load it waited on goes on and is kept", async () => {
    const cache = createCache({ now: clock });
    let finish = (_: string) => {};
    let calls = 0;
    const slow = () => {
      calls++;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    };
    const loading = cache.remember("k", 60_000, slow);
    const leaving = new AbortController();
    const waiting = cache.remember("k", 60_000, slow, { signal: leaving.signal });
    leaving.abort(new Error("left"));
    await expect(waiting).rejects.toThrow("left");
    finish("loaded");
    expect(await loading).toBe("loaded");
    expect(await cache.remember("k", 60_000, slow)).toBe("loaded");
    expect(calls).toBe(1);
    // A caller cancelled before it asks loads nothing.
    const gone = new AbortController();
    gone.abort();
    await expect(cache.remember("other", 60_000, slow, { signal: gone.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(calls).toBe(1);
  });

  test("after a load cancelled under its caller, the callers that waited on it share one new load", async () => {
    const cache = createCache({ now: clock });
    const controller = new AbortController();
    let calls = 0;
    const cancelledLoad = () => {
      calls++;
      return new Promise<string>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason));
      });
    };
    const load = async () => {
      calls++;
      return "shared";
    };
    const first = cache.remember("k", 1_000, cancelledLoad, { signal: controller.signal });
    const waiting = [cache.remember("k", 1_000, load), cache.remember("k", 1_000, load)];
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(await Promise.all(waiting)).toEqual(["shared", "shared"]);
    expect(calls).toBe(2);
  });

  test("a load that fails for a reason of its own is the answer of every caller waiting on it", async () => {
    const cache = createCache({ now: clock });
    let calls = 0;
    let fail = () => {};
    const load = () => {
      calls++;
      return new Promise<string>((_, reject) => {
        fail = () => reject(new DataError("unavailable", "down", { source: "X" }));
      });
    };
    const signal = new AbortController().signal;
    const asked = Promise.allSettled([
      cache.remember("k", 1_000, load, { signal }),
      cache.remember("k", 1_000, load, { signal }),
    ]);
    fail();
    expect((await asked).map((one) => (one.status === "rejected" ? String(one.reason) : one.value))).toEqual([
      "DataError: down",
      "DataError: down",
    ]);
    expect(calls).toBe(1);
  });

  test("a stale value is served when reloading fails for the source's reason, and said to be stale", async () => {
    const cache = createCache({ now: clock });
    expect(await cache.remember("list", 1_000, async () => "v1", { staleOnError: true })).toBe("v1");
    now += 5_000;
    const busy = async (): Promise<string> => {
      throw new DataError("rate_limited", "busy", { source: "Wikipedia", retryAfterMs: 45_000 });
    };
    expect(await cache.keep("list", 1_000, busy, { staleOnError: true })).toEqual({
      value: "v1",
      storedAt: 1_000_000,
      stale: true,
    });
    // An answer about the request is not the source failing: it is passed on.
    const invalid = async (): Promise<string> => {
      throw new DataError("invalid", "no such list", { source: "Wikipedia" });
    };
    await expect(cache.keep("list", 1_000, invalid, { staleOnError: true })).rejects.toThrow("no such list");
    // Without staleOnError, the failure is passed on.
    await expect(cache.remember("list", 1_000, busy)).rejects.toThrow("busy");
  });

  test("a key holding a configured secret is refused before anything is loaded", async () => {
    const secret = "dart-key-0123456789";
    const cache = createCache({ now: clock, secrets: [secret] });
    const source = counting("x");
    await expect(
      cache.remember(`https://opendart.fss.or.kr/api/list.json?crtfc_key=${secret}`, 1, source.load),
    ).rejects.toThrow("a cache key may not hold a key or secret");
    await expect(cache.remember(`dart:${encodeURIComponent(`${secret}/`)}`, 1, source.load)).rejects.toThrow(
      "secret",
    );
    expect(source.calls()).toBe(0);
    expect(await cache.remember("dart:corp-codes", 1, source.load)).toBe("x");
  });
});

describe("on disk", () => {
  test("a value outlives the cache that wrote it: JSON, text and bytes", async () => {
    const first = createCache({ dir, now: clock });
    await first.remember("json", 60_000, async () => ({ a: [1, "b"] }), { disk: "json" });
    await first.remember("text", 60_000, async () => "line one\nline two", { disk: "text" });
    await first.remember("bytes", 60_000, async () => new Uint8Array([0, 10, 255]), { disk: "bytes" });
    const second = createCache({ dir, now: clock });
    const never = async (): Promise<never> => {
      throw new Error("loaded again");
    };
    expect(await second.remember<unknown>("json", 60_000, never, { disk: "json" })).toEqual({ a: [1, "b"] });
    expect(await second.remember<unknown>("text", 60_000, never, { disk: "text" })).toBe(
      "line one\nline two",
    );
    expect(await second.remember<unknown>("bytes", 60_000, never, { disk: "bytes" })).toEqual(
      new Uint8Array([0, 10, 255]),
    );
    const kept = await second.keep("json", 60_000, never, { disk: "json" });
    expect(kept.storedAt).toBe(1_000_000);
  });

  test("past its time on disk, a value is loaded again and rewritten", async () => {
    const first = createCache({ dir, now: clock });
    await first.remember("k", 1_000, async () => "old", { disk: "text" });
    now += 2_000;
    const second = createCache({ dir, now: clock });
    expect(await second.remember("k", 1_000, async () => "new", { disk: "text" })).toBe("new");
    expect(
      await createCache({ dir, now: clock }).remember("k", 1_000, async () => "newer", { disk: "text" }),
    ).toBe("new");
  });

  test("a value past its time on disk is served stale when the source fails", async () => {
    await createCache({ dir, now: clock }).remember("sp500", 1_000, async () => ["AAPL"], { disk: "json" });
    now += 86_400_000;
    const later = createCache({ dir, now: clock });
    const down = async (): Promise<string[]> => {
      throw new DataError("unavailable", "down", { source: "Wikipedia" });
    };
    expect(await later.keep("sp500", 1_000, down, { disk: "json", staleOnError: true })).toEqual({
      value: ["AAPL"],
      storedAt: 1_000_000,
      stale: true,
    });
  });

  test("memory: false keeps a large value on disk only", async () => {
    const cache = createCache({ dir, now: clock });
    let calls = 0;
    const load = async () => {
      calls++;
      return "big";
    };
    await cache.remember("big", 60_000, load, { disk: "text", memory: false });
    expect(await cache.remember("big", 60_000, load, { disk: "text", memory: false })).toBe("big");
    expect(calls).toBe(1);
  });

  test("entries are owner-only files written whole, named by a hash, the key only inside", async () => {
    const cache = createCache({ dir, now: clock });
    await cache.remember("sec:submissions:0000320193", 60_000, async () => ({ ok: true }), { disk: "json" });
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f]{40}\.entry$/);
    expect(((await stat(join(dir, names[0] as string))).mode & 0o777).toString(8)).toBe("600");
    const raw = await readFile(join(dir, names[0] as string), "utf8");
    expect(raw.split("\n")[0]).toBe(
      JSON.stringify({
        v: 1,
        key: "sec:submissions:0000320193",
        storedAt: 1_000_000,
        expires: 1_060_000,
        kind: "json",
      }),
    );
  });

  test("a damaged or foreign entry is a miss; an unwritable directory leaves the value in memory", async () => {
    const cache = createCache({ dir, now: clock });
    await cache.remember("k", 60_000, async () => "v", { disk: "text" });
    const [name] = await readdir(dir);
    await writeFile(join(dir, name as string), "not a header\nv");
    expect(
      await createCache({ dir, now: clock }).remember("k", 60_000, async () => "reloaded", { disk: "text" }),
    ).toBe("reloaded");
    await writeFile(
      join(dir, name as string),
      `${JSON.stringify({ v: 1, key: "other", storedAt: 0, expires: 9e15, kind: "text" })}\nx`,
    );
    expect(
      await createCache({ dir, now: clock }).remember("k", 60_000, async () => "mine", { disk: "text" }),
    ).toBe("mine");
    const blocked = join(dir, "file-not-dir");
    await writeFile(blocked, "");
    const unwritable = createCache({ dir: join(blocked, "cache"), now: clock });
    expect(await unwritable.remember("k", 60_000, async () => "memory", { disk: "text" })).toBe("memory");
    expect(await unwritable.remember("k", 60_000, async () => "again", { disk: "text" })).toBe("memory");
  });

  test("forget drops an entry in memory and on disk", async () => {
    const cache = createCache({ dir, now: clock });
    await cache.remember("k", 60_000, async () => "v", { disk: "text" });
    await cache.forget("k");
    expect(await readdir(dir)).toEqual([]);
    expect(await cache.remember("k", 60_000, async () => "w", { disk: "text" })).toBe("w");
  });

  test("temporary files a stopped write left behind are swept once they are an hour old", async () => {
    const left = join(dir, ".0123456789abcdef.tmp");
    const writing = join(dir, ".fedcba9876543210.tmp");
    await writeFile(left, "half an entry");
    await writeFile(writing, "an entry being written");
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    await utimes(left, twoHoursAgo, twoHoursAgo);
    await createCache({ dir, now: clock }).remember("k", 60_000, async () => "v", { disk: "text" });
    const names = await readdir(dir);
    expect(names).not.toContain(".0123456789abcdef.tmp");
    expect(names).toContain(".fedcba9876543210.tmp");
    expect(names.filter((name) => name.endsWith(".entry"))).toHaveLength(1);
  });

  test("entries a month past their time are swept when the cache first writes", async () => {
    const old = createCache({ dir, now: clock });
    await old.remember("old", 1_000, async () => "o", { disk: "text" });
    await old.remember("recent", 40 * 86_400_000, async () => "r", { disk: "text" });
    now += 31 * 86_400_000;
    await createCache({ dir, now: clock }).remember("new", 1_000, async () => "n", { disk: "text" });
    expect((await readdir(dir)).length).toBe(2);
    const fresh = createCache({ dir, now: clock });
    expect(await fresh.remember("recent", 1_000, async () => "reloaded", { disk: "text" })).toBe("r");
  });
});
