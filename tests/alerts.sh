#!/usr/bin/env bash
# alerts.sh — a project's Studio alerts file: add/resolve/resolve-prefix/list, validation, replace-by-id.
# U222: written against the shell version first; ALERTS_SH points the suite at another build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
A="${ALERTS_SH:-$ROOT/bin/lib/alerts.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
F="$TMP/p/alerts.json"

pass=0; fail=0
eq(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
rc(){ set +e; "$@" >/dev/null 2>&1; local r=$?; set -e; echo "$r"; }
j(){ jq -r "$1" "$F"; }

eq "no args: usage, exit 2" "$(rc "$A")" "2"
eq "one arg: usage, exit 2" "$(rc "$A" "$F")" "2"
eq "list on a missing file is empty, exit 0" "$("$A" "$F" list)" ""
eq "resolve on a missing file: exit 0" "$(rc "$A" "$F" resolve x)" "0"
[ ! -e "$F" ] && r=none || r=created; eq "resolve on a missing file creates nothing" "$r" "none"

"$A" "$F" add a1 "Title one" "Question one?" "Do it" "because" 
eq "file created under a new directory" "$(j '.alerts | length')" "1"
eq "entry id" "$(j '.alerts[0].id')" "a1"
eq "entry asker/blocking" "$(j '.alerts[0] | "\(.asker) \(.blocking)"')" "sweep false"
eq "entry question/title" "$(j '.alerts[0] | "\(.question)|\(.title)"')" "Question one?|Title one"
eq "entry suggestion/options/why" "$(j '.alerts[0] | "\(.suggestion)|\(.options|join(","))|\(.why)"')" "Do it|Do it|because"
case "$(j '.alerts[0].since')" in 20??-??-??T??:??:??Z) r=ok ;; *) r=no ;; esac; eq "since is an ISO timestamp" "$r" "ok"

"$A" "$F" add a2 "" "Bare?" "" ""
eq "empty title/option/why are left out" "$(j '.alerts[1] | keys | join(",")')" "asker,blocking,id,question,since"
"$A" "$F" add a3 "T3" "Q3" "" "" '{"kind":"limit","blocking":true}'
eq "fields merge; the fixed keys win" "$(j '.alerts[2] | "\(.kind) \(.blocking) \(.asker)"')" "limit false sweep"
eq "fields must be an object" "$(rc "$A" "$F" add a4 t q o w '[1]')" "2"
eq "fields must be JSON" "$(rc "$A" "$F" add a4 t q o w 'nope')" "2"
eq "add with too few args" "$(rc "$A" "$F" add a4 t q)" "2"

"$A" "$F" add a1 "Replaced" "Q1b" "" ""
eq "same id replaces, moves last" "$(j '.alerts | map(.id) | join(",")')" "a2,a3,a1"
eq "replaced content" "$(j '.alerts[2].title')" "Replaced"
eq "list: id TAB question" "$("$A" "$F" list | head -n1)" "$(printf 'a2\tBare?')"
eq "list count" "$("$A" "$F" list | wc -l | tr -d ' ')" "3"

"$A" "$F" resolve a3
eq "resolve drops one" "$(j '.alerts | map(.id) | join(",")')" "a2,a1"
"$A" "$F" add ab-1 "" "x" "" ""; "$A" "$F" add ab-2 "" "y" "" ""; "$A" "$F" add zz "" "z" "" ""
"$A" "$F" resolve-prefix ab-
eq "resolve-prefix drops every match" "$(j '.alerts | map(.id) | join(",")')" "a2,a1,zz"
eq "unknown command" "$(rc "$A" "$F" frobnicate)" "2"
eq "output is 2-space pretty JSON" "$(sed -n 2p "$F")" '  "alerts": ['

printf '%s' '{"other":1}' > "$TMP/x.json"
"$A" "$TMP/x.json" add k "" "q" "" ""
eq "an object without alerts gets the list; other keys stay" "$(jq -r '"\(.other) \(.alerts|length)"' "$TMP/x.json")" "1 1"
printf '%s' 'not json' > "$TMP/bad.json"
eq "invalid JSON: exit 1" "$(rc "$A" "$TMP/bad.json" list)" "1"

echo "alerts: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
