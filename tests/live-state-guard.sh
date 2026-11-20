#!/usr/bin/env bash
# live-state-guard.sh — U253: the suite's live-state guard (tests/lib/live-state-guard.sh) names a new
# entry or a new loop.db project in a state dir, ignores a removed one, and tests/lib/state-root.sh
# hands a test a fresh temp root even when the caller's DS_STATE_ROOT points at the live state.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# shellcheck source=tests/lib/live-state-guard.sh
. "$ROOT/tests/lib/live-state-guard.sh"

pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 (want [$3], got [$2])" >&2; fi; }

S="$TMP/state"; mkdir -p "$S/real/squads"
DS_STATE_ROOT="$S" "$ROOT/bin/ds" import > /dev/null 2>&1 || true
live_state_snapshot "$S" > "$TMP/b.txt"
live_state_snapshot "$S" > "$TMP/a.txt"
eq "nothing changed: no leak" "$(live_state_leaks "$TMP/b.txt" "$TMP/a.txt")" ""

mkdir -p "$S/zzleak_1/squads"
live_state_snapshot "$S" > "$TMP/a.txt"
eq "a new project dir is a leak" "$(live_state_leaks "$TMP/b.txt" "$TMP/a.txt")" "entry zzleak_1"

printf '{"run_id":"r","status":"running","members":[],"units":[]}' > "$S/zzleak_1/squads/t.json"
DS_STATE_ROOT="$S" "$ROOT/bin/ds" import > /dev/null 2>&1
live_state_snapshot "$S" > "$TMP/a.txt"
eq "the db project is a leak too" "$(live_state_leaks "$TMP/b.txt" "$TMP/a.txt" | grep -c '^project zzleak_1$')" "1"

rm -rf "$S/real"
live_state_snapshot "$S" > "$TMP/b2.txt"
live_state_snapshot "$S" > "$TMP/a2.txt"
: > "$TMP/gone.txt"; echo "entry real" > "$TMP/gone.txt"
eq "a removed entry is not a leak" "$(live_state_leaks "$TMP/gone.txt" "$TMP/a2.txt" | grep -c '^entry real$' || true)" "0"

# state-root.sh: always a new root, named state/ (done-request.sh), whatever the caller holds.
out="$(DS_STATE_ROOT=/live/state DS_TEST_STATE_BASE="$TMP" bash -c '. "$1/tests/lib/state-root.sh"; printf "%s" "$DS_STATE_ROOT"' _ "$ROOT")"
case "$out" in "$TMP"/dsstate.*/state) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "  FAIL: state-root gave [$out]" >&2 ;; esac

echo "live-state-guard: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
