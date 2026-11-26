#!/bin/sh
# Copyright 2026 TradingAgents fork contributors
# SPDX-License-Identifier: Apache-2.0
# Added in this fork of TradingAgents 1.0.0.
# Apache-2.0 4(b) and 4(c): each upstream file this fork changed says so near its top, and each file it added
# says it was added. Files that cannot hold a comment (JSON, Markdown) are listed, in backticks, under
# FORK.md's "Change notices" heading instead.
# sh scripts/fork/check-notices.sh [<upstream ref>]   (default: main, the mirror of upstream)
#
# - A changed upstream file, a moved one included, starts with upstream's own lines through its SPDX line,
#   as upstream wrote them, and the next line is `Changed in this fork of TradingAgents <version>.`.
# - An added file starts, after any #! line, with the fork's copyright line, the SPDX line and
#   `Added in this fork of TradingAgents <version>.`.
# - No added path is a symbolic link: a link carries no notice, and one to a place on one machine (a
#   worktree's node_modules, which .gitignore's `node_modules/` does not match) breaks every other checkout.
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
# Renames are found whatever the configuration says, so a moved upstream file counts as changed (R, with
# its old and new path) rather than as added.
changed=$(git diff --name-status --find-renames --diff-filter=MR "$base" --)
added=$(git diff --name-only --find-renames --diff-filter=A "$base" --)
listed=$(awk '/^## / { on = ($0 == "## Change notices") } on' FORK.md 2>/dev/null) || listed=
tab=$(printf '\t')
status=0
commented() { case $1 in *.ts | *.tsx | *.js | *.mjs | *.cjs | *.sh | *.yml | *.yaml) return 0 ;; *) return 1 ;; esac; }
while IFS=$tab read -r kind from to; do
	[ -n "$kind" ] || continue
	file=${to:-$from}
	commented "$file" || {
		printf '%s\n' "$listed" | grep -q -F "\`$file\`" || { echo "FORK.md does not list $file" >&2; status=1; }
		continue
	}
	# Upstream's lines through its SPDX line; a file upstream gave none only needs the notice near its top.
	if ! kept=$(git show "$base:$from" |
		awk '{ print } /SPDX-License-Identifier/ { found = 1; exit } END { exit !found }'); then
		head -n 6 "$file" | grep -q "Changed in this fork" || { echo "$file: no change notice" >&2; status=1; }
		continue
	fi
	n=$(printf '%s\n' "$kept" | wc -l)
	if [ "$(head -n "$n" "$file")" != "$kept" ]; then
		echo "$file: does not start with upstream's lines through its SPDX line, as upstream wrote them" >&2
		status=1
	elif ! sed -n "$((n + 1))p" "$file" |
		grep -q -E '^(//|#) Changed in this fork of TradingAgents [0-9][0-9A-Za-z.+-]*\.$'; then
		echo "$file: no change notice on the line under its SPDX line" >&2
		status=1
	fi
done <<EOF
$changed
EOF
for file in $added; do
	if [ "$(git ls-files -s -- "$file" | cut -c1-6)" = 120000 ]; then
		echo "$file: a symbolic link is tracked; untrack it (the link itself stays): git rm --cached $file" >&2
		status=1
		continue
	fi
	commented "$file" || continue
	head -n 4 "$file" | awk '
		NR == 1 && /^#!/ { skip = 1; next }
		{ line[NR - skip] = $0 }
		END {
			exit !(line[1] ~ /^(\/\/|#) Copyright [0-9][0-9][0-9][0-9] TradingAgents fork contributors$/ &&
				line[2] ~ /^(\/\/|#) SPDX-License-Identifier: Apache-2\.0$/ &&
				line[3] ~ /^(\/\/|#) Added in this fork of TradingAgents [0-9][0-9A-Za-z.+-]*\.$/)
		}' || {
		echo "$file: does not start with the fork's copyright, SPDX and added-in-this-fork lines" >&2
		status=1
	}
done
[ "$status" -eq 0 ] && echo "check-notices: every changed or added file says so"
exit "$status"
