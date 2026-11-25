#!/bin/sh
# Copyright 2026 TradingAgents fork contributors
# SPDX-License-Identifier: Apache-2.0
# Added in this fork of TradingAgents 1.0.0.
# Apache-2.0 4(b): each upstream file this fork changed says so near its top, and each file it added says it
# was added. Files that cannot hold a comment (JSON, Markdown) are listed, in backticks, under FORK.md's
# "Change notices" heading instead.
# sh scripts/fork/check-notices.sh [<upstream ref>]   (default: main, the mirror of upstream)
#
# The working tree is compared with the merge base of the ref and HEAD (and, during a merge, the commit
# being merged), the upstream commit this branch last took: changes upstream made after it, on a ref
# updated before the merge, are upstream's and need no notice.
set -eu
ref=${1:-main}
top=$(git rev-parse --show-toplevel)
cd "$top"
merging=$(git rev-parse -q --verify MERGE_HEAD) || merging=
base=$(git merge-base "$ref" HEAD ${merging:+"$merging"}) || {
	echo "check-notices: $ref and HEAD have no commit in common here (is $ref fetched, with its history?)" >&2
	exit 1
}
changed=$(git diff --name-only --diff-filter=M "$base" --)
added=$(git diff --name-only --diff-filter=A "$base" --)
listed=$(awk '/^## / { on = ($0 == "## Change notices") } on' FORK.md 2>/dev/null) || listed=
status=0
commented() { case $1 in *.ts | *.tsx | *.js | *.mjs | *.cjs | *.sh | *.yml | *.yaml) return 0 ;; *) return 1 ;; esac; }
for file in $changed; do
	commented "$file" || {
		printf '%s\n' "$listed" | grep -q -F "\`$file\`" || { echo "FORK.md does not list $file" >&2; status=1; }
		continue
	}
	head -n 6 "$file" | grep -q "Changed in this fork" || { echo "$file: no change notice" >&2; status=1; }
done
for file in $added; do
	commented "$file" || continue
	head -n 6 "$file" | grep -q "Added in this fork" || { echo "$file: no notice that this fork added it" >&2; status=1; }
done
[ "$status" -eq 0 ] && echo "check-notices: every changed or added file says so"
exit "$status"
