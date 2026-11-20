#!/usr/bin/env bash
# review-proof-replay.sh — U250: the replay tool (bin/review/review-proof-replay.ts) over saved run folders:
# the U4 run (artifact_path null) passes with `repaired: artifact_path` and fails without the repair; a
# present-but-different artifact_path, an incomplete report, and a stage-log slip without the stage's
# output still fail; no folder passes against a HEAD it does not name.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 — want [$2] got [$3]" >&2; fi; }
has() { if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 — missing [$3] in [$2]" >&2; fi; }
TMP="$(mktemp -d -p "${XDG_RUNTIME_DIR:-/tmp}" proofreplay.XXXXXX)"; trap 'rm -rf "$TMP"' EXIT
FIX="$ROOT/tests/fixtures/review-proof"
replay() { (cd "$ROOT" && bun bin/review/review-proof-replay.ts --root "$1" "${@:2}" 2>/dev/null); }

U4=20261112-221849-f923e8a1
out="$(replay "$FIX")"
has   "U4 run: replayed"                  "$out" "replay of 1 saved runs"
has   "U4 run: repaired by artifact_path" "$out" "repaired      1"
has   "U4 run: the field is named"        "$out" "artifact_path"
check "U4 run: nothing failed"            "failed        0" "$(grep '^failed' <<<"$out")"
out="$(replay "$FIX" --before)"
has   "U4 run: before the repair it failed" "$out" "failed        1"
has   "U4 run: ...on artifact_path"         "$out" "artifact_path is missing or unreadable"
out="$(replay "$FIX" --wrong-head)"
has   "wrong HEAD: nothing passes"          "$out" "passed        0"

R="$TMP/runs"; mkdir -p "$R"
# artifact_path names another existing folder: still a failure
cp -r "$FIX/$U4" "$R/other-path"; mkdir -p "$TMP/elsewhere"
jq --arg d "$TMP/elsewhere" '.artifact_path=$d' "$FIX/$U4/review.json" > "$R/other-path/review.json"
# a report that is not complete
cp -r "$FIX/$U4" "$R/incomplete"; jq '.status="incomplete"' "$FIX/$U4/review.json" > "$R/incomplete/review.json"
# run_id agreeing with the folder name is repaired; a run_id in metadata that is another name is not
cp -r "$FIX/$U4" "$R/no-run-id"; jq 'del(.run_id)' "$FIX/$U4/review.json" > "$R/no-run-id/review.json"
jq '.run_id="no-run-id"' "$FIX/$U4/metadata.json" > "$R/no-run-id/metadata.json"
cp -r "$FIX/$U4" "$R/no-run-id-other"; jq 'del(.run_id)' "$FIX/$U4/review.json" > "$R/no-run-id-other/review.json"
# a lite run whose stage log closes review without a start passes with a note
cp -r "$FIX/$U4" "$R/lite-slip"; jq -c 'select((.stage=="review" and .phase=="start") | not)' "$FIX/$U4/stages.jsonl" > "$R/lite-slip/stages.jsonl"
jq '.artifact_path="/nonexistent"' "$FIX/$U4/review.json" > "$R/lite-slip/review.json"
out="$(replay "$R" --list "artifact_path ")"
has   "five folders replayed"                         "$out" "replay of 5 saved runs"
has   "an artifact_path naming another folder fails"  "$out" "is not the run folder found"
has   "an incomplete report fails"                    "$out" "review.json is missing or not a complete report"
has   "a missing run_id with a matching folder name is repaired" "$out" "run_id"
has   "a run_id only the folder name could supply fails when metadata disagrees" "$out" "run_id is missing"
has   "a lite stage-log slip is accepted with a note" "$out" "stage log: an end-only stage without supporting artifact"
echo "review-proof-replay: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
