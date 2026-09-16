# Official-data review contracts

Patch baseline: `data-sources` at `53a5888164312df93d916237e5893d7cd13aa632`.
This follow-up fixes the five findings from the subsequent source/workflow review.
It does not introduce a provider, dependency, extra agent or live LLM validation.

## Published changes versus calculated comparisons

Eurostat quarterly GDP `CLV_PCH_PRE` observations retain
`provider_reported_change=true` and `change_basis=quarter_on_quarter`. A direct
GDP growth statement naming Eurostat, its QoQ basis and the exact published
percentage may cite that one observation. English and Korean statements are
covered, including reported contractions and zero growth. Older saved records
with the same explicit table/unit/frequency dimensions remain usable.

Rate levels do not receive this exception. A different horizon, annualization,
multiple values, a percentage-point change or acceleration of growth still needs
comparison endpoints or a derived record. This remains a bounded structural
check, not proof that every sentence has the correct economic interpretation.
Reference: https://ec.europa.eu/eurostat/cache/metadata/en/namq_10_esms.htm

## Final issuer coverage and optional exclusions

When an applicable SEC/DART source is selected, the final ticker decision must
retain fresh issuer citations for available `earnings`, `cash_flow` and
`balance_sheet` purposes. A macro citation cannot substitute for these purposes;
uncited/stale-only core purposes yield `ISSUER_PURPOSE_UNVERIFIED` and
`REVIEW_REQUIRED`, using the existing non-tradeable `REVIEW` signal path.
Collection-time quality does not demand a final report before one exists.

Optional purposes may be excluded explicitly in the generated report:

```text
[official-exclude:liquidity] No financing or rate-sensitive conclusion is made in this narrow assessment.
[official-exclude:Energy/inventory_costs] No petroleum inventory claim is made for this regulated-power thesis.
```

The purpose must exist in the role's available evidence and the explanation must
contain at least 12 characters. Core issuer purposes cannot be waived. These
markers can be included in the existing text fields; no structured-output schema
or additional LLM call is introduced. The audit persists `purpose_coverage`,
including cited IDs, the stated exclusion reason, missing purposes and unavailable
selected-sector purposes. Explanations are recorded, not semantically endorsed.
The ticker quality object also exports `unverified_core_purposes`.

## Partial coverage and monetary units

KOSIS checks the three requested item IDs individually and preserves explicit
nonnumeric returned cells as gaps. It does not invent a Cartesian product of all
industries and indicators or label unknown applicability as zero. Customs checks
all five requested measures per product/partner and preserves missing fields in
returned months even when older values exist. Known future/out-of-window rows
and mismatched product/partner responses remain excluded. Reported zeros survive.
Existing gaps are not counted twice at the request-dimension level; warnings
identify their target so distinct gaps are not collapsed into one generic string.

Same-currency issuer calculations now accept an explicit ISO monetary-unit list
rather than five currencies only. This includes CAD/CNY/AUD/CHF/INR/HKD/SGD/TWD
and historical monetary codes; it is not a claim about current legal tender or
an FX conversion. Accounting scope, period, standard and accession checks are
unchanged. Unsupported monetary units produce `UNSUPPORTED_MONETARY_UNIT`
evidence with operand references. Raw share counts and EPS are retained without
being incorrectly labeled failed currency calculations.
References: https://www.sec.gov/search-filings/edgar-application-programming-interfaces
and the SIX ISO 4217 currency lists.

## Table and sector prioritization

Derived indicators preserve their original `source_tables` and `base_target`.
Census/BEA digests rotate by those original tables; a `derived/` prefix no longer
collapses unrelated tables into one budget group. Paired nominal/real consumption
diagnostics retain both tables. Legacy saved targets have a deterministic
fallback. The renderer is isolated in `public_digest.py` and re-exported from
`public_data.py`; existing callers keep the same API. Gap counts remain visible
when the text budget omits detailed failure records; raw evidence is unchanged.

Requested sectors, or sectors found in captured raw equity-screen results,
control industry routing. Model-authored sector prose is not used as a selector.
Before screening, available tagged sectors form an exploration menu. A compact
per-sector demand/production/inventory-cost bundle precedes bulk summaries.
Missing purposes are explicit. Sector citation coverage uses the same selection
and tags: citing another sector cannot satisfy a selected sector's purpose.
No issuer revenue geography, product share or energy exposure is inferred.

## Validation and limits

In this execution, baseline files were verified against their GitHub Git-blob
SHA values in a source-subset workspace. No production module stubs were used in
the executed core tests. Provider HTTP responses were fixtures; live requests
were blocked in the new regression suite.

```bash
python -m pytest -q tests/test_public_review_contracts.py tests/test_public_korea.py
# 33 passed
python -m compileall -q tradingagents tests
# passed for the source files present in the verification workspace
git diff --check
# passed
```

The full repository dependency environment was unavailable, so the full existing
suite, Ruff, graph/ToolNode end-to-end execution and remote CI were not rerun.
The existing CI does not run on a direct `data-sources` push without a pull request.
Actual LLM validation was deliberately excluded as requested. This patch does not
claim authenticated live-provider verification, semantic proof of LLM claims,
full issuer-exposure mapping or broader EIA gas/electricity coverage.
