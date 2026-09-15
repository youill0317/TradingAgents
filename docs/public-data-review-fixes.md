# Official-data review fixes

Baseline: `data-sources`, commit `0845af41aeeb5cca28cdf22c69a80c9d5e4e66bc`.

## Changes

- ECOS policy-rate and CPI histories fail independently. A failed CPI request
  no longer discards a successful policy-rate history. Percentage levels,
  including ECOS `연%`, use percentage-point differences rather than relative
  percentage changes.
- EIA's four requested petroleum series and NYFed's rate/volume pairs now
  produce individual missing-series evidence. An HTTP 200 or one successful
  series is not a complete-provider success. Reported zero remains zero.
- SEC class-share aliases `.A` and `.B` are mapped only for the SEC lookup.
  The user ticker is retained, and foreign exchange suffixes are not rewritten.
- Financial update cadence is separate from instant/quarter/YTD accounting
  basis. Latest stale series generate collection warnings; older observations
  in an otherwise current history do not generate stale-coverage warnings.
- SEC and standard OpenDART accounts share margin, FCF and liabilities/assets
  calculations. Original accounts, scope, currency, periods and accessions remain
  available. Conflicting aliases, different scopes, non-total DART members and
  incompatible versions are not silently combined. Missing numbers stay missing.
- Fiscal YTD differences can yield quarters, and four contiguous fiscal quarters
  can yield TTM. Cross-filing estimates explicitly state that restatement
  alignment is unverified. They must not be described as reported values or as
  guaranteed revision-consistent figures. A negative capex value with an unknown
  sign convention is not converted with `abs()`.
- Exact-date SOFR/EFFR and Treasury-curve spreads are computed with operands.
  Three-/twelve-month net securities transaction sums require consecutive months
  and exclude holdings and valuation changes. These are descriptive calculations,
  not causal signals or a deterministic buy/sell model.
- Ticker routing distinguishes issuer evidence, industry context and broad sector
  context. Detailed industry mismatches are not automatically injected; broad
  same-sector context is labelled and limited to two series per source, retaining
  those series' histories. FSC business descriptions can supply missing routing
  classification. No geographic revenue share is inferred from a sector match.
- Observations have stable `ev-...` IDs. Revised values or versions change the ID;
  re-downloading the same observation does not. Tool responses show history IDs
  and accept exact-ID queries. Reviewer prompts rehydrate observations explicitly
  cited upstream, including transitive numerical operands, outside the ordinary
  source digest. Unknown references and audit-budget omissions stay visible.
  Older saved snapshots without preassigned IDs use the original observation
  when generating a reference, before display summaries add changes or notes;
  their digest, exact-ID lookup and reviewer audit therefore resolve consistently.
- Repeated baseline/official FRED IDs are labelled as repeated views of the same
  series, not independent confirmations. No automatic cross-provider value
  arbitration or markdown-number parsing is performed.

## Snapshot reuse

`config["public_data_cache_ttl_seconds"]` defaults to **300**; `0` disables reuse,
with a supported range of 0–3600 seconds. This is a bounded **in-process** cache
for macro/industry providers, not a durable archive. Company sources are not
cached here. Different dates, credentials, collectors or TTL settings do not
share a cache entry. Concurrent requests for the same key share an in-flight
fetch. Results are deep-copied, and their original retrieval times and snapshot
IDs are retained. Errors and partial failures are not cached.

Historical collection restrictions run before cache lookup. This change does
not make revised feeds into historical point-in-time archives. Starting a new
process or disabling the cache forces another provider collection.

## Workflow boundary

Both workflow families continue to use their existing `collect_public_data`
and `public_data_for_agent` integration. No analyst, tool loop, portfolio state,
paid provider or extra external dependency is added. Market analysis receives the
new missing/stale collection warnings through its existing degraded-status path.
Ticker reviewers see the same role-specific coverage and citation audit text.

A valid evidence ID only establishes that an observation exists in the collected
snapshot. It does **not** prove the surrounding model claim or reasoning is true.
Analysts are asked to cite material claims, but this patch does not claim to
mechanically enforce complete semantic citation coverage in LLM outputs.

## Scope not implemented here

This patch does not add FDIC or other new agencies, expand EIA into natural gas
or electricity, construct a full company/geographic exposure ontology, calculate
an exhaustive net-debt model or all demand/inventory indicators, automatically
reconcile differing provider vintages, or provide an authenticated end-to-end
LLM validation. Those remain separate extensions rather than implied coverage.

## Validation

Run in the full repository with its declared development dependencies:

```bash
python -m pytest tests/test_public_review_fixes.py tests/test_public_us.py -q
python -m pytest tests/test_public_data*.py tests/test_public_us.py tests/test_public_korea.py tests/test_public_filings.py -q
python -m ruff check tradingagents tests/test_public_review_fixes.py tests/test_public_us.py
python -m pytest -q -m 'not integration'
```

The original patch was prepared against SHA-verified baseline files in an
isolated harness with some dependency stubs. After recovering it into the full
repository, the declared development dependencies were installed and the actual
LangGraph ToolNodes exercised with mocked provider/LLM responses.

Repository validation after application and the legacy-snapshot reference fix:

- `859 passed`, plus `77 subtests passed`, for the non-live repository suite.
- One optional Bedrock test skipped because `langchain_aws` was not installed;
  one live integration test deliberately deselected.
- Ruff and `git diff --check` passed.
- The runtime's SOCKS proxy required installing `socksio` locally; no project
  dependency or proxy configuration was changed for this environment issue.

These results verify implementation and workflow wiring with controlled inputs.
Authenticated live agency API contracts and a paid LLM end-to-end run remain
unverified; this is a local repository run, not a claim about remote CI.
