# This fork

This repository is a modified version of [TradingAgents](https://github.com/TauricResearch/TradingAgents)
1.0.0 by Tauric Research, used under the Apache License 2.0 ([LICENSE](LICENSE)). It is not made, endorsed
or supported by Tauric Research.

## What changed

- Tauric's services are removed: the Tauric data provider, the Tauric AI model provider, Tauric keys and
  sign-up, session sync and account calls, and the `tauric_view` tool.
- Data comes from free and official sources (Yahoo through yahoo-finance2, SEC EDGAR, FRED/ALFRED, ECB, and
  for Korea OpenDART, ECOS, KOSIS and data.go.kr), under `src/fork/data/`.
- A `web_search` tool searches the web through the chat provider's own search (Anthropic, OpenAI, Google).
- Releases, updates and issue links point at this repository; the default home is `~/.config/tradingagents`.

Each upstream file this fork changed carries `Changed in this fork of TradingAgents 1.0.0.` under its license
line, and each file it added carries `Added in this fork`. Changed files that cannot hold a comment:

- `README.md`, `SECURITY.md`, `docs/configuration.md`, `docs/install.md`, `docs/models.md`, `docs/usage.md`
- `specs/agents/equity.md` (the `tauric_view` tool and its sentence removed)

## Kept on purpose

Copyright and SPDX lines are kept as upstream wrote them. Names no code here reads are left as they are, so
upstream releases merge cleanly: the `openapi-fetch` dependency, `biome.json`'s ignores for the removed
Tauric files, the `tauric/tauric` entry in `src/models/provider-facts.json`, the `@tauric` npm names in
`src/config/release.ts` and `scripts/npm*`, upstream's release notes in `CHANGELOG.md` and
`src/cli/changelog.generated.ts` (shown without their Tauric items, `src/fork/changelog.ts`), and comments.

## Taking an upstream release

See "Branch and merge" in the fork's plan: update `main` from upstream, merge `main` into the work branch,
then run `npm run typecheck`, `npm run lint`, `npm run compile`, `sh scripts/smoke.sh`, `bun test test/`,
`sh scripts/fork/check-no-tauric.sh` and `sh scripts/fork/check-notices.sh`.
