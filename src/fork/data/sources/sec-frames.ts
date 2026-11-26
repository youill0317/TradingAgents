// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * SEC's XBRL frames (data.sec.gov/api/xbrl/frames/<taxonomy>/<concept>/<unit>/<period>.json): one value of one
 * concept for every filer, for one calendar period, read for the sector screen (providers/frames.ts). Every
 * request goes through the fork's HTTP client, which sends SEC_USER_AGENT and keeps to SEC's 10 requests a second.
 *
 * What the answers are like (measured on SEC's own answers of 2026-11-25, kept in the SEC area's facts):
 * - {taxonomy, tag, ccp, uom, label, description, pts, data: [{accn, cik, entityName, loc, start, end, val}]}:
 *   exactly one row per CIK, `cik` a JSON number, `start` only on a duration; no form, no filing date, no fiscal
 *   year or period. `accn` is the latest filing that reported the value, often the next year's annual report
 *   giving it as a comparative, and an 8-K recast at times.
 * - An annual frame CY<year> holds periods of about a year (342 to 371 days, a few shorter) ending from about
 *   June 30 of that year to June 29 of the next: Walmart's year ending 2025-01-31 is in CY2024, Microsoft's ending
 *   2025-06-30 in CY2025. A fiscal year ending in a calendar year Y is therefore in CY<Y-1> or CY<Y>.
 * - An instant frame CY<year>Q<n>I holds the balance-sheet dates nearest the quarter's end: CY2024Q4I held dates
 *   from 2024-11-22 to 2025-02-04, quarter ends of quarterly reports among them (Apple's 2024-12-28), so an
 *   instant frame alone does not tell a fiscal year's end from a quarter's.
 * - A closed year's frame still changes as later reports give its values again: frames are kept a day.
 * - A concept nobody filed for a period has no frame: SEC answers 404 with its XML error page, read here as a
 *   frame without rows.
 * - Sizes: 0.35 to 0.84 MB for the frames measured (Assets CY2024Q4I, 6,284 rows), within the HTTP client's bound.
 *
 * A frame is kept in a smaller form than SEC's answer: per row its CIK, period, value and accession (the names
 * the screen shows come from the index lists), and when it was read (the engine's clock), since frames carry no
 * filing date and what they hold is known as of the reading.
 */
import { DataError } from "../../../data/errors.js";
import type { ForkDeps } from "../deps.js";
import { SEC_DATA_URL, SEC_SOURCE } from "./sec.js";
import { paddedCik } from "./sec-tickers.js";

/** How long a frame is kept: values arrive and are given again as companies file. */
export const FRAME_TTL_MS = 86_400_000;

/** The units frames are read in, as SEC's paths write them. */
export type FrameUnit = "USD" | "USD-per-shares" | "shares";

/** An annual frame's period (CY2024). */
export const annualFrame = (year: number) => `CY${year}`;

/** An instant frame's period: the balance-sheet dates nearest a calendar quarter's end (CY2024Q4I). */
export const instantFrame = (year: number, quarter: 1 | 2 | 3 | 4) => `CY${year}Q${quarter}I`;

export function frameUrl(concept: string, unit: FrameUnit, period: string, taxonomy = "us-gaap"): string {
  return `${SEC_DATA_URL}/api/xbrl/frames/${taxonomy}/${concept}/${unit}/${period}.json`;
}

/** One filer's value in a frame. */
export type FrameRow = {
  /** Ten digits, as data.sec.gov's paths take it. */
  cik: string;
  /** The period's first day; null for a balance-sheet date. */
  start: string | null;
  end: string;
  value: number;
  /** The latest filing that reported the value. */
  accession: string;
};

/** A frame as kept: rows as [cik, start, end, value, accession], and when it was read. */
export type Frame = {
  concept: string;
  unit: FrameUnit;
  period: string;
  /** Whether SEC has the frame at all: a concept nobody filed for the period has none. */
  found: boolean;
  rows: [number, string | null, string, number, string][];
  /** When it was read (the engine's clock): what it holds is known as of then. */
  read_at: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;

/** A time as answers state it: UTC, without milliseconds that are zero (2026-11-25T22:00:00Z). */
export function instantOf(date: Date): string {
  return date.toISOString().replace(/\.000Z$/, "Z");
}

const malformed = (concept: string, period: string) =>
  new DataError(
    "unavailable",
    `${SEC_SOURCE} answered the frame of ${concept} for ${period} in a form this app does not read.`,
    { source: SEC_SOURCE },
  );

/**
 * The rows of a frame answer: a duration frame's rows need a start, an instant frame's have none; a row whose
 * CIK, dates, value or accession cannot be read is left out.
 */
export function parseFrame(body: unknown, concept: string, period: string): Frame["rows"] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!body || typeof body !== "object" || !Array.isArray(data)) throw malformed(concept, period);
  const instant = period.endsWith("I");
  const rows: Frame["rows"] = [];
  for (const item of data) {
    const row = item as {
      accn?: unknown;
      cik?: unknown;
      start?: unknown;
      end?: unknown;
      val?: unknown;
    } | null;
    if (!row || typeof row !== "object") continue;
    const cik =
      typeof row.cik === "number" ? row.cik : typeof row.cik === "string" ? Number(row.cik) : Number.NaN;
    const start = typeof row.start === "string" && DATE.test(row.start) ? row.start : null;
    if (!Number.isInteger(cik) || cik <= 0 || cik > 9_999_999_999) continue;
    if (typeof row.end !== "string" || !DATE.test(row.end)) continue;
    if (typeof row.val !== "number" || !Number.isFinite(row.val)) continue;
    if (typeof row.accn !== "string" || !ACCESSION.test(row.accn)) continue;
    if (instant ? row.start !== undefined && row.start !== null : start === null) continue;
    rows.push([cik, start, row.end, row.val, row.accn]);
  }
  return rows;
}

/** Each frame's rows by CIK, made once per frame kept. */
const INDEXES = new WeakMap<Frame, Map<string, FrameRow>>();

/** A frame's row for a CIK (ten digits), if it has one. */
export function rowOf(frame: Frame, cik: string): FrameRow | undefined {
  let index = INDEXES.get(frame);
  if (!index) {
    index = new Map();
    for (const [number, start, end, value, accession] of frame.rows) {
      const padded = paddedCik(number);
      index.set(padded, { cik: padded, start, end, value, accession });
    }
    INDEXES.set(frame, index);
  }
  return index.get(cik);
}

export type SecFrames = {
  /** A frame of a us-gaap concept, kept a day (on disk too) and served past its day when SEC cannot be read. */
  frame(concept: string, unit: FrameUnit, period: string, call?: { signal?: AbortSignal }): Promise<Frame>;
};

export function secFrames(deps: ForkDeps): SecFrames {
  return {
    async frame(concept, unit, period, call = {}) {
      const { signal } = call;
      const kept = await deps.cache.keep<Frame>(
        `sec:frame:us-gaap:${concept}:${unit}:${period}:v1`,
        FRAME_TTL_MS,
        async () => {
          const read_at = instantOf(deps.clock());
          let body: unknown;
          try {
            body = await deps.http.json(frameUrl(concept, unit, period), { source: SEC_SOURCE, signal });
          } catch (error) {
            // No frame: nobody filed the concept for the period (or SEC has not made it yet).
            if (error instanceof DataError && error.kind === "no_data" && error.details.status === 404) {
              return { concept, unit, period, found: false, rows: [], read_at };
            }
            throw error;
          }
          return { concept, unit, period, found: true, rows: parseFrame(body, concept, period), read_at };
        },
        { disk: "json", staleOnError: true, signal },
      );
      return kept.value;
    },
  };
}
