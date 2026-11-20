#!/usr/bin/env bash
# review-unit-proof.sh — part of the review-unit suite (U233): the proof checks in a repo unrelated to dev-studio. The suite is split so no one CI job nears
# CI_TEST_TIMEOUT on a loaded host; the stubs and helpers are in tests/lib/review-unit-prelude.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/review-unit-prelude.sh"

RP="$TMP/independent"; PF="$RP/.git/ds-review"; PB="$RP/.git/ds-review-base"
gp() { git -C "$RP" -c user.email=t@t -c user.name=t "$@"; }
proof_run() { (cd "$RP" && clear_last_run && "$RU" "$LBL" "$@") >"$TMP/proof-out" 2>"$TMP/err"; }
git init -q -b trunk "$RP"; echo base > "$RP/file"; gp add file; gp commit -q -m base
gp checkout -q -b feature; echo unit >> "$RP/file"; gp commit -q -am unit
printf 'builder-review claude opus elevate\n' > "$SD/roles.conf"
proof_run trunk; rc=$?
check "full proof succeeds in an unrelated repo" "0" "$rc"
check "full receipt carries proof=1" "proof=1" "$(cut -f6 "$PF")"
check "delta base carries proof=1" "proof=1" "$(cut -f7 "$PB")"
for good in empty-no-list empty-selected-empty empty-no-count empty-skill-shape empty-findings-only empty-count-null-zero verdicts-ok peer-offroster-local peer-offroster-folded-valid peer-offroster-unselected; do
  PROOF_CASE="$good" proof_run trunk; rc=$?
  check "$good proof succeeds" "0" "$rc"
done
# A printed report that escapes < > & still gets its receipt, and the findings
# read review.json (the file), not the retyped text.
rm -f "$PF"
arrow_report='{"status":"complete","actionable_findings":[{"title":"released->paid->returned flow","severity":"P2","file":"src/plain.ts","line":4}]}'
STUB_OUT="$arrow_report" PROOF_CASE=escaped-entities proof_run trunk; rc=$?
check "escaped entities print still writes a receipt" "0" "$rc"
check "escaped entities receipt exists" "present" "$([ -e "$PF" ] && echo present || echo absent)"
esc_dir="$(jq -r '.artifact_path' "$TMP/proof-out")"
has "escaped stdout keeps the printed copy" "$(cat "$TMP/proof-out")" "released-&gt;paid"
has "escaped entities findings read the file" "$(cat "$esc_dir/noted-findings.json")" "released->paid->returned flow"
lacks "escaped entities leave no entity in the findings" "$(cat "$esc_dir/noted-findings.json")" "&gt;"
# A faithful print of a string that legitimately contains an entity passes too.
rm -f "$PF"
entity_report='{"status":"complete","actionable_findings":[{"title":"quote &lt;b&gt; literal","severity":"P2","file":"src/plain.ts","line":4}]}'
STUB_OUT="$entity_report" proof_run trunk; rc=$?
check "a literal entity printed faithfully still writes a receipt" "0" "$rc"
lit_dir="$(jq -r '.artifact_path' "$TMP/proof-out")"
has "a literal entity survives into the findings" "$(cat "$lit_dir/noted-findings.json")" "quote &lt;b&gt; literal"
# A printed report with a different finding count or title no longer matters: the file wins.
rm -f "$PF"
STUB_OUT="$arrow_report" PROOF_CASE=printed-count-mismatch proof_run trunk; rc=$?
check "a printed report with a different finding count writes a receipt" "0" "$rc"
check "a count mismatch writes a receipt" "present" "$([ -e "$PF" ] && echo present || echo absent)"
check "the finding count comes from the file" "2" "$(cut -f4 "$PF")"
cnt_dir="$(jq -r '.artifact_path' "$TMP/proof-out")"
has "the file's extra finding is kept" "$(cat "$cnt_dir/noted-findings.json")" "extra finding"
rm -f "$PF"
STUB_OUT="$arrow_report" PROOF_CASE=printed-title-mismatch proof_run trunk; rc=$?
check "a printed report with a different title writes a receipt" "0" "$rc"
check "a title mismatch writes a receipt" "present" "$([ -e "$PF" ] && echo present || echo absent)"
ttl_dir="$(jq -r '.artifact_path' "$TMP/proof-out")"
has "the file's renamed finding is kept" "$(cat "$ttl_dir/noted-findings.json")" "renamed finding"
lacks "the printed title is not staged" "$(cat "$ttl_dir/noted-findings.json")" "\"title\":\"released->paid->returned flow\""
echo "review-unit-proof: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
