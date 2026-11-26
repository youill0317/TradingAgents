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

| Capability (tools)                            | Provider           | Source                                                                                                                                                            | Setting          |
| --------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| quotes (quote)                                | Yahoo              | Yahoo, through yahoo-finance2: US listings and upstream's venues (upstream's provider), Korean listings, futures front months, currency and crypto pairs, indices | none             |
| priceHistory (price_history): daily, intraday | Yahoo              | Yahoo's charts: daily bars adjusted for splits and dividends; 15-minute and hourly bars of listed securities, regular hours                                       | none             |
| priceHistory (price_history): a currency pair | ECB                | the ECB's euro reference rates (EXR): 29 currencies, other pairs crossed through the euro                                                                         | none             |
| technicals (technicals)                       | Yahoo              | 22 indicators computed from about 400 of Yahoo's daily bars                                                                                                       | none             |
| profiles (profile, estimates, comps)          | Yahoo              | Yahoo's quoteSummary modules: profile and key statistics, analyst consensus and targets, next earnings and dividend                                               | none             |
| corporateActions (corporate_actions)          | Yahoo              | the splits and dividends in Yahoo's chart                                                                                                                         | none             |
| ownership (ownership): institutional          | Yahoo              | the top 10 institutional holders Yahoo lists                                                                                                                      | none             |
| ownership (ownership): insider                | SEC EDGAR (filers) | Forms 4 and 5 in the issuer's filing index, read from their XML                                                                                                   | `SEC_USER_AGENT` |
| statements (statements)                       | SEC EDGAR (filers) | SEC's XBRL company facts: us-gaap, or ifrs-full for 20-F filers in their reporting currency                                                                       | `SEC_USER_AGENT` |
| filings (filings, filing_section)             | SEC EDGAR (filers) | SEC's filing index (submissions) and each filing's primary document, split by Item                                                                                | `SEC_USER_AGENT` |
| crossSections (screen)                        | SEC EDGAR (frames) | SEC's XBRL frames over the S&P 500, 400 and 600 members on Wikipedia's lists, by GICS sector                                                                      | `SEC_USER_AGENT` |
| macroSeries (macro_series)                    | Public statistics  | the U.S. Treasury's par and real yield curves, the New York Fed's reference rates, the ECB's key interest rates, FRED                                             | none (see FRED)  |
| news (news, article)                          | News search        | Yahoo's news for a listing; GDELT's article lists for words, a topic or the market's latest                                                                       | none             |
| predictionMarkets (prediction_markets)        | Polymarket         | Polymarket (upstream's provider)                                                                                                                                  | none             |
| markets (markets): 22 views                   | Market overview    | Yahoo's quotes, predefined screens and daily charts; the U.S. Treasury's yield curves; the New York Fed's reference rates; the ECB's key interest rates; FRED     | none (see FRED)  |
| instruments (find_instrument)                 | Instrument search  | the fork's catalogs (price series, futures roots, currency and crypto pairs, economic series), Yahoo's search, SEC's ticker list with `SEC_USER_AGENT`            | none             |

Without `SEC_USER_AGENT` nothing is read from SEC EDGAR: statements, filings and screens are not declared,
and the agents that need them (equity, quant and risk) are not offered; macro is, with the 16 built-in
skills. Ownership's insider view then answers that it needs `SEC_USER_AGENT`, and its institutional view is
Yahoo's. With it, all four agents are offered.

## The market views

| View                                   | Source                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| equity_summary                         | Yahoo: the S&P 500, Dow, Nasdaq Composite and Russell 2000, and the 11 SPDR sector funds with how many rose on the session                                                                       |
| sectors                                | Yahoo: the 11 SPDR sector funds, ranked by the session's move                                                                                                                                    |
| gainers, losers, most_active           | Yahoo's predefined screens (day_gainers, day_losers, most_actives): every row, read 250 a request (the most Yahoo answers to one), `more` when Yahoo stops short of the screen's total           |
| volatility                             | Yahoo: the VIX term structure (9-day, spot, 3-month, 6-month, 1-year), with its structure                                                                                                        |
| yield_curve                            | the Treasury's par yield curve, with the 10y-2y and 10y-3m spreads                                                                                                                               |
| tips_breakevens                        | the Treasury: par less real yields at 5, 7, 10, 20 and 30 years                                                                                                                                  |
| rate_indicators                        | the New York Fed: EFFR, SOFR, OBFR and the FOMC's target range; Yahoo: the MOVE index                                                                                                            |
| central_banks                          | the New York Fed (the FOMC's target range and EFFR), the ECB (its three key rates, each with the day it took effect), FRED (the OECD's rates of the Bank of Japan and the Reserve Bank of India) |
| credit_spreads                         | FRED: ICE BofA high-yield and investment-grade option-adjusted spreads, Moody's Baa less the 10-year Treasury                                                                                    |
| macro                                  | FRED: CPI, core CPI, PCE and core PCE prices, unemployment, payrolls, jobless claims, real GDP and its growth, each with its changes                                                             |
| indices                                | Yahoo: the US's, Korea's (KOSPI, KOSDAQ, KOSPI 200) and other major markets' indices                                                                                                             |
| cross_asset                            | the Treasury's 2- and 10-year yields; Yahoo: the S&P 500, VIX, dollar index, gold, crude oil and bitcoin                                                                                         |
| energy, metals, agriculture, livestock | Yahoo: continuous front-month futures                                                                                                                                                            |
| commodity_benchmarks                   | Yahoo: Cboe oil and gold volatility, the Bloomberg Commodity and S&P GSCI indices                                                                                                                |
| fx                                     | Yahoo: the major pairs, USD/CNY, USD/KRW and the dollar index                                                                                                                                    |
| crypto                                 | Yahoo: 16 large crypto assets against the dollar, ranked by market capitalization                                                                                                                |
| sector_rotation                        | Yahoo's adjusted daily closes: each sector fund's 1-week, 1-month and 3-month return less SPY's, and a risk-on, risk-off or neutral reading                                                      |

Each row names its source and gives its key. quote and price_history take the keys of the priced rows:
tickers, futures, currency and crypto pairs, Korean listings, and the `series:` keys of price series (the
indices, the VIX terms, the dollar index, the commodity benchmarks, MOVE). news takes the same keys but the
`series:` ones. macro_series takes the keys of the value series (the Treasury's yields, the New York Fed's
and the ECB's rates, FRED's series). A source that fails leaves out only its own rows, each listed in
`missing`, with its reason, or, when they share one, with the reason stated once in `coverage`. Market
breadth (advancing and declining issues, new highs and lows) has no source here: equity_summary lists it in
`missing`.

## The sources

- **Yahoo** (query1/query2.finance.yahoo.com): read only through yahoo-finance2, with the library's own
  User-Agent (Yahoo answers 429 to others). Yahoo publishes no rate. A Korean listing Yahoo does not answer
  fails as unsupported or unavailable (never no_data), so the FSC's prices on data.go.kr
  ([README](../../README.md#what-is-coming)) can answer it once that source is added. Its predefined screens
  are read unvalidated (yahoo-finance2 4.0.6 refuses a whole answer when one row lacks a field it requires), a
  page of 250 rows at a time until the screen's total is read; its search is asked in the Latin script only,
  for listings (no news), for 100 matches, and an answer holding as many as asked is asked again for ten times
  as many until Yahoo answers fewer (Yahoo publishes no maximum).
- **SEC EDGAR** (data.sec.gov, www.sec.gov): every request names its sender with `SEC_USER_AGENT`, SEC's
  fair-access rule, and all of SEC's hosts together are kept to its published 10 requests a second.
  Company facts give the latest value filed for each period, from periodic reports; a quarter not filed on
  its own is computed (year-to-date differences, the fourth quarter as the year less nine months) from the
  line's own concept, with both values as they stood at one time (one restated after the other was last filed
  is taken as filed before, and said), and says which filings it comes from; per-share figures and share
  counts are never computed. Frames give the latest value filed with no filing date, so a screen's values are
  as of when they were read.
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

- Yahoo: every fixture under `test/fork/fixtures/yahoo/`, `yahoo-news/` and `instruments/`, and the Yahoo
  answers under `markets/` (`quotes.json`, `screener-*.json`, `chart-*.json`), in yahoo-finance2's own
  schemas (the screens' companies are invented).
- www.sec.gov: the primary documents (`sec/document-*.html`), the insider reports (`sec/form4-*.xml`) and the
  ticker list (`sec/company-tickers-exchange.json`); www.sec.gov answers only a User-Agent naming a contact.
- GDELT: every fixture under `gdelt/`.
- FRED: every fixture under `fred/` but `error-no-key.json`, and `markets/fred-graph-*.csv`;
  `nyfed/tgcr-last1.json`.
- SEC frames assembled from company facts (`frames/`, marked `hand_made` in their meta).

Recording the markets and instruments cases gives the first real answers for Yahoo's symbols ^VIX1Y, ^MOVE,
^BCOM and ^SPGSCI, its screens' pages, its search's matches, and FRED's IRSTCB01JPM156N and
IRSTCB01INM156N.
