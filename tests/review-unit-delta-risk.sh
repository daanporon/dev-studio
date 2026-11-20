#!/usr/bin/env bash
# review-unit-delta-risk.sh — part of the review-unit suite (U233): one full review per PR, deltas after, and risk paths. The suite is split so no one CI job nears
# CI_TEST_TIMEOUT on a loaded host; the stubs and helpers are in tests/lib/review-unit-prelude.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/review-unit-prelude.sh"
. "$ROOT/tests/lib/review-unit-proof-repo.sh"

# --- U138: one full review per PR, deltas after, more depth only where the risk is ----------------
# U267: a project roster overrides per role, so each one below sets builder-review-standard to its
# builder-review row too (sed), or an untiered unit would review on the default's standard row.
printf 'builder-review claude opus elevate\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
RQ="$TMP/policy"; RFQ="$RQ/.git/ds-review"; RBQ="$RQ/.git/ds-review-base"; LOGQ="$RQ/.git/ds-review-log"
gq() { git -C "$RQ" -c user.email=t@t -c user.name=t "$@"; }
runq() { (cd "$RQ" && clear_last_run && "$RU" "$@") 2>"$TMP/q.err" >"$TMP/q.out"; }
qerr() { cat "$TMP/q.err"; }
loglines() { if [ -f "$LOGQ" ]; then wc -l < "$LOGQ" | tr -d ' '; else echo 0; fi; }
lastlog() { tail -1 "$LOGQ" 2>/dev/null; }
logf() { lastlog | cut -f"$1"; }
qcommit() { mkdir -p "$RQ/$(dirname "$1")"; printf '%s\n' "$2" >> "$RQ/$1"; gq add -A; gq commit -q -m "$3"; }
git init -q -b main "$RQ"; echo base > "$RQ/base.txt"; echo unit > "$RQ/unit.txt"
gq add -A; gq commit -q -m base; gq update-ref refs/remotes/origin/main main
gq checkout -q -b feat; echo one > "$RQ/unit.txt"; gq commit -q -am "unit v1"

# A first review is full, and logs one six-field line saying why.
: > "$CLAUDE_LOG"; runq "$LBL" origin/main; rc=$?
check "policy: the first review completes"          0 "$rc"
has   "policy: the first review is full"            "$(qerr)" "review-unit: full review (no usable previous review"
check "policy: the first run writes one log line"   1 "$(loglines)"
check "policy: a log line has six tab fields"       6 "$(lastlog | awk -F'\t' '{print NF}')"
case "$(logf 1)" in ''|*[!0-9]*) fail=$((fail+1)); echo "FAIL: policy: log epoch is not numeric [$(logf 1)]" >&2 ;; *) pass=$((pass+1)) ;; esac
check "policy: the log names the reviewed HEAD"     "$(gq rev-parse HEAD)" "$(logf 2)"
check "policy: the log says full"                   full "$(logf 3)"
has   "policy: the log says why it ran full"        "$(logf 4)" "no usable previous review"
check "policy: a full log lists the report's lenses" "correctness,adversarial" "$(logf 5)"
check "policy: the log names the engine"            "claude:opus leaf=sonnet" "$(logf 6)"
check "policy: the receipt keeps six fields"        "6:proof=1" "$(awk -F'\t' '{print NF ":" $6}' "$RFQ")"
check "policy: ds-review-base keeps seven fields"   "7:proof=1" "$(awk -F'\t' '{print NF ":" $7}' "$RBQ")"

# A fix commit after the full review is a delta, logged with its lenses.
qcommit unit.txt two "fix"
: > "$CLAUDE_LOG"; runq "$LBL" origin/main
has   "policy: a fix commit is a delta"             "$(qerr)" "review-unit: delta (correctness) review"
check "policy: the delta writes one more log line"  2 "$(loglines)"
check "policy: the log says delta"                  delta "$(logf 3)"
has   "policy: the delta reason names the previous review" "$(logf 4)" "since"
check "policy: the delta log lists its lenses"      correctness "$(logf 5)"
check "policy: the delta receipt keeps six fields"  "6:proof=1" "$(awk -F'\t' '{print NF ":" $6}' "$RFQ")"

# origin/main then the sha of the same commit is the same base: still a delta.
qcommit unit.txt three "fix 2"
: > "$CLAUDE_LOG"; runq "$LBL" "$(gq rev-parse origin/main)"
has   "policy: a ref then its sha is still a delta" "$(qerr)" "review-unit: delta (correctness) review"
lacks "policy: ...not a base-ref change"            "$(qerr)" "base-ref changed"
qcommit unit.txt four "fix 3"
: > "$CLAUDE_LOG"; runq "$LBL" origin/main
has   "policy: a sha then the ref is still a delta" "$(qerr)" "review-unit: delta (correctness) review"

# A base that really moved, with the unit's patch changed, is full.
gq checkout -q main; echo base-edit > "$RQ/unit.txt"; gq commit -q -am "base edits unit"; gq checkout -q feat
gq rebase main >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6; do
  [ -d "$RQ/.git/rebase-merge" ] || break
  echo resolved > "$RQ/unit.txt"; gq add -A; GIT_EDITOR=true gq rebase --continue >/dev/null 2>&1 || true
done
check "policy fixture: the rebase finished"         feat "$(gq rev-parse --abbrev-ref HEAD)"
: > "$CLAUDE_LOG"; runq "$LBL" "$(gq rev-parse main)"
has   "policy: a moved base with a changed patch is full" "$(qerr)" "review-unit: full review"
check "policy: ...and logs full"                    full "$(logf 3)"

# A stored base that no longer resolves is full.
qcommit unit.txt five "fix 4"
awk -F'\t' 'BEGIN{OFS="\t"} {$3="refs/heads/gone-base"; print}' "$RFQ" > "$RFQ.tmp" && mv "$RFQ.tmp" "$RFQ"
: > "$CLAUDE_LOG"; runq "$LBL" main
has   "policy: an unresolvable stored base is full" "$(qerr)" "review-unit: full review"
has   "policy: ...and says the base no longer resolves" "$(qerr)" "no longer resolves"

# U176: a delta over review_delta_wide_lines is wide, not full; test lines do not count.
gq update-ref refs/remotes/origin/main main
runq "$LBL" origin/main
qcommit tests/big.sh "$(seq 1 30)" "test lines only"
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_DELTA_WIDE_LINES=10 runq "$LBL" origin/main
has   "policy: test lines leave a delta a delta"    "$(qerr)" "review-unit: delta (correctness) review"
qcommit src/big.sh "$(seq 1 30)" "thirty code lines"
wide_base="$(cut -f1 "$RFQ")"
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_DELTA_WIDE_LINES=10 runq "$LBL" origin/main
has   "policy: a delta over the line threshold is wide" "$(qerr)" "review-unit: delta-wide"
lacks "policy: ...not a full review"               "$(qerr)" "review-unit: full review"
has   "policy: ...against the last receipt, not the base" "$(args)" "mode:agent base:$wide_base"
has   "policy: ...with the full reviewer set in the prompt" "$(args)" "full reviewer set"
lacks "policy: ...not narrowed to correctness"     "$(args)" "Run only these reviewers: correctness."
check "policy: ...logged as delta-wide"             delta-wide "$(logf 3)"
has   "policy: ...with the line count"              "$(logf 4)" "30 lines, over review_delta_wide_lines 10"
check "policy: the wide log lists what ran"         "correctness,adversarial" "$(logf 5)"
check "policy: a wide delta keeps the receipt format" "6:proof=1" "$(awk -F'\t' '{print NF ":" $6}' "$RFQ")"
check "policy: ...and stamps HEAD"                  "$(gq rev-parse HEAD)" "$(cut -f1 "$RFQ")"
# The legacy threshold name still widens when the new one is unset; the new one wins.
qcommit src/big.sh "$(seq 1 30)" "thirty more for the legacy name"
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_DELTA_FULL_LINES=10 runq "$LBL" origin/main
has   "policy: the legacy threshold name still widens" "$(qerr)" "review-unit: delta-wide"
has   "policy: ...naming the legacy key"           "$(logf 4)" "over review_delta_full_lines 10"
qcommit src/big.sh "$(seq 1 30)" "thirty more, new name wins"
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_DELTA_WIDE_LINES=10000 DS_LIMIT_REVIEW_DELTA_FULL_LINES=10 runq "$LBL" origin/main
has   "policy: the new name wins over the legacy one" "$(qerr)" "review-unit: delta (correctness) review"
qcommit src/big.sh "$(seq 1 30)" "thirty more"
: > "$CLAUDE_LOG"; runq "$LBL" origin/main
has   "policy: under the default 400 it stays a delta" "$(qerr)" "review-unit: delta (correctness) review"

# U176: one full review, then deltas of any size. No receipt still gets its first full review.
rm -f "$RFQ" "$RBQ"
qcommit src/u176a.sh "$(seq 1 5)" "u176 first unit commit"
: > "$CLAUDE_LOG"; runq "$LBL" origin/main
has   "u176: no receipt still gets its first full review" "$(qerr)" "review-unit: full review"
qcommit src/u176big.sh "$(seq 1 1000)" "a thousand code lines"
u176_base="$(cut -f1 "$RFQ")"
: > "$CLAUDE_LOG"; runq "$LBL" origin/main
has   "u176: a 1,000-line delta after a receipt is wide" "$(qerr)" "review-unit: delta-wide"
lacks "u176: ...not a full review"                  "$(qerr)" "review-unit: full review"
has   "u176: ...against the last receipt"           "$(args)" "mode:agent base:$u176_base"
has   "u176: ...with the full reviewer set"         "$(args)" "full reviewer set"
lacks "u176: ...not narrowed to correctness"        "$(args)" "Run only these reviewers: correctness."
check "u176: ...logged as delta-wide"               delta-wide "$(logf 3)"
has   "u176: ...with the line count"                "$(logf 4)" "1000 lines, over review_delta_wide_lines 400"
qcommit src/u176small.sh "$(seq 1 50)" "fifty code lines"
: > "$CLAUDE_LOG"; runq "$LBL" origin/main
has   "u176: a 50-line delta stays correctness-only" "$(qerr)" "review-unit: delta (correctness) review"
qcommit src/u176big2.sh "$(seq 1 500)" "five hundred lines"
: > "$CLAUDE_LOG"; runq "$LBL" origin/main --full "named risk on a wide delta"
has   "u176: --full on a wide delta is still full" "$(qerr)" "review-unit: full review (--full: named risk on a wide delta)"
has   "u176: ...and asks for depth:full"            "$(args)" "mode:agent depth:full base:origin/main"
qcommit src/u176risk.sh "$(seq 1 500)" "five hundred lines plus a risk file"
qcommit contracts/u176.sol "own" "u176 risk path"
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_RISK_PATHS='contracts/*.sol' runq "$LBL" origin/main
has   "u176: a wide delta touching a risk path is full" "$(qerr)" "review-unit: full review"
has   "u176: ...naming that path"                   "$(qerr)" "contracts/u176.sol"

# The skill's scope helper, when installed, counts the lines instead.
mkdir -p "$PLUG_HEALTHY/skills/ce-code-review/scripts"
cat > "$PLUG_HEALTHY/skills/ce-code-review/scripts/review-scope.py" <<'HELPER'
import json, os, sys
open(os.environ["SCOPE_HELPER_LOG"], "w").write(" ".join(sys.argv[1:]))
print(json.dumps({"exec_nontest_lines": int(os.environ.get("SCOPE_HELPER_LINES", "0")) if os.environ.get("SCOPE_HELPER_LINES") != "null" else None}))
HELPER
export SCOPE_HELPER_LOG="$TMP/scope-helper.log"
qcommit docs/one.md "one line" "doc line"
: > "$CLAUDE_LOG"; SCOPE_HELPER_LINES=999 runq "$LBL" origin/main
has   "policy: the scope helper's count widens"     "$(qerr)" "review-unit: delta-wide"
has   "policy: ...called on the delta"              "$(cat "$SCOPE_HELPER_LOG")" "--base"
qcommit src/more.sh "$(seq 1 30)" "thirty code lines again"
: > "$CLAUDE_LOG"; SCOPE_HELPER_LINES=0 DS_LIMIT_REVIEW_DELTA_WIDE_LINES=10 runq "$LBL" origin/main
has   "policy: the scope helper's count keeps a delta" "$(qerr)" "review-unit: delta (correctness) review"
qcommit src/more.sh "$(seq 1 30)" "helper says unknown"
: > "$CLAUDE_LOG"; SCOPE_HELPER_LINES=null DS_LIMIT_REVIEW_DELTA_WIDE_LINES=10 runq "$LBL" origin/main
has   "policy: an unknown helper count falls back to numstat" "$(qerr)" "review-unit: delta-wide"
rm -rf "$PLUG_HEALTHY/skills/ce-code-review/scripts"

# A delta touching review_risk_paths is full; a delta with no files stays a delta.
qcommit contracts/token.sol "contract change" "contract"
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_RISK_PATHS='contracts/*.sol,auth/*' runq "$LBL" origin/main
has   "policy: a risk-path delta is full"           "$(qerr)" "review-unit: full review"
has   "policy: ...naming the path"                  "$(qerr)" "contracts/token.sol"
has   "policy: ...logged with the risk reason"      "$(logf 4)" "review_risk_paths"
gq commit -q --allow-empty -m "empty"
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_RISK_PATHS='*' DS_LIMIT_REVIEW_DELTA_WIDE_LINES=0 runq "$LBL" origin/main
has   "policy: a delta with no files stays a delta" "$(qerr)" "review-unit: delta (correctness) review"

# --full needs a reason; with one it is a full depth:full review, logged.
qcommit unit.txt six "fix 5"
for bad in '--full' '--full ""'; do
  : > "$CLAUDE_LOG"; rc=0; before="$(loglines)"
  if [ "$bad" = --full ]; then runq "$LBL" origin/main --full || rc=$?; else runq "$LBL" origin/main --full "" || rc=$?; fi
  check "policy: $bad without a reason refuses"     2 "$rc"
  check "policy: $bad without a reason runs nothing" 0 "$(grep -c '^args:' "$CLAUDE_LOG")"
  has   "policy: $bad says a reason is needed"      "$(qerr)" "reason"
  check "policy: a refused run logs nothing"        "$before" "$(loglines)"
done
: > "$CLAUDE_LOG"; runq "$LBL" origin/main --full "touches the auth flow"; rc=$?
check "policy: --full with a reason completes"      0 "$rc"
has   "policy: --full is a full review"             "$(qerr)" "review-unit: full review (--full: touches the auth flow)"
has   "policy: --full asks for depth:full"          "$(args)" "mode:agent depth:full base:origin/main"
check "policy: --full logs full"                    full "$(logf 3)"
check "policy: --full logs its reason"              "--full: touches the auth flow" "$(logf 4)"
: > "$CLAUDE_LOG"; runq "$LBL" --full "before the base" origin/main; rc=$?
check "policy: --full may come before the base"     0 "$rc"
has   "policy: ...and keeps the base"               "$(args)" "base:origin/main"

# A skipped lens leaves the delta list; a full review is asked to skip it and warns if it still ran.
qcommit auth.txt "validate user input on login" "auth fix"
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_SKIP_LENSES=security,learnings runq "$LBL" origin/main
has   "policy: a skipped lens leaves the delta list" "$(qerr)" "review-unit: delta (correctness) review"
has   "policy: ...and the prompt"                   "$(args)" "Run only these reviewers: correctness."
lacks "policy: a delta has no lens to skip"         "$(qerr)" "skipped by review_skip_lenses"
check "policy: the delta log omits the skipped lens" correctness "$(logf 5)"
qcommit auth.txt "and the session cookie" "auth fix 2"
: > "$CLAUDE_LOG"; runq "$LBL" origin/main
has   "policy: without a skip the delta is the same" "$(qerr)" "review-unit: delta (correctness) review"
qcommit unit.txt seven "fix 6"
: > "$CLAUDE_LOG"; FIXTURE_REVIEWERS=correctness,security,learnings-researcher \
  DS_LIMIT_REVIEW_SKIP_LENSES=security,learnings runq "$LBL" origin/main --full "skip proof"; rc=$?
check "policy: a full review that still runs a skipped lens keeps its receipt" 0 "$rc"
has   "policy: the full prompt asks to skip the lenses" "$(args)" "Do not select these reviewers: security, learnings."
has   "policy: stderr warns the skipped lens still ran" "$(qerr)" "warning: review_skip_lenses: the review still ran security, learnings-researcher"
has   "policy: the log carries the warning"         "$(logf 4)" "still ran security, learnings-researcher"
check "policy: the full log lists what ran"         "correctness,security,learnings-researcher" "$(logf 5)"
qcommit unit.txt eight "fix 7"
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_SKIP_LENSES=security runq "$LBL" origin/main --full "obeyed"
lacks "policy: no warning when the skip is obeyed"  "$(qerr)" "still ran"
# A review whose scope touches a risk path keeps every lens.
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_SKIP_LENSES=security DS_LIMIT_REVIEW_RISK_PATHS='auth.txt' runq "$LBL" origin/main --full "risky"
lacks "policy: a risk-path review asks to skip nothing" "$(args)" "Do not select these reviewers"
has   "policy: ...and says why"                     "$(qerr)" "review_skip_lenses not applied"
qcommit unit.txt "retry with backoff" "retry fix"
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_SKIP_LENSES=adversarial DS_LIMIT_REVIEW_RISK_PATHS='auth.txt' runq "$LBL" origin/main
has   "policy: a risk-path unit's delta stays narrow" "$(qerr)" "review-unit: delta (correctness) review"
has   "policy: ...and says why"                     "$(qerr)" "review_skip_lenses not applied: the unit touches review_risk_paths (auth.txt: auth.txt)"
# With risk paths set but no base, the unit's files are unknown: every lens runs (fail closed).
qcommit unit.txt nine "fix 8"
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_SKIP_LENSES=security DS_LIMIT_REVIEW_RISK_PATHS='auth.txt' runq "$LBL" --full "no base"
lacks "policy: no base with risk paths skips nothing" "$(args)" "Do not select these reviewers"
has   "policy: ...and says why"                     "$(qerr)" "review_skip_lenses not applied: no base to check the unit against review_risk_paths"
qcommit unit.txt ten "fix 9"
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_SKIP_LENSES=security runq "$LBL" --full "no base, no risk paths"
has   "policy: no base and no risk paths still skips" "$(args)" "Do not select these reviewers: security."

# Listing correctness, or a malformed list, refuses at startup.
for value in correctness 'security,correctness' 'a b' ',security' 'security,,learnings'; do
  : > "$CLAUDE_LOG"; rc=0; before="$(loglines)"
  DS_LIMIT_REVIEW_SKIP_LENSES="$value" runq "$LBL" origin/main || rc=$?
  check "policy: review_skip_lenses '$value' refuses" 2 "$rc"
  check "policy: ...before any reviewer"            0 "$(grep -c '^args:' "$CLAUDE_LOG")"
  has   "policy: ...naming the key"                 "$(qerr)" "review_skip_lenses"
  check "policy: ...and logs nothing"               "$before" "$(loglines)"
done
rc=0; DS_LIMIT_REVIEW_DELTA_WIDE_LINES=many runq "$LBL" origin/main || rc=$?
check "policy: a non-numeric line threshold refuses" 2 "$rc"
has   "policy: ...naming the key"                   "$(qerr)" "review_delta_wide_lines"
rc=0; DS_LIMIT_REVIEW_DELTA_FULL_LINES=many runq "$LBL" origin/main || rc=$?
check "policy: a non-numeric legacy threshold refuses" 2 "$rc"
has   "policy: ...naming the legacy key"            "$(qerr)" "review_delta_full_lines"

# U172: a main merge doesn't make a delta full. A unit commit, then a merge of a large main
# change, narrows to the expected merge: only the unit's own change is in scope, so only it
# counts toward review_delta_wide_lines and review_risk_paths.
gq update-ref refs/remotes/origin/main main
runq "$LBL" origin/main
qcommit src/own-small.sh "$(seq 1 3)" "own small change"
gq checkout -q main; mkdir -p "$RQ/src" "$RQ/contracts"; seq 1 80 > "$RQ/src/main-big.sh"; echo risky > "$RQ/contracts/m.sol"
gq add -A; gq commit -q -m "main brings a large change"; gq update-ref refs/remotes/origin/main main; gq checkout -q feat
gq merge -q --no-edit main >/dev/null 2>&1
check "u172 fixture: the merge commit exists" 2 "$(gq rev-list --parents -n1 HEAD | wc -w | awk '{print $1 - 1}')"
prev172="$(awk -F'\t' 'NR==1 {print $1}' "$RFQ")"
check "u172 fixture: the plain delta is large" yes "$([ "$(gq diff --numstat "$prev172" HEAD | awk '{n+=$1} END{print n}')" -gt 50 ] && echo yes || echo no)"
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_DELTA_WIDE_LINES=10 DS_LIMIT_REVIEW_RISK_PATHS='contracts/*.sol' runq "$LBL" origin/main
has   "u172: a main merge plus a small own change is a delta" "$(qerr)" "review-unit: delta (correctness) review"
check "u172: ...logged as delta"                    delta "$(logf 3)"
# The review itself still reads the whole delta since the last review.
has   "u172: ...and the review still sees the merge"  "$(args)" "DELTA re-review"
# A large own change since the last review still goes full, merge or no merge.
gq checkout -q main; echo more >> "$RQ/src/main-big.sh"; gq commit -q -am "main moves again"; gq update-ref refs/remotes/origin/main main; gq checkout -q feat
qcommit src/own-big.sh "$(seq 1 30)" "own large change"
gq merge -q --no-edit main >/dev/null 2>&1
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_DELTA_WIDE_LINES=10 runq "$LBL" origin/main
has   "u172: a large own change is wide, not full"  "$(qerr)" "review-unit: delta-wide"
lacks "u172: ...not a full review"                  "$(qerr)" "review-unit: full review"
has   "u172: ...with the size reason"               "$(logf 4)" "review_delta_wide_lines"
# A risk path counts only when the unit itself changed it.
gq checkout -q main; echo risky2 > "$RQ/contracts/m.sol"; gq commit -q -am "main edits a risk path"; gq update-ref refs/remotes/origin/main main; gq checkout -q feat
qcommit src/own-tiny.sh "one" "own tiny change"
gq merge -q --no-edit main >/dev/null 2>&1
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_RISK_PATHS='contracts/*.sol' runq "$LBL" origin/main
has   "u172: a risk path only main changed stays a delta" "$(qerr)" "review-unit: delta (correctness) review"
qcommit contracts/own.sol "own" "own risk path"
gq checkout -q main; echo risky3 > "$RQ/contracts/m.sol"; gq commit -q -am "main edits it again"; gq update-ref refs/remotes/origin/main main; gq checkout -q feat
gq merge -q --no-edit main >/dev/null 2>&1
: > "$CLAUDE_LOG"; DS_LIMIT_REVIEW_RISK_PATHS='contracts/*.sol' runq "$LBL" origin/main
has   "u172: a risk path the unit changed is full"  "$(qerr)" "review-unit: full review"
has   "u172: ...naming that path"                   "$(qerr)" "contracts/own.sol"

# Every run writes one log line: a carried rebase and a failed engine too.
runq "$LBL" origin/main
before="$(loglines)"
gq checkout -q main; echo more > "$RQ/other.txt"; gq add -A; gq commit -q -m "base moves"; gq update-ref refs/remotes/origin/main main; gq checkout -q feat
gq rebase -q main
: > "$CLAUDE_LOG"; runq "$LBL" origin/main
has   "policy: a base-only rebase is carried"       "$(qerr)" "review-unit: carried review"
check "policy: the carried run logs one line"       "$((before + 1))" "$(loglines)"
check "policy: ...as carried"                       carried "$(logf 3)"
check "policy: ...with no lenses"                   - "$(logf 5)"
check "policy: the carried receipt keeps six fields" "6:proof=1" "$(awk -F'\t' '{print NF ":" $6}' "$RFQ")"
qcommit unit.txt nine "fix 8"
before="$(loglines)"; rc=0
STUB_EXIT=1 runq "$LBL" origin/main || rc=$?
check "policy: a failed engine run still logs one line" "$((before + 1))" "$(loglines)"
check "policy: ...as the kind it ran"               delta "$(logf 3)"

echo "review-unit-delta-risk: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
