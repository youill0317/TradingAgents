#!/bin/sh
# Copyright 2026 TradingAgents fork contributors
# SPDX-License-Identifier: Apache-2.0
# Added in this fork of TradingAgents 1.0.0.
# Checks that no Tauric service is left in this fork: sh scripts/fork/check-no-tauric.sh <executable> <scratch dir>
#
# - every tracked text file names Tauric, in any case, only where scripts/fork/tauric-allowlist.txt allows
#   it (upstream's copyright lines, FORK.md, upstream's release notes, and lines kept on purpose); each
#   other line is printed as path:line:text;
# - the executable carries no Tauric site, endpoint, key variable or tool beyond the upstream release notes
#   it embeds (src/cli/changelog.generated.ts, which src/fork/changelog.ts shows without their Tauric
#   items): each may appear only as often as those notes hold it;
# - nothing the executable sends a model mentions Tauric (one -p question to a recording stub).
set -eu
bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
mkdir -p "$2"
scratch=$(cd "$2" && pwd)
top=$(git rev-parse --show-toplevel)
cd "$top"
list=scripts/fork/tauric-allowlist.txt
notes=src/cli/changelog.generated.ts
status=0

# git grep -z prints each line that says "tauric" as its path, number and text, split by NULs (it exits 1
# when there is none, and above 1 when it fails); with each on a line of its own, awk reads them in
# threes. The list is read first: a path alone allows its whole file, and a path, a tab and a text allow
# that text in its lines (for *, in any file's). An entry that no line needs any more is named, without
# failing.
[ -r "$list" ] || {
	echo "check-no-tauric: cannot read $list" >&2
	exit 1
}
git grep -z -n -I -i -F --no-color --no-column tauric >"$scratch/lines" || [ $? -eq 1 ]
if ! tr '\0' '\n' <"$scratch/lines" | awk -v list="$list" '
# The line with each copy of the text of entry n taken out; the entry is used when the line had one.
function strip(line, n,    at) {
	while ((at = index(line, text[n])) > 0) {
		used[n] = 1
		line = substr(line, 1, at - 1) " " substr(line, at + length(text[n]))
	}
	return line
}
BEGIN {
	bad = 0
	while ((getline row < list) > 0) {
		sub(/\r$/, "", row)
		tab = index(row, "\t")
		# Comments, blank rows, and a path and a tab with no text allow nothing.
		if (row ~ /^#/ || tab == length(row)) continue
		path[++n] = tab ? substr(row, 1, tab - 1) : row
		if (!tab) {
			whole[row] = n
			continue
		}
		text[n] = substr(row, tab + 1)
		entries[path[n], ++count[path[n]]] = n
	}
}
NR % 3 == 1 { file = $0; next }
NR % 3 == 2 { number = $0; next }
{
	if (file in whole) {
		used[whole[file]] = 1
		next
	}
	rest = $0
	for (k = 1; k <= count["*"]; k++) rest = strip(rest, entries["*", k])
	for (k = 1; k <= count[file]; k++) rest = strip(rest, entries[file, k])
	if (tolower(rest) ~ /tauric/) {
		print file ":" number ":" $0
		bad = 1
	}
}
END {
	for (i = 1; i <= n; i++) {
		if (i in used) continue
		row = (i in text) ? path[i] "\t" text[i] : path[i]
		print "check-no-tauric: no line needs this entry of " list ": " row
	}
	exit bad
}' >&2; then
	echo "check-no-tauric: the lines above name Tauric, and $list does not allow them" >&2
	status=1
fi

# The executable embeds upstream's release notes, which name Tauric's site: each of these may appear in it
# as often as the notes hold it, and no more.
for pattern in api.tauric.ai tauric.ai TauricResearch TAURIC_API_KEY tauric_view "key tauric" \
	TRADINGAGENTS_SYNC .tauric/ '".tauric"'; do
	found=$(grep -a -o -F -e "$pattern" "$bin" | wc -l)
	kept=$(grep -o -F -e "$pattern" "$notes" | wc -l)
	if [ "$((found))" -gt "$((kept))" ]; then
		echo "check-no-tauric: $pattern: $((found)) in the executable, $((kept)) in the release notes it embeds" >&2
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
if [ ! -s "$scratch/requests" ]; then
	echo "check-no-tauric: the executable sent the stub no model request" >&2
	status=1
elif grep -q -i tauric "$scratch/requests"; then
	echo "check-no-tauric: a model request mentions Tauric" >&2
	status=1
fi
[ "$status" -eq 0 ] && echo "check-no-tauric: Tauric only where kept on purpose, and in no model request"
exit "$status"
