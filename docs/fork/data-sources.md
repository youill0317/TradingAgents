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

| Capability (tools)                                                | Provider           | Source                                                                                                                                                                                              | Setting                                  |
| ----------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| quotes (quote)                                                    | Yahoo              | Yahoo, through yahoo-finance2: US listings and upstream's venues (upstream's provider), Korean listings, futures front months, currency and crypto pairs, indices                                   | none                                     |
| quotes (quote): a Korean listing Yahoo fails                      | FSC                | the FSC's stock prices on data.go.kr: the last official KRX close of a KOSPI or KOSDAQ listing                                                                                                      | `DATA_GO_KR_API_KEY`                     |
| priceHistory (price_history): daily, intraday                     | Yahoo              | Yahoo's charts: daily bars adjusted for splits and dividends; 15-minute and hourly bars of listed securities, regular hours                                                                         | none                                     |
| priceHistory (price_history): a currency pair                     | ECB                | the ECB's euro reference rates (EXR): 29 currencies, other pairs crossed through the euro                                                                                                           | none                                     |
| priceHistory (price_history): daily, a Korean listing Yahoo fails | FSC                | the FSC's stock prices: KRX's official end-of-day prices, unadjusted                                                                                                                                | `DATA_GO_KR_API_KEY`                     |
| technicals (technicals)                                           | Yahoo              | 22 indicators computed from about 400 of Yahoo's daily bars                                                                                                                                         | none                                     |
| profiles (profile, estimates, comps)                              | Yahoo              | Yahoo's quoteSummary modules: profile and key statistics, analyst consensus and targets, next earnings and dividend                                                                                 | none                                     |
| corporateActions (corporate_actions)                              | Yahoo              | the splits and dividends in Yahoo's chart                                                                                                                                                           | none                                     |
| ownership (ownership): institutional                              | Yahoo              | the top 10 institutional holders Yahoo lists                                                                                                                                                        | none                                     |
| ownership (ownership): insider                                    | SEC EDGAR (filers) | Forms 4 and 5 in the issuer's filing index, read from their XML                                                                                                                                     | `SEC_USER_AGENT`                         |
| ownership (ownership): insider, a Korean listing                  | OpenDART (filers)  | the reports of officers and major shareholders (elestock.json)                                                                                                                                      | `DART_API_KEY`                           |
| statements (statements)                                           | SEC EDGAR (filers) | SEC's XBRL company facts: us-gaap, or ifrs-full for 20-F filers in their reporting currency                                                                                                         | `SEC_USER_AGENT`                         |
| statements (statements): a Korean listing                         | OpenDART (filers)  | each periodic report's statement lines (fnlttSinglAcntAll.json), consolidated, else separate; fiscal years ending in December                                                                       | `DART_API_KEY`                           |
| filings (filings, filing_section)                                 | SEC EDGAR (filers) | SEC's filing index (submissions) and each filing's primary document, split by Item                                                                                                                  | `SEC_USER_AGENT`                         |
| filings (filings, filing_section): a Korean listing               | OpenDART (filers)  | OpenDART's filings (list.json) and a periodic report's main document (document.xml), split by chapter                                                                                               | `DART_API_KEY`                           |
| crossSections (screen)                                            | SEC EDGAR (frames) | SEC's XBRL frames over the S&P 500, 400 and 600 members on Wikipedia's lists, by GICS sector                                                                                                        | `SEC_USER_AGENT`                         |
| macroSeries (macro_series)                                        | Public statistics  | the U.S. Treasury's par and real yield curves, the New York Fed's reference rates, the ECB's key interest rates, FRED                                                                               | none (see FRED)                          |
| macroSeries (macro_series): Korea's series                        | Public statistics  | the Bank of Korea's ECOS; Statistics Korea's KOSIS                                                                                                                                                  | `ECOS_API_KEY`, `KOSIS_API_KEY`          |
| news (news, article)                                              | News search        | Yahoo's news for a listing; GDELT's article lists for words, a topic or the market's latest                                                                                                         | none                                     |
| news (news, article): words in Korean                             | News search        | Naver's news search and GDELT's article lists together                                                                                                                                              | `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` |
| predictionMarkets (prediction_markets)                            | Polymarket         | Polymarket (upstream's provider)                                                                                                                                                                    | none                                     |
| markets (markets): 22 views                                       | Market overview    | Yahoo's quotes, predefined screens and daily charts; the U.S. Treasury's yield curves; the New York Fed's reference rates; the ECB's key interest rates; FRED; the Bank of Korea's base rate (ECOS) | none (see FRED, ECOS)                    |
| instruments (find_instrument)                                     | Instrument search  | the fork's catalogs (price series, futures roots, currency and crypto pairs, economic series), Yahoo's search, SEC's ticker list with `SEC_USER_AGENT`, OpenDART's company list with `DART_API_KEY` | none                                     |

Without `SEC_USER_AGENT` nothing is read from SEC EDGAR and screens are not declared; without it and
`DART_API_KEY`, statements and filings are not declared either, and the agents that need them (equity, quant
and risk) are not offered; macro is, with the 16 built-in skills. Ownership's insider view then answers that
it needs `SEC_USER_AGENT` (a Korean listing's, `DART_API_KEY`), and its institutional view is Yahoo's. With
`SEC_USER_AGENT`, all four agents are offered.

With `DART_API_KEY`, the filers provider ("SEC EDGAR / OpenDART") sends a Korean listing's statements,
filings, filing sections and insider reports to OpenDART, and every other listing to SEC EDGAR as before.
With `DART_API_KEY` and no `SEC_USER_AGENT`, statements, filings and insider transactions are declared for
the Korean listings, so risk is offered beside macro; a US listing's statements and filings then answer that
`SEC_USER_AGENT` is to be set. Equity and quant also need the sector screen, which only SEC EDGAR serves.
Without `DART_API_KEY`, a Korean listing's statements, filings, filing sections and insider view answer, wherever
they are declared, that `DART_API_KEY` is to be set: SEC EDGAR holds no Korean listing's filings. The other
Korean keys add sources to capabilities served in every setup and change no agent's offer
(`test/fork/gating.test.ts`); a Korean series named in `macro_series` or `find_instrument` in a setup without
its source's key answers that the key is to be set.

## The market views

| View                                   | Source                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| equity_summary                         | Yahoo: the S&P 500, Dow, Nasdaq Composite and Russell 2000, and the 11 SPDR sector funds with how many rose on the session                                                                                                                                                                                 |
| sectors                                | Yahoo: the 11 SPDR sector funds, ranked by the session's move                                                                                                                                                                                                                                              |
| gainers, losers, most_active           | Yahoo's predefined screens (day_gainers, day_losers, most_actives): every row, read 250 a request (the most Yahoo answers to one), `more` when Yahoo stops short of the screen's total                                                                                                                     |
| volatility                             | Yahoo: the VIX term structure (9-day, spot, 3-month, 6-month, 1-year), with its structure                                                                                                                                                                                                                  |
| yield_curve                            | the Treasury's par yield curve, with the 10y-2y and 10y-3m spreads                                                                                                                                                                                                                                         |
| tips_breakevens                        | the Treasury: par less real yields at 5, 7, 10, 20 and 30 years                                                                                                                                                                                                                                            |
| rate_indicators                        | the New York Fed: EFFR, SOFR, OBFR and the FOMC's target range; Yahoo: the MOVE index                                                                                                                                                                                                                      |
| central_banks                          | the New York Fed (the FOMC's target range and EFFR), the ECB (its three key rates, each with the day it took effect), FRED (the OECD's rates of the Bank of Japan and the Reserve Bank of India); with `ECOS_API_KEY`, ECOS (the Bank of Korea's base rate, the day it took effect and the rate before it) |
| credit_spreads                         | FRED: ICE BofA high-yield and investment-grade option-adjusted spreads, Moody's Baa less the 10-year Treasury                                                                                                                                                                                              |
| macro                                  | FRED: CPI, core CPI, PCE and core PCE prices, unemployment, payrolls, jobless claims, real GDP and its growth, each with its changes                                                                                                                                                                       |
| indices                                | Yahoo: the US's, Korea's (KOSPI, KOSDAQ, KOSPI 200) and other major markets' indices                                                                                                                                                                                                                       |
| cross_asset                            | the Treasury's 2- and 10-year yields; Yahoo: the S&P 500, VIX, dollar index, gold, crude oil and bitcoin                                                                                                                                                                                                   |
| energy, metals, agriculture, livestock | Yahoo: continuous front-month futures                                                                                                                                                                                                                                                                      |
| commodity_benchmarks                   | Yahoo: Cboe oil and gold volatility, the Bloomberg Commodity and S&P GSCI indices                                                                                                                                                                                                                          |
| fx                                     | Yahoo: the major pairs, USD/CNY, USD/KRW and the dollar index                                                                                                                                                                                                                                              |
| crypto                                 | Yahoo: 16 large crypto assets against the dollar, ranked by market capitalization                                                                                                                                                                                                                          |
| sector_rotation                        | Yahoo's adjusted daily closes: each sector fund's 1-week, 1-month and 3-month return less SPY's, and a risk-on, risk-off or neutral reading                                                                                                                                                                |

Each row names its source and gives its key. quote and price_history take the keys of the priced rows:
tickers, futures, currency and crypto pairs, Korean listings, and the `series:` keys of price series (the
indices, the VIX terms, the dollar index, the commodity benchmarks, MOVE). news takes the same keys but the
`series:` ones. macro_series takes the keys of the value series (the Treasury's yields, the New York Fed's
and the ECB's rates, FRED's series, the Bank of Korea's base rate). A source that fails leaves out only its
own rows, each listed in `missing`, with its reason, or, when they share one, with the reason stated once in
`coverage`. Market breadth (advancing and declining issues, new highs and lows) has no source here:
equity_summary lists it in `missing`.

## The sources

- **Yahoo** (query1/query2.finance.yahoo.com): read only through yahoo-finance2, with the library's own
  User-Agent (Yahoo answers 429 to others). Yahoo publishes no rate. A Korean listing Yahoo does not answer
  fails as unsupported or unavailable (never no_data), so the FSC's prices on data.go.kr answer it when
  `DATA_GO_KR_API_KEY` is set. Its predefined screens
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

### Korea's sources

Each is read only with its key: without it, nothing is asked of the source. A key travels only to its own
source, in the place the source documents (a request carrying one follows a redirect only to its own source's
address), and is removed from every message, note, log, cache key and fixture, before a source's words are cut
to length; a code a source answers with is quoted only in the form it documents. Answers link to public pages
(a filing's DART page, `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=<receipt number>`), never to an address
carrying a key. A daily quota is the source's to enforce: its answer is the `quota` kind.

- **OpenDART** (opendart.fss.or.kr, `DART_API_KEY`, sent as the `crtfc_key` query parameter): the company list
  (corpCode.xml, a ZIP of every company's corp_code, names and stock code; kept a day on disk, and served past
  its day when OpenDART cannot be read), which maps a Korean listing to its company and lets find_instrument
  find Korean companies by their Korean or English names (each listing placed on KOSPI or KOSDAQ by Yahoo's
  search or one batched Yahoo quote; without the key, a search in Hangul that finds nothing answers that
  `DART_API_KEY` is to be set); filings (list.json, every page of 100 read to the total, in windows of receipt
  days back to 1999); a periodic report's chapters (document.xml: business is "사업의 내용", mdna "이사의 경영진단 및
  분석의견", which only annual reports give: a half-year or quarterly report's is not found, with what the report
  says in its place, market_risk "위험관리 및 파생거래", financial_statements "재무에 관한 사항"; a periodic report has no
  risk-factors chapter); each report's statement lines (fnlttSinglAcntAll.json, business years from 2015,
  consolidated, else separate when OpenDART has no consolidated lines, status 013); insider reports
  (elestock.json: holdings and their changes, with no transaction date, code or price, covered from 1999, when
  DART's electronic filings begin); the company outline (company.json: the month its fiscal year ends, its
  market, which places a listing on KOSPI or KOSDAQ in every answer, the key's market where it gives none). A
  fiscal year ending in another month than December is unsupported, with the month. Statements follow the SEC
  filers' rules: a quarter's income statement is the report's three months, a cash-flow quarter the difference
  of two years to date, a fourth quarter the year less nine months, each computed value naming both reports,
  and a quarter that cannot be computed (the report before it not listed, holding no lines, or on another
  basis) said in the coverage; per-share figures and share counts are never computed; a line whose account ids
  are not filed is computed from its formula's (`catalog/lines.ts`: DART's template ids such as
  dart_LongTermBorrowingsGross, dart_CurrentPortionOfBonds, dart_AdjustmentsForDepreciationExpense beside the
  ifrs-full ones); the statement is in one currency, the one the newest report with lines writes most, rows in
  another being left out and their reports said. Each value is the one filed in its own period's report (or
  that report's correction): a later report's figures for an earlier period (its prior-year column,
  frmtrm_amount) are not read, so a period a later report restates keeps the value its own report filed (SEC's
  company facts give the latest value filed for each period). The forms filter takes OpenDART's report types
  (A001...), their group letters (A to J) and the SEC forms they answer to (10-K: A001; 10-Q: A002, A003; 8-K:
  B001 and the exchange's disclosures, group I). A preferred share or a fund has no row of its own in the
  company list, so its statements and filings are unsupported. Published limits: page_count at most 100; a
  list.json search without corp_code spans at most three months; at most 100 companies a request (status 021);
  about 20,000 requests a day per key (status 020, `quota`). No rate of requests a second or a minute is
  published, so none is applied. The 5% holders' reports (majorstock.json) are not read: ownership's holders
  contract is a quarter's 13F holdings.
- **The FSC on data.go.kr** (apis.data.go.kr, `DATA_GO_KR_API_KEY`, sent as `serviceKey`): KRX's official
  end-of-day prices of KOSPI and KOSDAQ listings (GetStockSecuritiesInfoService, getStockPriceInfo),
  unadjusted, published the next business day: a quote is the last official close (with the session's
  open, high, low, volume and the market capitalization), daily history one bar a session. Asked after Yahoo,
  for Korean listings only, and for a Korean listing whose Yahoo chart gives every session of the window asked
  without a close or without an adjusted close (the answer says which); a code the stock prices hold no row
  of, such as the ETF KODEX 200 (069500), is unsupported, so the answer says each source's reason, and a share
  they hold without a session in the window is no_data. With `DATA_GO_KR_API_KEY`, a quote or daily call no
  source answers carries the FSC's unsupported as its kind (the router's last source decides the kind, each
  source's reason said): a US listing's Yahoo outage or rate limit then reads as unsupported, without Yahoo's
  wait. data.go.kr hands out each key in two spellings, "Encoding" and "Decoding": either may be set; it is
  sent encoded once, and both spellings are kept out of everything said. The address with `_V2`
  (GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2) is asked first, the one without it when data.go.kr
  answers that the key is not registered for the first (code 30) or has no approved application for it (20),
  that it has no such service (12) or is not there (404); the address that answered is asked first from then
  on. Published limits: numOfRows at most 10,000 (pages read to totalCount); a daily quota per key (10,000
  requests for a development account; code 22, `quota`). The gateway answers a failure in its XML envelope
  even when JSON is asked; its words are quoted with the key removed, a body in another form not at all.
- **ECOS**, the Bank of Korea (ecos.bok.or.kr, `ECOS_API_KEY`, in the URL path): macro_series' Korean series
  `kr.ecos.<stat_code>.<item>...` (StatisticSearch, read 1,000 rows a page to its list_total_count), with
  the catalog's Bank of Korea base rate (722Y001/0101000, daily) and Korea CPI (901Y009/0, monthly), any
  other table by key, and a search of its table list (StatisticTableList in Korean and English, then
  StatisticItemList) for words in Hangul or naming Korea; the central_banks view's Bank of Korea row. Errors
  come with HTTP 200 as RESULT {CODE, MESSAGE}: INFO-200 no data, INFO-100 a key it does not accept
  (`rejected`), ERROR-602 too many calls (`rate_limited`), ERROR-400 its 60-second limit on one search, which
  asks for a narrower request: the window is asked again in halves, by period, and only a single period's
  ERROR-400 is the failure. ECOS publishes no rate of requests and keeps no vintages (known_from null).
- **KOSIS**, Statistics Korea (kosis.kr, `KOSIS_API_KEY`, sent as `apiKey`): macro_series' Korean series
  `kr.kosis.<tbl_id>.<itm_id>.<obj>...` (statisticsParameterData.do), with the catalog's semiconductor
  production, shipment and inventory indexes (DT_1F02011: T10, T11, T12), any other item or classification of
  a table the catalog holds, any other table by key once a KOSIS search has named its organization, and its
  search (statisticsSearch.do, then getMeta's items) for
  words in Hangul or naming Korea. Published limits: 40,000 cells a request (a longer window is split by
  period, and a request answered with err 31 is asked again in halves) and 200 requests a minute (paced).
  Errors come with HTTP 200 as {err, errMsg}: 30 no data, 31 too many cells, 40 the rate (`rate_limited`),
  41 the quota (`quota`), 10, 11, 12 and 42 the key or the account (`rejected`). KOSIS keeps no vintages.
- **Naver's news search** (openapi.naver.com/v1/search/news.json, `NAVER_CLIENT_ID` and
  `NAVER_CLIENT_SECRET`, sent in the X-Naver-Client-Id and X-Naver-Client-Secret headers): news for words
  holding Hangul, with GDELT's for the same words: one list, newest first, an address both list shown once,
  each publisher followed by the source that listed it, Naver's snippet as the summary (ids `nv:<hash>`).
  Published limits: display at most 100 and start at most 1,000, so a search reaches Naver's newest 1,099
  articles; a daily quota (HTTP 429, `quota`) and a rate a second (HTTP 429, `rate_limited`) whose number is
  not given. A topic or a tone cannot narrow Naver's search: invalid.

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
- OpenDART: every fixture under `dart/` (the company list cut to the tested companies, Samsung Electronics'
  periodic reports, statement lines, insider reports, outline and annual report's documents),
  `dart-statements/` (its reports since 2015 and their lines, JYP Entertainment's separate lines) and
  `dart-filings/` (the filings lists by type, the annual and quarterly reports' documents); and the Yahoo
  answers the Korean name search reads, `instruments/yahoo-quote-kr-listings.json` and
  `instruments/yahoo-search-069500.json`.
- The FSC: every fixture under `fsc/`.
- ECOS and KOSIS: every fixture under `ecos/` and `kosis/`, and `markets/ecos-722y001-d-since2024.json`.
- Naver: every fixture under `naver/`, GDELT's answer for the same Korean words among them.

Recording the markets and instruments cases gives the first real answers for Yahoo's symbols ^VIX1Y, ^MOVE,
^BCOM and ^SPGSCI, its screens' pages, its search's matches, and FRED's IRSTCB01JPM156N and
IRSTCB01INM156N. No answer of a Korean source has been seen: every Korean fixture's receipt numbers,
amounts, prices, names and texts are made up in the documented form (Samsung Electronics' corp_code
00126380 and the series codes the owner verified aside), and the Korean tests' golden texts change with the
recorded answers. ECOS and KOSIS answer a refusal with HTTP 200, so a refused case of theirs writes its body:
check each recorded ECOS and KOSIS fixture for a RESULT or err body.

## What to check live

The Korean sources' own guides (opendart.fss.or.kr, ecos.bok.or.kr, kosis.kr, data.go.kr) could not be read
from the session that built them. These facts come from the sources' pages as search results and open-source
clients quote them, and from third-party guides; check each when recording.

- OpenDART: the meaning of statuses 014 (no file: no_data), 021 (too many companies: invalid), 101 (improper
  access: invalid) and 901 (an expired account's key: rejected); that 020 is the daily limit and no rate a second
  or a minute is published; list.json's page_no, page_count, total_count and total_page as numbers, rcept_dt as
  YYYYMMDD, bgn_de defaulting to end_de, no window limit with corp_code, and receipt days answered back to
  1999-01-01 (DART_FIRST_DAY, the floor of the windows read and of the insider view's coverage); that a receipt
  number's first eight digits are its rcept_dt (filing_section finds a filing among its company's filings of that
  day); the report names filings types an unfiltered list by (사업보고서, 반기보고서, 분기보고서, 주요사항보고서, 주식등의대량보유상황보고서,
  임원ㆍ주요주주특정증권등소유상황보고서, with "ㆍ"); the periodic reports' chapter titles and nesting (사업의 내용 a SECTION-1 chapter,
  위험관리 및 파생거래 a section inside it, mdna left out of half-year and quarterly reports with a statement in its
  place, a "...참조하시기 바랍니다" pointer read as by_reference); whether an older periodic report's document.xml archive
  holds HTML documents in place of DART XML (the owner's reference reads `.html` members too; only `.xml` entries
  are read here); elestock.json writing a decrease as a negative change (its sign says acquired or disposed); the
  account ids catalog/lines.ts reads beyond ifrs-full_Revenue and dart_OperatingIncomeLoss
  (dart_TotalSellingGeneralAdministrativeExpenses, dart_ShortTermDepositsNotClassifiedAsCashEquivalents,
  dart_ShortTermTradeReceivable, dart_ShortTermTradePayables, dart_CurrentPortionOfBonds,
  dart_LongTermBorrowingsGross, dart_BondsIssued, dart_AdjustmentsForDepreciationExpense,
  dart_AdjustmentsForAmortisationExpense, dart_PaymentsToAcquirePropertyPlantAndEquipment,
  dart_AcquisitionOfTreasuryShares and the ifrs-full ids), against a recorded answer, Samsung Electronics' among
  them (its 2021 annual report's XBRL files 장기차입금 as dart_LongTermBorrowingsGross and 매입채무 and 유동성장기부채 with
  elements of its own, which the fixtures follow); that CORPCODE.xml holds one row per company under its common
  share's code (no preferred share's), a single space as an unlisted company's stock_code and corp_eng_name
  possibly empty, and its size (a list of 100,000 companies made up in its form is about 25 MB of XML, under 1 MB
  zipped); that corpCode.xml and document.xml answer a failure as XML `<result><status><message>` in place of the
  ZIP; document.xml's entries named `<rcept_no>.xml` and `<rcept_no>_<5 digits>.xml` in DART's XML (DOCUMENT,
  SECTION-n, TITLE, P, TABLE, TE); elestock.json's rcept_dt as YYYY-MM-DD and counts written with thousands
  separators and `-` for none; fnlttSinglAcntAll.json's amounts without separators and account_detail `-` outside
  the changes in equity; company.json's est_dt as YYYYMMDD and acc_mt as "12"; the income statement's
  thstrm_amount being three months in 11012 and 11014 reports and the year to date in 11013, the cash flow's the
  year to date; the corp_codes the fixtures give Samsung SDI (00126362), Samsung Electro-Mechanics (00126371),
  Samsung C&T (00149655), SK hynix (00164779), Kakao (00258801) and JYP Entertainment (00258689); KRX's
  preferred-share codes (the common code's first five characters and 5, 7, 9, K, L or M) and Yahoo's naming a
  preferred share by its common share's long name; how many symbols Yahoo's batched quote takes (Yahoo publishes
  no maximum).
- The FSC: that keys issued now are registered for the `_V2` address only, and that it takes the same parameters
  and gives the same answer as the address without it; numOfRows at most 10,000; beginBasDt inclusive and
  endBasDt exclusive; every item value a string, fltRt without its leading zero (`-.39`), one row as an object
  rather than a list, `""` for none, rows newest first; a halted session's mkp, hipr, lopr, trqu and trPrc as 0
  with clpr carried over, and vs and fltRt against the exchange's base price; publication after 13:00 in Seoul
  the next business day; the gateway's codes 1, 2, 3, 4, 5 (SERVICETIMEOUT_ERROR), 10, 11, 12, 20 (no approved
  application for the service: the other address is asked), 21, 22, 29 (BLACKLIST_IP_ACCESS_ERROR), 30 to 33 and
  99, as data.go.kr's dataset pages list them, and 23 for a rate a second (`rate_limited`); that ETFs are not in
  getStockPriceInfo; mrktCtg values KOSPI, KOSDAQ and KONEX; a srtnCd of seven characters starting with `A`.
- ECOS: the address form `/api/<Service>/<key>/json/<lang>/<from>/<to>/...` and the answer `{"<Service>":
  {"list_total_count", "row"}}`, with RESULT at the top or inside it and INFO-000 for success; the RESULT codes
  (INFO-100, INFO-200; ERROR-100, 101, 200, 300 and 301 a malformed request; ERROR-400 the 60-second search
  timeout, answered by asking again in halves by period, as ECOS's specification asks for narrower conditions;
  ERROR-500, 600 and 601 the server; ERROR-602 too many calls); third parties report about 300 calls in 3 minutes
  before ERROR-602, and about 1,000 calls a day; StatisticItemList's fields (GRP_CODE, GRP_NAME, ITEM_CODE,
  ITEM_NAME, P_ITEM_CODE, CYCLE, START_TIME, END_TIME, DATA_CNT, UNIT_NAME, WEIGHT), each item listed once per
  cycle, groups 1 to 4 as item codes 1 to 4; StatisticTableList's fields (P_STAT_CODE, STAT_CODE, STAT_NAME,
  CYCLE, SRCH_YN, ORG_NAME) and English names with lang `en`; TIME as D YYYYMMDD, SM YYYYMMS1 or S2, M YYYYMM, Q
  YYYYQn, S YYYYSn, A YYYY; the base rate's daily rows on business days, DATA_VALUE written as `2.5`; 817Y002's
  items 010200000 (3-year KTB) and 010210000 (10-year).
- KOSIS: the err codes (10 key missing, 11 a key it does not accept, "유효하지 않은 인증KEY입니다." as an open-source client
  reports from live calls, 12 expired, 20 and 21 parameters, 30 no data, 31 over 40,000 cells, 40 the rate, 41
  the row limit, 42 a user's restriction, 50 the server); the 40,000 cells and 200 requests a minute of its
  service introduction (KOSIS posted notices on its per-minute limit on 2026-02-05 and 2026-07-09: check the
  number in force); how statisticsParameterData.do gives statistical symbols (통계부호) since the notice of
  2026-07-09 changed the statistics data API: as a field of their own or within DT, which is read as a number
  here (a value that is not one is null); PRD_DE for quarters (YYYYQQ) and half-years (YYYYHH); codes in upper
  case; getMeta's ITM rows (OBJ_ID `ITEM` the items with UNIT_NM, the others the classifications by OBJ_ID_SN);
  statisticsSearch.do's fields (ORG_ID, ORG_NM, TBL_ID, TBL_NM, STAT_NM, STRT_PRD_DE, END_PRD_DE) and parameters
  (searchNm, sort=RANK, startCount, resultCount); a period kind a table lacks answered with no rows (err 30 or an
  empty list); DT_1F02011's classification `E` for semiconductors.
- Naver: that start=1000 with display=100 gives articles 1,000 to 1,099; the codes 010 (the daily quota) and 012
  (the rate a second) with HTTP 429. NAVER Cloud's migration guide moves Naver's search APIs to NAVER API HUB
  (naverapihub.apigw.ntruss.com, `GET /search/v1/news`, its API Gateway key headers), where NAVER Developers
  Center client ids and secrets are not accepted; news reports date the end of new Developers Center applications
  for the search API to 2026-07-31, existing keys' use there to 2027-06-30, and revised search-API terms, in
  force from 2026-09-07, on caching results and using them as an AI's input. This app reads
  openapi.naver.com/v1/search/news.json with Developers Center keys: which address, keys and terms are in force
  is the owner's to check.
