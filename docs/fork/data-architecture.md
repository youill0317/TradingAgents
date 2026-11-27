<!--
Copyright 2026 TradingAgents fork contributors
SPDX-License-Identifier: Apache-2.0
Added in this fork of TradingAgents 1.0.0.
-->

# Public data: how the fork's providers are built

This is for whoever implements a provider under `src/fork/data/`. It describes the foundation every
provider stands on: the module map and who owns which file, what a provider is given, the HTTP client, the
cache, the listing parser, how a provider declares what it serves, how the router passes a call on, and how
fixtures and tests are made without the network.

The owner's rules bind everything here:

- **No real calls in testing.** Tests, checks, reviews and demonstrations send no request to any outside
  service, data source or model provider: fixtures, stub servers on 127.0.0.1 and injected fetch functions
  only. Every test runs behind a network guard that fails it otherwise (see [Tests](#tests)).
- No limit of our own on how much, how often or how many times anything is used: only the rates a service
  publishes, a Retry-After, hang protection, and a body bound the largest real answers fit comfortably.
- Keys never in a payload, note, error, log, cache key or fixture; never an API URL carrying a key in a
  payload (link to a public page instead).
- A notice at the top of every new file; no new dependency; upstream files touched as little as possible.

## Module map

```
src/fork/data/
  index.ts          forkProviders(config, options): the Providers map, one provider per routes.ts key
  deps.ts           ForkDeps (what every provider is built from), forkDeps(), yahooClient()
  config.ts         PublicDataConfig; publicDataConfig(env, paths) -> {config, notes}; cacheDirOf; secretsOf
  http.ts           createHttp(): the one HTTP client (deadlines, published rates, Retry-After, one retry,
                    User-Agents, DataError mapping, redaction)
  cache.ts          createCache(): memory and disk, remember/keep/forget
  listings.ts       parseListing(): every key form the tools pass, typed, with canonical key and Yahoo symbol
  redact.ts         redact(), redactUrl(), holdsSecret()
  timer.ts          Timer (elapsed time for pacing and waits), REAL_TIMER, abortable()
  catalog/
    instruments.ts  price series (series: keys) and futures roots (future: keys) with their Yahoo symbols
    lines.ts        statement lines: names as the tools write them, XBRL concepts and OpenDART account ids in
                    order, formulas (statements, screens)
    series.ts       the economic series macro_series names, under the skills' names, with aliases and FRED,
                    ECOS and KOSIS codes
    gics.ts         GICS's 2023 tree: each sub-industry's industry, industry group and sector
    markets.ts      what each market view lists: keys, the Treasury's maturities, rates (the Bank of Korea's
                    too), FRED series, Yahoo's screens
  compute/
    technicals.ts   the technicals capability's 22 indicators from daily bars
  sources/
    sec-tickers.ts  secTickers(deps): SEC's ticker list, CIK by US listing and tickers by CIK (shared)
    yahoo-call.ts   yahooCall(work, options): every Yahoo read's failures as DataError kinds (shared)
    yahoo.ts        Yahoo's quotes, charts, quoteSummary modules and chart events, in the capabilities' shapes
    sec.ts          SEC's submissions (filing index) and companyfacts (XBRL facts) on data.sec.gov
    sec-sections.ts a filing's primary document as text, split by Item
    sec-form4.ts    insider reports (Forms 3, 4, 5) in SEC's ownership XML
    sec-frames.ts   SEC's XBRL frames: one concept for every filer, one calendar period
    wikipedia.ts    Wikipedia's S&P 500, 400 and 600 lists (wikitext, CC BY-SA 4.0)
    gdelt.ts        GDELT's DOC 2.0 article lists
    treasury.ts     the U.S. Treasury's par and real yield curves
    nyfed.ts        the New York Fed's reference rates (EFFR with the FOMC's target range, OBFR, SOFR, TGCR, BGCR)
    ecb.ts          the ECB's euro reference rates (EXR) and key interest rates (FM)
    fred.ts         FRED: its API with FRED_API_KEY (every vintage), its keyless download otherwise
    dart.ts         dartSource(deps): OpenDART (company list, filings, statement lines, insider reports, outline,
                    documents), shared by the filers provider and instrument search
    dart-sections.ts a Korean periodic report's chapters, from its main document's DART XML
    fsc.ts          the FSC's stock prices on data.go.kr (the key in either spelling, either address)
    ecos.ts         the Bank of Korea's ECOS: StatisticSearch, its item and table lists
    kosis.ts        Statistics Korea's KOSIS: parameter data, search, items
  util/
    zip.ts          readZip(): stored and deflated entries, checked (no ZIP64, no encryption)
    xml.ts          parseXml() and helpers: tolerant, never throws, no recursion, linear time
    html.ts         htmlToText(): blocks to lines, tables to tab-separated rows, scripts and ix:header left out
    entities.ts     character references for both
    csv.ts          readCsv(), csvTable(), numberOf(): the agencies' CSV files (RFC 4180, read by header)
    hangul.ts       hasHangul(): whether a text holds Hangul (a search in Korean)
  providers/        one module per routes.ts key, each exporting a stable factory:
    yahoo.ts        yahooComposite(deps)       "Yahoo"
    fsc.ts          fscProvider(deps)          "FSC"
    filers.ts       filersProvider(deps)       "SEC EDGAR" ("SEC EDGAR / OpenDART" with DART_API_KEY)
    dart-statements.ts, dart-filings.ts        OpenDART's statements, and filings, sections and insider reports,
                                               which filersProvider serves Korean listings with
    frames.ts       framesProvider(deps)       "SEC EDGAR"
    ecb.ts          ecbProvider(deps)          "ECB"
    statistics.ts   statisticsProvider(deps)   "Public statistics"
    markets.ts      marketsProvider(deps)      "Market overview"
    instruments.ts  instrumentsProvider(deps)  "Instrument search"
    news.ts         newsProvider(deps)         "News search"
scripts/fork/record-fixtures.ts    the owner's fixture recorder; case modules in scripts/fork/fixture-cases/
test/fork/net-guard.ts             the network guard; test/fork/preload.ts loads it for bun test (bunfig.toml)
test/fork/data/harness.ts          fixtureFetch, fixedClock, fakeTimer, testDeps/testProviders, buildTools/runTool,
                                   readCheck and SPREAD_KEYS
test/fork/data/korea-routes.test.ts the routes and keys a setup with Korea's keys reads Samsung Electronics from
test/fork/fixtures/<source>/       fixture bodies and their .meta.json (sec/company-tickers-exchange.json: SEC's
                                   ticker list, hand-made)
```

The top comment of each provider module says what it serves. In every setup: `yahooComposite` quotes,
daily, intraday and paired price history, technicals, profiles (profile, analyst, calendar), corporate actions
and institutional holders (upstream's Yahoo provider, unchanged, answers US listings and its venues; the
composite answers Korean listings, futures, currency and crypto pairs and price series itself); `ecbProvider`
a pair's reference rates; `statisticsProvider` macro series (the Treasury, the New York Fed, the ECB, FRED);
`newsProvider` news by symbol (Yahoo) and by words, topic or the market's latest (GDELT); `marketsProvider`
the 22 market views (Yahoo, the Treasury, the New York Fed, the ECB, FRED); `instrumentsProvider` instrument
search (the catalogs and Yahoo's search, and SEC's ticker list with SEC_USER_AGENT). With SEC_USER_AGENT:
`filersProvider` statements, filings (list and section) and insider transactions, `framesProvider` sector
screens; without it `filersProvider` declares only insider transactions, which answer `not_configured`
naming SEC_USER_AGENT (a Korean listing's naming DART_API_KEY; ownership is offered either way: Yahoo serves its
institutional view).

Korea's keys add: with DART_API_KEY, `filersProvider` (then "SEC EDGAR / OpenDART") answers a Korean listing's
statements, filings, sections and insider transactions from OpenDART and every other listing as before, and
without SEC_USER_AGENT declares statements, filings and insider transactions for the Korean listings (a US
listing's statements and filings answer `not_configured` naming SEC_USER_AGENT; a listing elsewhere is
`unsupported`), and `instrumentsProvider` finds Korean companies by name in OpenDART's company list (without
DART_API_KEY, a Korean listing's statements, filings, sections and insider view answer `not_configured` naming
it wherever they are declared, and so does a search in Hangul that finds nothing); with
DATA_GO_KR_API_KEY, `fscProvider` a Korean listing's quote and daily prices after Yahoo; with ECOS_API_KEY and
KOSIS_API_KEY, `statisticsProvider` their series (and instrument search their catalog entries), and with
ECOS_API_KEY `marketsProvider` the Bank of Korea's row of central_banks. So the engine offers macro with the 16
built-in skills without SEC_USER_AGENT and DART_API_KEY, macro and risk with DART_API_KEY and no SEC_USER_AGENT
(equity and quant also name the sector screen), and all four built-in agents with SEC_USER_AGENT
(`test/fork/gating.test.ts`).

### Who changes what

- A provider is implemented in its own module and in new files beside it: `sources/<source>.ts`,
  `catalog/<name>.ts`, `compute/<name>.ts`, tests under `test/fork/data/`, fixtures under
  `test/fork/fixtures/<source>/`, case modules under `scripts/fork/fixture-cases/<source>.ts`.
- Shared, changed only on their own and with their tests: `index.ts`, `deps.ts`, `config.ts`, `http.ts`,
  `cache.ts`, `listings.ts`, `redact.ts`, `timer.ts`, `util/*`, `catalog/instruments.ts`, `catalog/series.ts`,
  `sources/sec-tickers.ts`, `sources/yahoo-call.ts`, `test/fork/net-guard.ts`, `test/fork/preload.ts`,
  `test/fork/data/harness.ts` and the fixture `test/fork/fixtures/sec/company-tickers-exchange.json`. Rows
  added to `catalog/instruments.ts` or `catalog/series.ts` never change what an existing key names. Their
  interfaces are fixed so the providers can be built in parallel on them; a provider that needs more of one
  says so rather than writing its own copy.
- SEC's ticker list (filers, frames, instrument search) is `sources/sec-tickers.ts`, and every Yahoo read
  maps its failures with `sources/yahoo-call.ts`. Any other source more than one provider reads has one
  module, which the next provider reuses rather than writing its own: the market views read Yahoo's quotes
  and charts through `sources/yahoo.ts` (`planOf`, `readQuotes`, `quoteOf`, `readDaily`), the yield curve
  and breakevens through `sources/treasury.ts`, the rate indicators through `sources/nyfed.ts`, the
  central banks through `sources/nyfed.ts`, `sources/ecb.ts` and `sources/fred.ts`, and FRED's series
  through `sources/fred.ts`; every value-series key a view gives (the Treasury's, the New York Fed's, the
  ECB's, FRED's, the Bank of Korea's) is one `catalog/series.ts` holds, so macro_series reads it as given.
  Instrument search reads the catalogs (`catalog/instruments.ts`, `catalog/series.ts`), SEC's ticker list
  and OpenDART's company list (`sources/dart.ts`, which the filers provider's Korean statements and filings
  read too).
- Upstream files stay as they are except `src/data/routes.ts` (the routing table), `src/engine/factory.ts`
  (`EngineSettings.publicData` and `dataProviders`), `src/cli/main.tsx` (the config read once, passed to
  each engine, its notes said at start), `src/tools/filings.ts` (filing_section's accession pattern takes an
  OpenDART receipt number, 14 digits, beside an SEC accession) and docs. Never edit
  `src/data/capabilities.ts`, `src/data/router.ts`, the other files of `src/tools/`, `src/data/yahoo/*`,
  `src/data/polymarket/*`, `package.json` or `package-lock.json`.

## What a provider is given: ForkDeps

```ts
type ForkDeps = {
  config: PublicDataConfig; // SEC_USER_AGENT and the agencies' keys, the cache directory
  fetch: typeof globalThis.fetch; // under http and yahoo; for another yahoo-finance2 client or the recorder only
  clock: Clock; // the engine's clock: what day it is (tests fix it)
  timer: Timer; // elapsed time, for pacing and waits (tests pass fakeTimer())
  http: Http; // every request but Yahoo's
  cache: Cache;
  yahoo: YahooFinanceClient; // the one yahoo-finance2 client: quote, chart, quoteSummary, search, screener...
};
```

`forkProviders(config, options)` builds one `ForkDeps` with `forkDeps(config, options)` and hands it to every
factory. `options` (`ForkOptions`) may give `fetch`, `clock`, `timer`, `yahoo`, `cache`, `pacer` and
`userAgent`; tests build them with `testDeps` or `testProviders` (see [Tests](#tests)). The engine passes
its `fetch` (when it has one) and its clock, and Polymarket is added beside the fork's providers as
upstream builds it. A provider never sends a request with `deps.fetch`: its requests go through
`deps.http` (published rates, Retry-After, User-Agents, deadlines, redaction) or `deps.yahoo`.

Yahoo is always read through `deps.yahoo`, built by `yahooClient(fetch)` as upstream's provider builds its
own: the library's own User-Agent, its survey and removed-module notices suppressed, a silent logger, and
upstream's `answeredOrThrown` bounding every request (`REQUEST_MS.yahoo`) and turning a non-OK answer from
Yahoo's query hosts into an error carrying its status. Beyond upstream: an answer that fails the library's
schema is not logged, which also stops the library asking npm's registry for its latest version (a request
of its own through the global fetch); requests are not queued four at a time (the library's default:
Yahoo publishes no limit, and the fork adds none); and each client keeps its own cookies and crumb (a new
`ExtendedCookieJar` unless `yahooClient(fetch, { cookieJar })` is given one), where the library's default
shares one jar among every client in the process. Yahoo answers 429 to any other User-Agent, so `deps.http`
refuses a Yahoo address outright; never send Yahoo a request another way, in the app, in tests or when
recording.

Every Yahoo read runs in `yahooCall` (`sources/yahoo-call.ts`), so its failures are the same DataError kinds
for every provider:

```ts
const quote = await yahooCall(() => deps.yahoo.quote(symbol, {}, { fetchOptions: { signal } }), {
  signal, // the caller's cancellation: the signal's reason, as it came
  notFound: "unsupported", // a 404: "no_data" (default, a listing only Yahoo serves), "unsupported", "unavailable"
  statuses: { 422: "unsupported" }, // another status's kind, where the read knows what it means
});
```

| Failure                                                                   | Kind                                       |
| ------------------------------------------------------------------------- | ------------------------------------------ |
| the caller's cancellation                                                 | the caller's own error                     |
| 429, or "too many requests"                                               | `rate_limited`                             |
| 404 or 410, or "not found", "no data found", "delisted", "invalid symbol" | `notFound` (`no_data` unless given)        |
| 401, 403                                                                  | `rejected`                                 |
| the request's deadline, a schema failure, 5xx, any other                  | `unavailable` (or `statuses` for a status) |

A Korean listing the composite cannot answer must pass the call on (`notFound: "unsupported"` or
`"unavailable"`), never `no_data`. Messages are one line of at most 200 characters, without Yahoo's crumb.

## Configuration: config.ts

`publicDataConfig(process.env, paths)` runs once per process (src/cli/main.tsx). Each setting is read from
its environment variable, else from the `"data"` object in `credentials.json` under the same name
(`{"data": {"FRED_API_KEY": "..."}}`):

| Field          | Variable                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `secUserAgent` | `SEC_USER_AGENT` (a name and an email: SEC's fair-access rule; not a secret, but personal)                     |
| `fredKey`      | `FRED_API_KEY`                                                                                                 |
| `dartKey`      | `DART_API_KEY`                                                                                                 |
| `ecosKey`      | `ECOS_API_KEY`                                                                                                 |
| `kosisKey`     | `KOSIS_API_KEY`                                                                                                |
| `dataGoKrKey`  | `DATA_GO_KR_API_KEY`                                                                                           |
| `cacheDir`     | `<home>/cache/fork-data` with `TRADINGAGENTS_HOME`, else `${XDG_CACHE_HOME:-~/.cache}/tradingagents/fork-data` |

`dartKey` is read by the filers provider (OpenDART's statements, filings and insider reports) and instrument
search (OpenDART's company list), `ecosKey` by the statistics and markets providers, `kosisKey` by the
statistics provider, `dataGoKrKey` by the FSC provider.

The notes it returns are said as the session starts, like web_search's: SEC_USER_AGENT unset (nothing is read
from SEC EDGAR, how to set it, that it is SEC's fair-access rule and not a secret), or set without an email; a
setting set where it cannot be used, said as such and not used: on more than one line, not text, empty in the
file, or for SEC_USER_AGENT with characters other than plain ASCII (a User-Agent cannot carry them). An
environment value that cannot be used gives way to the one under `"data"`, and the note says so; when
SEC_USER_AGENT has no usable value at all, a note says nothing is read from SEC EDGAR. A `"data"` that is not
an object, or a name in it the app does not read, is said too. A note names a setting, never its value.
`secretsOf(config)` lists every value that must never be said (each key, data.go.kr's in both the spellings it
hands keys out in, and the SEC User-Agent); the HTTP client and the cache are built with it.

A capability whose source needs a setting that is not there is not declared when the whole capability rests
on it: without SEC_USER_AGENT the SEC-backed capabilities (statements, filings, screens) are not declared,
so they show as not available and the agents that need them are not offered, while the start-up note says
what to set. Where only some requests need a setting (one FRED series in a catalog of keyless ones;
ownership's insider view, whose institutional view Yahoo serves), the call answers `not_configured`, naming
the variable (and where to get a key) in a message shown as it is (`code: NOTICE.capabilityUnavailable`).

## HTTP: http.ts

```ts
const answer = await deps.http.get(url, {
  source: "SEC EDGAR", // errors name it
  signal: call?.signal, // the caller's cancellation
  timeoutMs: FORK_REQUEST_MS.bulk, // optional: the class default (requestTimeout) unless given
  headers: { Accept: "application/json" },
  notFound: "no_data", // what a 404 or 410 means: "no_data" (default), "unsupported", "invalid"
  notFoundMessage: "SEC EDGAR has no filer with CIK 0000000001",
  accept: [400], // statuses read by the caller instead of failed (FRED's error JSON)
  maxBytes: ANSWER_BYTES, // the body bound (upstream's 16 MiB unless given)
  redirect: "same-origin", // redirects followed to the request's own origin only ("follow" unless given)
});
answer.status;
answer.headers;
await answer.json(); // or .text(), .bytes(): the body is read once
await deps.http.json(url, options); // shortcuts: .json(), .text(), .bytes()
deps.http.redact(text); // every configured secret removed, for what a provider says itself
```

What a request does:

- Its deadline covers the body too. By class of source (`FORK_REQUEST_MS`, hang protection only, built on
  upstream's `REQUEST_MS.yahoo`): `api` (30 s, the default: SEC's JSON APIs answered in 0.07-1.4 s, the
  Treasury, the New York Fed, FRED's API, Wikipedia in under 1 s), `slow` (60 s, the default for
  `SLOW_HOSTS`: the ECB took 1.1-7.4 s for one series and 21.3 s for every currency's latest rate) and
  `bulk` (60 s, given by the caller for a large document). `requestTimeout(host, given)` says which applies.
- A host with a published rate (`HOST_RULES`) waits for its turn: SEC 10 requests a second shared by every
  `*.sec.gov` host, FRED's API (`api.stlouisfed.org`) 120 a minute, FRED's website (`fred.stlouisfed.org`,
  the keyless download) one a second (its robots.txt's `Crawl-delay: 1`), GDELT's API one every 5 s, KOSIS
  (`kosis.kr`) 200 a minute. OpenDART, ECOS and data.go.kr publish no such number; their daily quotas
  are theirs to enforce. Turns are
  given in the order asked; a start is counted when it is actually made, and a request whose timer woke
  late waits until the window holds room, so starts never exceed the published rate in any window. A
  request whose turn would come after its own deadline fails at once as `rate_limited` (with
  `retryAfterMs`), unsent; it never hangs. A turn a cancelled request will not take is given back. The
  turns are kept for the whole process (`Pacer`), as the services count per sender.
- Identical GDELT requests in flight share one request and its answer, run under a cancellation of their
  own: each caller stops waiting on its own, and when every caller that could cancel has, the request is
  cancelled (unsent if its turn had not come) and its turn given back. A caller already cancelled starts
  nothing; a caller does not join a shared request whose turn comes after its own deadline (`rate_limited`).
- 429 and 503 with Retry-After: the source's pause is kept, for the host (for a rule's hosts, all of them:
  SEC's), and holds every later request too: one whose deadline the pause fits waits it out, one whose
  deadline it outlasts fails at once as `rate_limited` with the time left, unsent. The request that got it
  is asked once more after the pause when that fits its deadline; otherwise it is `rate_limited` with
  `retryAfterMs`. A 429 without Retry-After is `rate_limited` at once, and keeps no pause (Yahoo's 429 to a
  wrong User-Agent is not a rate, so nothing backs off on it).
- A host is compared as DNS reads it: `hostName()` lower-cases it and drops a fully-qualified name's
  trailing dot, so `data.sec.gov.` is paced and named as data.sec.gov, and `finance.yahoo.com.` is refused.
- One retry, after `RETRY_PAUSE_MS` (1 s), of a dropped connection or a 5xx. A request that ran past its
  deadline, or was cancelled, is not retried.
- Redirects are followed as fetch follows them, unless the caller passes `redirect: "same-origin"`, as Korea's
  sources do with their keys in the address (OpenDART, the FSC, ECOS, KOSIS), and the
  recorder for any address holding a key: a redirect to the request's own origin (scheme, host and port) is
  followed, up to the Fetch standard's 20; one elsewhere is not, and the request is `unavailable`, its address
  unsaid, so their keys reach nothing but their sources. FRED's API, whose address carries `FRED_API_KEY`,
  passes no such option and follows redirects as fetch does, as every other source does.
- User-Agent: SEC's hosts get `SEC_USER_AGENT` (the app's name when it is not set, which happens only in the
  recorder), every other host the app's name and version (`tradingagents/1.0.0`), the fixture recorder
  `TradingAgents-fork-dev/1.0`. A Yahoo address is refused with an Error before any request.
- The status is mapped before the body is read (SEC's 404 is an S3 XML page, not JSON). Failures, as
  DataError kinds the router acts on:

| Answer                                 | Kind                   | Note                                                               |
| -------------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| 401, 403                               | `rejected`             | SEC's 403 explains its User-Agent rule and 10-a-second limit       |
| 404, 410                               | `notFound` option      | `no_data` unless the caller says `unsupported` or `invalid`        |
| 429, 503 with a wait too long          | `rate_limited`         | `retryAfterMs` when the source gave one                            |
| other 4xx                              | `unavailable`          | read it yourself with `accept` when the body says why (FRED's 400) |
| 5xx after the retry, network, deadline | `unavailable`          |                                                                    |
| body past `maxBytes`                   | `unavailable`          | upstream's "answered more than N bytes"                            |
| `json()` on a body that is not JSON    | `unavailable`          |                                                                    |
| a header value fetch cannot send       | `unavailable`          | unsent; the header is named, never its value                       |
| the caller's cancellation              | the caller's own error | as upstream: the router stops on it                                |

- The default body bound is upstream's `ANSWER_BYTES` (16 MiB); the largest answer measured, SEC
  companyfacts for MetLife, is 9.3 MB decoded. A source whose real answers are larger (a bank's 10-K
  document may be) passes its own `maxBytes`, measured, never a smaller one to save work.
- `unreadable(source, what)` is the failure a source gives for an answer read whole that is not in the form
  it documents ("FRED answered its API in a form this app does not read."): `unavailable`.
- No message ever holds a key: every message is passed through `redact`, which removes each configured
  secret as written and URL-encoded (`encodeURIComponent`, a form query, either case of hex), in a query or
  a path (ECOS puts its key in the path). Network errors are named by their code, never by their message
  (which may quote the URL).

## Cache: cache.ts

```ts
// A fresh value, else load it; callers asking together share one load.
const facts = await deps.cache.remember(`sec:companyfacts:${cik}`, DAY_MS, () => readFacts(cik, call), {
  disk: "json", // keep it on disk too: "json" (plain data), "text" or "bytes"
  signal: call?.signal, // this caller's cancellation (the load uses it too)
});
// With when it was stored, and served stale when reloading fails for the source's reason.
const { value, stale, storedAt } = await deps.cache.keep("wikipedia:sp500", WEEK_MS, load, {
  disk: "json",
  staleOnError: true, // unavailable, rate_limited or quota: the old value, stale: true
  memory: false, // a large value on disk only
  signal: call?.signal,
});
await deps.cache.forget(`sec:companyfacts:${cik}`);
```

- A failed load is never kept, and is the answer of every caller waiting on it.
- Pass the call's `signal`: a caller's cancellation ends its own wait at once, never a load another caller
  waits on. When the caller whose load it is was cancelled (its signal aborted, whatever the error says),
  each caller waiting on it looks again: the first starts its own load, the others join it.
- A kept value is shared by every caller that asks for it: read it, never change it.
- A key holding any configured secret is refused (an Error): build keys from what the request is about
  (`fred:series:CPIAUCSL`), never from a URL that carries a key.
- Disk entries live in `config.cacheDir`, one file per key (named by a hash; the key is inside), written
  whole through a temporary file and a rename, owner-only. An entry that cannot be read is a miss; a
  directory that cannot be written leaves the value in memory. Entries a month past their time, and
  temporary files an hour old (a process stopped between writing and renaming), are swept when a cache
  first writes.
- Nothing limits how much is kept. Keep what is worth keeping: a parsed, smaller form rather than a large raw
  answer held in memory (`memory: false` keeps a large body on disk only).
- Without `config.cacheDir` (tests, an engine built without the CLI) the cache is memory only.

## Listings: listings.ts

`parseListing(key)` never throws; it reads every form the tools pass (`security:` prefixed or not, typed keys
in either case as the symbol-schema tools upper-case them), reading the kind as upstream's
`src/data/instrument-key.ts` does:

| Key                                             | Listing                                                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `AAPL`, `brk.b`, `BRK-B`                        | `{kind: "us", key: "BRK-B", ticker, yahoo: "BRK-B"}`                                                                 |
| `XNAS:AAPL`, `XLON:VOD`, `XNYS:BRK.B`           | `{kind: "venue", key, mic, symbol, yahoo: "VOD.L" or null when Yahoo lists no such venue}`; key `XNYS:BRK-B`         |
| `XKRX:005930`, `005930.KS`                      | `{kind: "kr", key: "XKRX:005930", code, market: "XKRX", yahoo: ["005930.KS"]}`                                       |
| `XKOS:035900`, `035900.KQ`                      | `{kind: "kr", key: "XKOS:035900", market: "XKOS", yahoo: ["035900.KQ"]}`                                             |
| `005930`                                        | `{kind: "kr", key: null, market: null, yahoo: ["005930.KS", "005930.KQ"]}` (resolve by one batched quote)            |
| `future:XNYM:CL`, `future:CL`, `.../continuous` | `{kind: "future", key: "future:XNYM:CL", mic, root, yahoo: "CL=F", known}`                                           |
| `fx:EURUSD`                                     | `{kind: "fx", key, base, quote, yahoo: "EURUSD=X"}`                                                                  |
| `crypto:BTC-USD`                                | `{kind: "crypto", key, base, quote, yahoo: "BTC-USD"}`                                                               |
| `crypto:BTC-USDT`                               | `{kind: "crypto", key: "crypto:BTC-USD", yahoo: "BTC-USD", note: "...read as BTC-USD..."}`: say `note` in the answer |
| `series:us.equity_index.sp500`                  | `{kind: "price_series", key, series: {...}, yahoo: "^GSPC"}` (catalog/instruments.ts)                                |
| `series:us.fred.cpiaucsl`                       | `{kind: "value_series", key}`: price tools answer `notPriced(listing, source)` (invalid, pointing to macro_series)   |
| anything else                                   | `{kind: "invalid", input, reason}`                                                                                   |

`canonicalKey(key)` gives the key answers name (undefined for an unresolved bare Korean code): one key per
listing, so a share class is written as the venue writes it, with a dash at the US venues, London and
Toronto (`BRK.B`, `BRK-B` are `BRK-B`; `XNYS:BRK.B`, `XNYS:BRK-B` are `XNYS:BRK-B`). Answers name the
canonical key in `instrument.key`; Korean answers say venue KOSPI or KOSDAQ and currency KRW. 035720
(Kakao) is a KOSPI listing; KOSDAQ examples are 035900 (JYP Entertainment) and 247540 (EcoPro BM).
`US_VENUES` lists the US venues' MICs.

## SEC's ticker list: sources/sec-tickers.ts

```ts
const tickers = secTickers(deps); // not_configured on use without SEC_USER_AGENT
await tickers.bySymbol("BRK.B", call); // {cik: "0001067983", name, ticker: "BRK-B", exchange: "NYSE"} or undefined
await tickers.byCik(1067983, call); // every ticker of the CIK, in SEC's order (BRK-B, BRK-A)
await tickers.all(call); // the whole list, for instrument search
```

- It reads `https://www.sec.gov/files/company_tickers_exchange.json` (`SEC_TICKERS_URL`), SEC's documented
  `{fields: [cik, name, ticker, exchange], data: [...]}`, by field name; CIKs are padded to ten digits as
  data.sec.gov's paths take them; `exchange` is null where SEC gives none (OTC tickers say `OTC`).
- Kept a day, on disk too (`sec:company-tickers-exchange`), and served past its day when SEC cannot be
  read; callers asking together share one request.
- Only US listings are looked up, in any spelling the tools pass (`AAPL`, `brk.b`, `XNYS:BRK.B`,
  `security:BRK.B`): a listing on another venue is another company than the US filer with its letters
  (`XLON:BA` is BAE Systems, not Boeing), so it is undefined, with no request; so are Korean codes, pairs and
  series. `secTicker(key)` gives the ticker as SEC writes it, or undefined.

## Readers: util/

- `readZip(bytes)` lists entries; `entry.bytes()` / `entry.text()` inflate one, checked against its size and
  CRC-32; `zipEntry(entries, name)` finds one. A damaged archive throws a `ZipError`: answer `unavailable`.
  An entry declaring more than 256 MiB is refused before it is inflated (protection against an archive
  bomb; OpenDART's company list, the largest archive expected, is reported at tens of MB unpacked: measure
  it when it is recorded), and inflating never passes the size an entry declares.
- `parseXml(text)` returns a `#document` element; `child`, `children`, `find(el, "a/b/c")`, `findAll`,
  `textOf`, `valueAt(el, "transactionAmounts/transactionShares/value")` read it. A name without a prefix
  matches an element's local name. Attributes are kept in an object without a prototype.
- `htmlToText(html)` gives the text a reader sees, for filing sections. A head whose end tag is left out
  ends where the body's content starts, as browsers read it; a table inside a cell stays on the cell's line.
- `readCsv(text)` reads RFC 4180 rows (CRLF or LF, quoted fields holding commas, quotes and line ends, a
  byte-order mark), `csvTable(text)` a file by its header's names, `numberOf(cell)` a number as the agencies
  write one (null for an empty cell, `.` or `NaN`); in one pass, never throwing.
- All three read hostile input in time proportional to it and never recurse; their tests hold the
  adversarial cases (bombs, deep nesting, unclosed quotes and tags, stray end tags) and pages of filing
  size (a 5 MB page of 100,000 paragraphs, 20,000 nested tables) with time bounds.

## Declaring capabilities

A provider is a `DataProvider`: `{ name, capabilities }`, each capability an `Implementation<C>` whose methods
answer the data alone; the router adds `source`, `notes` and `after`. Declare a capability only when the
provider can serve it in this setup; declare only the methods it serves (the router asks the next provider
in the chain for a method a provider lacks). A declaration is what gating counts: an agent is offered only
when every data tool it names has a provider, so never declare a capability that will always fail. The one
exception is a method of a capability another provider serves, declared to say which setting it needs
(ownership's insider view without SEC_USER_AGENT): gating counts capabilities, so it changes nothing there.

```ts
export function framesProvider(deps: ForkDeps): DataProvider {
  if (!deps.config.secUserAgent) return { name: "SEC EDGAR", capabilities: {} };
  const sources = { universe: spUniverse(deps), tickers: secTickers(deps), frames: secFrames(deps) };
  return {
    name: "SEC EDGAR",
    capabilities: {
      crossSections: {
        financials: (query, call) => financials(deps, sources, query, call),
      },
    },
  };
}
```

Fill every field the tools read: `src/tools/*.ts` read more than the zod output schemas require, and a field
left undefined is a value the model never sees. Set fields to `null` when the source has no value, and say why
in `field_states`. The read check in the tests (below) lists every field a tool read that the answer did not
supply, and, for an answer a tool spreads or passes on whole (technicals, estimates, institutional
holders, a quote's day), every key `SPREAD_KEYS` names that the answer leaves out.

## The router: which failures pass a call on

`src/data/routes.ts` lists each capability's providers in order:

| Capability                             | Providers                              |
| -------------------------------------- | -------------------------------------- |
| quotes                                 | yahoo, fsc                             |
| priceHistory                           | yahoo, ecb, fsc                        |
| statements, filings                    | filers                                 |
| news                                   | news                                   |
| profiles, corporateActions, technicals | yahoo                                  |
| ownership                              | filers (transactions), yahoo (holders) |
| macroSeries                            | statistics                             |
| instruments                            | instruments                            |
| crossSections                          | frames                                 |
| markets                                | markets                                |
| predictionMarkets                      | polymarket                             |

The FSC declares its methods only with DATA_GO_KR_API_KEY; the router skips a provider that does not
implement the method asked. A call goes to the first provider that implements the method. These kinds pass
it to the next one, and the answer then says which failed before it: `unsupported`, `unavailable`,
`rate_limited`, `quota`, `rejected`, `not_configured`. `no_data` and `invalid` end the call: they are
answers about the request or the market. So:

- A listing a provider does not cover is `unsupported`, never `no_data`. A Korean listing the Yahoo composite
  cannot answer fails as `unsupported` or `unavailable`, so the FSC is asked; test the single-quote path
  (`quotes.quote`) as well as the batch.
- `quotes.many` answers per instrument: an instrument it could not answer goes in `errors` with its `kind`,
  and the router asks the next provider for those with a passing kind.
- Upstream's Yahoo maps a 404 to `no_data`: hand it only the listings it serves (US tickers and its MIC
  venues), and answer the others in the composite.
- A cancelled call goes no further, whatever its kind.

## Fixtures

A fixture is a body under `test/fork/fixtures/<source>/` (in any folder below it) with a `.meta.json` beside
it (`source`, `name`, `url` with keys removed, `status`, `content_type`, `recorded_at`, `bytes`, `hand_made`,
and `note`: for a hand-made one starting "Hand-made", saying what it is made from; for a real answer saved
earlier, where it was saved). A test checks that every fixture has its meta and that the meta's `bytes`
match. Fixtures come from three places, never from a live request made in a development session:

- answers the owner records with the recorder, on the owner's own machine (`hand_made: false`);
- real answers saved earlier, kept whole when they are complete answers (an error page, an empty or cut-off
  body is not a fixture), or cut to an excerpt with the full size stated where it matters; `recorded_at` is
  the answer's own date and `note` says where it was saved (`ecb/exr-usd-last5.csv`);
- hand-made answers in the source's documented format, `"hand_made": true` with a `note`: where no real
  answer has been seen (www.sec.gov needs a contact User-Agent, GDELT was unreachable, Yahoo's own answers
  were not recorded), listed for a live check later. `sec/company-tickers-exchange.json` is SEC's ticker
  list made this way, its rows following SEC's own submissions answers; every SEC provider's tests use it.

Keep fixtures small. Wikipedia excerpts carry their CC BY-SA attribution. JSON bodies under
`test/fork/fixtures/` are exempt from the formatter (`test/fork/fixtures/biome.json`) so they stay as
recorded; `.meta.json` files are formatted.

### The recorder (the owner's tool)

```sh
bun scripts/fork/record-fixtures.ts --dry-run          # list the cases and the files, send nothing
bun scripts/fork/record-fixtures.ts --only ecb,nyfed   # record those sources' cases
bun scripts/fork/record-fixtures.ts --cases <dir> --out <dir>   # other case modules, another folder
```

A case module in `scripts/fork/fixture-cases/<source>.ts`:

```ts
import type { FixtureCase } from "../record-fixtures.ts";

export const cases: FixtureCase[] = [
  {
    source: "ecb",
    name: "exr-usd-last5",
    url: "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?format=csvdata&lastNObservations=5",
  },
  {
    // A key comes from the settings (environment or credentials.json), never from the module.
    source: "fred",
    name: "series-cpiaucsl",
    url: (config) =>
      `https://api.stlouisfed.org/fred/series?series_id=CPIAUCSL&file_type=json&api_key=${config.fredKey}`,
  },
  {
    // Yahoo's raw answer to a yahoo-finance2 call, made with the library's own User-Agent (its crumb removed).
    source: "yahoo",
    name: "quote-aapl",
    read: (_http, { yahooAnswer }) => yahooAnswer((yahoo) => yahoo.quote("AAPL"), /\/v7\/finance\/quote\?/),
  },
];
```

Every request goes through the fork's own clients, so it is paced and bounded as the app's; every configured
key is removed from a text answer and from the meta's URL, and a binary answer holding one is not written. A
case that fails writes nothing, so a fixture is never replaced by a failure; `accept: [400]` records an
error body deliberately. Its tests (`test/fork/data/recorder.test.ts`) prove all of this against a stub
server on 127.0.0.1, Yahoo's addresses included (a fetch sends them to the stub); nothing else ever runs it.

## Tests

No test reaches the network. Run `bun test` from the repository root: `bunfig.toml`, read from the working
directory, preloads `test/fork/preload.ts`, which installs `test/fork/net-guard.ts`: fetch, WebSocket,
Bun.connect and node's http, https, http2, net and tls clients refuse any host but 127.0.0.1 and localhost,
and every proxy variable points at a local trap that refuses what reaches it (Bun.fetch, which cannot be
replaced). A refused request is printed (`net-guard: ...`), thrown, and fails the test that made it even
when the code under test caught it. `test/fork/data/harness.ts` installs the guard too when it is imported,
so a data test run from elsewhere still reaches no host (the refusal is thrown, though only the preload
fails the test for a refusal the code caught). A test that starts a process from source passes the guard
on: `Bun.spawn([process.execPath, "--preload", NET_GUARD, ...])`, then checks its stderr holds no
`net-guard:`. A test that checks a refusal on purpose takes it with `takeBlocked()`. Stub servers listen
on 127.0.0.1, port 0.

`test/fork/data/harness.ts`:

```ts
const { providers, fetch, clock } = testProviders({ secUserAgent: "Test Agent test@example.com" }, [
  { match: SEC_TICKERS_URL, file: "sec/company-tickers-exchange.json" }, // shared, hand-made
  // A provider's own fixture, added with it (the filers provider's, from SEC's saved answer for Apple):
  { match: /data\.sec\.gov\/submissions\/CIK0000320193\.json$/, file: "sec/submissions-aapl.json" },
  { match: (url) => url.hostname === "api.gdeltproject.org", body: "{}", status: 200 },
  ...YAHOO_AAPL, // Yahoo's cookie page and crumb, and the hand-made AAPL quote and chart
]);
const { runTool } = buildTools(providers, { clock, check: true });
const run = await runTool("filings", { symbol: "AAPL", forms: ["10-K"] });
run.text; // what the model reads
run.summary; // the transcript's line
run.evidence; // its record's id ("e1"), for a later call: runTool("dcf", { cash_flow: { ref: "e1" }, ... })
run.payload; // the recorded payload
run.provenance; // { source, after?, notes?, subject?, as_of? }
run.failure; // "data_no_data", "data_unsupported", ... when it failed
run.reads.missing(); // fields the tool read (or SPREAD_KEYS names) that the provider's answer left undefined
expect(fetch.unmatched).toEqual([]);
```

- `testProviders(config, routes, extra?)` and `testDeps(config, routes, extra?)` build the fork's providers or
  deps for a test: a fixture fetch over `routes`, the engine's day fixed (`TEST_DAY`, or `extra.now`), a fake
  timer and a pacer of the test's own (no turn or Retry-After pause of another test's is waited for, and
  nothing waits in real time), a cache in memory unless the config names a directory (or `extra.cache`
  gives one), and a yahoo-finance2 client with cookies of its own, so a Yahoo test serves its own cookie
  page and crumb (`YAHOO_AAPL`) and passes alone or after another. Build every provider test on them.
- A request no route matches is printed and thrown, and listed in `fetch.unmatched`.
- `buildTools` routes the providers and builds the data tools, the compute tools (dcf, returns_risk, beta,
  correlation, portfolio_risk, optimize_portfolio, indicators, calc) and the evidence tool in one
  `ToolRegistry` over one evidence store, as the engine does, and runs each call as the model's would be
  run, each a step of its own: a compute tool's `{"ref": "e1"}` reads an earlier call's recorded result.
  With `check: true` every provider answer is behind `readCheck`, a view that logs each field the tool
  read and whether it held a value (a field asked about with `in` is read, never missing; listing an
  object's keys is noted in `reads.listed`). A spread or a record passed on whole never asks the view for a
  key the answer lacks, so `SPREAD_KEYS` names the keys the tools need of those answers (technicals'
  22 indicators and the fields its text states, a quote's day, estimates' consensus and calendar, holders'
  rows) and the
  check logs each, missing when absent; `expectKeys` does the same for keys a test names.
- `fakeTimer()` makes pacing and Retry-After waits instant: sleeps end one at a time in the order of their
  end times, the time set to each one's end, and are listed in `slept`; `fakeTimer(0, late)` ends each
  sleep `late(index)` ms past its time, as a busy real timer does.
- `test/fork/data/harness.test.ts` shows quote and price_history through upstream Yahoo on the hand-made
  Yahoo fixtures, with the read check's findings, a statements result read by dcf, price_history read by
  returns_risk, and technicals' left-out indicators found. `YAHOO_AAPL` in the harness holds their routes
  (Yahoo's cookie page and crumb included): a Yahoo test adds its own routes before them.
- Golden render tests run each data tool a provider serves through `runTool` and compare `text`; the read
  check asserts `run.reads.missing()` holds only fields the provider leaves out on purpose.
- `test/fork/data/all-tools.test.ts` runs every data tool once (once per method where a tool reads more than
  one, statements annual and quarterly, news by symbol and by topic, markets once per view) through all the
  fork's providers together, as a setup with SEC_USER_AGENT builds them, and Polymarket, on the providers'
  fixtures: each call answers, from the source the router names, with no field the tool reads by name left
  out (upstream Yahoo's own optional fields aside) and, of a record it passes on whole, none of the keys
  `SPREAD_KEYS` or a view's `VIEW_KEYS` (`markets-routes.test.ts`) name, so a change that drops one fails
  there. A data tool added without a call there fails it too. Then, with Korea's keys too
  (`korea-routes.test.ts`), Samsung Electronics through every Korean source the same way: statements,
  filings, sections and insider reports (OpenDART), quote and daily prices (the FSC, Yahoo failing), an ECOS
  and a KOSIS series, central_banks' Bank of Korea row, news for Korean words (GDELT) and find_instrument by
  its Korean name; no key is said in any of them.
- `test/fork/gating.test.ts` pins the agents and skills an engine offers: as built (`AS_BUILT`: macro with
  the 16 built-in skills), and with the fork's providers as each configuration builds them over a fixture
  fetch (macro without SEC_USER_AGENT and DART_API_KEY; macro and risk with DART_API_KEY, or every Korean key,
  and no SEC_USER_AGENT; all four with SEC_USER_AGENT, whatever other key is set), each the agents whose every
  data tool the routed providers serve. Update it when a provider changes what it declares.
- `test/fork/korea-engine.test.ts` asks one question of an engine built with Korea's keys (`publicData`) over
  a fixture fetch and a scripted model on 127.0.0.1: find_instrument by a Korean name, then the key's
  statements, filings and a filing's section, each answered; no key is in any request the model receives,
  and each key reaches only its own source.

Before a change is done, run the checks FORK.md lists under "Taking an upstream release" (step 5), from
`npm run typecheck` through `sh scripts/fork/check-notices.sh main` (with `export
PATH=/opt/node22/bin:/root/.bun/bin:$PATH` in the cloud session; never `npm ci` or `npm install` there).
The compiled executable may be run only against a local stub model that answers without a tool call, so
it asks no source for data. A stub model lists its context window in `/v1/models` as vLLM does
(`max_model_len`, as the stubs of `scripts/smoke.sh` and of the fork's check of the request the executable
sends a model do): with the built-in agents and skills offered, the app's estimate of the main agent's first
request (two characters a token, plus the step's output, at most a quarter of the window, and a margin of
2,048 tokens) is more than the 32,768 tokens assumed for a server that reports none
(`test/fork/context-window.test.ts`).

Biome's formatter rewrites a Unicode escape in a string or a regular expression (a backslash, `u` and four
hex digits) as the character itself, invisible ones included: write such a character with
`String.fromCharCode(0xa0)`, or keep code points in a table as `util/entities.ts` does.
