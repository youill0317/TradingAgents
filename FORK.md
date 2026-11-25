# This fork

This repository is a modified version of [TradingAgents](https://github.com/TauricResearch/TradingAgents)
1.0.0 by Tauric Research, used under the Apache License 2.0 ([LICENSE](LICENSE)). It is not made, endorsed
or supported by Tauric Research.

## What changed

- Tauric's services are removed: the Tauric data provider, the Tauric AI model provider, Tauric keys, login
  and sign-up, session sync and account calls, and the `tauric_view` tool with the syntheses capability.
  Sessions stay on this computer.
- Quotes and daily price history come from Yahoo, and prediction-market odds from Polymarket. The fork's
  free public-data providers, under `src/fork/data/`, arrive in later commits; until one serves a
  capability, asking for it answers that no data source here serves it. The built-in agents and skills are
  offered as the data they need becomes available.
- A `web_search` tool searches the web through Anthropic's, OpenAI's or Google's own search, the chat
  model's provider first, when a key for one of them is set.
- Releases, the update check, the installer and issue links point at this repository.
- The default home is `~/.config/tradingagents`; `TRADINGAGENTS_HOME` still overrides it.

## Change notices

Each upstream file this fork changed carries `Changed in this fork of TradingAgents 1.0.0.` under its
license line, and each file it added carries `Added in this fork of TradingAgents 1.0.0.`;
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
  Tauric items (`src/fork/changelog.ts`);
- seven code comments on upstream's data and session sync: one each in `src/cli/report/report.ts`,
  `src/tools/company.ts`, `src/tools/evidence-store.ts`, `src/tools/tool.ts` and `src/tools/valuation.ts`,
  and two in `src/contracts/citations.ts`.

`scripts/fork/tauric-allowlist.txt` lists each line that may still name Tauric, with the reason.
`scripts/fork/check-no-tauric.sh` fails on any other line of a tracked file that does, on a Tauric name in
the executable beyond the release notes it embeds, and on a model request that mentions Tauric.

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
   - A Tauric file this fork deleted and upstream changed stays deleted: `git rm <file>`.
   - A file the removal of Tauric's services edited (likeliest `src/engine/session.ts`,
     `src/contracts/messages.ts`, `src/cli/main.tsx`, `src/cli/interactive.tsx`, `src/cli/ChatApp.tsx`,
     `src/cli/setup/setup-flows.ts`, `src/engine/factory.ts`): take upstream's change, then remove its
     Tauric parts again.
   - `specs/agents/equity.md` and `src/agents/builtin.generated.ts`: take upstream's, then drop `tauric_view`
     and its sentence again.
   - `src/data/routes.ts`: keep the fork's routes, and route any new capability.
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

   Then push the work branch, and no tags: `git push origin claude/dazzling-fermat-ik4q5y`. The Fork
   workflow runs the same checks on each push to it and each pull request into it.
