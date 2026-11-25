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
  util/
    zip.ts          readZip(): stored and deflated entries, checked (no ZIP64, no encryption)
    xml.ts          parseXml() and helpers: tolerant, never throws, no recursion, linear time
    html.ts         htmlToText(): blocks to lines, tables to tab-separated rows, scripts and ix:header left out
    entities.ts     character references for both
  providers/        one module per routes.ts key, each exporting a stable factory:
    yahoo.ts        yahooComposite(deps)       "Yahoo"
    filers.ts       filersProvider(deps)       "SEC EDGAR"
    frames.ts       framesProvider(deps)       "SEC EDGAR"
    ecb.ts          ecbProvider(deps)          "ECB"
    statistics.ts   statisticsProvider(deps)   "Public statistics"
    markets.ts      marketsProvider(deps)      "Market overview"
    instruments.ts  instrumentsProvider(deps)  "Instrument search"
    news.ts         newsProvider(deps)         "News search"
scripts/fork/record-fixtures.ts    the owner's fixture recorder; case modules in scripts/fork/fixture-cases/
test/fork/net-guard.ts             the network guard; test/fork/preload.ts loads it for bun test (bunfig.toml)
test/fork/data/harness.ts          fixtureFetch, fixedClock, fakeTimer, buildTools/runTool, readCheck
test/fork/fixtures/<source>/       fixture bodies and their .meta.json
```

The top comment of each provider module says what it will serve. Today `yahooComposite` is upstream's
Yahoo provider unchanged (quotes and daily price history) over the shared yahoo-finance2 client, and every
other provider declares nothing, so the engine offers what it offered before (no built-in agent, no
built-in skill).

### Who changes what

- A provider is implemented in its own module and in new files beside it: `sources/<source>.ts`,
  `catalog/<name>.ts`, `compute/<name>.ts`, tests under `test/fork/data/`, fixtures under
  `test/fork/fixtures/<source>/`, case modules under `scripts/fork/fixture-cases/<source>.ts`.
- Shared, changed only on their own and with their tests: `index.ts`, `deps.ts`, `config.ts`, `http.ts`,
  `cache.ts`, `listings.ts`, `redact.ts`, `timer.ts`, `util/*`, `catalog/instruments.ts`,
  `test/fork/net-guard.ts`, `test/fork/preload.ts`, `test/fork/data/harness.ts`. Rows added to
  `catalog/instruments.ts` never change what an existing key names.
- A source more than one provider reads (SEC's ticker list for filers, frames and instrument search; Yahoo's
  quotes for the Yahoo composite and the market views) needs one owner: agree who writes
  `sources/<source>.ts` before two providers each write their own.
- Upstream files stay as they are except `src/data/routes.ts` (the routing table), `src/engine/factory.ts`
  (`EngineSettings.publicData` and `dataProviders`), `src/cli/main.tsx` (the config read once, passed to
  each engine, its notes said at start) and docs. Never edit `src/data/capabilities.ts`,
  `src/data/router.ts`, `src/tools/*`, `src/data/yahoo/*`, `src/data/polymarket/*`, `package.json` or
  `package-lock.json`.

## What a provider is given: ForkDeps

```ts
type ForkDeps = {
  config: PublicDataConfig; // SEC_USER_AGENT and the agencies' keys, the cache directory
  fetch: typeof globalThis.fetch;
  clock: Clock; // the engine's clock: what day it is (tests fix it)
  timer: Timer; // elapsed time, for pacing and waits (tests pass fakeTimer())
  http: Http; // every request but Yahoo's
  cache: Cache;
  yahoo: YahooFinanceClient; // the one yahoo-finance2 client: quote, chart, quoteSummary, search, screener...
};
```

`forkProviders(config, options)` builds one `ForkDeps` with `forkDeps(config, options)` and hands it to every
factory. `options` (`ForkOptions`) may give `fetch`, `clock`, `timer`, `yahoo`, `cache`, `pacer` and
`userAgent`; tests give a fixture fetch, a fixed clock and a fake timer. The engine passes its `fetch` (when
it has one) and its clock, and Polymarket is added beside the fork's providers as upstream builds it.

Yahoo is always read through `deps.yahoo`, built by `yahooClient(fetch)` as upstream's provider builds its
own: the library's own User-Agent, its survey and removed-module notices suppressed, a silent logger, and
upstream's `answeredOrThrown` bounding every request (`REQUEST_MS.yahoo`) and turning a non-OK answer from
Yahoo's query hosts into an error carrying its status. Beyond upstream, an answer that fails the library's
schema is not logged, which also stops the library asking npm's registry for its latest version (a request
of its own through the global fetch). Yahoo answers 429 to any other User-Agent, so `deps.http` refuses a
Yahoo address outright; never send Yahoo a request another way, in the app, in tests or when recording.

## Configuration: config.ts

`publicDataConfig(process.env, paths)` runs once per process (src/cli/main.tsx). Each setting is read from
its environment variable, else from the `"data"` object in `credentials.json` under the same name
(`{"data": {"FRED_API_KEY": "..."}}`):

| Field                                | Variable                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `secUserAgent`                       | `SEC_USER_AGENT` (a name and an email: SEC's fair-access rule; not a secret, but personal)                     |
| `fredKey`                            | `FRED_API_KEY`                                                                                                 |
| `dartKey`                            | `DART_API_KEY`                                                                                                 |
| `ecosKey`                            | `ECOS_API_KEY`                                                                                                 |
| `kosisKey`                           | `KOSIS_API_KEY`                                                                                                |
| `dataGoKrKey`                        | `DATA_GO_KR_API_KEY`                                                                                           |
| `naverClientId`, `naverClientSecret` | `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`                                                                       |
| `beaKey`, `eiaKey`                   | `BEA_API_KEY`, `EIA_API_KEY`                                                                                   |
| `cacheDir`                           | `<home>/cache/fork-data` with `TRADINGAGENTS_HOME`, else `${XDG_CACHE_HOME:-~/.cache}/tradingagents/fork-data` |

The notes it returns are said as the session starts, like web_search's: SEC_USER_AGENT unset (what needs it,
how to set it, that it is SEC's fair-access rule and not a secret), without an email, or with characters a
header cannot carry (then it is not used), and a `"data"` object or field that cannot be used. A note names
a setting, never its value. `secretsOf(config)` lists every value that must never be said (each key, and
the SEC User-Agent); the HTTP client and the cache are built with it.

A capability whose source needs a setting that is not there is not declared when the whole capability rests
on it: without SEC_USER_AGENT the SEC-backed capabilities (statements, filings, insider transactions,
screens) are not declared, so they show as not available and the agents that need them are not offered,
while the start-up note says what to set. Where only some requests need a key (one FRED series in a catalog
of keyless ones), the call answers `not_configured`, naming the variable and where to get a key.

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
  `*.sec.gov` host, FRED's API (`api.stlouisfed.org`) 120 a minute, GDELT's API one every 5 s. A request
  whose turn would come after its own deadline fails at once as `rate_limited` (with `retryAfterMs`); it
  never hangs. Identical GDELT requests in flight share one request and its answer; one caller cancelling
  does not cancel the others. The turns are kept for the whole process, as the services count per sender.
- 429 and 503 with Retry-After: waited for when the wait fits the deadline, then asked once more; otherwise
  `rate_limited` with `retryAfterMs`. A 429 without Retry-After is `rate_limited` at once (Yahoo's 429 to a
  wrong User-Agent is not a rate, so nothing backs off on it).
- One retry, after `RETRY_PAUSE_MS` (1 s), of a dropped connection or a 5xx. A request that ran past its
  deadline, or was cancelled, is not retried.
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
| the caller's cancellation              | the caller's own error | as upstream: the router stops on it                                |

- The default body bound is upstream's `ANSWER_BYTES` (16 MiB); the largest answer measured, SEC
  companyfacts for MetLife, is 9.3 MB decoded. A source whose real answers are larger (a bank's 10-K
  document may be) passes its own `maxBytes`, measured, never a smaller one to save work.
- No message ever holds a key: every message is passed through `redact`, which removes each configured
  secret as written and URL-encoded (`encodeURIComponent`, a form query, either case of hex), in a query or
  a path (ECOS puts its key in the path). Network errors are named by their code, never by their message
  (which may quote the URL).

## Cache: cache.ts

```ts
// A fresh value, else load it; callers asking together share one load.
const tickers = await deps.cache.remember("sec:company-tickers", DAY_MS, () => readTickers(call), {
  disk: "json", // keep it on disk too: "json" (plain data), "text" or "bytes"
});
// With when it was stored, and served stale when reloading fails for the source's reason.
const { value, stale, storedAt } = await deps.cache.keep("wikipedia:sp500", WEEK_MS, load, {
  disk: "json",
  staleOnError: true, // unavailable, rate_limited or quota: the old value, stale: true
  memory: false, // a large value on disk only
});
await deps.cache.forget("sec:company-tickers");
```

- A failed load is never kept. A load cancelled under another caller is run again for that caller.
- A kept value is shared by every caller that asks for it: read it, never change it.
- A key holding any configured secret is refused (an Error): build keys from what the request is about
  (`fred:series:CPIAUCSL`), never from a URL that carries a key.
- Disk entries live in `config.cacheDir`, one file per key (named by a hash; the key is inside), written
  whole through a temporary file and a rename, owner-only. An entry that cannot be read is a miss; a
  directory that cannot be written leaves the value in memory. Entries a month past their time are swept.
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
| `XNAS:AAPL`, `XLON:VOD`                         | `{kind: "venue", key, mic, symbol, yahoo: "VOD.L" or null when Yahoo lists no such venue}`                           |
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

`canonicalKey(key)` gives the key answers name (undefined for an unresolved bare Korean code). Answers name
the canonical key in `instrument.key`; Korean answers say venue KOSPI or KOSDAQ and currency KRW. 035720
(Kakao) is a KOSPI listing; KOSDAQ examples are 035900 (JYP Entertainment) and 247540 (EcoPro BM).

## Readers: util/

- `readZip(bytes)` lists entries; `entry.bytes()` / `entry.text()` inflate one, checked against its size and
  CRC-32; `zipEntry(entries, name)` finds one. A damaged archive throws a `ZipError`: answer `unavailable`.
  An entry declaring more than 256 MiB is refused before it is inflated (protection against an archive
  bomb; OpenDART's company list, the largest archive expected, is reported at tens of MB unpacked: measure
  it when it is recorded), and inflating never passes the size an entry declares.
- `parseXml(text)` returns a `#document` element; `child`, `children`, `find(el, "a/b/c")`, `findAll`,
  `textOf`, `valueAt(el, "transactionAmounts/transactionShares/value")` read it. A name without a prefix
  matches an element's local name. Attributes are kept in an object without a prototype.
- `htmlToText(html)` gives the text a reader sees, for filing sections.
- All three read hostile input in time proportional to it and never recurse; their tests hold the
  adversarial cases (bombs, deep nesting, unclosed quotes and tags, stray end tags).

## Declaring capabilities

A provider is a `DataProvider`: `{ name, capabilities }`, each capability an `Implementation<C>` whose methods
answer the data alone; the router adds `source`, `notes` and `after`. Declare a capability only when the
provider can serve it in this setup; declare only the methods it serves (the router asks the next provider
in the chain for a method a provider lacks). A declaration is what gating counts: an agent is offered only
when every data tool it names has a provider, so never declare a capability that will always fail.

```ts
export function filersProvider(deps: ForkDeps): DataProvider {
  if (!deps.config.secUserAgent) return { name: "SEC EDGAR", capabilities: {} };
  return {
    name: "SEC EDGAR",
    capabilities: {
      filings: {
        list: (symbol, query, call) => listFilings(deps, symbol, query, call),
        section: (target, query, call) => readSection(deps, target, query, call),
      },
    },
  };
}
```

Fill every field the tools read: `src/tools/*.ts` read more than the zod output schemas require, and a field
left undefined is a value the model never sees. Set fields to `null` when the source has no value, and say why
in `field_states`. The read check in the tests (below) lists every field a tool read that the answer did not
supply.

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

FSC (Phase 4) is not built yet; the router skips a provider a setup does not have. A call goes to the first
provider that implements the method. These kinds pass it to the next one, and the answer then says which
failed before it: `unsupported`, `unavailable`, `rate_limited`, `quota`, `rejected`, `not_configured`.
`no_data` and `invalid` end the call: they are answers about the request or the market. So:

- A listing a provider does not cover is `unsupported`, never `no_data`. A Korean listing the Yahoo composite
  cannot answer fails as `unsupported` or `unavailable`, so FSC (Phase 4) is asked; test the single-quote
  path (`quotes.quote`) as well as the batch.
- `quotes.many` answers per instrument: an instrument it could not answer goes in `errors` with its `kind`,
  and the router asks the next provider for those with a passing kind.
- Upstream's Yahoo maps a 404 to `no_data`: hand it only the listings it serves (US tickers and its MIC
  venues), and answer the others in the composite.
- A cancelled call goes no further, whatever its kind.

## Fixtures

A fixture is a body under `test/fork/fixtures/<source>/` with a `.meta.json` beside it (`source`, `name`,
`url` with keys removed, `status`, `content_type`, `recorded_at`, `bytes`, `hand_made`, and for a hand-made
one `note`, starting "Hand-made", saying what it is made from). A test checks that every fixture has its
meta and that the meta's `bytes` match. Fixtures come from three places, never from a live request made in
a development session:

- answers the owner records with the recorder, on the owner's own machine (`hand_made: false`);
- real answers saved earlier, kept whole when they are complete answers (an error page, an empty or cut-off
  body is not a fixture), or cut to an excerpt with the full size stated where it matters;
- hand-made answers in the source's documented format, `"hand_made": true` with a `note`: where no real
  answer has been seen (www.sec.gov needs a contact User-Agent, GDELT was unreachable, Yahoo's own answers
  were not recorded), listed for a live check later.

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

No test reaches the network. `bunfig.toml` preloads `test/fork/preload.ts` for `bun test`, which installs
`test/fork/net-guard.ts`: fetch, WebSocket, Bun.connect and node's http, https, http2, net and tls clients
refuse any host but 127.0.0.1 and localhost, and every proxy variable points at a local trap that refuses
what reaches it (Bun.fetch, which cannot be replaced). A refused request is printed (`net-guard: ...`),
thrown, and fails the test that made it even when the code under test caught it. A test that starts a
process from source passes the guard on: `Bun.spawn([process.execPath, "--preload", NET_GUARD, ...])`, then
checks its stderr holds no `net-guard:`. A test that checks a refusal on purpose takes it with
`takeBlocked()`. Stub servers listen on 127.0.0.1, port 0.

`test/fork/data/harness.ts`:

```ts
const fetch = fixtureFetch([
  { match: /data\.sec\.gov\/submissions\/CIK0000320193\.json$/, file: "sec/submissions-aapl.json" },
  { match: "https://www.sec.gov/files/company_tickers.json", file: "sec/company-tickers.json" },
  { match: (url) => url.hostname === "api.gdeltproject.org", body: "{}", status: 200 },
]);
const clock = fixedClock("2026-11-25T22:00:00Z");
const providers = forkProviders(
  { secUserAgent: "Test Agent test@example.com" },
  { fetch, clock, timer: fakeTimer() },
);
const { runTool } = buildTools(providers, { clock, check: true });
const run = await runTool("filings", { symbol: "AAPL", forms: ["10-K"] });
run.text; // what the model reads
run.summary; // the transcript's line
run.payload; // the recorded payload
run.provenance; // { source, after?, notes?, subject?, as_of? }
run.failure; // "data_no_data", "data_unsupported", ... when it failed
run.reads.missing(); // fields the tool read that the provider's answer left undefined
expect(fetch.unmatched).toEqual([]);
```

- A request no route matches is printed and thrown, and listed in `fetch.unmatched`.
- `buildTools` routes the providers, builds `dataTools` and a `ToolRegistry` as the engine does, and runs
  each call as the model's would be run. With `check: true` every provider answer is behind `readCheck`, a
  view that logs each field the tool read and whether it held a value.
- `fakeTimer()` makes pacing and Retry-After waits instant and lists them in `slept`; pass a new `Pacer()`
  in `options.pacer` when a test counts turns.
- `test/fork/data/harness.test.ts` shows quote and price_history through upstream Yahoo on the hand-made
  Yahoo fixtures, with the read check's findings. `YAHOO_AAPL` in the harness holds their routes (Yahoo's
  cookie page and crumb included): a Yahoo test adds its own routes before them.
- Golden render tests run each data tool a provider serves through `runTool` and compare `text`; the read
  check asserts `run.reads.missing()` holds only fields the provider leaves out on purpose.
- `test/fork/gating.test.ts` pins the agents and skills an engine offers as built (`AS_BUILT`, today none).
  Update it to each milestone's real configuration, built from the fork providers with a fixture fetch: 3a
  `['risk']` and 16 skills, 3b `['equity', 'quant', 'risk']`, 3c all four.

Before a change is done, run the checks FORK.md lists under "Taking an upstream release" (step 5), from
`npm run typecheck` through `sh scripts/fork/check-notices.sh main` (with `export
PATH=/opt/node22/bin:/root/.bun/bin:$PATH` in the cloud session; never `npm ci` or `npm install` there).
The compiled executable may be run only against a local stub model that answers without a tool call, so
it asks no source for data.

Biome's formatter rewrites a Unicode escape in a string or a regular expression (a backslash, `u` and four
hex digits) as the character itself, invisible ones included: write such a character with
`String.fromCharCode(0xa0)`, or keep code points in a table as `util/entities.ts` does.
