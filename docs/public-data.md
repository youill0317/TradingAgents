# Official evidence for ticker and market analysis

Enable with `TRADINGAGENTS_PUBLIC_DATA_SOURCES=all` in `.env`, or set
`config["public_data_sources"] = "all"` in Python. Comma-separated source IDs
select a smaller set. The default is off. No additional package dependencies or
paid data subscriptions are introduced. Provider registration, endpoint approval,
usage terms and quotas still apply.

## Source catalog

This is a curated analytical scope, not a mirror of every table each agency
publishes. Numeric evidence preserves native units, dates, reporting basis and
source links. Most macro series retain about two years; exact bounds are below.

| ID | Collected scope | History / limits | Credential |
| --- | --- | --- | --- |
| `sec` | Recent 10-K/Q, 8-K, 20-F/40-F/6-K and supported amendments; standard US-GAAP financial concepts with IFRS fallback; same-period margins/FCF; periodic/event filing excerpts | Current submissions page; facts within 1,100 days, up to 16 periods per concept/unit; one periodic and one event document, excerpts capped at 12,000 characters each | Real identifying `SEC_USER_AGENT` |
| `dart` | Recent and periodic filings, corrections; complete single-company financial accounts, CFS with OFS fallback; document excerpt | Two bounded 100-filing lists over 1,100 days; up to eight fiscal reports; latest document excerpt | `DART_API_KEY` |
| `fsc` | Corporate outline and business identifiers, matched through DART registration number | Current identity snapshot | `DART_API_KEY` + `DATA_GO_KR_API_KEY` |
| `eia` | Commercial crude stocks, crude production, gasoline stocks, distillate stocks | Weekly, 800 days | `EIA_API_KEY` |
| `nyfed` | SOFR, EFFR, OBFR rates and transaction volumes | Last 300 observations per rate, filtered to analysis date | None |
| `treasury` | TGA closing balance from the Daily Treasury Statement | Last 400 daily records | None |
| `cftc` | Asset-manager net, leveraged-money net and open interest in financial futures | 100 days, up to 3,000 provider rows; 12 largest markets by latest open interest | None |
| `ecb` | Deposit facility, main refinancing and marginal lending rates | Daily, 800 days | None |
| `ecos` | Policy-rate and CPI histories plus the 100 key-statistics snapshot | Rate 45 days, CPI 13 months; latest snapshot for other indicators | `ECOS_API_KEY` |
| `customs` | Korean exports/imports by value and weight, and balance: HS 8542, 8703, 8507, 3004, 2710, 7208; partners US, China, Japan, Vietnam | 13 months with conservative monthly cutoff; 24 independent product/partner requests | `DATA_GO_KR_API_KEY` |
| `kosis` | Industry production, shipment and inventory indexes from DT_1F02011, all industry categories | 13 months; item IDs T10/T11/T12 | `KOSIS_API_KEY` |
| `fred` | Fed assets/reserves/reverse repos; C&I lending standards and demand; NFCI/STLFSI4; nominal/real yields, breakeven, industrial production, capacity, bank business loans, broad dollar | 16 series, 800 days, metadata and observations pinned to ALFRED vintage | `FRED_API_KEY` |
| `ofr` | Financial Stress Index, five risk components, three regional contributions, term DVP repo rate | 400 days | None |
| `census` | Durable goods orders/shipments/inventories; retail and wholesale sales/inventories/ratios; residential construction; construction spending | M3ADV/MRTS/MWTS/RESCONST/VIP official bulk files, last 800 days, national series | None; uses official bulk downloads |
| `bea` | Nominal and real consumption by product, industry value added | NIPA T20305/T20306 and GDPbyIndustry table 1; current and two preceding years | `BEA_API_KEY` |
| `bls` | Hourly earnings; manufacturing, construction, retail and health/education employment; job openings, quits rate; final-demand PPI and finished-goods PPI excluding food/energy | Nine monthly series, current and two preceding years, excluding M13 annual averages | Optional `BLS_API_KEY` for expanded quota |
| `oecd` | Amplitude-adjusted composite leading indicators | 800 days; US, UK, China, Japan, Korea, India, Germany, France, Italy, Spain, Canada, Australia, Brazil, Mexico | None |
| `eurostat` | Industrial, retail-volume and construction indexes; real GDP quarterly change; unemployment | About 800 days; fixed EA20 composition, Germany, France, Italy, Spain | None |
| `bis` | USD/EUR/JPY credit to non-bank borrowers outside the respective currency areas | Quarterly, current and three preceding years; native currencies retained separately | None |
| `tic` | Foreign holdings of US securities, net US sales to foreigners and valuation changes; total securities, Treasuries, agencies, corporate bonds and equity | SLT table 1, 800 days; aggregate and selected major countries | None |
| `mof_japan` | Japanese outward/inward net equity, long-term debt, short-term debt and total securities transactions | Weekly and monthly official files, 800 days | None |

The existing FRED `get_macro_indicators` tool still supports its prior aliases
and arbitrary series IDs. The new `fred` collector preloads the additional
liquidity/credit set so that it is available even when an LLM does not request it.

## Source-to-agent mapping

| Workflow role | Direct official evidence | Required analytical use |
| --- | --- | --- |
| News Analyst | SEC/DART filing metadata and excerpts; ECOS, NYFed, Treasury, ECB, FRED, OFR; EIA for relevant industries | Separate verified filing events from macro context and explain business transmission |
| Fundamentals Analyst | SEC/DART facts, FSC identity; relevant Census/BEA/BLS/Eurostat/customs/KOSIS series; EIA where relevant | Compare like-for-like issuer periods, cash generation and balance sheets, then corroborate demand/inventory exposure |
| Macro Analyst | ECOS, NYFed, Treasury, ECB, CFTC, EIA, FRED, OFR, Census, BEA, BLS, OECD, Eurostat, BIS, TIC, Japan MOF | Liquidity/funding → credit/stress → regional activity → measured securities transactions → scenarios |
| Sector Analyst | EIA, customs, KOSIS, CFTC, Census, BEA, BLS, Eurostat | Orders/consumption → production/shipments → inventory → pricing/margin exposure; compare with market leadership before screening |
| Ticker bull/bear researchers, research manager, trader, risk debaters and portfolio manager | News/fundamentals evidence plus CFTC, OECD, BIS, TIC, Japan MOF | Check contradictory official observations, data gaps and thesis invalidation |
| Market researchers, rebuttal, strategist and risk reviewer | Union of macro and sector evidence | Reconcile regime and sector views; carry uncertainty into scenarios and risk constraints |

Company-source collection is market-aware: SEC for supported US-style listed
tickers; DART/FSC for Korean stock codes. Market scans and crypto do not collect
issuer filings. Industry assignment uses resolved business classification and
row-level sector tags. Ambiguous aggregate statistics stay in the market
workflow. Korean industry data can corroborate a foreign company's sector
exposure but are never labeled as that company's revenue or inventory.

Technical and social analysts keep their existing price/technical and social
tools. They do not receive the whole official-data catalog.

The four primary analysts bind `get_official_evidence` in both the LLM tool
schema and their actual LangGraph ToolNodes. It reads the already collected state:

- `source="all"` lists collected sources.
- `source="census", query="M3ADV"` finds matching series by target/title.
- `offset`/`limit` paginate series; `observations` returns 1–60 recent numeric
  points per series in addition to the trend digest.
- SEC/DART document excerpts are searchable as `query="filing excerpt"`.

Market analysts retain their existing seven-round tool budget. Reviewers receive
role-specific digests and upstream reports; they do not receive a new tool loop.

## Correctness and coverage rules

- Observation date, publication date and retrieval time are distinct. An unknown
  publication date stays unknown. Latest revised macro feeds are blocked for
  historical runs; FRED uses dated ALFRED vintages, SEC facts require
  `filed <= trade_date`, and historical DART runs retain dated filing metadata
  only. This is not a complete point-in-time issuer archive.
- Missing values stay missing; a reported zero remains zero. Provider errors,
  missing credentials, empty tables and unsupported coverage remain evidence
  records. Exception messages/credential-bearing URLs are not exported.
- Each multi-table collector preserves successful series when another fails.
  Selected sources run with at most four source workers. Shared HTTP calls have
  finite timeouts, one transient retry and response-size bounds.
- Digests compute previous-observation, three-month and year comparisons only
  when matching dates and reporting bases exist. Rates use percentage points.
  Net flows/positions do not receive misleading percentage changes from negative
  bases. Latest observations older than frequency-specific thresholds are marked
  stale (D:14, W:28, M:100, Q:200, A:550 days); these are heuristics, not release
  calendar guarantees.
- SEC ratios require the same period, currency, duration basis and accession.
  CFO minus capex is labeled as a calculated FCF measure. Unsupported custom
  taxonomy facts may require reading the filing.
- DART separates consolidated/standalone, instant/quarter/annual and each YTD
  duration. Custom account names and member details remain distinct. Non-calendar
  fiscal reporting disables numeric extraction until a calendar is verified;
  document excerpts remain available.
- Census decodes category, unit, geography, time and adjustment dictionaries.
  Sampling-error cells and redundant published percent-change cells are excluded.
  Adjusted series are preferred when available; unadjusted-only series retain
  their basis. Some construction series are annualized; do not interpret them as
  one month's actual units or dollars. BEA levels preserve scaling, metric names
  and provider notes; chained-dollar components are not additive.
- Customs exports are FOB and imports CIF. BIS credit is a stock. TIC explicitly
  separates holdings, net transactions and valuation changes. Japan MOF is a
  designated-investor sample, not all balance-of-payments flows. CFTC positions
  are dated futures positions, not today's capital flows.
- Prompt digests have a weighted per-source text budget so a daily series or large table
  cannot dominate. Census/BEA rotate across table groups; issuer financials receive
  extra space. Omitted counts and failure coverage are visible. Full
  collected observations survive in state and evidence exports. A filing excerpt
  is explicitly partial and does not establish a full-document review.

Fresh ticker runs collect once before the analyst graph; checkpoint resume uses
the saved evidence. Market scans collect once during their existing global
precollection. Existing report exports retain `public_data.md` and raw evidence
(`public_evidence.jsonl` for ticker runs; global evidence for market scans).

## Verify in your environment

```bash
python scripts/smoke_public_data.py --list
python scripts/smoke_public_data.py --sources census,ofr,bis,tic,mof_japan
python scripts/smoke_public_data.py --sources sec,fred --ticker AAPL
python scripts/smoke_public_data.py --sources dart,fsc,ecos,customs,kosis --ticker 005930.KS
python scripts/smoke_public_data.py --sources all --ticker AAPL --output results/public-check.json
python -m pytest tests/test_public_data*.py tests/test_public_us.py tests/test_public_korea.py tests/test_public_filings.py -q
```

The smoke script loads `.env`, makes no LLM calls, reports per-source status and
series counts, and exits 2 on partial/unconfigured coverage. It does not silently
convert a failed provider into a successful check.

Development validation on 2026-09-15 used actual responses from all five Census
programs, OFR, OECD, BIS, Eurostat, TIC, Japan MOF, CFTC, Treasury, ECB and
keyless BLS/NYFed endpoints. Some requests timed out; partial-result handling was
exercised. Authenticated SEC/DART/FSC/EIA/ECOS/KOSIS/FRED/BEA calls require the
operator's credentials and were validated with contract fixtures rather than a
claim of authenticated live success. No paid LLM end-to-end run was performed.

## Official contracts

- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [OpenDART complete financial statements](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019020)
- [ECOS](https://ecos.bok.or.kr/api/), [KOSIS](https://kosis.kr/openapi/), [data.go.kr](https://www.data.go.kr/)
- [EIA API](https://www.eia.gov/opendata/), [NYFed Markets API](https://markets.newyorkfed.org/), [CFTC public reporting](https://publicreporting.cftc.gov/)
- [Treasury Fiscal Data API](https://fiscaldata.treasury.gov/api-documentation/), [ECB API](https://data.ecb.europa.eu/help/api/overview)
- [FRED vintage parameters](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html), [OFR FSI](https://www.financialresearch.gov/financial-stress-index/), [OFR API](https://www.financialresearch.gov/short-term-funding-monitor/api/)
- [Census bulk datasets and embedded dictionaries](https://www.census.gov/econ_datasets/), [BEA API guide](https://apps.bea.gov/api/_pdf/bea_web_service_api_user_guide.pdf), [BLS API v2](https://www.bls.gov/developers/api_signature_v2.htm)
- [OECD SDMX API](https://sdmx.oecd.org/public/rest/v1/), [Eurostat API](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-introduction), [BIS global liquidity indicators](https://www.bis.org/statistics/gli.htm)
- [Treasury TIC SLT](https://home.treasury.gov/data/treasury-international-capital-tic-system-home-page/tic-forms-instructions/tic-slt-form-and-instructions), [Japan MOF securities transactions](https://www.mof.go.jp/english/policy/international_policy/reference/itn_transactions_in_securities/index.htm)
