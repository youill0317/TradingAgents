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

## Web search

Unless `TRADINGAGENTS_WEB_SEARCH` is `off`, every agent has a `web_search` tool when an Anthropic or OpenAI API key is set, in the environment or stored; a ChatGPT plan's sign-in is not one. It searches with the chat model's provider when that is Anthropic or OpenAI, else with the first of them that has a key, Anthropic first, using that provider's fast model. Google Search grounding runs only when `TRADINGAGENTS_WEB_SEARCH` names `google` (or `google/<model>`): Google's terms ask that its search suggestions be shown, which a terminal app cannot do. A note at the start says when the setting cannot be read, when the provider it names has no key, when only a Google key is set, and which key pays when the search runs on another provider than the chat model's.

A call is one request to that provider's own web search, which runs as many searches as its model decides: TradingAgents sets no limit. The provider bills each search to that key, a search fee plus the search model's tokens, and each result notes how many searches ran and the tokens the search model used.
