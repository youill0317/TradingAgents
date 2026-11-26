# Configuration

Settings and data live in `~/.config/tradingagents/`, the configuration directory:

| Where                | What                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| `config.json`        | the model, reasoning, provider settings and limits                            |
| `credentials.json`   | stored keys, readable only by you                                             |
| `chatgpt-auth.json`  | a ChatGPT sign-in, readable only by you                                       |
| `history.jsonl`      | the last questions asked in the terminal                                      |
| `agents/`, `skills/` | your own agents and skills (see [usage](usage.md#your-own-agents-and-skills)) |
| `sessions/`          | sessions                                                                      |
| `memory/`            | notes and recorded decisions                                                  |

The update check's state is kept there too. `TRADINGAGENTS_HOME`, an absolute path, moves the whole directory. Skills shared between agent clients, in `~/.agents/skills/`, are read from there wherever the directory is. Sessions stay on this computer.

A complete `config.json`:

```json
{
  "model": "anthropic/claude-sonnet-5-5",
  "reasoning": "high",
  "providers": {
    "openai-compatible": {
      "baseURL": "https://your-server/v1",
      "contextWindow": 131072
    }
  },
  "limits": { "question": { "time": "20m" } }
}
```

| Environment variable                                                                              | Sets                                                                                      |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `TRADINGAGENTS_MODEL`                                                                             | the model, as `provider/id` (or the server's model, with `TRADINGAGENTS_BASE_URL`)        |
| `TRADINGAGENTS_BASE_URL`                                                                          | an OpenAI-compatible server's address                                                     |
| `TRADINGAGENTS_MODEL_API_KEY`                                                                     | that server's key                                                                         |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY` | a provider's key (see [models](models.md))                                                |
| `TRADINGAGENTS_HOME`                                                                              | one directory for configuration and data                                                  |
| `TRADINGAGENTS_NO_UPDATE_CHECK`                                                                   | any non-empty value turns off the check for a newer release                               |
| `TRADINGAGENTS_WEB_SEARCH`                                                                        | `off`, or `web_search`'s provider (and model): `anthropic`, `google`, `openai/gpt-6-luna` |

Settings come from the command line first, then the environment, then `config.json`. TradingAgents reads no `.env` file: set the variables in your shell, or export them in your shell's profile.

## Public data

Market data comes from free public sources ([which serves what](fork/data-sources.md); see also [FORK.md](../FORK.md)). Some of them ask for a setting, read from the environment, else from a `"data"` object in `credentials.json` under the same name:

```json
{ "data": { "SEC_USER_AGENT": "Your Name you@example.com", "FRED_API_KEY": "..." } }
```

| Setting                                                                                                         | For                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEC_USER_AGENT`                                                                                                | SEC EDGAR (filings, financial statements, insider trades, sector screens): nothing is read from it without this. Your name and email, in plain ASCII. SEC's fair-access rule asks every program that reads EDGAR to name its sender this way. It is not a secret, but it names you, so it is never shown. |
| `FRED_API_KEY`                                                                                                  | FRED, the St. Louis Fed's economic data: every FRED series, FRED's search and each value's vintages. Without it, the headline series (CPI, unemployment, payrolls, GDP and others) come from FRED's keyless download                                                                                      |
| `DART_API_KEY`, `ECOS_API_KEY`, `KOSIS_API_KEY`, `DATA_GO_KR_API_KEY`, `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` | Korea's OpenDART, the Bank of Korea's ECOS, Statistics Korea's KOSIS, the FSC's data on data.go.kr, Naver's news search                                                                                                                                                                                   |
| `BEA_API_KEY`, `EIA_API_KEY`                                                                                    | the U.S. Bureau of Economic Analysis and Energy Information Administration                                                                                                                                                                                                                                |

A note at the start says when `SEC_USER_AGENT` is not set (then nothing is read from SEC EDGAR) or holds no email address, and when a setting cannot be used: one on more than one line, an entry under `"data"` that is not text or is empty, a `SEC_USER_AGENT` with characters other than plain ASCII letters, digits and punctuation (a User-Agent cannot carry them), a `"data"` that is not an object, or a name in it TradingAgents does not read. A setting in the environment that cannot be used gives way to the one under `"data"`, and the note says so. A note names a setting, never its value. Answers worth keeping are cached in `~/.cache/tradingagents/fork-data` (under `XDG_CACHE_HOME` when it is set), or in `cache/fork-data` in the directory `TRADINGAGENTS_HOME` names.

## Web search

With `TRADINGAGENTS_WEB_SEARCH` unset, every agent has a `web_search` tool when an Anthropic or OpenAI API key is set, in the environment or stored; a ChatGPT plan's sign-in is not one. It searches with the chat model's provider when that is Anthropic or OpenAI, else with the first of them that has a key, Anthropic first, using that provider's fast model. When the variable names a provider, only that provider's key is used, and there is no `web_search` without it; `off`, or a value that cannot be read, turns it off. Google Search grounding runs only when `TRADINGAGENTS_WEB_SEARCH` names `google` (or `google/<model>`): Google's terms ask that its search suggestions be shown, which a terminal app cannot do. A note at the start says when the setting cannot be read, when the provider it names has no key, when only a Google key is set, and which key pays when the search runs on another provider than the chat model's.

A call is one request to that provider's own web search, which runs as many searches as its model decides: TradingAgents sets no limit. The provider bills each search to that key, a search fee plus the search model's tokens, and each result notes how many searches ran and the tokens the search model used.
