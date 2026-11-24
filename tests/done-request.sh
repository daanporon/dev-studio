#!/usr/bin/env bash
# done-request.sh — the one way to clear a handled restart/board request: delete the file,
# then print what is still waiting in that same folder (so the agent handles each before it
# stops), or `none left`. Refuses anything outside state/*/requests/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
LBL="zzdr_$$"; RQ="$DS_STATE_ROOT/$LBL/requests"
TMP="$(mktemp -d)"
state_root_on_exit 'rm -rf "$DS_STATE_ROOT/$LBL" "$TMP"'
mkdir -p "$RQ/_studio" "$RQ/mt"

pass=0; fail=0
has(){ if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
no(){ if grep -qF -- "$3" <<<"$2"; then fail=$((fail+1)); echo "  FAIL: $1 — unexpected [$3]" >&2; else pass=$((pass+1)); fi; }
eq(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
run(){ out=""; rc=0; out="$("$ROOT/bin/role/done-request.sh" "$@" 2>&1)" || rc=$?; }

echo "restart lead of mt (dead since 03:00)" > "$RQ/_studio/mt.lead-1.txt"
echo "board: the operator asks you to run: /ds-close-squad mt" > "$RQ/_studio/board-close-mt-1.txt"

run "$RQ/_studio/mt.lead-1.txt"
eq  "clearing one exits 0" "$rc" "0"
no  "clearing one deletes it" "$(ls "$RQ/_studio")" "mt.lead-1.txt"
has "clearing one prints the other's line" "$out" "↻ request"$'\t'"board: the operator asks you to run: /ds-close-squad mt"
has "the listing names the other's file" "$out" "$RQ/_studio/board-close-mt-1.txt"

run "$RQ/_studio/board-close-mt-1.txt"
eq  "clearing the last exits 0" "$rc" "0"
has "clearing the last prints none left" "$out" "none left"

# An already-deleted path still lists what's left (exit 0).
echo "restart lead of mt (dead since 03:00)" > "$RQ/_studio/mt.lead-2.txt"
run "$RQ/_studio/mt.lead-1.txt"
eq  "an already-deleted path exits 0" "$rc" "0"
has "an already-deleted path still lists what's left" "$out" "restart lead of mt (dead since 03:00)"

# A Lead's requests/<topic>/ folder works the same way.
echo "restart builder-u3 of mt (hung since 10:00)" > "$RQ/mt/mt.builder-u3-1.txt"
echo "switch: restart builder-u4 of mt (usage limit) — run: bin/commands/restart-role.sh x" > "$RQ/mt/mt.builder-u4-1.txt"
run "$RQ/mt/mt.builder-u3-1.txt"
eq  "a Lead folder exits 0" "$rc" "0"
no  "a Lead folder deletes the cleared file" "$(ls "$RQ/mt")" "mt.builder-u3-1.txt"
has "a Lead folder lists what is left" "$out" "switch: restart builder-u4 of mt (usage limit)"

# Refusals: outside requests/, or not a .txt — nothing deleted.
echo "precious" > "$TMP/keep.txt"
run "$TMP/keep.txt"
no  "a path outside requests/ is refused" "$rc" "0"
has "the refusal says why" "$out" "refusing"
eq  "a refused path deletes nothing" "$(cat "$TMP/keep.txt")" "precious"
echo "restart lead of mt (dead)" > "$RQ/_studio/note.md"
run "$RQ/_studio/note.md"
no  "a non-.txt path is refused" "$rc" "0"
eq  "a refused non-.txt deletes nothing" "$(cat "$RQ/_studio/note.md")" "restart lead of mt (dead)"
run
no  "no argument is refused" "$rc" "0"

echo "done-request: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
