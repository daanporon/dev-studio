#!/usr/bin/env bash
# PR title check (public-readiness U10): `tests/pr-title.sh "<title>"` exits 0 for a conventional-commit
# title and otherwise prints the format and the allowed types — never the title itself, so a refusal
# can be posted anywhere. With squash merging the PR title is the only message that reaches main.
#
#   <type>(<scope>)!: <summary>      scope and ! are optional
#   type     feat fix docs refactor perf test build ci chore revert
#   scope    lowercase a-z 0-9 and -, the area (board, loop, review-unit, focus-squad)
#   summary  starts with a lowercase letter or a digit; the whole title is at most 72 characters
#
# With no argument it runs its own accept and refuse cases and exits 0 when they all hold (as
# tests/leak-guard.sh does), because tests/ci.sh runs every tests/*.sh with no arguments.
# Users: .github/workflows/pr-title.yml, githooks/gh-text-check, tests/leak-pr-gate.sh.
set -uo pipefail

TYPES="feat|fix|docs|refactor|perf|test|build|ci|chore|revert"
MAX=72

# check_title <title>: 0 when it holds the format.
check_title() {
  local t="$1"
  [[ "$t" != *$'\n'* && "$t" != *$'\r'* ]] || return 1
  [ "${#t}" -le "$MAX" ] || return 1
  [[ "$t" =~ ^($TYPES)(\([a-z0-9-]+\))?!?:\ [a-z0-9] ]]
}

explain() {
  cat >&2 <<EOF
pr-title: the PR title does not follow conventional commits.
  format:  <type>(<scope>)!: <summary>      (the scope and the ! are optional)
  types:   ${TYPES//|/, }
  scope:   lowercase a-z, 0-9 and -, the area (board, loop, review-unit, focus-squad)
  summary: starts lowercase; the whole title is at most $MAX characters, on one line
  example: feat(board): show idle Builders
EOF
}

if [ "$#" -gt 1 ]; then
  echo "usage: tests/pr-title.sh [\"<title>\"]   (no argument: run the self-test)" >&2
  exit 2
fi

if [ "$#" -eq 1 ]; then
  if check_title "$1"; then exit 0; fi
  explain
  exit 1
fi

# --- self-test
fails=0
want_ok() { check_title "$1" || { echo "FAIL pr-title: should accept: $1"; fails=$((fails + 1)); }; }
want_no() { ! check_title "$1" || { echo "FAIL pr-title: should refuse: $1"; fails=$((fails + 1)); }; }

want_ok "feat(board): show idle Builders"
want_ok "fix: x"
want_ok "refactor(loop)!: y"
want_ok "feat(review-unit): keep the receipt"
want_ok "chore(focus-squad): 2 units"
want_ok "revert: feat(board): x"
for ty in feat fix docs refactor perf test build ci chore revert; do want_ok "$ty: x"; done
want_ok "fix: $(printf 'a%.0s' $(seq 1 67))"   # exactly 72 characters

want_no "board: x"
want_no "Feat: x"
want_no "feat(Board): x"
want_no "feat(): x"
want_no "feat(board)x: y"
want_no "feat: X"
want_no "feat:x"
want_no "feat:  x"
want_no "feat : x"
want_no "feat!(board): x"
want_no "feat(a b): x"
want_no "feat(board)(loop): x"
want_no "style: x"
want_no ""
want_no "feat: "
want_no $'feat: x\nmore'
want_no "fix: $(printf 'a%.0s' $(seq 1 68))"   # 73 characters

# a refusal names the format and the types and never the title
out="$(bash "$0" "Zebra-private-title" 2>&1)"; rc=$?
[ "$rc" = 1 ] || { echo "FAIL pr-title: a bad title should exit 1, got $rc"; fails=$((fails + 1)); }
case "$out" in *Zebra-private-title*) echo "FAIL pr-title: the refusal repeats the title"; fails=$((fails + 1)) ;; esac
case "$out" in *"<type>(<scope>)!: <summary>"*"feat, fix, docs, refactor, perf, test, build, ci, chore, revert"*) ;; *)
  echo "FAIL pr-title: the refusal lacks the format or the types"; fails=$((fails + 1)) ;; esac
bash "$0" "fix: x" > /dev/null 2>&1 || { echo "FAIL pr-title: a good title should exit 0"; fails=$((fails + 1)); }
bash "$0" a b > /dev/null 2>&1; [ "$?" = 2 ] || { echo "FAIL pr-title: two arguments should exit 2"; fails=$((fails + 1)); }

[ "$fails" = 0 ] || { echo "FAIL pr-title: $fails case(s)"; exit 1; }
echo "ok pr-title: all cases hold"
