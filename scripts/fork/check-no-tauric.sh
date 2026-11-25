#!/bin/sh
# Copyright 2026 TradingAgents fork contributors
# SPDX-License-Identifier: Apache-2.0
# Added in this fork of TradingAgents 1.0.0.
# Checks that no Tauric service is left in this fork: sh scripts/fork/check-no-tauric.sh <executable> <scratch dir>
#
# - the sources, prompts, specs and docs name no Tauric endpoint, key, tool, account or model;
# - the executable carries no Tauric endpoint, key variable or tool;
# - nothing the executable sends a model mentions Tauric (one -p question to a recording stub).
# Kept on purpose, and so not checked: the copyright lines, upstream's generated release notes (filtered when
# shown, src/fork/changelog.ts), and inert names no code reads (see FORK.md).
set -eu
bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
scratch=$2
mkdir -p "$scratch"
status=0

forbidden='api\.tauric\.ai|tauric\.ai/|TAURIC_API_KEY|TRADINGAGENTS_SYNC|tauric_view|key tauric|"tauric"|"\.tauric"|~/\.tauric|Tauric (API key|account|AI)'
if git grep -n -I -E "$forbidden" -- src specs docs README.md scripts \
	':!src/cli/changelog.generated.ts' ':!scripts/fork/check-no-tauric.sh'; then
	echo "check-no-tauric: the lines above name a Tauric service" >&2
	status=1
fi

for pattern in api.tauric.ai TAURIC_API_KEY tauric_view "key tauric" TRADINGAGENTS_SYNC .tauric/ '".tauric"'; do
	if grep -a -q -F "$pattern" "$bin"; then
		echo "check-no-tauric: the executable carries $pattern" >&2
		status=1
	fi
done

rm -f "$scratch/port" "$scratch/requests"
node -e '
const fs = require("node:fs");
const [port, log] = process.argv.slice(1);
const reply = (res, chunk) => res.write(`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "stub", ...chunk })}\n\n`);
const server = require("node:http").createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.method === "GET") return res.end(JSON.stringify({ object: "list", data: [{ id: "stub", object: "model" }] }));
    fs.appendFileSync(log, `${body}\n`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    reply(res, { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] });
    reply(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.end("data: [DONE]\n\n");
  });
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(port, String(server.address().port)));
' "$scratch/port" "$scratch/requests" &
stub=$!
trap 'kill "$stub" 2>/dev/null || true' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$scratch/port" ] && break; sleep 1; done
env -u TRADINGAGENTS_WEB_SEARCH TRADINGAGENTS_HOME="$scratch/home" \
	TRADINGAGENTS_BASE_URL="http://127.0.0.1:$(cat "$scratch/port")/v1" TRADINGAGENTS_MODEL=stub \
	TRADINGAGENTS_NO_UPDATE_CHECK=1 "$bin" -p "What can you look up?" >/dev/null
if grep -q -i tauric "$scratch/requests"; then
	echo "check-no-tauric: a model request mentions Tauric" >&2
	status=1
fi
[ "$status" -eq 0 ] && echo "check-no-tauric: none in the sources, the executable or a model request"
exit "$status"
