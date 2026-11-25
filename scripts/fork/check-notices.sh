#!/bin/sh
# Copyright 2026 TradingAgents fork contributors
# SPDX-License-Identifier: Apache-2.0
# Added in this fork of TradingAgents 1.0.0.
# Apache-2.0 4(b): each upstream file this fork changed says so near its top, and each file it added says it
# was added. Files that cannot hold a comment (JSON, Markdown) are listed in FORK.md instead.
# sh scripts/fork/check-notices.sh [<upstream ref>]   (default: main, the mirror of upstream)
set -eu
base=${1:-main}
status=0
commented() { case $1 in *.ts | *.tsx | *.js | *.mjs | *.cjs | *.sh | *.yml | *.yaml) return 0 ;; *) return 1 ;; esac; }
for file in $(git diff --name-only --diff-filter=M "$base" --); do
	commented "$file" || { grep -q -F "$file" FORK.md 2>/dev/null || { echo "FORK.md does not list $file" >&2; status=1; }; continue; }
	head -n 6 "$file" | grep -q "Changed in this fork" || { echo "$file: no change notice" >&2; status=1; }
done
for file in $(git diff --name-only --diff-filter=A "$base" --); do
	commented "$file" || continue
	head -n 6 "$file" | grep -q "Added in this fork" || { echo "$file: no notice that this fork added it" >&2; status=1; }
done
[ "$status" -eq 0 ] && echo "check-notices: every changed or added file says so"
exit "$status"
