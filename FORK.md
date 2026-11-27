# This fork

This repository is a modified version of [TradingAgents](https://github.com/TauricResearch/TradingAgents)
1.0.0 by Tauric Research, used under the Apache License 2.0 ([LICENSE](LICENSE)). It is not made, endorsed
or supported by Tauric Research.

## What changed

- Tauric's services are removed: the Tauric data provider, the Tauric AI model provider, Tauric keys, login
  and sign-up, session sync and account calls, and the `tauric_view` tool with the syntheses capability.
  Sessions stay on this computer.
- Market data comes from free public sources: Yahoo (quotes, daily and intraday prices, technicals, company
  profiles and analyst estimates, corporate actions, institutional holders, news by symbol), SEC EDGAR
  (financial statements, filings and their sections, insider transactions, and sector screens over the
  S&P 1500 lists on Wikipedia), the U.S. Treasury, the New York Fed, the ECB and FRED (economic series, and
  the ECB's reference rates for currency pairs), GDELT (news by words or topic) and Polymarket
  (prediction-market odds); the 22 market views come from Yahoo, the Treasury, the New York Fed, the ECB and
  FRED, and instrument search reads the fork's catalogs, Yahoo's search and SEC's ticker list. SEC EDGAR is
  read only with `SEC_USER_AGENT` set. Korean sources, each with its own key: OpenDART (a Korean company's
  statements, filings and their sections, insider reports, and its company list for instrument search), the
  FSC's official KRX end-of-day prices on data.go.kr, and the Bank of Korea's ECOS and Statistics Korea's
  KOSIS (economic series, and the Bank of Korea's base rate among the central banks). A built-in agent is
  offered when every data tool it names is served: macro in every setup, risk with `SEC_USER_AGENT` or
  `DART_API_KEY`, equity and quant with `SEC_USER_AGENT`; the built-in skills
  come with them. The settings, SEC's User-Agent and the agencies' keys, are read from the environment or
  from a `"data"` object in `credentials.json` ([configuration](docs/configuration.md#public-data)); which
  source serves what is in [docs/fork/data-sources.md](docs/fork/data-sources.md), and how the providers are
  built in [docs/fork/data-architecture.md](docs/fork/data-architecture.md).
- A `web_search` tool searches the web through Anthropic's or OpenAI's own search when a key for one of
  them is set (the chat model's provider first when it is one of them), or through Google Search grounding
  when `TRADINGAGENTS_WEB_SEARCH` names Google.
- Releases, the update check, the installer and issue links point at this repository. It publishes no
  release yet: the update check finds none, `tradingagents update` says the release lookup failed and
  changes nothing, and where upstream gives its install command, the app says how to build from source.
- The default home is `~/.config/tradingagents`; `TRADINGAGENTS_HOME` still overrides it.

## Change notices

Each upstream file this fork changed, or moved, keeps upstream's copyright and SPDX lines as they were and
carries `Changed in this fork of TradingAgents 1.0.0.` on the line under them. Each code, script or
workflow file it added starts, after a `#!` line if it has one, with `Copyright 2026 TradingAgents fork
contributors`, the SPDX line and `Added in this fork of TradingAgents 1.0.0.`.
`scripts/fork/check-notices.sh` checks both. Changed files that cannot hold a comment are listed here:

- `README.md`, `SECURITY.md`, `docs/configuration.md`, `docs/install.md`, `docs/models.md`, `docs/usage.md`
- `specs/agents/equity.md` (the `tauric_view` tool and its sentence removed)

Upstream files this fork deleted:

- the Tauric data provider, its client and its API specs: `src/data/tauric/*`
- session sync, and restoring sessions from the Tauric account: `src/engine/sync.ts`,
  `src/engine/restore.ts`, `src/cli/setup/sync-question.ts`
- the `tauric_view` tool: `src/tools/tauric-view.ts`
- npm publishing and the project site: `.github/workflows/npm.yml`, `.github/workflows/pages.yml`,
  `.github/site/*`
- the README's images of upstream's build: `assets/tauric-logo.svg`, `assets/tauric-logo-dark.svg`,
  `assets/demo.gif`, `assets/taxonomy.svg`

## Kept on purpose

Copyright and SPDX lines are kept as upstream wrote them. So that upstream's releases merge cleanly, inert
names and text are left as they are:

- the `openapi-fetch` dependency, which only the removed Tauric client imported;
- `biome.json`'s ignores for the removed Tauric files;
- the `tauric/tauric` entry in `src/models/provider-facts.json`, which no provider here looks up;
- the `@tauric` npm names in `src/config/release.ts`, `scripts/npm-packages.ts` and `scripts/npm/launcher.js`
  (this fork publishes no npm package);
- upstream's release notes in `CHANGELOG.md` and `src/cli/changelog.generated.ts`, shown without their
  Tauric items (`src/fork/changelog.ts`); the README says `CHANGELOG.md` is upstream's, as upstream wrote
  it;
- eight code comments on upstream's data and session sync: one each in `src/cli/report/report.ts`,
  `src/cli/transcript-state.ts`, `src/tools/company.ts`, `src/tools/evidence-store.ts`, `src/tools/tool.ts`
  and `src/tools/valuation.ts`, and two in `src/contracts/citations.ts`;
- other comments and inert text of upstream's that the removal left behind, such as a count of providers
  or a mention of syncing, so that its edits to them merge.

`scripts/fork/tauric-allowlist.txt` lists each line that may still name Tauric, with the reason.
`scripts/fork/check-no-tauric.sh` fails on any other line of a tracked file that does, on a Tauric name in
the executable beyond the release notes it embeds, and on a model request that mentions Tauric (with
`web_search` offered, so its description and instructions are checked too).

## Taking an upstream release

`main` mirrors upstream and never takes a commit of its own. The work branch,
`claude/dazzling-fermat-ik4q5y`, takes each upstream release by merging `main`.

Once per clone:

```sh
git remote add upstream https://github.com/TauricResearch/TradingAgents.git   # when it is not there yet
git config rerere.enabled true               # reuse the conflict resolutions of earlier merges
git config remote.upstream.tagOpt --no-tags  # fetch no upstream tags
git remote set-url --push upstream no-push   # never push to upstream
```

Never push tags: an upstream `v*` tag here would make `release.yml` draft a release of upstream's code on
this fork.

1. Update `main`, only by fast-forward:

   ```sh
   git fetch upstream
   git checkout main
   git merge --ff-only upstream/main
   git push origin main
   ```

   GitHub's Sync fork on `main` does the same; then fast-forward the local `main` to `origin/main`. If a
   fast-forward is refused, `main` has a commit upstream does not have: never commit to `main`.

2. Note the upstream commit the work branch last took, then merge `main` into it. Never rebase the work
   branch: it is published.

   ```sh
   git checkout claude/dazzling-fermat-ik4q5y
   old=$(git merge-base main HEAD)
   git merge --no-ff main
   ```

3. Resolve the conflicts:
   - A file this fork deleted (listed under Change notices) and upstream changed stays deleted:
     `git rm <file>`.
   - A file the removal of Tauric's services edited (likeliest `src/engine/session.ts`,
     `src/contracts/messages.ts`, `src/cli/main.tsx`, `src/cli/interactive.tsx`, `src/cli/ChatApp.tsx`,
     `src/cli/setup/setup-flows.ts`, `src/engine/factory.ts`): take upstream's change, then remove its
     Tauric parts again, and keep the fork's own additions there: `src/engine/factory.ts`'s
     `dataProviders` over `forkProviders`, `EngineSettings.publicData` and the web search wiring
     (`webSearchTools`); `src/cli/main.tsx`'s `publicDataConfig`, its start-up notes and `webSearchFor`.
   - `specs/agents/equity.md` and `src/agents/builtin.generated.ts`: take upstream's, then drop `tauric_view`
     and its sentence again.
   - `src/data/routes.ts`: keep the fork's routes, and route any new capability.
   - `src/tools/filings.ts`: take upstream's change, and keep filing_section's accession pattern taking an
     OpenDART receipt number (14 digits) beside an SEC accession, with its message naming both.
   - `README.md`: keep the fork's.
   - `CHANGELOG.md`, `src/cli/changelog.generated.ts`, `package.json`, `package-lock.json`, `biome.json`,
     `src/models/provider-facts.json`: take upstream's; the fork never edits them.
   - A change-notice line in conflict with an upstream edit beside it: keep both.

4. A merge without conflicts can still break:
   - Upstream code that still uses what the fork removed (`tauricSessions`, `SIGN_UP_URL`, `RECOMMENDED`,
     the `"tauric"` `HostedProvider`, `Syntheses`) fails the typecheck: remove those uses again.
   - The data contracts may have moved. Review what upstream changed in them, and update the fork's
     providers for new or changed fields, methods and capabilities:
     `git diff "$old" main -- src/data/capabilities.ts src/tools specs`.
   - When upstream edits a line `scripts/fork/tauric-allowlist.txt` keeps, `check-no-tauric.sh` prints the
     new line and names the entry that no longer matches: if the line is still kept on purpose, update the
     entry.

5. Run the checks, in this order:

   ```sh
   rm -rf dist dist-bin
   npm ci
   npm run typecheck
   npx tsc -p test/tsconfig.json
   npm run lint
   npx bun test test/
   npm run compile
   sh scripts/smoke.sh dist-bin/tradingagents <scratch dir>
   sh scripts/fork/check-no-tauric.sh dist-bin/tradingagents <scratch dir>
   sh scripts/fork/check-notices.sh main
   ```

   The tests make no real call: `bunfig.toml` runs them behind a network guard (`test/fork/preload.ts`)
   that fails any test reaching a host other than 127.0.0.1 or localhost. Run them from the repository
   root, where `bunfig.toml` is read. `check-notices.sh` also refuses a tracked symbolic link (a
   worktree's `node_modules` link, which `.gitignore`'s `node_modules/` does not match): untrack one with
   `git rm --cached <path>`.

   Then push the work branch, and no tags: `git push origin claude/dazzling-fermat-ik4q5y`. The Fork
   workflow runs the same checks on each push to it and each pull request into it.
