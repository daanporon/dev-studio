#!/usr/bin/env bash
# review-unit-proof-run.sh — part of the review-unit suite (U233): the proof checks on the run folder and its report. The suite is split so no one CI job nears
# CI_TEST_TIMEOUT on a loaded host; the stubs and helpers are in tests/lib/review-unit-prelude.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/review-unit-prelude.sh"
. "$ROOT/tests/lib/review-unit-proof-repo.sh"

# --- U174: the report is read from the run folder, not the printed text ---------------
# A reworded print (different intent, shortened evidence, dropped notes) still gets a
# receipt, and the findings come from the file.
rm -f "$PF"
reword_report='{"status":"complete","actionable_findings":[{"title":"arrow finding","severity":"P2","file":"src/plain.ts","line":4}]}'
STUB_OUT="$reword_report" PROOF_CASE=rewritten-print proof_run trunk; rc=$?
check "a reworded print still writes a receipt" "0" "$rc"
check "a reworded print writes a receipt" "present" "$([ -e "$PF" ] && echo present || echo absent)"
rw_dir="$(jq -r '.artifact_path' "$TMP/proof-out")"
has "stdout keeps the printed copy" "$(cat "$TMP/proof-out")" "check the thing"
has "the findings come from the file" "$(cat "$rw_dir/noted-findings.json")" "arrow finding"
# A print with nothing parseable still gets a receipt when the run folder is complete.
rm -f "$PF"
STUB_OUT='{"status":"complete","actionable_findings":[]}' PROOF_CASE=print-garbage proof_run trunk; rc=$?
check "an unparseable print with a complete folder writes a receipt" "0" "$rc"
check "an unparseable print writes a receipt" "present" "$([ -e "$PF" ] && echo present || echo absent)"
has "the unparseable print reaches stdout" "$(cat "$TMP/proof-out")" "still reviewing, nothing yet"
# Two matching folders in one call: the newer one is used.
rm -f "$PF"
STUB_OUT='{"status":"complete","actionable_findings":[]}' REVIEW_FIXTURE_TWO_RUNS=1 proof_run trunk; rc=$?
check "two matching folders write a receipt" "0" "$rc"
check "two matching folders write a receipt file" "present" "$([ -e "$PF" ] && echo present || echo absent)"
check "the newer folder's findings are staged" "1" "$(grep -rl 'second-run-marker' "$TMP/scratch/ce-code-review"/*/noted-findings.json 2>/dev/null | wc -l)"
check "the older folder's findings are unused" "0" "$(grep -rl 'first-run-marker' "$TMP/scratch/ce-code-review"/*/noted-findings.json 2>/dev/null | wc -l)"
# A stale run is refused: seed an isolated scratch root the fresh run never lands in,
# so the finder sees only the stale folder.
# A run folder written during the call that names another HEAD or branch is refused
# with today's message and no retry: the engine did run the skill.
seed_run() { (cd "$RP" && FIXTURE_HEAD="$(git rev-parse HEAD)" FIXTURE_PROMPT="mode:agent base:trunk" REVIEW_FIXTURES="$1" PROOF_CASE="$2" "$TMP/review-fixture" "$3" >/dev/null); }
seed_head="$(git -C "$RP" rev-parse HEAD)"
rm -f "$PF"
: > "$CLAUDE_LOG"
STUB_OUT='{"status":"complete","actionable_findings":[]}' PROOF_CASE=metadata-head proof_run trunk; rc=$?
check "a run for another HEAD is not used" "4" "$rc"
check "a run for another HEAD writes no receipt" "absent" "$([ -e "$PF" ] && echo present || echo absent)"
has "a run for another HEAD names HEAD and branch" "$(cat "$TMP/err")" "no complete ce-code-review run for HEAD $seed_head on feature since"
check "a run for another HEAD runs the reviewer once" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
rm -f "$PF"
: > "$CLAUDE_LOG"
STUB_OUT='{"status":"complete","actionable_findings":[]}' PROOF_CASE=wrong-branch proof_run trunk; rc=$?
check "a run for another branch is not used" "4" "$rc"
check "a run for another branch writes no receipt" "absent" "$([ -e "$PF" ] && echo present || echo absent)"
has "a run for another branch names HEAD and branch" "$(cat "$TMP/err")" "no complete ce-code-review run for HEAD $seed_head on feature since"
check "a run for another branch runs the reviewer once" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
# A stale run is refused, and a prose answer on top still gets the stricter retry.
rm -rf "$TMP/seed"; mkdir -p "$TMP/seed/ce-code-review" "$TMP/fresh/ce-code-review"
seed_run "$TMP/seed/ce-code-review" baseline '{"status":"complete","actionable_findings":[]}'
touch -d '2000-01-01 00:00:00' "$TMP/seed/ce-code-review"/*
rm -f "$PF"
: > "$CLAUDE_LOG"
REVIEW_FIXTURES="$TMP/fresh/ce-code-review" REVIEW_UNIT_SCRATCH_ROOT="$TMP/seed" STUB_OUT='not json at all' proof_run trunk; rc=$?
check "a run older than the call is not used" "4" "$rc"
check "a stale run writes no receipt" "absent" "$([ -e "$PF" ] && echo present || echo absent)"
check "a stale run with a prose answer retries the reviewer once" "2" "$(grep -c '^args:' "$CLAUDE_LOG")"
has "a stale run with a prose answer names the skipped skill" "$(cat "$TMP/err")" "reviewer answered without running ce-code-review (no run folder for HEAD $seed_head"
# An incomplete review.json is still refused with today's message and no retry:
# the folder exists. A printed incomplete report with no folder gets the retry.
rm -f "$PF"
: > "$CLAUDE_LOG"
STUB_OUT='{"status":"incomplete","actionable_findings":[]}' proof_run trunk; rc=$?
check "an incomplete print still exits 4" "4" "$rc"
check "an incomplete print writes no receipt" "absent" "$([ -e "$PF" ] && echo present || echo absent)"
has "an incomplete print names the skipped skill" "$(cat "$TMP/err")" "reviewer answered without running ce-code-review (no run folder for HEAD"
check "an incomplete print retries the reviewer once" "2" "$(grep -c '^args:' "$CLAUDE_LOG")"
rm -f "$PF"
: > "$CLAUDE_LOG"
STUB_OUT='{"status":"complete","actionable_findings":[]}' PROOF_CASE=incomplete-file proof_run trunk; rc=$?
check "an incomplete review.json is not used" "4" "$rc"
check "an incomplete review.json writes no receipt" "absent" "$([ -e "$PF" ] && echo present || echo absent)"
has "an incomplete review.json names the missing run" "$(cat "$TMP/err")" "no complete ce-code-review run for HEAD"
check "an incomplete review.json runs the reviewer once" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
# A refused run saves nothing for re-check: the print is complete, but the only
# searchable folder is for another branch (the fresh folder lands out of search).
rm -rf "$TMP/seed/ce-code-review"; mkdir -p "$TMP/seed/ce-code-review" "$TMP/fresh2/ce-code-review"
seed_run "$TMP/seed/ce-code-review" wrong-branch '{"status":"complete","actionable_findings":[]}'
rm -f "$PF"
REVIEW_FIXTURES="$TMP/fresh2/ce-code-review" REVIEW_UNIT_SCRATCH_ROOT="$TMP/seed" STUB_OUT='{"status":"complete","actionable_findings":[]}' proof_run trunk; rc=$?
check "a refused run still exits 4" "4" "$rc"
check "a refused run writes no receipt" "absent" "$([ -e "$PF" ] && echo present || echo absent)"
check "a refused run saves no re-check" "absent" "$([ -e "$RP/.git/ds-review-last-run" ] && echo present || echo absent)"
prior="$(cat "$PB")"
for bad in empty-list-labeled empty-selected-labeled empty-count-two empty-findings-filled empty-numbers-filled empty-selected-string empty-input-array empty-input-unreadable verdicts-missing-file verdicts-unparseable verdicts-null-path verdicts-outside verdicts-empty verdicts-wrong-type peer-offroster-failed peer-offroster-not-run peer-offroster-folded-missing peer-offroster-folded-unreported; do
  rm -f "$PF"
  PROOF_CASE="$bad" proof_run trunk; rc=$?
  check "$bad fails proof" "4" "$rc"
  check "$bad writes no receipt" "absent" "$([ -e "$PF" ] && echo present || echo absent)"
  check "$bad retains review base" "$prior" "$(cat "$PB")"
done
# (U228: the roster is parsed in process, so the old jq-fault cases have no jq call left to fail.)
for bad in swap-double-start swap-empty-dangling swap-no-dangling artifact-other-run wrong-scope-head missing-head-no-meta no-reviewers empty-roster missing-base wrong-base orphan-peer-mismatch orphan-peer-no-artifact orphan-dispatch-no-returns orphan-review-no-artifact orphan-review-empty-ts empty-no-input empty-selected verdicts-no-validate validator-infra-failure security-timeout security-bound security-silent security-fast-pass security-unrelated-peer security-prose-spoof learnings-unlisted learnings-missing-file learnings-empty-file learnings-wrong-file learnings-unreported learnings-cross-pair learnings-alias-empty learnings-alias-unreported agent-native-unlisted agent-native-missing-file agent-native-empty-file agent-native-outside-file agent-native-alias-outside agent-native-unreported structured-second-unreported folded-peer-unfolded folded-peer-wrong-provider folded-peer-missing-artifact folded-peer-unreported folded-peer-outside folded-peer-external-link folded-peer-lens-offroster folded-peer-lens-crossname folded-peer-lens-invalid-artifact roster-truncated roster-duplicate select-missing-count select-string-count abbrev-wrong-finish-head selected-blank selected-empty missing-failed-list null-failed-list string-failed-list missing-bound-list null-bound-list string-bound-list depth-mismatch metadata-head partial-cost missing-finish missing-validator malformed-log artifact-mismatch no-returns unselected-return unreported-return failed-returns bounded-returns missing-collection missing-returns malformed-returns wrong-finish-run wrong-finish-head focused-no-name focused-no-file focused-wrong-reviewer focused-no-findings focused-last-depth-mismatch focused-scope-full focused-scope-lite focused-mid-downgrade; do
  rm -f "$PF"
  PROOF_CASE="$bad" proof_run trunk; rc=$?
  check "$bad fails proof" "4" "$rc"
  check "$bad writes no receipt" "absent" "$([ -e "$PF" ] && echo present || echo absent)"
  check "$bad leaves the delta base unchanged" "$prior" "$(cat "$PB")"
  has "$bad names missing proof and skill copy" "$(cat "$TMP/err")" "ce-code-review"
  case "$bad" in
    focused-no-name|focused-no-file|focused-wrong-reviewer|focused-no-findings)
      has "$bad names missing adversarial result" "$(cat "$TMP/err")" "matching adversarial result file" ;;
    focused-last-depth-mismatch)
      has "$bad names the last depth" "$(cat "$TMP/err")" "last stage depth" ;;
    focused-scope-full|focused-scope-lite)
      has "$bad names the scope depth" "$(cat "$TMP/err")" "scope stage depth" ;;
    orphan-review-empty-ts)
      has "$bad names unsupported end-only review" "$(cat "$TMP/err")" "end-only stage without supporting artifact" ;;
    focused-mid-downgrade)
      has "$bad names the depth downgrade" "$(cat "$TMP/err")" "stage depth decreased" ;;
    validator-infra-failure)
      has "$bad names failed validation" "$(cat "$TMP/err")" "validator-outcome.json" ;;
    security-timeout|security-bound)
      has "$bad names failed collection" "$(cat "$TMP/err")" "failed or bound-exceeded reviewer" ;;
    folded-peer-lens-offroster)
      has "$bad names missing peer" "$(cat "$TMP/err")" "selected peer lacks a completed adversarial result" ;;
    security-silent|security-fast-pass|security-unrelated-peer|security-prose-spoof|learnings-unlisted|learnings-missing-file|learnings-empty-file|learnings-wrong-file|learnings-unreported|learnings-cross-pair|learnings-alias-empty|learnings-alias-unreported|agent-native-unlisted|agent-native-missing-file|agent-native-empty-file|agent-native-outside-file|agent-native-alias-outside|agent-native-unreported|structured-second-unreported|folded-peer-unfolded|folded-peer-wrong-provider|folded-peer-missing-artifact|folded-peer-unreported|folded-peer-outside|folded-peer-external-link|folded-peer-lens-crossname|folded-peer-lens-invalid-artifact|roster-truncated|roster-duplicate|select-missing-count|select-string-count|selected-blank|selected-empty)
      has "$bad names unaccounted selection" "$(cat "$TMP/err")" "selected reviewer lacks a completed return" ;;
    abbrev-wrong-finish-head)
      has "$bad names mismatched finish head" "$(cat "$TMP/err")" "finish-input.json" ;;
    missing-failed-list|null-failed-list|string-failed-list|missing-bound-list|null-bound-list|string-bound-list)
      has "$bad names malformed failure lists" "$(cat "$TMP/err")" "failed or bound-exceeded reviewer" ;;
  esac
done
for good in lite focused focused-contract focused-pending-depth full-mid-escalate base-ref orphan-end orphan-claude-peer orphan-unverified-peer orphan-dispatch orphan-review orphan-review-zero learnings-omission learnings-catalog learnings-alias-return learnings-alias-all deployment-prose agent-native-prose agent-native-reviewer-prose agent-native-alias-file agent-native-alias-return agent-native-alias-all folded-adversarial-bare folded-adversarial-alias folded-adversarial-provider folded-peer-internal-link folded-peer-lens-reported folded-peer-lens-alias roster-equal roster-peer-above abbrev-full-finish-head empty-no-validate; do
  PROOF_CASE="$good" PROOF_BASE_REF=trunk proof_run trunk; rc=$?
  check "$good proof succeeds" "0" "$rc"
done
# U250: what review-unit already knows from the run folder it found is filled in, with `repaired:` in the
# receipt and the log; a stage-log slip with the folder's output present passes with a note.
RLOG="$RP/.git/ds-review-log"
for pair in "missing-artifact:artifact_path" "artifact-null:artifact_path" "artifact-gone:artifact_path" "missing-run-id:run_id" "missing-head:scope.head_sha"; do
  c="${pair%%:*}"; f="${pair#*:}"
  rm -f "$PF"; : > "$RLOG"
  PROOF_CASE="$c" proof_run trunk; rc=$?
  check "$c is repaired: the proof passes" "0" "$rc"
  has   "$c: the receipt names the repair" "$(cat "$PF" 2>/dev/null)" "repaired=$f"
  has   "$c: the log names the repair" "$(cat "$RLOG")" "repaired: $f"
  has   "$c: stderr names the repair" "$(cat "$TMP/err")" "repaired: $f"
done
for slip in swap-last swap-start-only swap-end-start-end swap-other-dangling swap-one-ok-one-not lite-review-orphan dangling orphan-select orphan-merge orphan-report; do
  rm -f "$PF"; : > "$RLOG"
  PROOF_CASE="$slip" proof_run trunk; rc=$?
  check "$slip stage-log slip with the output present passes" "0" "$rc"
  has   "$slip: the log carries the stage-log note" "$(cat "$RLOG")" "stage log:"
  lacks "$slip: no repair is claimed" "$(cat "$PF" 2>/dev/null)" "repaired="
done
echo "review-unit-proof-run: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
