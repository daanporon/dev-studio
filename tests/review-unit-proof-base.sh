#!/usr/bin/env bash
# review-unit-proof-base.sh — part of the review-unit suite (U233): the proof checks on the base ref and its annotations. The suite is split so no one CI job nears
# CI_TEST_TIMEOUT on a loaded host; the stubs and helpers are in tests/lib/review-unit-prelude.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/review-unit-prelude.sh"
. "$ROOT/tests/lib/review-unit-proof-repo.sh"

# U219: one stage logged end then start still earns the receipt, and says so.
rm -f "$PF"
PROOF_CASE=swap-merge PROOF_BASE_REF=trunk proof_run trunk; rc=$?
check "a swapped merge end/start proof succeeds" "0" "$rc"
check "a swapped merge end/start writes the receipt" "present" "$([ -e "$PF" ] && echo present || echo absent)"
has "a swapped merge end/start names the stage" "$(cat "$TMP/err")" "stage log: merge end/start swapped (skill log order), accepted"
has "a swapped merge end/start is in the review log" "$(cat "$RP/.git/ds-review-log")" "stage log: merge end/start swapped"
# A moved base can be reported as its ref tip or the older merge-base SHA.
gp checkout -q trunk; echo moved > "$RP/base-only"; gp add base-only; gp commit -q -m 'base advances'
gp checkout -q feature
proof_run trunk; rc=$?
check "a merge-base SHA resolves a moved requested base" "0" "$rc"
PROOF_CASE=base-ref PROOF_BASE_REF=trunk proof_run trunk; rc=$?
check "a ref tip resolves a moved requested base" "0" "$rc"
PROOF_CASE=base-ref PROOF_BASE_REF=feature proof_run trunk; rc=$?
check "a ref resolving to the wrong commit refuses" "4" "$rc"
# The skill's annotated form "<sha> (merge-base of HEAD and trunk)" (the U144 run) is the sha alone.
mbase="$(gp merge-base trunk HEAD)"
PROOF_CASE=base-ref PROOF_BASE_REF="$mbase" PROOF_BASE_NOTE=" (merge-base of HEAD and trunk)" proof_run trunk; rc=$?
check "an annotated merge-base sha writes a receipt" "0" "$rc"
PROOF_CASE=base-ref PROOF_BASE_REF="$(gp rev-parse trunk)" PROOF_BASE_NOTE=" (tip of trunk)" proof_run trunk; rc=$?
check "an annotated ref tip writes a receipt" "0" "$rc"
PROOF_CASE=base-ref PROOF_BASE_REF="$(gp rev-parse HEAD)" PROOF_BASE_NOTE=" (merge-base of HEAD and trunk)" proof_run trunk; rc=$?
check "an annotated sha that is neither tip nor merge base refuses" "4" "$rc"
PROOF_CASE=base-ref PROOF_BASE_REF="$mbase" PROOF_BASE_NOTE=" and more" proof_run trunk; rc=$?
check "a sha with trailing prose that is not a parenthetical refuses" "4" "$rc"
# U198: the skill's reversed annotation "<ref> (<sha>)" (the U184 run) reads as the sha.
PROOF_CASE=base-ref PROOF_BASE_REF="origin/main" PROOF_BASE_NOTE=" ($mbase)" proof_run trunk; rc=$?
check "a reversed annotated base writes a receipt" "0" "$rc"
PROOF_CASE=base-ref PROOF_BASE_REF="origin/main" PROOF_BASE_NOTE=" ($(gp rev-parse HEAD))" proof_run trunk; rc=$?
check "a reversed annotated wrong sha refuses" "4" "$rc"
has "a reversed annotated wrong sha names the mismatch" "$(cat "$TMP/err")" "does not match requested base"
PROOF_CASE=base-ref PROOF_BASE_REF="origin/main" PROOF_BASE_NOTE="" proof_run trunk; rc=$?
check "a bare ref without a sha refuses" "4" "$rc"
has "a bare ref names its unverifiable base" "$(cat "$TMP/err")" "origin/main' base-unverifiable"
# U201: a worded note around the sha reads as that sha (the U200 run: "origin/main (merge-base <sha>)").
PROOF_CASE=base-ref PROOF_BASE_REF="origin/main" PROOF_BASE_NOTE=" (merge-base $mbase)" proof_run trunk; rc=$?
check "U201: a worded note around the sha writes a receipt" "0" "$rc"
PROOF_CASE=base-ref PROOF_BASE_REF="origin/main" PROOF_BASE_NOTE=" ($mbase, merge-base)" proof_run trunk; rc=$?
check "U201: a sha then a word in the note writes a receipt" "0" "$rc"
PROOF_CASE=base-ref PROOF_BASE_REF="origin/main" PROOF_BASE_NOTE=" (merge-base $(gp rev-parse HEAD))" proof_run trunk; rc=$?
check "U201: a worded note with the wrong sha refuses" "4" "$rc"
has "U201: ...naming the mismatch" "$(cat "$TMP/err")" "does not match requested base"
PROOF_CASE=base-ref PROOF_BASE_REF="origin/main" PROOF_BASE_NOTE=" (merge-base)" proof_run trunk; rc=$?
check "U201: a worded note with no sha refuses" "4" "$rc"
has "U201: ...as unverifiable" "$(cat "$TMP/err")" "base-unverifiable"
PROOF_CASE=base-ref PROOF_BASE_REF="origin/main" PROOF_BASE_NOTE=" ($mbase, $(gp rev-parse HEAD))" proof_run trunk; rc=$?
check "U201: a note with two different shas refuses" "4" "$rc"
has "U201: ...as unverifiable" "$(cat "$TMP/err")" "base-unverifiable"
# U198: run files may name HEAD by a short sha (the U184 run wrote 7 characters in
# metadata.json and finish-input.json). A short sha of another commit is not this run.
rm -f "$PF"
PROOF_CASE=short-run-sha proof_run trunk; rc=$?
check "a short run sha writes a receipt" "0" "$rc"
check "a short run sha records the full HEAD" "$(gp rev-parse HEAD)" "$(cut -f1 "$PF" 2>/dev/null)"
rm -f "$PF"
PROOF_CASE=wrong-short-run-sha proof_run trunk; rc=$?
check "a short sha of another commit is not used" "4" "$rc"
check "a short sha of another commit writes no receipt" "absent" "$([ -e "$PF" ] && echo present || echo absent)"
has "a short sha of another commit names the missing run" "$(cat "$TMP/err")" "no complete ce-code-review run for HEAD"
# U198: a selected peer that ran with no usable output is the skipped peer, not a failure.
rm -f "$PF"
el_before="$([ -f "$SD/review-proof-errors.log" ] && awk 'END{print NR}' "$SD/review-proof-errors.log" || echo 0)"
PROOF_CASE=peer-offroster-no-output proof_run trunk; rc=$?
check "U198: a peer with no usable output still gets a receipt" "0" "$rc"
check "U198: ...with proof=1" "proof=1" "$(cut -f6 "$PF")"
check "U198: ...and no proof-error line" "$el_before" "$([ -f "$SD/review-proof-errors.log" ] && awk 'END{print NR}' "$SD/review-proof-errors.log" || echo 0)"
has   "U198: ...carrying the coverage note" "$(tail -1 "$RP/.git/ds-review-log")" "cross-model peer ran with no usable output (codex)"
has   "U198: ...and stderr says so as info, not an error" "$(cat "$TMP/err")" "review-unit: info: cross-model peer ran with no usable output (codex)"
# No requested base still requires a present scope.base, without resolving its value.
PROOF_CASE=unknown-base proof_run; rc=$?
check "no requested base accepts a present opaque base" "0" "$rc"
PROOF_CASE=missing-base proof_run; rc=$?
check "no requested base rejects missing scope.base" "4" "$rc"
# A PR marker must resolve through a local pull-merge ref for this HEAD.
PROOF_CASE=pr-marker proof_run trunk; rc=$?
check "a missing pull merge ref refuses a PR marker" "4" "$rc"
has "a missing pull ref names its unverifiable base" "$(cat "$TMP/err")" "pr:17' base-unverifiable"
merge="$(gp commit-tree 'HEAD^{tree}' -p trunk -p HEAD -m 'PR merge evidence')"
gp update-ref refs/pull/17/merge "$merge"
PROOF_CASE=pr-marker proof_run trunk; rc=$?
check "a local PR merge ref resolves the matching base" "0" "$rc"
foreign="$(gp commit-tree 'HEAD^{tree}' -p trunk -m 'foreign HEAD')"
other="$(gp commit-tree 'HEAD^{tree}' -p trunk -p "$foreign" -m 'foreign PR')"
gp update-ref refs/pull/17/merge "$other"
PROOF_CASE=pr-marker proof_run trunk; rc=$?
check "a pull ref for another HEAD refuses" "4" "$rc"
# A PR merge ref for HEAD with the wrong base refuses as well.
wrongbase="$(gp commit-tree 'trunk^{tree}' -p trunk -m 'different base')"
other="$(gp commit-tree 'HEAD^{tree}' -p "$wrongbase" -p HEAD -m 'wrong PR base')"
gp update-ref refs/pull/17/merge "$other"
PROOF_CASE=pr-marker proof_run trunk; rc=$?
check "a pull ref with the wrong base refuses" "4" "$rc"
gp update-ref -d refs/pull/17/merge
# Legacy receipts survive a failed replacement unchanged.
proof_run trunk; cut -f1-5 "$PF" > "$TMP/legacy"; cp "$TMP/legacy" "$PF"
PROOF_CASE=missing-base proof_run trunk; rc=$?
check "a failed replacement preserves the legacy receipt" "$(cat "$TMP/legacy")" "$(cat "$PF")"
# A legacy base survives failed proof byte for byte and forces full on the next fix.
proof_run trunk
cut -f1-6 "$PB" > "$TMP/legacy"; cp "$TMP/legacy" "$PB"; rm -f "$PF"
echo fix >> "$RP/file"; gp commit -q -am fix
PROOF_CASE=missing-base proof_run trunk; rc=$?
has "a legacy delta base forces a full review" "$(cat "$TMP/err")" "full review"
check "a failed run leaves legacy base unchanged" "$(cat "$TMP/legacy")" "$(cat "$PB")"
proof_run trunk
# Wrong delta base cannot advance a proven base.
prior="$(cat "$PB")"; echo fix2 >> "$RP/file"; gp commit -q -am fix2
PROOF_CASE=wrong-base proof_run trunk; rc=$?
check "a wrong delta scope.base fails" "4" "$rc"
has "the wrong delta was attempted from proof" "$(cat "$TMP/err")" "delta ("
check "a failed delta proof leaves the base unchanged" "$prior" "$(cat "$PB")"
# Legacy receipts cannot be carried across a base-only rebase.
proof_run trunk; cut -f1-5 "$PF" > "$TMP/legacy"; cp "$TMP/legacy" "$PF"
gp checkout -q trunk; echo advance > "$RP/other"; gp add other; gp commit -q -m advance
gp checkout -q feature; gp rebase -q trunk
: > "$CLAUDE_LOG"; proof_run trunk; rc=$?
check "a legacy carried candidate runs a fresh review" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
has "a legacy carried candidate is full" "$(cat "$TMP/err")" "full review"
# Preamble rules remain identical for all engines and delta calls.
for engine in claude codex muse; do
  if [ "$engine" = muse ]; then
    # U267: a project roster overrides per role, so each one below sets builder-review-standard to its
    # builder-review row too (sed), or an untiered unit would review on the default's standard row.
    printf 'builder-review claude opus elevate - muse:muse-spark-1.3\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
    STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" proof_run trunk
    log="$MUSE_LOG"
  else
    printf 'builder-review %s opus elevate\n' "$engine" | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
    proof_run trunk
    if [ "$engine" = claude ]; then log="$CLAUDE_LOG"; else log="$CODEX_LOG"; fi
  fi
  prompt="$(grep '^args:' "$log" | tail -1)"
  has "$engine allows internal reviewers" "$prompt" "Run the skill's own reviewers, validator and cross-model job"
  has "$engine runs the skill whatever the diff" "$prompt" "Run the ce-code-review skill end to end, whatever the size of the diff"
  has "$engine never replaces the skill run" "$prompt" "it never replaces the skill run"
  has "$engine rejects a review without the run folder" "$prompt" "A review written without the skill's run folder is rejected"
  has "$engine permits temp evidence" "$prompt" "temp run directory"
  has "$engine forbids project edits" "$prompt" "Do not edit project files, commit or push"
  has "$engine forbids outside messages" "$prompt" "Do not post to GitHub, Slack or any squad member"
  echo delta >> "$RP/file"; gp commit -q -am delta
  if [ "$engine" = muse ]; then STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" proof_run trunk
  else proof_run trunk; fi
  prompt="$(grep '^args:' "$log" | tail -1)"
  has "$engine delta preserves internal workflow permission" "$prompt" "Run the skill's own reviewers, validator and cross-model job"
  has "$engine delta keeps the delta scope" "$prompt" "DELTA re-review"
  has "$engine delta still requires the skill run" "$prompt" "Run the ce-code-review skill end to end, whatever the size of the diff"
done

echo "review-unit-proof-base: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
