#!/usr/bin/env bash
# review-unit-base-merge.sh — part of the review-unit suite (U233): delta reviews after a merge from base, and after a main merge. The suite is split so no one CI job nears
# CI_TEST_TIMEOUT on a loaded host; the stubs and helpers are in tests/lib/review-unit-prelude.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/review-unit-prelude.sh"

# --- Merges from base keep delta reviews on the unit's changes ----------------------------------
REAL_GIT="$(command -v git)"; export REAL_GIT
cat > "$TMP/git" <<'GIT_STUB'
#!/usr/bin/env bash
if [ "${MERGE_TREE_FAIL:-0}" = 1 ] && [ "${1:-}" = merge-tree ]; then
  echo 'fixture: merge-tree unavailable' >&2; exit 128
fi
if [ "${UNIT_COMMITS_FAIL:-0}" = 1 ] && [ "${1:-}" = rev-list ]; then
  echo 'fixture: unit history unavailable' >&2; exit 128
fi
if [ "${MARKER_READ_FAIL:-0}" = 1 ] && [ "${1:-}" = --literal-pathspecs ] && [ "${2:-}" = grep ]; then
  echo 'fixture: conflict blob unreadable' >&2; exit 128
fi
if [ "${CONFLICT_COMPARE_FAIL:-0}" = 1 ] && [ "${1:-}" = --literal-pathspecs ] && [ "${2:-}" = diff ]; then
  echo 'fixture: conflict comparison unavailable' >&2; exit 128
fi
exec "$REAL_GIT" "$@"
GIT_STUB
chmod +x "$TMP/git"
merge_fixture() {
  RM="$TMP/merge-$1"; RFM="$RM/.git/ds-review"
  git init -q -b main "$RM"
  gm config user.name t; gm config user.email t@t
  if [ "${2:-}" = custom-driver ]; then
    echo 'unit.txt merge=keep' > "$RM/.gitattributes"
    gm config merge.keep.driver false
  fi
  echo original > "$RM/unit.txt"
  [ "${2:-}" != two-text ] || echo original > "$RM/another.txt"
  gm add -A; gm commit -qm base
  gm checkout -qb feature
  echo reviewed > "$RM/unit.txt"
  [ "${2:-}" != two-text ] || echo reviewed > "$RM/another.txt"
  gm commit -qam unit
  (cd "$RM" && "$RU" "$LBL" main) >/dev/null 2>&1
  reviewed="$(gm rev-parse HEAD)"
  gm checkout -q main
  echo 'authenticate user input and retry with backoff' > "$RM/base.txt"
  gm add -A; gm commit -qm 'base moves'
  gm checkout -q feature
  : > "$CLAUDE_LOG"
}
gm() { git -C "$RM" "$@"; }
merge_review() {
  (cd "$RM" && clear_last_run && REVIEW_SCOPE_LOG="$TMP/merge-scope.json" "$RU" "$LBL" main) > "$TMP/merge-report.json" 2> "$TMP/merge-err"
}
merge_fixture clean
gm merge -q --no-edit main
merge_review; rc=$?
check 'a clean base merge carries the receipt' 0 "$rc"
has 'a clean base merge is carried' "$(cat "$TMP/merge-err")" 'carried review'
check 'a clean base merge runs no reviewer' 0 "$(grep -c '^args:' "$CLAUDE_LOG")"
check 'a clean merge stamps HEAD' "$(gm rev-parse HEAD)" "$(cut -f1 "$RFM")"

merge_fixture own
gm merge -q --no-edit main
echo later > "$RM/later.txt"; gm add -A; gm commit -qm 'later unit change'
merge_review; rc=$?
check 'base merge plus unit commit completes a delta' 0 "$rc"
check 'base merge delta includes only the later unit file' '["later.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"
has 'base changes do not select conditional reviewers' "$(args)" 'Run only these reviewers: correctness.'
check 'the merge delta base has no parents' '' "$(jq -r .parents "$TMP/merge-scope.json")"
check 'the parentless base bypasses the skill merge-base' 1 "$(gm merge-base "$(jq -r .base "$TMP/merge-scope.json")" HEAD >/dev/null 2>&1; echo $?)"
check 'the synthetic base is held by a ref during review' true "$(jq '.refs | length > 0' "$TMP/merge-scope.json")"
check 'the synthetic base ref is released after review' '' "$(gm for-each-ref --format='%(refname)' --points-at "$(jq -r .base "$TMP/merge-scope.json")")"
check 'the proof accepts the exact synthetic scope base' "$(jq -r .base "$TMP/merge-scope.json")" "$(jq -r .scope.base "$TMP/merge-report.json")"
check 'the receipt keeps the original base ref' main "$(cut -f3 "$RFM")"

merge_fixture conflict
gm checkout -q main; echo upstream > "$RM/unit.txt"; gm commit -qam 'conflicting base change'; gm checkout -q feature
gm merge --no-edit main >/dev/null 2>&1; rc=$?
check 'fixture has a textual conflict' 1 "$rc"
echo resolved > "$RM/unit.txt"; gm add unit.txt; gm commit -qm 'resolve base merge'
merge_review; rc=$?
check 'a conflicted merge delta completes' 0 "$rc"
check 'a conflicted merge reviews only the resolution file' '["unit.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"
has 'the old side contains conflict markers' "$(jq -r .diff "$TMP/merge-scope.json")" '-<<<<<<<'
has 'the new side contains the chosen resolution' "$(jq -r .diff "$TMP/merge-scope.json")" '+resolved'
has 'the reviewer is told why conflict markers appear' "$(args)" 'conflict markers on the old side'

merge_fixture twice
gm merge -q --no-edit main
gm checkout -q main; echo newest > "$RM/new-base.txt"; gm add -A; gm commit -qm 'base moves again'; gm checkout -q feature
gm merge -q --no-edit main
echo later > "$RM/later.txt"; gm add -A; gm commit -qm 'later unit change'
merge_review; rc=$?
check 'two base merges still complete a delta' 0 "$rc"
check 'two merges exclude changes from both base tips' '["later.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"

merge_fixture failure
gm merge -q --no-edit main
MERGE_TREE_FAIL=1 merge_review; rc=$?
check 'merge-tree failure completes a full review' 0 "$rc"
has 'merge-tree failure falls back to full' "$(cat "$TMP/merge-err")" 'full review'
has 'merge-tree failure explains the fallback' "$(cat "$TMP/merge-err")" 'merge-tree'
has 'full fallback uses the original base' "$(args)" 'mode:agent base:main'

merge_fixture dirty
gm merge -q --no-edit main; echo dirty > "$RM/uncommitted.txt"
merge_review; rc=$?
check 'a dirty base merge cannot stamp a receipt' 4 "$rc"
check 'a dirty base merge runs a reviewer' 1 "$(grep -c '^args:' "$CLAUDE_LOG")"
lacks 'a dirty base merge is never carried' "$(cat "$TMP/merge-err")" 'carried review'

merge_fixture dirty-source
rm -f "$RFM" "$RM/.git/ds-review-base"
echo uncommitted > "$RM/unit.txt"
merge_review; rc=$?
check 'a dirty source review reports without a receipt' 4 "$rc"
check 'the dirty review base records clean=0' 0 "$(cut -f6 "$RM/.git/ds-review-base")"
gm restore unit.txt; gm merge -q --no-edit main
: > "$CLAUDE_LOG"; merge_review; rc=$?
check 'a clean merge after a dirty review completes a fresh review' 0 "$rc"
has 'a dirty previous review cannot be carried through a merge' "$(cat "$TMP/merge-err")" 'full review'
check 'a dirty previous review runs a reviewer after the merge' 1 "$(grep -c '^args:' "$CLAUDE_LOG")"

merge_fixture modify-delete
gm checkout -q main; gm rm -q unit.txt; gm commit -qm 'base deletes unit file'; gm checkout -q feature
gm merge --no-edit main >/dev/null 2>&1; rc=$?
check 'fixture has a modify-delete conflict' 1 "$rc"
gm add unit.txt; gm commit -qm 'resolve merge by keeping unit file'
expected="$(gm merge-tree --write-tree "$reviewed" "$(gm rev-parse main)")"; rc=$?
check 'the expected merge still reports a conflict' 1 "$rc"
check 'the chosen resolution matches the expected conflict tree' "${expected%%$'\n'*}" "$(gm rev-parse 'HEAD^{tree}')"
: > "$CLAUDE_LOG"; merge_review; rc=$?
check 'a resolution matching the conflict tree completes a fresh review' 0 "$rc"
has 'a conflict-bearing merge tree is never carried' "$(cat "$TMP/merge-err")" 'full review'
check 'a matching conflict tree runs a reviewer' 1 "$(grep -c '^args:' "$CLAUDE_LOG")"

merge_fixture absorbed
# Main absorbs a post-receipt unit commit before the feature catches up.
echo unreviewed > "$RM/absorbed.txt"; gm add absorbed.txt; gm commit -qm 'later unit change'
gm checkout -q main; gm merge -q --no-edit feature; gm checkout -q feature; gm merge -q --ff-only main
: > "$CLAUDE_LOG"; rm -f "$TMP/merge-scope.json"; merge_review; rc=$?
check 'a review of absorbed unit history completes' 0 "$rc"
check 'an absorbed unit commit is reviewed' 1 "$(grep -c '^args:' "$CLAUDE_LOG")"
check 'the absorbed unit file remains in review scope' '["absorbed.txt","base.txt"]' "$(jq -c .files "$TMP/merge-scope.json" 2>/dev/null)"

merge_fixture modify-delete-later
gm checkout -q main; gm rm -q unit.txt; gm commit -qm 'base deletes unit file'; gm checkout -q feature
gm merge --no-edit main >/dev/null 2>&1
gm add unit.txt; gm commit -qm 'resolve by keeping unit file'
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'later unit change'
merge_review; rc=$?
check 'a review of a marker-free resolution plus later change completes' 0 "$rc"
has 'a marker-free resolution plus later change runs full' "$(cat "$TMP/merge-err")" 'full review'
check 'the marker-free resolution stays in scope' '["later.txt","unit.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"

merge_fixture binary-later
gm checkout -q main; printf 'upstream\0binary\n' > "$RM/unit.txt"; gm commit -qam 'base makes unit file binary'; gm checkout -q feature
gm merge --no-edit main >/dev/null 2>&1
gm add unit.txt; gm commit -qm 'resolve by keeping unit file'
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'later unit change'
merge_review; rc=$?
check 'a review of a binary resolution plus later change completes' 0 "$rc"
has 'a binary resolution plus later change runs full' "$(cat "$TMP/merge-err")" 'full review'
check 'the binary resolution stays in scope' '["later.txt","unit.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"


merge_fixture cherry-absorbed
echo unreviewed > "$RM/absorbed.txt"; gm add absorbed.txt; gm commit -qm 'later unit change'
unit_later="$(gm rev-parse HEAD)"
gm checkout -q main; gm cherry-pick "$unit_later" >/dev/null
gm checkout -q feature; gm merge -q --no-edit main
: > "$CLAUDE_LOG"; rm -f "$TMP/merge-scope.json"; merge_review; rc=$?
check 'a cherry-absorbed unit commit review completes' 0 "$rc"
check 'a cherry-absorbed unit commit is reviewed' 1 "$(grep -c '^args:' "$CLAUDE_LOG")"
check 'a cherry-absorbed unit file stays in scope' '["absorbed.txt","base.txt"]' "$(jq -c .files "$TMP/merge-scope.json" 2>/dev/null)"

merge_fixture status-failure
gm merge -q --no-edit main
echo dirty > "$RM/uncommitted.txt"
printf invalid > "$TMP/bad-index"
GIT_INDEX_FILE="$TMP/bad-index" merge_review; rc=$?
check 'an unreadable index cannot issue a receipt' 4 "$rc"
check 'an unreadable index leaves no receipt' absent "$([ -f "$RFM" ] && echo present || echo absent)"
check 'an unreadable index cannot vouch for a clean review base' 0 "$(cut -f6 "$RM/.git/ds-review-base")"
lacks 'an unreadable index is never carried' "$(cat "$TMP/merge-err")" 'carried review'


merge_fixture cherry-partial
echo unreviewed > "$RM/absorbed.txt"; gm add absorbed.txt; gm commit -qm 'later unit change'
unit_later="$(gm rev-parse HEAD)"
gm checkout -q main; gm cherry-pick "$unit_later" >/dev/null; gm checkout -q feature; gm merge -q --no-edit main
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'another unit change'
: > "$CLAUDE_LOG"; merge_review; rc=$?
check 'a partially absorbed cherry review completes' 0 "$rc"
check 'a cherry absorption cannot hide beside another delta' '["absorbed.txt","base.txt","later.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"

merge_fixture squash-absorbed
for n in one two; do echo unreviewed > "$RM/absorbed-$n.txt"; gm add "absorbed-$n.txt"; gm commit -qm 'later unit change'; done
gm checkout -q main; gm merge -q --squash feature; gm commit -qm 'base squashes unit changes'; gm checkout -q feature; gm merge -q --no-edit main
: > "$CLAUDE_LOG"; rm -f "$TMP/merge-scope.json"; merge_review; rc=$?
check 'a squash-absorbed unit review completes' 0 "$rc"
check 'squash-absorbed unit commits are reviewed' 1 "$(grep -c '^args:' "$CLAUDE_LOG")"
check 'squash-absorbed unit files stay in scope' '["absorbed-one.txt","absorbed-two.txt","base.txt"]' "$(jq -c .files "$TMP/merge-scope.json" 2>/dev/null)"

merge_fixture history-failure
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'later unit change'
gm merge -q --no-edit main
UNIT_COMMITS_FAIL=1 merge_review; rc=$?
check 'failed unit-history enumeration still completes a review' 0 "$rc"
check 'failed unit-history enumeration keeps the plain delta' '["base.txt","later.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"
has 'failed unit-history enumeration explains the wider review' "$(cat "$TMP/merge-err")" 'could not identify post-review unit commits'

merge_fixture status-late
gm merge -q --no-edit main
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'later unit change'
cp "$RM/.git/index" "$TMP/review-index"
GIT_INDEX_FILE="$TMP/review-index" STUB_BAD_INDEX=1 merge_review; rc=$?
check 'a late status failure cannot issue a receipt' 4 "$rc"
check 'a late status failure leaves no receipt' absent "$([ -f "$RFM" ] && echo present || echo absent)"
check 'a late status failure cannot vouch for a clean review base' 0 "$(cut -f6 "$RM/.git/ds-review-base")"
check 'an unstamped merge delta releases its temporary ref' '' "$(gm for-each-ref --format='%(refname)' --points-at "$(jq -r .base "$TMP/merge-scope.json")")"


merge_fixture squash-partial
for n in one two; do echo "$n" >> "$RM/unit.txt"; gm commit -qam 'later unit change'; done
gm checkout -q main; gm merge -q --squash feature; gm commit -qm 'base squashes unit changes'; gm checkout -q feature; gm merge -q --no-edit main
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'another unit change'
merge_review; rc=$?
check 'a partially squash-absorbed review completes' 0 "$rc"
check 'squashed same-file work keeps the plain delta' '["base.txt","later.txt","unit.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"


merge_fixture squash-files-partial
for n in one two; do echo "$n" > "$RM/absorbed-$n.txt"; gm add "absorbed-$n.txt"; gm commit -qm 'later unit change'; done
gm checkout -q main; gm merge -q --squash feature; gm commit -qm 'base squashes unit changes'; gm checkout -q feature; gm merge -q --no-edit main
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'another unit change'
merge_review; rc=$?
check 'a partially squash-absorbed file review completes' 0 "$rc"
check 'squashed files cannot hide beside another delta' '["absorbed-one.txt","absorbed-two.txt","base.txt","later.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"

merge_fixture own-between-merges
gm merge -q --no-edit main
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'unit change between base merges'
gm checkout -q main; echo newest > "$RM/new-base.txt"; gm add new-base.txt; gm commit -qm 'base moves again'; gm checkout -q feature; gm merge -q --no-edit main
merge_review; rc=$?
check 'a unit change between base merges completes' 0 "$rc"
check 'a unit change between base merges narrows to the unit change' '["later.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"
check 'a between-merges delta base has no parents' '' "$(jq -r .parents "$TMP/merge-scope.json")"
has 'a narrowed between-merges delta names the expected merge' "$(cat "$TMP/merge-err")" 'against the expected merge with'

merge_fixture squash-tail
echo unabsorbed > "$RM/unabsorbed.txt"; gm add unabsorbed.txt; gm commit -qm 'uncopied unit change'
copied=()
for n in one two; do
  echo "$n" > "$RM/absorbed-$n.txt"; gm add "absorbed-$n.txt"; gm commit -qm 'unit change copied to base'
  copied+=("$(gm rev-parse HEAD)")
done
gm checkout -qb base-copy main; gm cherry-pick "${copied[@]}" >/dev/null
gm checkout -q main; gm merge -q --squash base-copy; gm commit -qm 'base squashes only the unit suffix'
gm checkout -q feature; gm merge -q --no-edit main
merge_review; rc=$?
check 'a squash-copied suffix beside uncopied work completes a review' 0 "$rc"
check 'uncopied work cannot hide a squash-copied suffix' '["absorbed-one.txt","absorbed-two.txt","base.txt","unabsorbed.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"
has 'an absorbed squash suffix explains the plain delta' "$(cat "$TMP/merge-err")" 'unit work absorbed by the base'

for later in no yes; do
  merge_fixture "merge-authored-$later"
  gm merge -q --no-commit --no-ff main
  echo unreviewed > "$RM/absorbed.txt"; gm add absorbed.txt; gm commit -qm 'add unit work while committing the base merge'
  edited_merge="$(gm rev-parse HEAD)"
  gm checkout -q main; gm cherry-pick -m 1 "$edited_merge" >/dev/null
  gm checkout -q feature; gm merge -q --no-edit main
  files='["absorbed.txt","base.txt"]'
  if [ "$later" = yes ]; then
    echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'later unit change'
    files='["absorbed.txt","base.txt","later.txt"]'
  fi
  : > "$CLAUDE_LOG"; rm -f "$TMP/merge-scope.json"; merge_review; rc=$?
  check "merge-authored work with later=$later completes a review" 0 "$rc"
  check "merge-authored work with later=$later runs a reviewer" 1 "$(grep -c '^args:' "$CLAUDE_LOG")"
  check "merge-authored work with later=$later stays in scope" "$files" "$(jq -c .files "$TMP/merge-scope.json" 2>/dev/null)"
  has "merge-authored work with later=$later explains the plain delta" "$(cat "$TMP/merge-err")" 'earlier merge content absorbed by the base'
done

merge_fixture two-clean-merges
gm merge -q --no-edit main
gm checkout -q main; echo newest > "$RM/new-base.txt"; gm add new-base.txt; gm commit -qm 'base moves again'; gm checkout -q feature; gm merge -q --no-edit main
: > "$CLAUDE_LOG"; merge_review; rc=$?
check 'two automatic base merges carry the review' 0 "$rc"
has 'two automatic base merges are carried' "$(cat "$TMP/merge-err")" 'carried review'
check 'two automatic base merges run no reviewer' 0 "$(grep -c '^args:' "$CLAUDE_LOG")"

merge_fixture automatic-merge-unverifiable
gm merge -q --no-edit main
gm checkout -q main; echo newest > "$RM/new-base.txt"; gm add new-base.txt; gm commit -qm 'base moves again'; gm checkout -q feature; gm merge -q --no-edit main
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'unit change after the latest base merge'
MERGE_TREE_FAIL=1 merge_review; rc=$?
check 'an unverifiable earlier merge still completes a review' 0 "$rc"
check 'an unverifiable earlier merge keeps all plain delta files' '["base.txt","later.txt","new-base.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"
has 'an unverifiable earlier merge explains the plain delta' "$(cat "$TMP/merge-err")" 'earlier merge cannot be proven automatic'

merge_fixture custom-marker-free custom-driver
gm checkout -q main; echo upstream > "$RM/unit.txt"; gm commit -qam 'base changes custom-driver file'; gm checkout -q feature
gm merge --no-edit main >/dev/null 2>&1; rc=$?
check 'a custom driver reports a conflict' 1 "$rc"
gm add unit.txt; gm commit -qm 'keep reviewed content after driver failure'
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'later unit change'
merge_review; rc=$?
check 'a marker-free custom conflict completes a full review' 0 "$rc"
has 'a custom conflict without verified markers falls back to full' "$(cat "$TMP/merge-err")" 'full review'
check 'a custom-driver resolution stays in scope' '["later.txt","unit.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"

merge_fixture marker-read-failure
gm checkout -q main; echo upstream > "$RM/unit.txt"; gm commit -qam 'conflicting base change'; gm checkout -q feature
gm merge --no-edit main >/dev/null 2>&1
echo resolved > "$RM/unit.txt"; gm add unit.txt; gm commit -qm 'resolve base merge'
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'later unit change'
MARKER_READ_FAIL=1 merge_review; rc=$?
check 'unverifiable conflict markers still complete a review' 0 "$rc"
has 'unverifiable conflict markers fall back to full' "$(cat "$TMP/merge-err")" 'full review'
check 'unverifiable conflict markers use the original base' "$(gm rev-parse main)" "$(jq -r .base "$TMP/merge-scope.json")"


# A committed merge-tree conflict blob must not disappear beside a separate delta.
merge_fixture unchanged-conflict
gm checkout -q main; echo upstream > "$RM/unit.txt"; gm commit -qam 'conflicting base change'; gm checkout -q feature
expected="$(gm merge-tree --write-tree --name-only "$reviewed" "$(gm rev-parse main)" 2>/dev/null)"; rc=$?
check 'expected unresolved marker fixture has a content conflict' 1 "$rc"
gm merge --no-edit main >/dev/null 2>&1
gm show "${expected%%$'\n'*}:unit.txt" > "$RM/unit.txt"
gm add unit.txt; gm commit -qm 'commit generated conflict blob'
check 'committed conflict blob matches the expected markers' "$(gm rev-parse "${expected%%$'\n'*}:unit.txt")" "$(gm rev-parse HEAD:unit.txt)"
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'later unit change'
merge_review; rc=$?
check 'unchanged conflict plus later change completes a review' 0 "$rc"
has 'an unchanged conflict beside another delta forces full review' "$(cat "$TMP/merge-err")" 'full review'
check 'unchanged conflicts remain in scope beside later changes' '["later.txt","unit.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"
has 'the committed conflict markers remain visible to review' "$(jq -r .diff "$TMP/merge-scope.json")" '+<<<<<<<'

merge_fixture partly-resolved two-text
gm checkout -q main
printf 'upstream\n' > "$RM/unit.txt"; printf 'upstream\n' > "$RM/another.txt"
gm commit -qam 'two conflicting base changes'; gm checkout -q feature
expected="$(gm merge-tree --write-tree --name-only "$reviewed" "$(gm rev-parse main)" 2>/dev/null)"
gm merge --no-edit main >/dev/null 2>&1
gm show "${expected%%$'\n'*}:unit.txt" > "$RM/unit.txt"
echo resolved > "$RM/another.txt"; gm add -A; gm commit -qm 'resolve one conflict only'
merge_review; rc=$?
check 'a partly resolved conflict merge completes a review' 0 "$rc"
has 'one untouched conflict forces full despite another resolution' "$(cat "$TMP/merge-err")" 'full review'
check 'both conflict paths remain in the full review' '["another.txt","unit.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"

merge_fixture conflict-compare-failure
gm checkout -q main; echo upstream > "$RM/unit.txt"; gm commit -qam 'conflicting base change'; gm checkout -q feature
gm merge --no-edit main >/dev/null 2>&1
echo resolved > "$RM/unit.txt"; gm add unit.txt; gm commit -qm 'resolve base merge'
CONFLICT_COMPARE_FAIL=1 merge_review; rc=$?
check 'unverifiable conflict comparison completes a review' 0 "$rc"
has 'unverifiable conflict comparison forces full review' "$(cat "$TMP/merge-err")" 'full review'
check 'unverifiable conflict comparison uses the original base' "$(gm rev-parse main)" "$(jq -r .base "$TMP/merge-scope.json")"

# --- U196: a delta after a main merge reviews only the unit's own work ---------------------------
# An earlier main merge resolved by hand no longer forces the plain delta: the delta base
# is the expected merge, and the diff holds the unit commit plus the resolved lines.
merge_fixture hand-resolved-earlier
gm checkout -q main; echo upstream > "$RM/unit.txt"; gm commit -qam 'conflicting base change'; gm checkout -q feature
gm merge --no-edit main >/dev/null 2>&1; rc=$?
check 'U196 fixture: the earlier merge conflicts' 1 "$rc"
echo resolved > "$RM/unit.txt"; gm add unit.txt; gm commit -qm 'resolve base merge by hand'
gm checkout -q main; echo newest > "$RM/new-base.txt"; gm add new-base.txt; gm commit -qm 'base moves again'; gm checkout -q feature
gm merge -q --no-edit main
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'later unit change'
: > "$CLAUDE_LOG"; rm -f "$TMP/merge-scope.json"; merge_review; rc=$?
check 'U196: a hand-resolved earlier merge still completes a delta' 0 "$rc"
check 'U196: the delta holds the unit commit and the resolution only' '["later.txt","unit.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"
check 'U196: the delta base has no parents' '' "$(jq -r .parents "$TMP/merge-scope.json")"
has 'U196: the diff shows the later unit change' "$(jq -r .diff "$TMP/merge-scope.json")" '+later'
has 'U196: the diff shows the chosen resolution' "$(jq -r .diff "$TMP/merge-scope.json")" '+resolved'
lacks 'U196: no main-only file in the delta' "$(jq -c .files "$TMP/merge-scope.json")" 'base.txt'
lacks 'U196: no second base file in the delta' "$(jq -c .files "$TMP/merge-scope.json")" 'new-base.txt'
has 'U196: the start line names the expected merge' "$(cat "$TMP/merge-err")" 'against the expected merge with'
has 'U196: the log names the expected merge' "$(tail -1 "$RM/.git/ds-review-log")" 'against the expected merge with'

# The same, with the unit commit between the two merges: still the expected-merge base.
merge_fixture hand-resolved-unit-between
gm merge -q --no-edit main
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'unit change between base merges'
gm checkout -q main; echo upstream > "$RM/unit.txt"; gm commit -qam 'conflicting base change'; gm checkout -q feature
gm merge --no-edit main >/dev/null 2>&1; rc=$?
check 'U196 fixture: the later merge conflicts' 1 "$rc"
echo resolved > "$RM/unit.txt"; gm add unit.txt; gm commit -qm 'resolve base merge by hand'
: > "$CLAUDE_LOG"; rm -f "$TMP/merge-scope.json"; merge_review; rc=$?
check 'U196: a unit commit between merges still completes a delta' 0 "$rc"
check 'U196: the delta holds the between-merges change and the resolution' '["later.txt","unit.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"
check 'U196: the between-merges delta base has no parents' '' "$(jq -r .parents "$TMP/merge-scope.json")"
has 'U196: the between-merges start line names the expected merge' "$(cat "$TMP/merge-err")" 'against the expected merge with'

# A hand resolution that also changes a unit line outside the conflict shows in the diff.
merge_fixture hand-resolved-extra-unit-line
gm checkout -q main; echo upstream > "$RM/unit.txt"; gm commit -qam 'conflicting base change'; gm checkout -q feature
gm merge --no-edit main >/dev/null 2>&1
echo resolved > "$RM/unit.txt"; echo tweak > "$RM/tweak.txt"; gm add -A; gm commit -qm 'resolve and add a unit line outside the conflict'
gm checkout -q main; echo newest > "$RM/new-base.txt"; gm add new-base.txt; gm commit -qm 'base moves again'; gm checkout -q feature
gm merge -q --no-edit main
: > "$CLAUDE_LOG"; rm -f "$TMP/merge-scope.json"; merge_review; rc=$?
check 'U196: a resolution with an extra unit line still completes a delta' 0 "$rc"
check 'U196: the extra unit line shows in the diff' '["tweak.txt","unit.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"
has 'U196: the diff shows the outside-the-conflict unit line' "$(jq -r .diff "$TMP/merge-scope.json")" '+tweak'

# A case that still falls back (the base absorbed a unit commit): the preamble lists the
# unit's files, and a plain delta over review_delta_wide_lines runs as delta-wide.
merge_fixture absorbed-fallback-wide
echo unreviewed > "$RM/absorbed.txt"; gm add absorbed.txt; gm commit -qm 'later unit change'
unit_later="$(gm rev-parse HEAD)"
gm checkout -q main; gm cherry-pick "$unit_later" >/dev/null; gm checkout -q feature; gm merge -q --no-edit main
echo later > "$RM/later.txt"; gm add later.txt; gm commit -qm 'another unit change'
: > "$CLAUDE_LOG"; rm -f "$TMP/merge-scope.json"; DS_LIMIT_REVIEW_DELTA_WIDE_LINES=1 merge_review; rc=$?
check 'U196: an absorbed fallback still completes a review' 0 "$rc"
check 'U196: the fallback keeps the plain delta files' '["absorbed.txt","base.txt","later.txt"]' "$(jq -c .files "$TMP/merge-scope.json")"
has 'U196: a plain delta over the threshold is wide' "$(cat "$TMP/merge-err")" 'delta-wide'
has 'U196: the wide start line names the plain delta reason' "$(cat "$TMP/merge-err")" 'plain delta (unit work absorbed by the base)'
has 'U196: the wide log names the plain delta reason' "$(tail -1 "$RM/.git/ds-review-log")" 'plain delta (unit work absorbed by the base)'
has 'U196: the preamble scopes the review to the unit files' "$(args)" 'Review only the changes to these unit files: later.txt'
has 'U196: the preamble names the base change as reviewed' "$(args)" "Every other file in the diff is the base's change and was reviewed there"

echo "review-unit-base-merge: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
