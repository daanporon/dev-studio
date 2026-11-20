#!/usr/bin/env bash
# stop-mine.sh — `ds stop-mine` signals only processes under the caller's worktree:
# two identical sleepers (same command line) in two git repos; stopping from repo A
# kills A's sleeper, leaves B's running (listed as left alone). --dry-run stops
# nothing; a pattern with no match exits 1.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=tests/lib.sh
. "$ROOT/tests/lib.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/a" "$TMP/b"
git init -q "$TMP/a" 2>/dev/null
git init -q "$TMP/b" 2>/dev/null

pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 (want [$3], got [$2])" >&2; fi }
alive() { kill -0 "$1" 2>/dev/null; }

MARK="ds-stop-mine-probe-$BASHPID"
# The sleeper's stdio is detached: a background child inherits the $(...) capture
# pipe, and the capture would hang until the sleeper exits.
start_in() { (cd "$1" && exec -a "$MARK" sleep 300 >/dev/null 2>&1) & echo $!; }

PA="$(start_in "$TMP/a")"
PB="$(start_in "$TMP/b")"
sleep 1
eq "both sleepers start alive" "$([ "$(alive "$PA"; echo $?)$(alive "$PB"; echo $?)" = "00" ] && echo yes || echo no)" "yes"

out="$(cd "$TMP/a" && "$ROOT/bin/ds" stop-mine "$MARK" 2>&1)"; rc=$?
eq "stop from A exits 0" "$rc" "0"
eq "output names A's PID as stopped" "$(printf '%s' "$out" | grep -c "stopped $PA ")" "1"
sleep 1
eq "A's sleeper is dead" "$(alive "$PA"; echo $?)" "1"
eq "B's sleeper survives" "$(alive "$PB"; echo $?)" "0"
eq "output lists B as left alone" "$(printf '%s' "$out" | grep -c "left alone: 1.*$TMP/b")" "1"

# --dry-run stops nothing.
PA="$(start_in "$TMP/a")"
sleep 1
out="$(cd "$TMP/a" && "$ROOT/bin/ds" stop-mine "$MARK" --dry-run 2>&1)"; rc=$?
eq "dry-run exits 0 on a match" "$rc" "0"
eq "dry-run would stop A's new sleeper" "$(printf '%s' "$out" | grep -c "would stop $PA ")" "1"
eq "dry-run kills nothing (A alive)" "$(alive "$PA"; echo $?)" "0"
eq "dry-run kills nothing (B alive)" "$(alive "$PB"; echo $?)" "0"

# A pattern with no match exits 1.
(cd "$TMP/a" && "$ROOT/bin/ds" stop-mine "no-such-process-$BASHPID" >/dev/null 2>&1); eq "no match exits 1" "$?" "1"
(cd "$TMP/a" && "$ROOT/bin/ds" stop-mine >/dev/null 2>&1); eq "no pattern exits 2" "$?" "2"

stop_own "$PA"; stop_own "$PB"
echo "stop-mine: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
