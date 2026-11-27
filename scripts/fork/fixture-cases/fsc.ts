// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of the FSC's stock prices on data.go.kr, for the FSC provider's tests (test/fork/data/fsc*.test.ts):
 * getStockPriceInfo's answers for Samsung Electronics (005930), its preferred shares (005935), JYP
 * Entertainment (035900, KOSDAQ) and KODEX 200 (069500, a fund the stock prices do not list), each over the
 * sessions from 2026-10-12 to 2026-11-24, as the provider asks (sources/fsc.ts: the first address, the key
 * encoded once, 10,000 rows a page, JSON). DATA_GO_KR_API_KEY comes from the settings (the environment, else
 * credentials.json's "data"), never from here; the recorder removes it from the answer and its meta.
 *
 * Each case reads its answer itself so that data.go.kr's failures, which its gateway answers in XML even with
 * HTTP 200 (a key not registered for the service, the day's requests spent), fail the case and write nothing.
 * The repository's fixtures of these names are hand-made in the documented form until the owner records them;
 * recording replaces their invented prices with KRX's, so the golden texts of those tests then need bringing up
 * to date.
 */
import { resolvePaths } from "../../../src/config/paths.js";
import { type PublicDataConfig, publicDataConfig } from "../../../src/fork/data/config.js";
import type { Http } from "../../../src/fork/data/http.js";
import {
  FSC_ADDRESSES,
  FSC_PAGE_ROWS,
  serviceKeyParam,
  withoutServiceKey,
} from "../../../src/fork/data/sources/fsc.js";
import type { FixtureCase, Recorded } from "../record-fixtures.ts";

/** The settings as the app reads them: the key is taken from them when a case runs, never at import. */
async function settings(): Promise<PublicDataConfig> {
  return (await publicDataConfig(process.env, resolvePaths(process.env))).config;
}

/** The address of a share's prices over the recorded sessions (the key encoded once, as the provider sends it). */
export function pricesUrl(key: string, code: string): string {
  const query = new URLSearchParams({
    numOfRows: String(FSC_PAGE_ROWS),
    pageNo: "1",
    resultType: "json",
    likeSrtnCd: code,
    beginBasDt: "20261012",
    endBasDt: "20261125",
  });
  return `${FSC_ADDRESSES[0]}?serviceKey=${serviceKeyParam(key)}&${query}`;
}

/** The answer read, refused unless it is the service's own JSON with resultCode 00. */
async function read(http: Http, code: string): Promise<Recorded> {
  const key = (await settings()).dataGoKrKey;
  if (!key) throw new Error("DATA_GO_KR_API_KEY is not set");
  const url = pricesUrl(key, code);
  const answer = await http.get(url, {
    source: "FSC",
    headers: { Accept: "application/json" },
    redirect: "same-origin",
  });
  const body = await answer.text();
  let result: unknown;
  try {
    result = (JSON.parse(body) as { response?: { header?: { resultCode?: unknown } } }).response?.header
      ?.resultCode;
  } catch {
    result = undefined;
  }
  if (result !== "00") {
    // The settings' keys are removed before the body is cut, so no part of one is left at the cut.
    const said = withoutServiceKey(http.redact(body.trim())).slice(0, 160);
    throw new Error(`data.go.kr answered something other than the service's prices (${said})`);
  }
  return {
    body,
    status: answer.status,
    url,
    ...(answer.headers.get("content-type")
      ? { contentType: answer.headers.get("content-type") as string }
      : {}),
  };
}

const prices = (code: string): FixtureCase => ({
  source: "fsc",
  name: `stock-price-${code}`,
  read: (http) => read(http, code),
  file: `stock-price-${code}.json`,
});

export const cases: FixtureCase[] = [prices("005930"), prices("005935"), prices("035900"), prices("069500")];
