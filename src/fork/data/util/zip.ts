// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * A small ZIP reader for the archives public sources answer with (OpenDART's corpCode.xml and report
 * documents): the central directory is read from the end-of-central-directory record, and an entry's data
 * from its local header, stored or deflated (node:zlib's inflateRawSync), checked against its declared size
 * and CRC-32. ZIP64 archives, encrypted entries and other compression methods are refused with a
 * ZipError, as is anything that points outside the archive; nothing here recurses or reads past the bytes.
 *
 * An entry larger than `maxEntryBytes` is refused before it is inflated: protection against an archive
 * that inflates far beyond any real answer (the largest one the fork reads, OpenDART's corpCode.xml, is
 * tens of megabytes), not a limit on use.
 */
import { crc32, inflateRawSync } from "node:zlib";
import { ANSWER_BYTES } from "../../../contracts/limits.js";

/** The largest entry inflated by default: sixteen times the largest answer read over HTTP (256 MiB). */
export const ZIP_ENTRY_BYTES = 16 * ANSWER_BYTES;

export class ZipError extends Error {
  override readonly name = "ZipError";
}

export type ZipEntry = {
  /** The path inside the archive, as stored ("CORPCODE.xml", "docs/a.xml"). */
  name: string;
  /** 0 stored, 8 deflated; others are listed but cannot be read. */
  method: number;
  compressedSize: number;
  /** The size its data inflates to, as the archive declares it. */
  size: number;
  crc32: number;
  /** A directory: a name ending in "/", with no data. */
  directory: boolean;
  /** Its data, inflated and checked; a ZipError when it cannot be read. */
  bytes(): Uint8Array;
  /** Its data as UTF-8 text. */
  text(): string;
};

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The entries of the archive in `bytes`, in central-directory order. */
export function readZip(
  bytes: Uint8Array,
  { maxEntryBytes = ZIP_ENTRY_BYTES }: { maxEntryBytes?: number } = {},
): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endRecord(view);
  const total = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  // A ZIP64 archive marks the classic fields it outgrew; one whose classic fields still hold is read as one.
  if (total === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new ZipError("a ZIP64 archive, which is not read");
  }
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) {
    throw new ZipError("an archive split across disks, which is not read");
  }
  if (offset + size > end) throw new ZipError("its central directory lies outside the archive");
  const entries: ZipEntry[] = [];
  let at = offset;
  for (let index = 0; index < total; index++) {
    if (at + 46 > offset + size || view.getUint32(at, true) !== CENTRAL) {
      throw new ZipError(`its central directory is damaged at entry ${index + 1}`);
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const checksum = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const declared = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const nameEnd = at + 46 + nameLength;
    if (nameEnd > bytes.length) throw new ZipError(`its central directory is damaged at entry ${index + 1}`);
    const name = decodeName(bytes.subarray(at + 46, nameEnd), (flags & 0x800) !== 0);
    at = nameEnd + extraLength + commentLength;
    const entry: ZipEntry = {
      name,
      method,
      compressedSize,
      size: declared,
      crc32: checksum,
      directory: name.endsWith("/"),
      bytes: () => entryData(bytes, view, { name, flags, method, compressedSize, declared, checksum, local }, maxEntryBytes),
      text: () => new TextDecoder().decode(entry.bytes()),
    };
    entries.push(entry);
  }
  return entries;
}

/** The entry named `name` (exactly, else ignoring case), if the archive has it. */
export function zipEntry(entries: readonly ZipEntry[], name: string): ZipEntry | undefined {
  return (
    entries.find((entry) => entry.name === name) ??
    entries.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
  );
}

/** Where the end-of-central-directory record starts: the last signature whose comment ends the archive. */
function endRecord(view: DataView): number {
  if (view.byteLength < 22) throw new ZipError("too short to be a ZIP archive");
  const lowest = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let at = view.byteLength - 22; at >= lowest; at--) {
    if (view.getUint32(at, true) !== EOCD) continue;
    const comment = view.getUint16(at + 20, true);
    if (at + 22 + comment <= view.byteLength) return at;
  }
  throw new ZipError("no end-of-central-directory record: not a ZIP archive, or a truncated one");
}

/** A name as stored: UTF-8 when its flag says so, else each byte as one character (ASCII names read right). */
function decodeName(raw: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder().decode(raw);
  let name = "";
  for (const byte of raw) name += String.fromCharCode(byte);
  return name;
}

function entryData(
  bytes: Uint8Array,
  view: DataView,
  entry: {
    name: string;
    flags: number;
    method: number;
    compressedSize: number;
    declared: number;
    checksum: number;
    local: number;
  },
  maxEntryBytes: number,
): Uint8Array {
  const { name, flags, method, compressedSize, declared, checksum, local } = entry;
  if (flags & 0x1) throw new ZipError(`${name} is encrypted`);
  if (method !== 0 && method !== 8) throw new ZipError(`${name} uses compression method ${method}, which is not read`);
  if (declared > maxEntryBytes) {
    throw new ZipError(`${name} declares ${declared} bytes, more than the ${maxEntryBytes} read`);
  }
  if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL) {
    throw new ZipError(`${name}: its local header is missing or damaged`);
  }
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  if (start + compressedSize > bytes.length) throw new ZipError(`${name}: its data runs past the archive`);
  const raw = bytes.subarray(start, start + compressedSize);
  let data: Uint8Array;
  if (method === 0) {
    if (compressedSize !== declared) throw new ZipError(`${name}: stored data of the wrong size`);
    data = raw;
  } else {
    try {
      // The declared size bounds the output: data that inflates past it is damaged.
      data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(declared, 1) }));
    } catch (error) {
      throw new ZipError(`${name}: its deflated data is damaged (${(error as Error).message})`);
    }
  }
  if (data.length !== declared) throw new ZipError(`${name}: inflated to ${data.length} bytes, not ${declared}`);
  if ((crc32(data) >>> 0) !== checksum >>> 0) throw new ZipError(`${name}: its CRC-32 does not match`);
  return data;
}
