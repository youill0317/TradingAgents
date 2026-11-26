# TradingAgents: Towards Agentic Finance Research

This repository is a fork of [TradingAgents](https://github.com/TauricResearch/TradingAgents) 1.0.0 by
Tauric Research, used under the Apache License 2.0. It is not made, endorsed or supported by Tauric Research.
[FORK.md](FORK.md) says what this fork changed.

TradingAgents is a finance research agent for the terminal. Ask it a question: it plans the research, reads
data with its tools, works the numbers, and answers with every figure marked with its source. It researches
and answers; it does not place trades.

This fork needs no data account. It reads free sources, runs on the model provider you choose with your own
key or plan, and keeps your sessions on this computer.

## What works today

- **Models**: OpenAI, Anthropic, Google, DeepSeek and OpenRouter with your API key, a ChatGPT plan, or a
  model you serve yourself behind an OpenAI-compatible API (vLLM, Ollama, LM Studio).
- **Market data** from free public sources ([which serves what](docs/fork/data-sources.md)): quotes, daily
  and intraday prices, technicals, company profiles and analyst estimates, corporate actions, institutional
  holders and news by symbol from Yahoo; economic series from the U.S. Treasury, the New York Fed, the ECB
  and FRED; currency pairs' reference rates from the ECB; news by words or topic from GDELT; event odds from
  Polymarket's prediction markets; market overviews (indices, sectors and sector rotation, gainers and
  losers, volatility, the yield curve and breakevens, rates and central banks, credit spreads, commodities,
  currencies, crypto, macro indicators) from Yahoo, the Treasury, the New York Fed, the ECB and FRED; and
  instrument search, which turns a name or code into the keys the tools take. With `SEC_USER_AGENT` set
  (your name and email, [configuration](docs/configuration.md#public-data)), SEC EDGAR adds financial
  statements, filings and their sections, insider transactions, and sector screens over the S&P 1500.
- **Web search**: `web_search`, through Anthropic's or OpenAI's own web search, or Google's when named
  ([below](#web-search)).
- **Compute**: arithmetic, statistics, returns and risk, correlation and beta, technical indicators,
  portfolio risk and weights, and DCF valuation, over the data read.
- **Memory**: notes and recorded decisions, kept across sessions.
- **Sessions and output**: plan mode, sessions to resume, an answer saved as a PDF report or Markdown, and
  `tradingagents -p` for one question from a script.

Macro Strategy is offered in every setup, and the sixteen built-in skills, written for the built-in agents,
come with it. With `SEC_USER_AGENT` set, Equity Research, Quant Research and Risk Analysis are offered too.
`/agents` and `/skills` show which are offered. An agent of your own is offered when the data tools it names
have a source ([docs/usage.md](docs/usage.md#your-own-agents-and-skills)).

## What is coming

Korean sources: OpenDART, ECOS, KOSIS and data.go.kr.

## Build and install

This fork publishes no releases: build it from source, with Git and Node.js 22 or later. Its code is on the
`claude/dazzling-fermat-ik4q5y` branch; `main` mirrors upstream.

```bash
git clone --branch claude/dazzling-fermat-ik4q5y https://github.com/youill0317/TradingAgents.git
cd TradingAgents
npm ci
npm run compile
mkdir -p ~/.local/bin
cp dist-bin/tradingagents ~/.local/bin/tradingagents
```

`npm run compile` builds one executable for this machine, `dist-bin/tradingagents`; the copy can go in any
directory on your `PATH`. Then run:

```bash
tradingagents
```

[docs/install.md](docs/install.md) has the details, and how to update.

## Models

The first session in a terminal with no model set walks you through the choice: the provider, its key or
sign-in, the model, and how hard it reasons. Or set one up yourself:

| Provider                                     | Needs                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| OpenAI                                       | `OPENAI_API_KEY`, or `tradingagents key openai`                               |
| Anthropic                                    | `ANTHROPIC_API_KEY`, or `tradingagents key anthropic`                         |
| Google                                       | `GEMINI_API_KEY`, or `tradingagents key google`                               |
| DeepSeek                                     | `DEEPSEEK_API_KEY`, or `tradingagents key deepseek`                           |
| OpenRouter                                   | `OPENROUTER_API_KEY`, or `tradingagents key openrouter`                       |
| ChatGPT plan                                 | `tradingagents login chatgpt`                                                 |
| Self-hosted models (vLLM, Ollama, LM Studio) | `TRADINGAGENTS_BASE_URL` and `TRADINGAGENTS_MODEL`, and a key if it needs one |

In a session, `/model` chooses the model and how hard it reasons. For one run, name it:
`tradingagents --model anthropic/claude-sonnet-5-5`. See [docs/models.md](docs/models.md).

## Keys

TradingAgents reads no `.env` file. Export a key in your shell's profile (such as `~/.bashrc` or `~/.zshrc`):

```bash
export ANTHROPIC_API_KEY=...
```

Or store it: `tradingagents key <provider>` (`openai`, `anthropic`, `google`, `deepseek`, `openrouter`, or
`model` for an OpenAI-compatible server) asks for it without showing it, or reads it from a pipe, and keeps it
in `credentials.json`, readable only by you. A key in the environment is used over a stored one, and a key is
sent only to its own provider.

## Web search

Every agent has a `web_search` tool when an Anthropic or OpenAI API key is set (a ChatGPT plan's sign-in is
not one). It searches with the chat model's provider when that is Anthropic or OpenAI, else with the first of
them that has a key, Anthropic first, using that provider's fast model.

A call is one request to the provider's own web search, whose model runs as many searches as it decides:
TradingAgents sets no limit. The provider bills each search to that key, a search fee plus the search
model's tokens, and each result notes how many searches ran and the tokens the search model used.
The answer cites each page it uses with a link.

`TRADINGAGENTS_WEB_SEARCH` changes this: `off`, a provider (`anthropic`, `openai`, `google`), or a provider and
its model (`openai/gpt-6-luna`). Google Search grounding runs only when it is named, with a Google key set:
Google's terms ask that its search suggestions be shown, which a terminal app cannot do. A note at the start
says when the setting cannot be read, when the provider it names has no key, when only a Google key is set,
and which key pays when the search runs on another provider than the chat model's. See
[docs/configuration.md](docs/configuration.md#web-search).

## Where files live

Settings and data live in `~/.config/tradingagents/`; `TRADINGAGENTS_HOME`, an absolute path, moves them.

| Where                | What                                               |
| -------------------- | -------------------------------------------------- |
| `config.json`        | the model, reasoning, provider settings and limits |
| `credentials.json`   | stored keys, readable only by you                  |
| `chatgpt-auth.json`  | a ChatGPT sign-in, readable only by you            |
| `history.jsonl`      | the last questions asked in the terminal           |
| `agents/`, `skills/` | your own agents and skills                         |
| `sessions/`          | sessions, which stay on this computer              |
| `memory/`            | notes and recorded decisions                       |

See [docs/configuration.md](docs/configuration.md).

## Usage

Type a question and press Enter. Every figure in the answer is marked with its source, and a numbered list of
sources follows.

| Command   | Does                                                             |
| --------- | ---------------------------------------------------------------- |
| `/`       | Open the commands                                                |
| `/model`  | Choose the model and how hard it reasons                         |
| `/resume` | Resume an earlier session                                        |
| `/export` | Save the last answer as a PDF report, or the session as Markdown |
| `/copy`   | Copy the last answer                                             |
| `/help`   | List every command and key                                       |

Shift+Tab switches to plan mode, where the agent proposes a research plan first. `tradingagents -p "question"`
answers one question and prints the answer, and `--json` prints every event as a JSON line.

## Documentation

- [Install](docs/install.md): building from source, and updates.
- [Usage](docs/usage.md): the terminal, one-off questions, sessions, agents and skills, sources and limits.
- [Models](docs/models.md): providers, keys, reasoning and OpenAI-compatible servers.
- [Configuration](docs/configuration.md): files, environment variables and web search.
- [FORK.md](FORK.md): what this fork changed, and how it takes upstream's releases.
- [CHANGELOG.md](CHANGELOG.md): upstream's release notes, as upstream wrote them. Some of their items are
  upstream's own services, which this fork does not have; `/changelog` shows the notes without them.

To report an issue or open a pull request, see [CONTRIBUTING.md](CONTRIBUTING.md); to report a security problem, [SECURITY.md](SECURITY.md).

## Citation

```bibtex
@article{xiao2024tradingagents,
  title={TradingAgents: Multi-agents LLM financial trading framework},
  author={Xiao, Yijia and Sun, Edward and Luo, Di and Wang, Wei},
  journal={arXiv preprint arXiv:2412.20138},
  year={2024}
}
```

## License

Apache-2.0. See [LICENSE](LICENSE).
