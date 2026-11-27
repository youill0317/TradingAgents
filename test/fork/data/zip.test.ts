// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/** The ZIP reader on archives written here: stored and deflated entries, and every way one can be damaged. */
import { describe, expect, test } from "bun:test";
import { crc32, deflateRawSync } from "node:zlib";
import { readZip, ZipError, zipEntry } from "../../../src/fork/data/util/zip.js";

type Entry = {
  name: string;
  data: string | Uint8Array;
  method?: 0 | 8;
  flags?: number;
  /** Values written in place of the true ones, to damage the archive. */
  size?: number;
  compressedSize?: number;
  crc?: number;
};

const bytesOf = (data: string | Uint8Array) =>
  typeof data === "string" ? new TextEncoder().encode(data) : data;

/** An archive of `entries`, as a ZIP writer lays one out: local headers and data, then the directory, then its end. */
function zip(entries: readonly Entry[], { comment = "" }: { comment?: string } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = bytesOf(entry.data);
    const method = entry.method ?? 8;
    const stored = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const name = new TextEncoder().encode(entry.name);
    const crc = entry.crc ?? crc32(data) >>> 0;
    const size = entry.size ?? data.length;
    const compressed = entry.compressedSize ?? stored.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, entry.flags ?? 0, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, compressed, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, stored);
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, entry.flags ?? 0, true);
    record.setUint16(10, method, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, compressed, true);
    record.setUint32(24, size, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), name);
    offset += 30 + name.length + stored.length;
  }
  const directory = Buffer.concat(central);
  const note = new TextEncoder().encode(comment);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directory.length, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, note.length, true);
  return new Uint8Array(Buffer.concat([...parts, directory, new Uint8Array(end.buffer), note]));
}

describe("reading", () => {
  test("stored and deflated entries, with their names and sizes", () => {
    const text = "<result><list><corp_code>00126380</corp_code></list></result>".repeat(50);
    const entries = readZip(
      zip([
        { name: "CORPCODE.xml", data: text },
        { name: "notes/readme.txt", data: "stored as is", method: 0 },
        { name: "notes/", data: "", method: 0 },
      ]),
    );
    expect(entries.map((entry) => [entry.name, entry.method, entry.size, entry.directory])).toEqual([
      ["CORPCODE.xml", 8, text.length, false],
      ["notes/readme.txt", 0, 12, false],
      ["notes/", 0, 0, true],
    ]);
    expect(entries[0]?.compressedSize).toBeLessThan(text.length);
    expect(entries[0]?.text()).toBe(text);
    expect(entries[1]?.text()).toBe("stored as is");
    expect(zipEntry(entries, "corpcode.XML")?.name).toBe("CORPCODE.xml");
    expect(zipEntry(entries, "missing.xml")).toBeUndefined();
  });

  test("an archive comment, an empty archive, an empty entry", () => {
    expect(
      readZip(
        zip([{ name: "a.txt", data: "a" }], { comment: "PK\u0005\u0006 looks like an end" }),
      )[0]?.text(),
    ).toBe("a");
    expect(readZip(zip([]))).toEqual([]);
    expect(readZip(zip([{ name: "empty.txt", data: "" }]))[0]?.bytes()).toEqual(new Uint8Array());
  });

  test("a UTF-8 name, flagged as such", () => {
    const entries = readZip(zip([{ name: "사업보고서.xml", data: "x", flags: 0x800 }]));
    expect(entries[0]?.name).toBe("사업보고서.xml");
  });

  test("an archive at an offset into a larger buffer", () => {
    const archive = zip([{ name: "a.txt", data: "inside" }]);
    const padded = new Uint8Array(archive.length + 10);
    padded.set(archive, 7);
    expect(readZip(padded.subarray(7, 7 + archive.length))[0]?.text()).toBe("inside");
  });
});

describe("damaged or unread archives fail with a ZipError, never a crash or a wrong answer", () => {
  const failsWith = (run: () => unknown, words: string) => {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZipError);
    expect((caught as Error).message).toContain(words);
  };

  test("not an archive, or one cut short", () => {
    failsWith(() => readZip(new Uint8Array([1, 2, 3])), "too short");
    failsWith(
      () => readZip(new TextEncoder().encode("<html>not a zip, just a page long enough</html>")),
      "no end",
    );
    const archive = zip([{ name: "a.txt", data: "some data to cut" }]);
    failsWith(() => readZip(archive.subarray(0, archive.length - 5)), "no end");
  });

  test("a directory that points outside the archive", () => {
    const archive = zip([{ name: "a.txt", data: "abc" }]);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const end = archive.length - 22;
    view.setUint32(end + 16, archive.length, true);
    failsWith(() => readZip(archive), "outside the archive");
  });

  test("a directory entry with the wrong signature", () => {
    const archive = zip([{ name: "a.txt", data: "abc" }]);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    view.setUint32(view.getUint32(archive.length - 22 + 16, true), 0x12345678, true);
    failsWith(() => readZip(archive), "damaged at entry 1");
  });

  test("an entry whose local header is elsewhere", () => {
    const archive = zip([{ name: "a.txt", data: "abc" }]);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const directory = view.getUint32(archive.length - 22 + 16, true);
    view.setUint32(directory + 42, 3, true);
    const [entry] = readZip(archive);
    failsWith(() => entry?.bytes(), "local header");
  });

  test("data past the end of the archive", () => {
    const [entry] = readZip(zip([{ name: "a.txt", data: "abc", compressedSize: 1_000_000 }]));
    failsWith(() => entry?.bytes(), "runs past the archive");
  });

  test("a CRC that does not match, a size that does not match", () => {
    failsWith(() => readZip(zip([{ name: "a.txt", data: "abc", crc: 1 }]))[0]?.bytes(), "CRC-32");
    failsWith(() => readZip(zip([{ name: "a.txt", data: "abcdef", size: 3 }]))[0]?.bytes(), "damaged");
    failsWith(
      () => readZip(zip([{ name: "a.txt", data: "abc", size: 10 }]))[0]?.bytes(),
      "inflated to 3 bytes",
    );
    failsWith(
      () => readZip(zip([{ name: "a.txt", data: "abc", method: 0, size: 2 }]))[0]?.bytes(),
      "wrong size",
    );
  });

  test("deflated data that is not deflate", () => {
    const archive = zip([{ name: "a.txt", data: "abc", method: 0 }]);
    // Marked deflated while stored: inflating three plain bytes fails or yields the wrong size.
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const directory = view.getUint32(archive.length - 22 + 16, true);
    view.setUint16(directory + 10, 8, true);
    failsWith(() => readZip(archive)[0]?.bytes(), "a.txt");
  });

  test("an encrypted entry, another compression method", () => {
    failsWith(() => readZip(zip([{ name: "a.txt", data: "abc", flags: 1 }]))[0]?.bytes(), "encrypted");
    const archive = zip([{ name: "a.txt", data: "abc", method: 0 }]);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    view.setUint16(view.getUint32(archive.length - 22 + 16, true) + 10, 12, true);
    failsWith(() => readZip(archive)[0]?.bytes(), "compression method 12");
  });

  test("a ZIP64 archive", () => {
    const archive = zip([{ name: "a.txt", data: "abc" }]);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    view.setUint32(archive.length - 22 + 16, 0xffffffff, true);
    failsWith(() => readZip(archive), "ZIP64");
  });

  test("an end record that counts more entries than its directory holds", () => {
    const archive = zip([{ name: "a.txt", data: "abc" }]);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    view.setUint16(archive.length - 22 + 10, 3, true);
    failsWith(() => readZip(archive), "damaged at entry 2");
  });

  test("a name that runs past the archive", () => {
    const archive = zip([{ name: "a.txt", data: "abc" }]);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const directory = view.getUint32(archive.length - 22 + 16, true);
    view.setUint16(directory + 28, 60_000, true);
    failsWith(() => readZip(archive), "damaged at entry 1");
  });

  test("an archive split across disks", () => {
    const archive = zip([{ name: "a.txt", data: "abc" }]);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    view.setUint16(archive.length - 22 + 4, 1, true);
    failsWith(() => readZip(archive), "split across disks");
  });

  test("two entries pointing at one local header read the same data, each checked", () => {
    const archive = zip([
      { name: "a.txt", data: "same" },
      { name: "b.txt", data: "same" },
    ]);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const directory = view.getUint32(archive.length - 22 + 16, true);
    const second = directory + 46 + "a.txt".length;
    view.setUint32(second + 42, 0, true);
    const entries = readZip(archive);
    expect(entries.map((entry) => entry.text())).toEqual(["same", "same"]);
  });

  test("an entry that declares more than may be inflated, refused before it is", () => {
    const big = "x".repeat(10_000);
    const [entry] = readZip(zip([{ name: "big.txt", data: big }]), { maxEntryBytes: 1_000 });
    failsWith(() => entry?.bytes(), "declares 10000 bytes");
  });

  test("an entry that inflates past what it declares (a bomb) stops at the declared size", () => {
    const bomb = "0".repeat(5_000_000);
    const [entry] = readZip(zip([{ name: "bomb.txt", data: bomb, size: 100 }]));
    failsWith(() => entry?.bytes(), "bomb.txt");
  });
});
