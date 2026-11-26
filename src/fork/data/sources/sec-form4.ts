// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Insider ownership reports (SEC Forms 3, 4 and 5) as filed in EDGAR's ownership XML: who reported (the
 * reporting owners and their relationship to the issuer), and each transaction of the non-derivative and
 * derivative tables (date, code, shares, price, acquired or disposed, holding after; for a derivative its
 * exercise price and underlying security). Read with util/xml.ts, which never throws on hostile input.
 *
 * Where the XML is: an issuer's filing index lists each report with its primary document in a stylesheet
 * folder ("xslF345X06/form4.xml", the page EDGAR renders); the raw XML is the same name without that folder,
 * in the filing's folder: https://www.sec.gov/Archives/edgar/data/<CIK>/<accession without dashes>/form4.xml.
 * The element names follow SEC's EDGAR Ownership XML Technical Specification (ownershipDocument, issuer,
 * reportingOwner, nonDerivativeTable, derivativeTable, values inside <value> elements, footnotes by
 * <footnoteId>). www.sec.gov answers only a User-Agent naming a contact, so the fixtures these are tested on
 * are hand-made in that format and listed for a live check.
 */
import type { ForkDeps } from "../deps.js";
import { child, children, parseXml, valueAt, type XmlElement } from "../util/xml.js";
import { archiveUrl, type FilingRow, SEC_SOURCE } from "./sec.js";
import { paddedCik } from "./sec-tickers.js";

/** The forms whose reports carry insider transactions (Form 3 states holdings only, so it is not read). */
export const TRANSACTION_FORMS: ReadonlySet<string> = new Set(["4", "4/A", "5", "5/A"]);

/** How long a parsed report is kept: a filed report never changes (an amendment is a filing of its own). */
export const OWNERSHIP_TTL_MS = 30 * 86_400_000;

/** One reporting owner and how it relates to the issuer. */
export type OwnershipOwner = {
  cik: string | null;
  name: string | null;
  isDirector: boolean | null;
  isOfficer: boolean | null;
  isTenPercentOwner: boolean | null;
  isOther: boolean | null;
  officerTitle: string | null;
  otherText: string | null;
};

/** One transaction of a report's non-derivative or derivative table. */
export type OwnershipTransaction = {
  derivative: boolean;
  securityTitle: string | null;
  /** YYYY-MM-DD. */
  date: string | null;
  /** The form the transaction is reported on ("4", "5"), and its one-letter code ("P", "S", "M"...). */
  formType: string | null;
  code: string | null;
  equitySwap: boolean | null;
  shares: number | null;
  price: number | null;
  acquiredDisposed: "A" | "D" | null;
  ownedFollowing: number | null;
  /** D (direct) or I (indirect), and how an indirect holding is held. */
  directOrIndirect: "D" | "I" | null;
  natureOfOwnership: string | null;
  conversionOrExercisePrice: number | null;
  exerciseDate: string | null;
  expirationDate: string | null;
  underlyingTitle: string | null;
  underlyingShares: number | null;
};

/** A report read: its type and period, the issuer, the owners and the transactions, in the document's order. */
export type OwnershipDocument = {
  documentType: string | null;
  periodOfReport: string | null;
  /** The issuer's CIK, ten digits. */
  issuerCik: string | null;
  issuerName: string | null;
  issuerSymbol: string | null;
  /** Whether the report says the trades were made under a Rule 10b5-1 plan (schemas from X0508 on). */
  rule10b5One: boolean | null;
  owners: OwnershipOwner[];
  transactions: OwnershipTransaction[];
};

/**
 * The raw XML's name for a report's primary document as the index lists it ("xslF345X06/form4.xml" is
 * "form4.xml"); undefined when it is not an XML document (reports filed before XML, in 2003, were HTML or text).
 */
export function rawOwnershipDocument(primaryDocument: string): string | undefined {
  const raw = primaryDocument.replace(/^xslF345X\d{2}\//i, "");
  return /^[^/]+\.xml$/i.test(raw) ? raw : undefined;
}

const text = (value: string | undefined) =>
  value === undefined ? null : value.replace(/\s+/g, " ").trim() || null;

function flag(value: string | undefined): boolean | null {
  const said = value?.trim().toLowerCase();
  if (said === "1" || said === "true") return true;
  if (said === "0" || said === "false") return false;
  return null;
}

function number(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value.replace(/,/g, "").trim());
  return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
}

/** A date as XML writes it (an offset may follow: "2026-11-17-05:00"), as YYYY-MM-DD. */
function day(value: string | undefined): string | null {
  const match = value?.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? (match[1] as string) : null;
}

function letter<T extends string>(value: string | undefined, allowed: readonly T[]): T | null {
  const said = value?.trim().toUpperCase();
  return allowed.includes(said as T) ? (said as T) : null;
}

function transaction(element: XmlElement, derivative: boolean): OwnershipTransaction {
  const at = (path: string) => valueAt(element, path);
  return {
    derivative,
    securityTitle: text(at("securityTitle/value")),
    date: day(at("transactionDate/value")),
    formType: text(at("transactionCoding/transactionFormType")),
    code: text(at("transactionCoding/transactionCode"))?.toUpperCase() ?? null,
    equitySwap: flag(at("transactionCoding/equitySwapInvolved")),
    shares: number(at("transactionAmounts/transactionShares/value")),
    price: number(at("transactionAmounts/transactionPricePerShare/value")),
    acquiredDisposed: letter(at("transactionAmounts/transactionAcquiredDisposedCode/value"), ["A", "D"]),
    ownedFollowing: number(at("postTransactionAmounts/sharesOwnedFollowingTransaction/value")),
    directOrIndirect: letter(at("ownershipNature/directOrIndirectOwnership/value"), ["D", "I"]),
    natureOfOwnership: text(at("ownershipNature/natureOfOwnership/value")),
    conversionOrExercisePrice: derivative ? number(at("conversionOrExercisePrice/value")) : null,
    exerciseDate: derivative ? day(at("exerciseDate/value")) : null,
    expirationDate: derivative ? day(at("expirationDate/value")) : null,
    underlyingTitle: derivative ? text(at("underlyingSecurity/underlyingSecurityTitle/value")) : null,
    underlyingShares: derivative ? number(at("underlyingSecurity/underlyingSecurityShares/value")) : null,
  };
}

function owner(element: XmlElement): OwnershipOwner {
  const at = (path: string) => valueAt(element, path);
  const cik = at("reportingOwnerId/rptOwnerCik");
  return {
    cik: cik && /^\d{1,10}$/.test(cik) ? paddedCik(cik) : null,
    name: text(at("reportingOwnerId/rptOwnerName")),
    isDirector: flag(at("reportingOwnerRelationship/isDirector")),
    isOfficer: flag(at("reportingOwnerRelationship/isOfficer")),
    isTenPercentOwner: flag(at("reportingOwnerRelationship/isTenPercentOwner")),
    isOther: flag(at("reportingOwnerRelationship/isOther")),
    officerTitle: text(at("reportingOwnerRelationship/officerTitle")),
    otherText: text(at("reportingOwnerRelationship/otherText")),
  };
}

/** A Form 3, 4 or 5 as filed in XML; undefined when the text is not an ownership document. */
export function parseOwnership(xml: string): OwnershipDocument | undefined {
  const root = child(parseXml(xml), "ownershipDocument");
  if (!root) return undefined;
  const issuerCik = valueAt(root, "issuer/issuerCik");
  const rows = (table: string, row: string, derivative: boolean) => {
    const found = child(root, table);
    return found ? children(found, row).map((element) => transaction(element, derivative)) : [];
  };
  return {
    documentType: text(valueAt(root, "documentType")),
    periodOfReport: day(valueAt(root, "periodOfReport")),
    issuerCik: issuerCik && /^\d{1,10}$/.test(issuerCik) ? paddedCik(issuerCik) : null,
    issuerName: text(valueAt(root, "issuer/issuerName")),
    issuerSymbol: text(valueAt(root, "issuer/issuerTradingSymbol")),
    rule10b5One: flag(valueAt(root, "aff10b5One")),
    owners: children(root, "reportingOwner").map(owner),
    transactions: [
      ...rows("nonDerivativeTable", "nonDerivativeTransaction", false),
      ...rows("derivativeTable", "derivativeTransaction", true),
    ],
  };
}

/** A report as read: the document, or why it could not be read (it is then left out, and coverage says so). */
export type OwnershipRead = { document: OwnershipDocument } | { document: null; why: string };

/**
 * The report `row` of the issuer `cik`, from its raw XML in EDGAR's archives, kept a month (on disk too).
 * A report with no XML document, a document SEC does not have, and one that is not an ownership document are
 * answered with why; a source failure (unavailable, rate limited, refused) is thrown.
 */
export async function readOwnership(
  deps: ForkDeps,
  cik: string,
  row: FilingRow,
  call?: { signal?: AbortSignal },
): Promise<OwnershipRead> {
  const raw = rawOwnershipDocument(row.primaryDocument);
  if (!raw) return { document: null, why: `no XML document (${row.primaryDocument || "none named"})` };
  return deps.cache.remember<OwnershipRead>(
    `sec:ownership:${row.accession}`,
    OWNERSHIP_TTL_MS,
    async () => {
      let xml: string;
      try {
        xml = await deps.http.text(archiveUrl(cik, row.accession, raw), {
          source: SEC_SOURCE,
          signal: call?.signal,
          notFound: "no_data",
        });
      } catch (error) {
        if ((error as { kind?: unknown }).kind === "no_data") {
          return { document: null, why: `${raw} is not in the filing's folder` };
        }
        throw error;
      }
      const document = parseOwnership(xml);
      return document ? { document } : { document: null, why: `${raw} is not an ownership document` };
    },
    { disk: "json", signal: call?.signal },
  );
}
