<!--
Copyright 2026 TradingAgents fork contributors
SPDX-License-Identifier: Apache-2.0
Added in this fork of TradingAgents 1.0.0.
-->

# Public data: the sources

Which source serves each capability, what setting it needs, and the limits and terms the sources publish.
How the providers are built is in [data-architecture.md](data-architecture.md); the settings are in
[configuration](../configuration.md#public-data).

## By capability

| Capability (tools)                               | Provider           | Source                                                                                                                                                            | Setting          |
| ------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| quotes (quote)                                   | Yahoo              | Yahoo, through yahoo-finance2: US listings and upstream's venues (upstream's provider), Korean listings, futures front months, currency and crypto pairs, indices | none             |
| priceHistory (price_history): daily, intraday    | Yahoo              | Yahoo's charts: daily bars adjusted for splits and dividends; 15-minute and hourly bars of listed securities, regular hours                                       | none             |
| priceHistory (price_history): a currency pair    | ECB                | the ECB's euro reference rates (EXR): 29 currencies, other pairs crossed through the euro                                                                         | none             |
| technicals (technicals)                          | Yahoo              | 22 indicators computed from about 400 of Yahoo's daily bars                                                                                                       | none             |
| profiles (profile, estimates, comps)             | Yahoo              | Yahoo's quoteSummary modules: profile and key statistics, analyst consensus and targets, next earnings and dividend                                               | none             |
| corporateActions (corporate_actions)             | Yahoo              | the splits and dividends in Yahoo's chart                                                                                                                         | none             |
| ownership (ownership): institutional             | Yahoo              | the top 10 institutional holders Yahoo lists                                                                                                                      | none             |
| ownership (ownership): insider                   | SEC EDGAR (filers) | Forms 4 and 5 in the issuer's filing index, read from their XML                                                                                                   | `SEC_USER_AGENT` |
| statements (statements)                          | SEC EDGAR (filers) | SEC's XBRL company facts: us-gaap, or ifrs-full for 20-F filers in their reporting currency                                                                       | `SEC_USER_AGENT` |
| filings (filings, filing_section)                | SEC EDGAR (filers) | SEC's filing index (submissions) and each filing's primary document, split by Item                                                                                | `SEC_USER_AGENT` |
| crossSections (screen)                           | SEC EDGAR (frames) | SEC's XBRL frames over the S&P 500, 400 and 600 members on Wikipedia's lists, by GICS sector                                                                      | `SEC_USER_AGENT` |
| macroSeries (macro_series)                       | Public statistics  | the U.S. Treasury's par and real yield curves, the New York Fed's reference rates, the ECB's key interest rates, FRED                                             | none (see FRED)  |
| news (news, article)                             | News search        | Yahoo's news for a listing; GDELT's article lists for words, a topic or the market's latest                                                                       | none             |
| predictionMarkets (prediction_markets)           | Polymarket         | Polymarket (upstream's provider)                                                                                                                                  | none             |
| markets (markets), instruments (find_instrument) | not served yet     | asking answers that the capability is not available in this setup                                                                                                 | -                |

Without `SEC_USER_AGENT` nothing is read from SEC EDGAR: statements, filings, insider transactions and
screens are not declared, and the agents that need them are not offered. With it, equity, quant and risk are
offered with the 16 built-in skills; macro also needs the market views.

## The sources

- **Yahoo** (query1/query2.finance.yahoo.com): read only through yahoo-finance2, with the library's own
  User-Agent (Yahoo answers 429 to others). Yahoo publishes no rate. A Korean listing Yahoo does not answer
  passes the call on to the next provider (FSC, Phase 4).
- **SEC EDGAR** (data.sec.gov, www.sec.gov): every request names its sender with `SEC_USER_AGENT`, SEC's
  fair-access rule, and all of SEC's hosts together are kept to its published 10 requests a second.
  Company facts give the latest value filed for each period, from periodic reports; a quarter not filed on
  its own is computed (year-to-date differences, the fourth quarter as the year less nine months) and says
  which filings it comes from; per-share figures and share counts are never computed. Frames give the latest
  value filed with no filing date, so a screen's values are as of when they were read.
- **Wikipedia** (en.wikipedia.org, MediaWiki parse API): the S&P 500, S&P 400 and S&P 600 lists, licensed
  CC BY-SA 4.0 (said in each screen's coverage), read one after another and kept a week; a 429's Retry-After
  is honoured.
- **The U.S. Treasury** (home.treasury.gov): the daily par yield curve (from 1990) and real yield curve
  (from 2003), one CSV a year; breakevens are par less real yields.
- **The New York Fed** (markets.newyorkfed.org): EFFR with the FOMC's target range, OBFR, SOFR, TGCR and
  BGCR.
- **The ECB** (data-api.ecb.europa.eu): euro reference rates (from 1999-01-04) and its deposit facility,
  main refinancing and marginal lending rates, served as the dates they changed.
- **FRED** (St. Louis Fed): without a key, the catalogued series (CPI, core CPI, unemployment, payrolls, GDP
  and the others in `catalog/series.ts`) from FRED's keyless download (fred.stlouisfed.org, latest vintage,
  one request a second as its robots.txt asks). With `FRED_API_KEY`, FRED's API (api.stlouisfed.org, about
  120 requests a minute): every series, FRED's search, and each value's vintages (when it became known, and
  its first release when revised).
- **GDELT** (api.gdeltproject.org, DOC 2.0 API): article lists of up to 250 articles a request, over a
  rolling window of about three months, one request every 5 seconds as GDELT publishes; identical requests
  in flight share one answer. Its articles carry no snippet; a tone filter uses GDELT's tone score.
- **Polymarket** (gamma-api.polymarket.com): unchanged from upstream.

## Fixtures to record again

Tests use fixtures only (no request reaches the network). These were made by hand in the sources'
documented formats, because no real answer was saved, and are replaced when the owner runs the recorder
(`bun scripts/fork/record-fixtures.ts`, case modules in `scripts/fork/fixture-cases/`); the golden texts of
their tests are updated with them:

- Yahoo: every fixture under `test/fork/fixtures/yahoo/` and `yahoo-news/` (yahoo-finance2's own schemas).
- www.sec.gov: the primary documents (`sec/document-*.html`), the insider reports (`sec/form4-*.xml`) and the
  ticker list (`sec/company-tickers-exchange.json`); www.sec.gov answers only a User-Agent naming a contact.
- GDELT: every fixture under `gdelt/`.
- FRED: every fixture under `fred/` but `error-no-key.json`; `nyfed/tgcr-last1.json`.
- SEC frames assembled from company facts (`frames/`, marked `hand_made` in their meta).
