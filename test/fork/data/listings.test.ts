// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Every key form the tools may pass, read into a listing: each example the tool texts show (tool-text.ts),
 * the forms the instrument and symbol schemas hand over (security: prefixed, upper-cased typed keys), and
 * Korean listings in all four spellings.
 */
import { describe, expect, test } from "bun:test";
import { canonicalKey, notPriced, parseListing } from "../../../src/fork/data/listings.js";
import { instrument, symbol } from "../../../src/tools/tool-text.js";

describe("the tool texts' examples", () => {
  test("each is accepted, as the instrument schema hands it over", () => {
    const handed = [
      "AAPL",
      "XNAS:AAPL",
      "future:XNYM:CL",
      "fx:EURUSD",
      "crypto:BTC-USDT",
      "series:us.equity_index.sp500",
    ].map((key) => instrument.parse(key));
    expect(handed.map((key) => parseListing(key).kind)).toEqual([
      "us",
      "venue",
      "future",
      "fx",
      "crypto",
      "price_series",
    ]);
  });

  test("crypto:BTC-USDT reads as Yahoo's BTC-USD pair, and says so", () => {
    expect(parseListing("crypto:BTC-USDT")).toEqual({
      kind: "crypto",
      key: "crypto:BTC-USD",
      base: "BTC",
      quote: "USD",
      yahoo: "BTC-USD",
      note: "crypto:BTC-USDT is read as BTC-USD: Yahoo lists crypto pairs against USD, not against USDT",
    });
    expect(parseListing("crypto:ETH-USDC")).toMatchObject({ key: "crypto:ETH-USD", yahoo: "ETH-USD" });
    expect(parseListing("crypto:btc-usd")).toEqual({
      kind: "crypto",
      key: "crypto:BTC-USD",
      base: "BTC",
      quote: "USD",
      yahoo: "BTC-USD",
    });
    expect(parseListing("crypto:ETH-EUR")).toMatchObject({ key: "crypto:ETH-EUR", yahoo: "ETH-EUR" });
  });

  test("a price series names its Yahoo symbol; an unknown one in a price family has none", () => {
    expect(parseListing("series:us.equity_index.sp500")).toEqual({
      kind: "price_series",
      key: "series:us.equity_index.sp500",
      series: { yahoo: "^GSPC", name: "S&P 500", type: "index", currency: "USD" },
      yahoo: "^GSPC",
    });
    expect(parseListing("series:kr.equity_index.kospi")).toMatchObject({ yahoo: "^KS11" });
    expect(parseListing("series:us.volatility.vix")).toMatchObject({ yahoo: "^VIX" });
    expect(parseListing("series:zz.equity_index.nothing")).toEqual({
      kind: "price_series",
      key: "series:zz.equity_index.nothing",
      series: null,
      yahoo: null,
    });
  });
});

describe("US listings and venues", () => {
  test("a bare ticker; share classes spelled with a dash; security: prefixed", () => {
    expect(parseListing("AAPL")).toEqual({ kind: "us", key: "AAPL", ticker: "AAPL", yahoo: "AAPL" });
    expect(parseListing("brk.b")).toEqual({ kind: "us", key: "BRK-B", ticker: "BRK-B", yahoo: "BRK-B" });
    expect(parseListing("BRK-B")).toMatchObject({ key: "BRK-B" });
    expect(parseListing("security:AAPL")).toMatchObject({ kind: "us", key: "AAPL" });
    expect(parseListing(" security:xnas:aapl ")).toMatchObject({ kind: "venue", key: "XNAS:AAPL" });
  });

  test("MIC:SYMBOL, with Yahoo's spelling where Yahoo lists the venue", () => {
    expect(parseListing("XNYS:BRK.B")).toEqual({
      kind: "venue",
      key: "XNYS:BRK.B",
      mic: "XNYS",
      symbol: "BRK.B",
      yahoo: "BRK-B",
    });
    expect(parseListing("XHKG:700")).toMatchObject({ yahoo: "0700.HK" });
    expect(parseListing("XLON:BT.A")).toMatchObject({ yahoo: "BT-A.L" });
    expect(parseListing("XTKS:7203")).toMatchObject({ yahoo: "7203.T" });
    expect(parseListing("XSWX:NESN")).toMatchObject({ kind: "venue", yahoo: null });
  });
});

describe("Korean listings", () => {
  test("XKRX: and XKOS: are canonical", () => {
    expect(parseListing("XKRX:005930")).toEqual({
      kind: "kr",
      key: "XKRX:005930",
      code: "005930",
      market: "XKRX",
      yahoo: ["005930.KS"],
    });
    expect(parseListing("XKOS:035900")).toEqual({
      kind: "kr",
      key: "XKOS:035900",
      code: "035900",
      market: "XKOS",
      yahoo: ["035900.KQ"],
    });
    expect(parseListing("XKRX:0088M0")).toMatchObject({ key: "XKRX:0088M0", yahoo: ["0088M0.KS"] });
  });

  test(".KS and .KQ name the same listings, in any case", () => {
    expect(canonicalKey("005930.KS")).toBe("XKRX:005930");
    expect(canonicalKey("005930.ks")).toBe("XKRX:005930");
    expect(canonicalKey("035900.KQ")).toBe("XKOS:035900");
    expect(canonicalKey("security:005930.KS")).toBe("XKRX:005930");
  });

  test("a bare six-character code: a Korean listing whose market is not known yet", () => {
    expect(parseListing("005930")).toEqual({
      kind: "kr",
      key: null,
      code: "005930",
      market: null,
      yahoo: ["005930.KS", "005930.KQ"],
    });
    expect(canonicalKey("005930")).toBeUndefined();
    // Six letters, or a digit-first code of another length, is not one.
    expect(parseListing("GOOGLX")).toMatchObject({ kind: "us" });
    expect(parseListing("12345")).toMatchObject({ kind: "us" });
  });

  test("a Korean MIC with a code that is not one", () => {
    expect(parseListing("XKRX:SAMSUNG")).toEqual({
      kind: "invalid",
      input: "XKRX:SAMSUNG",
      reason: "a KOSPI code is six characters, such as 005930",
    });
  });
});

describe("futures, currency pairs, value series", () => {
  test("a future with its exchange, without it, continuous", () => {
    expect(parseListing("future:XNYM:CL")).toEqual({
      kind: "future",
      key: "future:XNYM:CL",
      mic: "XNYM",
      root: "CL",
      yahoo: "CL=F",
      known: true,
    });
    expect(parseListing("future:GC")).toMatchObject({ key: "future:XCEC:GC", mic: "XCEC", yahoo: "GC=F" });
    expect(parseListing("future:XCME:ES/continuous")).toMatchObject({ key: "future:XCME:ES", yahoo: "ES=F" });
    expect(parseListing("FUTURE:XCBT:ZC")).toMatchObject({ key: "future:XCBT:ZC" });
    expect(parseListing("future:QQQQ")).toEqual({
      kind: "future",
      key: "future:QQQQ",
      mic: null,
      root: "QQQQ",
      yahoo: "QQQQ=F",
      known: false,
    });
    expect(parseListing("future:XCME:CL")).toEqual({
      kind: "invalid",
      input: "future:XCME:CL",
      reason: "CL (WTI crude oil) trades on XNYM: future:XNYM:CL",
    });
  });

  test("a currency pair, in either case", () => {
    expect(parseListing("fx:eurusd")).toEqual({
      kind: "fx",
      key: "fx:EURUSD",
      base: "EUR",
      quote: "USD",
      yahoo: "EURUSD=X",
    });
    expect(parseListing("FX:USDKRW")).toMatchObject({ key: "fx:USDKRW", yahoo: "USDKRW=X" });
    expect(parseListing("fx:USDUSD")).toMatchObject({ kind: "invalid" });
  });

  test("a value series is recognized, so a price tool can point to macro_series", () => {
    const listing = parseListing("SERIES:US.FRED.CPIAUCSL");
    expect(listing).toEqual({ kind: "value_series", key: "series:us.fred.cpiaucsl" });
    const error = notPriced(listing, "Yahoo");
    expect([error?.kind, error?.message, error?.details.retry]).toEqual([
      "invalid",
      "series:us.fred.cpiaucsl is an economic series, not a price: read it with macro_series",
      "change_request",
    ]);
    expect(notPriced(parseListing("series:us.equity_index.sp500"), "Yahoo")).toBeUndefined();
    expect(parseListing("series:kr.ecos.722y001.0101000")).toMatchObject({ kind: "value_series" });
  });
});

describe("keys no form takes", () => {
  test("are invalid, never thrown", () => {
    for (const key of [
      "",
      "  ",
      "^GSPC",
      "CL=F",
      "EURUSD=X",
      "fx:EUR/USD",
      "crypto:BTCUSD",
      "future:XCME:ES/front",
      "bogus:thing x",
    ]) {
      expect(parseListing(key).kind).toBe("invalid");
    }
  });

  test("security: names a security whatever follows, as upstream reads it", () => {
    expect(parseListing("SECURITY:aapl")).toMatchObject({ kind: "us", key: "AAPL" });
    expect(parseListing("security:fx:EURUSD")).toMatchObject({ kind: "venue", mic: "FX", yahoo: null });
    expect(parseListing("security:^GSPC")).toMatchObject({ kind: "invalid" });
  });

  test("the symbol schema's upper-cased typed keys read as their kind", () => {
    expect(parseListing(symbol.parse("crypto:btc-usd"))).toMatchObject({
      kind: "crypto",
      key: "crypto:BTC-USD",
    });
    expect(parseListing(symbol.parse("fx:eurusd"))).toMatchObject({ kind: "fx", key: "fx:EURUSD" });
  });
});
