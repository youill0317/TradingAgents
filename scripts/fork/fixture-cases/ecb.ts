// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of the ECB's data API (no key), for the ECB provider's tests (test/fork/data/ecb.test.ts) and the
 * key interest rates in the statistics provider's: euro reference rates (EXR) as the provider asks for them
 * (one currency, a cross's two in one request, a window ending in the past), a full-detail answer with its
 * quoted titles, the 404 of a currency the ECB does not know, and the key interest rates (FM): the deposit
 * facility rate's days since 2024 (the provider's newest window in 2026) and the three rates' latest days.
 *
 * The fixtures in the repository are the ECB's own answers saved earlier (fm-dfr-since2024 cut to the deposit
 * facility rate's rows of a request for all three); recording replaces them with the ECB's current answers,
 * so the golden texts in those tests then need bringing up to date.
 */
import type { FixtureCase } from "../record-fixtures.ts";

const EXR = "https://data-api.ecb.europa.eu/service/data/EXR";
const FM = "https://data-api.ecb.europa.eu/service/data/FM";

export const cases: FixtureCase[] = [
  {
    source: "ecb",
    name: "exr-usd-last5",
    url: `${EXR}/D.USD.EUR.SP00.A?format=csvdata&lastNObservations=5`,
  },
  {
    source: "ecb",
    name: "exr-krw-usd-2026-11",
    url: `${EXR}/D.KRW+USD.EUR.SP00.A?format=csvdata&detail=dataonly&startPeriod=2026-11-16&endPeriod=2026-11-25`,
  },
  {
    source: "ecb",
    name: "exr-usd-end-last5",
    url: `${EXR}/D.USD.EUR.SP00.A?format=csvdata&detail=dataonly&endPeriod=2026-10-31&lastNObservations=5`,
  },
  {
    source: "ecb",
    name: "exr-krw-2026-11",
    url: `${EXR}/D.KRW.EUR.SP00.A?format=csvdata&startPeriod=2026-11-01`,
  },
  {
    // A currency the ECB does not quote: its 404, kept deliberately.
    source: "ecb",
    name: "exr-xxx-nodata",
    url: `${EXR}/D.XXX.EUR.SP00.A?format=csvdata&lastNObservations=1`,
    accept: [404],
    file: "exr-xxx-nodata.json",
  },
  {
    source: "ecb",
    name: "fm-dfr-since2024",
    url: `${FM}/D.U2.EUR.4F.KR.DFR.LEV?format=csvdata&detail=dataonly&startPeriod=2024-01-01`,
  },
  {
    source: "ecb",
    name: "fm-policy-last3",
    url: `${FM}/D.U2.EUR.4F.KR.DFR+MRR_FR+MLFR.LEV?format=csvdata&lastNObservations=3`,
  },
];
