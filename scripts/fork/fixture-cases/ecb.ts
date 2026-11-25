// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Fixtures of the ECB's data API (no key): the euro reference rate of the US dollar, and the answer for a
 * currency it has no series for (404, problem+json), recorded as answered.
 */
import type { FixtureCase } from "../record-fixtures.ts";

const EXR = "https://data-api.ecb.europa.eu/service/data/EXR";

export const cases: FixtureCase[] = [
  {
    source: "ecb",
    name: "exr-usd-last5",
    url: `${EXR}/D.USD.EUR.SP00.A?format=csvdata&lastNObservations=5`,
  },
  {
    source: "ecb",
    name: "exr-unknown-currency",
    url: `${EXR}/D.XXX.EUR.SP00.A?format=csvdata&lastNObservations=1`,
    accept: [404],
  },
];
