#!/usr/bin/env bash
# review-unit-marker.sh — part of the review-unit suite (U4): `<git-dir>/ds-review-start` exists while a
# full, delta or delta-wide review's engine runs (epoch, HEAD, kind, the script's live pid) and is gone
# after every exit (0, 4, 5, an engine failure, TERM); a carried run and an exit-6 stop write none; an
# unwritable marker changes no exit code; the receipt and the log line keep their fields.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/review-unit-prelude.sh"
# U284: review-unit.ts leaves its tmp.* files when it exits on a TERM or an engine failure (its own temp files,
# not this test's); they go under $TMP, which the prelude's trap removes.
mkdir -p "$TMP/tmpd"; export TMPDIR="$TMP/tmpd"

GD="$TMP/repo/.git"; MK="$GD/ds-review-start"; ML="$TMP/marker-log"; export STUB_MARKER_LOG="$ML"
mkdir -p "$SD"; printf 'builder-review claude opus elevate\n' > "$SD/roles.conf"
gc() { git -C "$TMP/repo" -c user.email=t@t -c user.name=t "$@"; }
commit() { echo "$1" >> "$TMP/repo/$2"; gc add "$2"; gc commit -q -m "$1"; }
gone() { check "$1" "absent" "$([ -e "$MK" ] && echo present || echo absent)"; }
# The marker as the engine saw it, without its epoch: HEAD, kind, pid liveness.
seen() { cut -f2,3,5 "$ML"; }

# A full review: the engine sees the marker, gone after exit 0; the receipt and log keep their fields.
commit one a.txt; rm -f "$RFILE"; : > "$ML"
run_ru "$LBL" origin/main >/dev/null 2>"$TMP/err"; rc=$?
check "U4: a full review exits 0" "0" "$rc"
check "U4: ...its engine sees the marker: HEAD, full, a live pid" "$(head_sha)	full	alive" "$(seen)"
check "U4: ...stamped with the time it started" "1" "$(awk -F'\t' -v n="$(date +%s)" '{print ($1 + 0 > 0 && n - $1 < 300) ? 1 : 0}' "$ML")"
gone  "U4: ...and it is gone after exit 0"
check "U4: the receipt keeps its six fields and proof=1" "6 $(head_sha) proof=1" "$(awk -F'\t' '{print NF, $1, $6}' "$RFILE")"
check "U4: the log line keeps its six fields" "6 full" "$(awk -F'\t' 'END {print NF, $3}' "$GD/ds-review-log")"

# A delta review names its kind.
commit two a.txt; : > "$ML"
run_ru "$LBL" origin/main >/dev/null 2>"$TMP/err"; rc=$?
check "U4: a delta review exits 0" "0" "$rc"
check "U4: ...its engine sees the marker with kind delta" "$(head_sha)	delta	alive" "$(seen)"
gone  "U4: ...gone after"

# Exit 4: a review whose proof fails.
commit three a.txt; : > "$ML"
PROOF_CASE=missing-finish run_ru "$LBL" origin/main >/dev/null 2>"$TMP/err"; rc=$?
check "U4: a failed proof exits 4" "4" "$rc"
check "U4: ...after its engine saw the marker" "alive" "$(cut -f5 "$ML")"
gone  "U4: ...gone after exit 4"

# The engine's own failure.
: > "$ML"
STUB_OUT='not a report' STUB_EXIT=7 run_ru "$LBL" origin/main >/dev/null 2>"$TMP/err"; rc=$?
check "U4: an engine failure keeps its exit code" "7" "$rc"
check "U4: ...after its engine saw the marker" "alive" "$(cut -f5 "$ML")"
gone  "U4: ...gone after it"

# Exit 5: no usable review agent, nothing runs.
: > "$ML"
FAKE_ACCOUNTS='[{"agent":"claude","account":"cl1","state":"disabled"}]' run_ru "$LBL" origin/main >/dev/null 2>"$TMP/err"; rc=$?
check "U4: no usable agent exits 5" "5" "$rc"
check "U4: ...with no engine run" "" "$(cat "$ML")"
gone  "U4: ...and no marker"

# An unwritable marker path: the review still finishes with its normal exit code.
commit four a.txt; : > "$ML"; mkdir "$MK"
run_ru "$LBL" origin/main >/dev/null 2>"$TMP/err"; rc=$?
check "U4: a marker that can't be written still exits 0" "0" "$rc"
check "U4: ...the engine ran without one" "none" "$(cat "$ML")"
check "U4: ...and the receipt names HEAD" "$(head_sha)" "$(cut -f1 "$RFILE")"
rmdir "$MK"

# A carried run (a rebase moved only the base) reviews nothing and writes no marker.
gc checkout -q --detach refs/remotes/origin/main; commit base b.txt; gc update-ref refs/remotes/origin/main HEAD
gc checkout -q main; gc rebase -q origin/main; : > "$ML"
run_ru "$LBL" origin/main >/dev/null 2>"$TMP/err"; rc=$?
check "U4: a carried run exits 0" "0" "$rc"
has   "U4: ...as carried" "$(cat "$TMP/err")" "carried"
check "U4: ...with no engine run" "" "$(cat "$ML")"
gone  "U4: ...and no marker"
check "U4: ...its log line keeps its six fields" "6 carried" "$(awk -F'\t' 'END {print NF, $3}' "$GD/ds-review-log")"

# Exit 6: two proof failures in a row stop reviews; the stopped call writes no marker.
run_keep() { (cd "$TMP/repo" && rm -f "$GD/ds-review-last-run" && "$RU" "$@"); }
commit five a.txt; rm -f "$GD/ds-review-stop"
PROOF_CASE=missing-finish run_keep "$LBL" origin/main >/dev/null 2>&1
PROOF_CASE=missing-finish run_keep "$LBL" origin/main >/dev/null 2>&1
: > "$ML"
run_keep "$LBL" origin/main >/dev/null 2>"$TMP/err"; rc=$?
check "U4: a stopped unit exits 6" "6" "$rc"
check "U4: ...with no engine run" "" "$(cat "$ML")"
gone  "U4: ...and no marker"
rm -f "$GD/ds-review-stop" "$GD/ds-review-last-run"

# TERM while the engine runs: the script exits 143 and the marker is gone. The stub records its pid
# and sleeps; it is stopped by that pid afterwards.
commit six a.txt; : > "$ML"; rm -f "$TMP/stub-pid"
(cd "$TMP/repo" && clear_last_run && STUB_SLEEP=60 STUB_SLEEP_PID="$TMP/stub-pid" exec "$RU" "$LBL" origin/main) >/dev/null 2>"$TMP/term-err" &
rp=$!
for _ in $(seq 1 300); do [ -s "$TMP/stub-pid" ] && break; sleep 0.1; done
check "U4: while the engine runs the marker names the script's pid" "$rp" "$(cut -f4 "$MK" 2>/dev/null)"
kill -TERM "$rp"; wait "$rp"; rc=$?
check "U4: TERM exits 143" "143" "$rc"
gone  "U4: ...and the marker is gone"
[ -s "$TMP/stub-pid" ] && kill "$(cat "$TMP/stub-pid")" 2>/dev/null

echo "review-unit-marker: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
