#!/usr/bin/env bash
# review-unit-stop.sh — part of the review-unit suite (U233): tier-based models, no cross-model peer, and the stop after two proof failures. The suite is split so no one CI job nears
# CI_TEST_TIMEOUT on a loaded host; the stubs and helpers are in tests/lib/review-unit-prelude.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/review-unit-prelude.sh"
. "$ROOT/tests/lib/review-unit-proof-repo.sh"

# --- U163: the review model follows the unit's tier; peers and fallbacks respect accounts ------
# A throwaway state root with a Codex, a Claude and a Muse account; `bin/ds account` reads it.
ST="$TMP/st163"; mkdir -p "$ST"
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\ncodex\tcx1\t-\t-\t-\t-\t-\t1\tcx\nclaude\tcl1\t-\t-\t-\t-\t-\t1\tcl\nmuse\tmu1\t-\t-\t-\t-\t-\t1\tmu\n' > "$ST/accounts.tsv"
export DS_STATE_ROOT="$ST"; "$ROOT/bin/ds" import >/dev/null 2>&1
RW="$(cd "$TMP/repo" && pwd -P)"
mkdir -p "$SD/squads"
unit_tier() { jq -n --arg w "x::$RW" --arg t "$1" '{units:[{slug:"u1",builder_wt:$w} + (if $t == "" then {} else {tier:$t} end)]}' > "$SD/squads/t.json"; }
printf 'builder-review claude opus elevate - muse:muse-spark-1.3\nbuilder-review-standard claude sonnet elevate medium muse:muse-spark-1.3\n' > "$SD/roles.conf"
unit_tier standard; rm -f "$RFILE"; : > "$CLAUDE_LOG"; run_ru "$LBL" >/dev/null 2>&1
has   "U163: a standard unit reviews on the standard row's model"  "$(args)" "--model sonnet"
has   "U163: ...at the standard row's effort"                      "$(args)" "--effort medium"
check "U163: ...and the receipt names it"                          "claude:sonnet" "$(cut -f5 "$RFILE")"
unit_tier hard; rm -f "$RFILE"; : > "$CLAUDE_LOG"; run_ru "$LBL" >/dev/null 2>&1
has   "U163: a hard unit reviews on builder-review"                "$(args)" "--model opus"
unit_tier ""; rm -f "$RFILE"; : > "$CLAUDE_LOG"; run_ru "$LBL" >/dev/null 2>&1
has   "U177: a unit with no tier reviews on builder-review-standard" "$(args)" "--model sonnet"
rm -f "$SD/squads/t.json"; rm -f "$RFILE"; : > "$CLAUDE_LOG"; run_ru "$LBL" >/dev/null 2>&1
has   "U177: no unit found reviews on builder-review-standard"       "$(args)" "--model sonnet"
unit_tier standard
# U267: a project roster overrides per role, so each one below sets builder-review-standard to its
# builder-review row too (sed), or an untiered unit would review on the default's standard row.
printf 'builder-review claude opus elevate\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
rm -f "$RFILE"; : > "$CLAUDE_LOG"; run_ru "$LBL" >/dev/null 2>&1
has   "U163: a roster without the standard row falls back to builder-review" "$(args)" "--model opus"

# --- U177: a hard unit's full review runs on Opus, every delta review on Sonnet ---
# A full review (no receipt yet) of a hard unit stays on builder-review; the fix
# round after it — a delta from that receipt — moves to builder-review-standard.
# rcommit: an empty fix commit in the $TMP/repo fixture (no identity configured there).
rcommit() { git -C "$TMP/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "$1"; }
printf 'builder-review claude opus elevate - muse:muse-spark-1.3\nbuilder-review-standard claude sonnet elevate medium muse:muse-spark-1.3\n' > "$SD/roles.conf"
unit_tier hard
rm -f "$RFILE"; : > "$CLAUDE_LOG"; err="$(run_ru "$LBL" 2>&1 >/dev/null)"
has   "U177: a hard unit's first review runs on builder-review"  "$(args)" "--model opus "
has   "U177: ...as a full review"                               "$err" "review-unit: full review"
check "U177: ...and the receipt names it"                        "claude:opus" "$(cut -f5 "$RFILE")"
rcommit "fix 1"
: > "$CLAUDE_LOG"; err="$(run_ru "$LBL" 2>&1 >/dev/null)"
has   "U177: a hard unit's delta runs on builder-review-standard" "$(args)" "--model sonnet "
has   "U177: ...as a delta review"                               "$err" "review-unit: delta (correctness) review"
check "U177: ...and the receipt names it"                        "claude:sonnet" "$(cut -f5 "$RFILE")"
: > "$CLAUDE_LOG"; err="$(run_ru "$LBL" --full "risk" 2>&1 >/dev/null)"
has   "U177: a hard unit's --full runs on builder-review again"  "$(args)" "--model opus "
has   "U177: ...as a full review"                                "$err" "review-unit: full review (--full: risk)"
# A standard unit reviews on the standard row for both full and delta.
unit_tier standard
rm -f "$RFILE"; : > "$CLAUDE_LOG"; run_ru "$LBL" >/dev/null 2>&1
has   "U177: a standard unit's first review runs on the standard row" "$(args)" "--model sonnet "
rcommit "fix 2"
: > "$CLAUDE_LOG"; err="$(run_ru "$LBL" 2>&1 >/dev/null)"
has   "U177: a standard unit's delta stays on the standard row"  "$(args)" "--model sonnet "
has   "U177: ...as a delta review"                               "$err" "review-unit: delta (correctness) review"
# U267: a project roster without a builder-review-standard row runs the default's, so a hard
# unit's delta moves to it as with the row in the project's roster.
unit_tier hard
printf 'builder-review claude opus elevate\n' > "$SD/roles.conf"
rm -f "$RFILE"; : > "$CLAUDE_LOG"; run_ru "$LBL" >/dev/null 2>&1
rcommit "fix 3"
: > "$CLAUDE_LOG"; err="$(run_ru "$LBL" 2>&1 >/dev/null)"
has   "U177: no standard row of its own: a hard unit's delta runs the default's" "$(args)" "--model $(awk '$1=="builder-review-standard"{print $3}' "$ROOT/conventions/roles.conf") "
has   "U177: ...still as a delta review"                         "$err" "review-unit: delta (correctness) review"

# Peers: every agent with an enabled, unlimited account, minus the review's own.
printf 'builder-review claude opus elevate\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
rm -f "$RFILE"; : > "$CLAUDE_LOG"; run_ru "$LBL" >/dev/null 2>&1
check "U163: all accounts usable: the peers are codex and muse"    "peers:codex" "$(grep '^peers:' "$CLAUDE_LOG" | tail -1)"
rm -f "$RFILE"; : > "$CLAUDE_LOG"; CROSS_MODEL_PEERS=grok run_ru "$LBL" >/dev/null 2>&1
check "U163: an operator allowlist is narrowed, never widened" "peers:none" "$(grep '^peers:' "$CLAUDE_LOG" | tail -1)"
"$ROOT/bin/ds" account disable codex:cx1 >/dev/null
rm -f "$RFILE"; : > "$CLAUDE_LOG"; err="$(run_ru "$LBL" 2>&1 >/dev/null)"; rc=$?
check "U163: every peer unavailable: the review still passes"     "0" "$rc"
check "U163: ...with a receipt"                                    "proof=1" "$(cut -f6 "$RFILE")"
check "U163: ...and no provider allowed for the peer"              "peers:none" "$(grep '^peers:' "$CLAUDE_LOG" | tail -1)"
has   "U163: ...and the coverage says so as info, not an error"  "$err" "review-unit: info: this review has no cross-model peer (no enabled, unlimited account for another agent); that is not an error"
has   "U163: ...and the review is told not to substitute one"      "$(args)" "do not substitute a same-model adversarial reviewer"
# A limited account is as unavailable as a disabled one.
"$ROOT/bin/ds" account enable codex:cx1 >/dev/null
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\ncodex\tcx1\t-\t-\t-\t-\t%s\t2\tcx\nclaude\tcl1\t-\t-\t-\t-\t-\t2\tcl\nmuse\tmu1\t-\t-\t-\t-\t-\t2\tmu\n' "$(( $(date +%s) + 3600 ))" > "$ST/accounts.tsv"
"$ROOT/bin/ds" import >/dev/null 2>&1
rm -f "$RFILE"; : > "$CLAUDE_LOG"; run_ru "$LBL" >/dev/null 2>&1
check "U163: a limited Codex account leaves codex out of the peers" "peers:none" "$(grep '^peers:' "$CLAUDE_LOG" | tail -1)"

# A builder-review fallback to a disabled agent is skipped.
printf 'builder-review claude opus elevate - codex:gpt-6.1-sol:high\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
"$ROOT/bin/ds" account disable codex:cx1 >/dev/null
rm -f "$RFILE"; : > "$CODEX_LOG"
out="$(STUB_OUT="You've hit your limit" STUB_EXIT=1 run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "U163: a disabled fallback agent is not run"                 "0" "$(grep -c '^args:' "$CODEX_LOG")"
check "U163: ...so the limit stays a failure"                      "1" "$rc"
"$ROOT/bin/ds" account enable codex:cx1 >/dev/null
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\ncodex\tcx1\t-\t-\t-\t-\t-\t3\tcx\nclaude\tcl1\t-\t-\t-\t-\t-\t3\tcl\nmuse\tmu1\t-\t-\t-\t-\t-\t3\tmu\n' > "$ST/accounts.tsv"; "$ROOT/bin/ds" import >/dev/null 2>&1
rm -f "$RFILE"; : > "$CODEX_LOG"
out="$(STUB_OUT="You've hit your limit" STUB_EXIT=1 run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "U163: an enabled fallback agent still runs"                 "0" "$rc"
unset DS_STATE_ROOT

# --- U167: a review never starts on a disabled agent, the roster's first one included ---
export DS_STATE_ROOT="$ST"
rm -f "$SD/squads/t.json"
printf 'builder-review codex gpt-6.1-sol elevate high claude:opus:medium\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
"$ROOT/bin/ds" account disable codex:cx1 >/dev/null
rm -f "$RFILE"; : > "$CLAUDE_LOG"; : > "$CODEX_LOG"
out="$(run_ru "$LBL" origin/main 2>"$TMP/err")"; rc=$?
check "U167: a disabled first agent still completes" "0" "$rc"
check "U167: ...on the first usable fallback" "claude:opus" "$(cut -f5 "$RFILE")"
check "U167: ...and the disabled agent never runs" "0" "$(grep -c '^args:' "$CODEX_LOG")"
check "U167: ...while the fallback runs once" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
has   "U167: ...keeping the fallback's effort" "$(args)" "--effort medium"
has   "U167: ...naming the skip" "$(cat "$TMP/err")" "review-unit: codex has no usable account (disabled or limited) — reviewing on claude:opus"
# Peers are worked out against the agent that ran (claude): codex is disabled and
# claude is the review itself, so none — against the row's codex it would be claude.
check "U167: ...and the peers follow the agent that ran" "peers:none" "$(grep '^peers:' "$CLAUDE_LOG" | tail -1)"
# A limited first agent reroutes the same way.
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\ncodex\tcx1\t-\t-\t-\t-\t%s\t4\tcx\nclaude\tcl1\t-\t-\t-\t-\t-\t4\tcl\nmuse\tmu1\t-\t-\t-\t-\t-\t4\tmu\n' "$(( $(date +%s) + 3600 ))" > "$ST/accounts.tsv"
"$ROOT/bin/ds" import >/dev/null 2>&1
rm -f "$RFILE"; : > "$CLAUDE_LOG"; : > "$CODEX_LOG"
out="$(run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "U167: a limited first agent reroutes too" "0" "$rc"
check "U167: ...to Claude" "claude:opus" "$(cut -f5 "$RFILE")"
check "U167: ...without running Codex" "0" "$(grep -c '^args:' "$CODEX_LOG")"
has   "U167: ...naming the skip" "$(cat "$TMP/err")" "review-unit: codex has no usable account (disabled or limited) — reviewing on claude:opus"
# A usable first agent runs it as today: no skip, Codex engine.
"$ROOT/bin/ds" account enable codex:cx1 >/dev/null
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\ncodex\tcx1\t-\t-\t-\t-\t-\t5\tcx\nclaude\tcl1\t-\t-\t-\t-\t-\t5\tcl\nmuse\tmu1\t-\t-\t-\t-\t-\t5\tmu\n' > "$ST/accounts.tsv"
"$ROOT/bin/ds" import >/dev/null 2>&1
rm -f "$RFILE"; : > "$CLAUDE_LOG"; : > "$CODEX_LOG"
out="$(run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "U167: a usable first agent still runs first" "0" "$rc"
check "U167: ...on Codex" "codex:gpt-6.1-sol" "$(cut -f5 "$RFILE")"
check "U167: ...without running Claude" "0" "$(grep -c '^args:' "$CLAUDE_LOG")"
lacks "U167: ...with no skip line" "$(cat "$TMP/err")" "has no usable account"
# No usable candidate: a clear message, nothing run, no receipt.
"$ROOT/bin/ds" account disable codex:cx1 >/dev/null
"$ROOT/bin/ds" account disable claude:cl1 >/dev/null
"$ROOT/bin/ds" account disable muse:mu1 >/dev/null
rm -f "$RFILE"; : > "$CLAUDE_LOG"; : > "$CODEX_LOG"; : > "$MUSE_LOG"
out="$(run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "U167: every candidate disabled exits 5" "5" "$rc"
check "U167: ...and prints no report" "" "$out"
check "U167: ...and writes no receipt" "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
check "U167: ...and Codex never runs" "0" "$(grep -c '^args:' "$CODEX_LOG")"
check "U167: ...and Claude never runs" "0" "$(grep -c '^args:' "$CLAUDE_LOG")"
check "U167: ...and Muse never runs" "0" "$(grep -c '^args:' "$MUSE_LOG")"
has   "U167: ...naming the row and the cause" "$(cat "$TMP/err")" "review-unit: no usable review agent on builder-review-standard (codex and every fallback disabled or limited)"   # an untiered unit
"$ROOT/bin/ds" account enable codex:cx1 >/dev/null
"$ROOT/bin/ds" account enable claude:cl1 >/dev/null
"$ROOT/bin/ds" account enable muse:mu1 >/dev/null
unset DS_STATE_ROOT

# --- U169: a review with no allowed cross-model peer still gets its receipt ---
export DS_STATE_ROOT="$ST"
printf 'builder-review claude opus elevate\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
"$ROOT/bin/ds" account disable codex:cx1 >/dev/null
ERRLOG="$SD/review-proof-errors.log"; rm -f "$ERRLOG"
elog() { [ -f "$ERRLOG" ] && awk 'END{print NR}' "$ERRLOG" || echo 0; }
dlog() { awk 'END{print NR}' "$(dirname "$RFILE")/ds-review-log"; }
fresh() { rm -f "$RFILE" "$TMP/repo/.git/ds-review-base"; }
# peer.selected true, no folded artifact, no peer allowed: receipt, with the coverage note.
fresh; dl_before="$(dlog)"; el_before="$(elog)"
PROOF_CASE=peer-offroster-not-run run_ru "$LBL" >"$TMP/out" 2>"$TMP/err"; rc=$?
check "U169: no allowed peer: a skipped selected peer still gets a receipt" "0" "$rc"
check "U169: ...with proof=1" "proof=1" "$(cut -f6 "$RFILE")"
check "U169: ...and the run logs one ds-review-log line" "$((dl_before + 1))" "$(dlog)"
has   "U169: ...carrying the coverage note" "$(tail -1 "$(dirname "$RFILE")/ds-review-log")" "no cross-model peer"
has   "U169: ...and stderr says so as info, not an error" "$(cat "$TMP/err")" "review-unit: info: this review has no cross-model peer (no enabled, unlimited account for another agent); that is not an error"
check "U169: ...and no proof-error line" "$el_before" "$(elog)"
# An adversarial lens the skill left unrun is the skipped peer too.
fresh
PROOF_CASE=folded-peer-unfolded run_ru "$LBL" >"$TMP/out" 2>"$TMP/err"; rc=$?
check "U169: no allowed peer: an unrun adversarial lens still gets a receipt" "0" "$rc"
check "U169: ...with proof=1" "proof=1" "$(cut -f6 "$RFILE")"
# A peer allowed but missing still fails as today, and is counted.
"$ROOT/bin/ds" account enable codex:cx1 >/dev/null
fresh; el_before="$(elog)"
PROOF_CASE=peer-offroster-not-run run_ru "$LBL" >"$TMP/out" 2>"$TMP/err"; rc=$?
check "U169: an allowed but missing peer still fails proof" "4" "$rc"
check "U169: ...and writes no receipt" "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
has   "U169: ...naming the missing peer" "$(cat "$TMP/err")" "selected peer lacks a completed adversarial result"
check "U169: ...and appends one proof-error line" "$((el_before + 1))" "$(elog)"
eline="$(tail -1 "$ERRLOG")"
check "U169: ...with four tab fields" "4" "$(awk -F'\t' '{print NF}' <<<"$eline")"
check "U169: ...for this project" "$LBL" "$(cut -f2 <<<"$eline")"
check "U169: ...naming the engine" "claude:opus" "$(cut -f3 <<<"$eline")"
has   "U169: ...naming the proof error" "$eline" "selected peer lacks a completed adversarial result"
# A missing non-adversarial return still fails when no peer is allowed.
"$ROOT/bin/ds" account disable codex:cx1 >/dev/null
fresh; el_before="$(elog)"
PROOF_CASE=security-silent run_ru "$LBL" >"$TMP/out" 2>"$TMP/err"; rc=$?
check "U169: no allowed peer: a missing non-adversarial return still fails" "4" "$rc"
has   "U169: ...naming the unaccounted selection" "$(cat "$TMP/err")" "selected reviewer lacks a completed return"
check "U169: ...and appends one proof-error line" "$((el_before + 1))" "$(elog)"
# A folded but invalid peer is still checked when no peer is allowed.
fresh
PROOF_CASE=folded-peer-lens-offroster run_ru "$LBL" >"$TMP/out" 2>"$TMP/err"; rc=$?
check "U169: no allowed peer: a folded but invalid peer still fails" "4" "$rc"
has   "U169: ...naming the missing peer" "$(cat "$TMP/err")" "selected peer lacks a completed adversarial result"
"$ROOT/bin/ds" account enable codex:cx1 >/dev/null
unset DS_STATE_ROOT

# --- U198: the account list comes from the dev-studio home, not the script's checkout ---
# The script under test already runs from outside the home; with Codex disabled in the home's
# accounts the review has no peer, and an empty (or unreadable) home list fails safe the same
# way. The review's own engine choice is unchanged either way.
printf 'builder-review claude opus elevate\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
rm -f "$RFILE"; : > "$CLAUDE_LOG"
FAKE_ACCOUNTS='[{"agent":"codex","account":"cx1","state":"disabled"},{"agent":"claude","account":"cl1","state":"enabled"}]' \
  run_ru "$LBL" >"$TMP/out" 2>"$TMP/err"; rc=$?
check "U198: a worktree copy sees the home's disabled Codex" "0" "$rc"
check "U198: ...with a receipt" "proof=1" "$(cut -f6 "$RFILE")"
check "U198: ...and no provider allowed for the peer" "peers:none" "$(grep '^peers:' "$CLAUDE_LOG" | tail -1)"
has   "U198: ...saying it runs outside the home" "$(cat "$TMP/err")" "outside the dev-studio home"
has   "U198: ...and the coverage says so as info, not an error" "$(cat "$TMP/err")" "review-unit: info: this review has no cross-model peer (no enabled, unlimited account for another agent); that is not an error"
rm -f "$RFILE"; : > "$CLAUDE_LOG"
FAKE_ACCOUNTS='[]' run_ru "$LBL" >"$TMP/out" 2>"$TMP/err"; rc=$?
check "U198: an empty home account list still passes" "0" "$rc"
check "U198: ...with a receipt" "proof=1" "$(cut -f6 "$RFILE")"
check "U198: ...and no provider allowed for the peer" "peers:none" "$(grep '^peers:' "$CLAUDE_LOG" | tail -1)"
has   "U198: ...and the coverage says why as info" "$(cat "$TMP/err")" "review-unit: info: this review has no cross-model peer (the account list is empty or unreadable); that is not an error"
rm -f "$RFILE"; : > "$CLAUDE_LOG"
FAKE_ACCOUNTS='not json' run_ru "$LBL" >"$TMP/out" 2>"$TMP/err"; rc=$?
check "U198: an unreadable home account list still passes" "0" "$rc"
check "U198: ...and no provider allowed for the peer" "peers:none" "$(grep '^peers:' "$CLAUDE_LOG" | tail -1)"

# --- U171: a refused review is re-checked, not re-run, on the same HEAD ------------
export DS_STATE_ROOT="$ST"
printf 'builder-review claude opus elevate\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
RU171="$TMP/repo-u171"; RF171="$RU171/.git/ds-review"; RL171="$RU171/.git/ds-review-last-run"
g171() { git -C "$RU171" -c user.email=t@t -c user.name=t "$@"; }
# run171 calls the script directly: the helpers above clear ds-review-last-run, but
# these cases need the saved run to survive between the two calls.
run171() { (cd "$RU171" && "$RU" "$@") >"$TMP/u171-out" 2>"$TMP/u171-err"; }
git init -q -b main "$RU171"; echo base > "$RU171/base.txt"; echo unit > "$RU171/unit.txt"
g171 add -A; g171 commit -q -m base

# A proof failure on a clean tree saves its run folder; the reviewer ran once.
: > "$CLAUDE_LOG"; rm -f "$RF171"
PROOF_CASE=peer-offroster-not-run run171 "$LBL"; rc=$?
check "U171: a refused run exits 4" "4" "$rc"
check "U171: ...writes no receipt" "absent" "$([ -e "$RF171" ] && echo present || echo absent)"
check "U171: ...ran the reviewer once" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
check "U171: ...records the failed run" "present" "$([ -f "$RL171" ] && echo present || echo absent)"

# U201: with the same script, a second call runs a new review at the normal depth, not a re-check.
: > "$CLAUDE_LOG"
PROOF_CASE=peer-offroster-not-run run171 "$LBL"; rc=$?
check "U201: the same script runs a new review" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
has   "U201: ...saying the saved run already failed" "$(cat "$TMP/u171-err")" "already failed this check; running a new review"
check "U201: ...and fails the same way" "4" "$rc"
# A saved run records the hash of the script that failed it; a changed script (update-host.sh)
# re-checks the folder, so the saved hash is made stale here.
rm -f "$RU171/.git/ds-review-stop"   # two failures stop reviews; this case is about reuse
sed -i 's/\t[0-9a-f]\{64\}$/\tstale-hash/' "$RL171"
check "U201: the saved run records the script hash" "stale-hash" "$(cut -f7 "$RL171")"
# The host fix (no allowed peer) makes the same folder pass: no new skill run, receipt written.
"$ROOT/bin/ds" account disable codex:cx1 >/dev/null
: > "$CLAUDE_LOG"
run171 "$LBL"; rc=$?
check "U171: a re-check passes" "0" "$rc"
check "U171: ...without a new skill run" "0" "$(grep -c '^args:' "$CLAUDE_LOG")"
check "U171: ...prints the reused report" "complete" "$(jq -r .status "$TMP/u171-out" 2>/dev/null)"
check "U171: ...writes the receipt" "$(g171 rev-parse HEAD)" "$(cut -f1 "$RF171" 2>/dev/null)"
check "U171: ...with proof=1" "proof=1" "$(cut -f6 "$RF171" 2>/dev/null)"
has   "U171: ...logging the reused run" "$(tail -1 "$RU171/.git/ds-review-log")" "reused 20"
check "U171: ...clearing the saved run" "absent" "$([ -e "$RL171" ] && echo present || echo absent)"
"$ROOT/bin/ds" account enable codex:cx1 >/dev/null

# A re-check that still fails exits 4 with the same error and runs nothing.
echo two > "$RU171/unit.txt"; g171 commit -q -am "unit v2"
: > "$CLAUDE_LOG"; rm -f "$RF171" "$RU171/.git/ds-review-stop"
PROOF_CASE=security-silent run171 "$LBL" >/dev/null 2>&1; rc=$?
check "U171: a second refused run exits 4" "4" "$rc"
sed -i 's/\t[0-9a-f]\{64\}$/\tstale-hash/' "$RL171"
: > "$CLAUDE_LOG"
PROOF_CASE=security-silent run171 "$LBL"; rc=$?
check "U171: ...still exits 4" "4" "$rc"
check "U171: ...without a new skill run" "0" "$(grep -c '^args:' "$CLAUDE_LOG")"
check "U171: ...writes no receipt" "absent" "$([ -e "$RF171" ] && echo present || echo absent)"
has   "U171: ...with the same proof error" "$(cat "$TMP/u171-err")" "selected reviewer lacks a completed return"

# A new commit after a refused run is a normal new review: the reviewer runs again.
# U175: the two refused runs above stopped reviews in this worktree, so clear the stop
# (this case is about reuse, not the stop); the receipt below resolves its alert.
echo three > "$RU171/unit.txt"; g171 commit -q -am "unit v3"
: > "$CLAUDE_LOG"; rm -f "$RF171" "$RU171/.git/ds-review-stop"
run171 "$LBL"; rc=$?
check "U171: a new commit runs a fresh review" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
check "U171: ...and stamps the new HEAD" "$(g171 rev-parse HEAD)" "$(cut -f1 "$RF171" 2>/dev/null)"

# --full forces a new review even with a saved run waiting.
echo four > "$RU171/unit.txt"; g171 commit -q -am "unit v4"
: > "$CLAUDE_LOG"; rm -f "$RF171"
PROOF_CASE=security-silent run171 "$LBL" >/dev/null 2>&1
: > "$CLAUDE_LOG"
run171 "$LBL" --full "risk re-check"; rc=$?
check "U171: --full runs a fresh review" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
lacks "U171: --full is not a reuse" "$(cat "$TMP/u171-err")" "reused 20"

# U219: the saved-run re-check reads the same swapped-pair rule. A refused run's folder is
# rewritten as the skill would have left it (merge end then start, partial / dangling merge),
# then re-checked once the host fix lets it pass.
cat > "$TMP/u219-mutate.py" <<'PYEOF'
import json, sys
folder, mode = sys.argv[1], sys.argv[2]
path = folder + "/stages.jsonl"
events = [json.loads(l) for l in open(path) if l.strip()]
meta = json.load(open(folder + "/metadata.json"))
i = next(n for n, e in enumerate(events) if e["stage"] == "merge" and e["phase"] == "start")
if mode == "swapped": events[i], events[i + 1] = events[i + 1], events[i]
meta["cost"].update(status="partial", dangling_stages=["merge"])
open(path, "w").write("".join(json.dumps(e) + "\n" for e in events))
json.dump(meta, open(folder + "/metadata.json", "w"))
PYEOF
for mode in swapped plain; do
  echo "u219 $mode" > "$RU171/unit.txt"; g171 commit -q -am "unit u219 $mode"
  rm -f "$RF171" "$RU171/.git/ds-review-stop"
  PROOF_CASE=peer-offroster-not-run run171 "$LBL" >/dev/null 2>&1
  python3 -I "$TMP/u219-mutate.py" "$(cut -f4 "$RL171")" "$mode"
  sed -i 's/\t[0-9a-f]\{64\}$/\tstale-hash/' "$RL171"
  "$ROOT/bin/ds" account disable codex:cx1 >/dev/null
  : > "$CLAUDE_LOG"
  run171 "$LBL"; rc=$?
  "$ROOT/bin/ds" account enable codex:cx1 >/dev/null
  if [ "$mode" = swapped ]; then
    check "U219: a re-check accepts a swapped merge pair" "0" "$rc"
    check "U219: ...without a new skill run" "0" "$(grep -c '^args:' "$CLAUDE_LOG")"
    check "U219: ...writes the receipt" "$(g171 rev-parse HEAD)" "$(cut -f1 "$RF171" 2>/dev/null)"
    has   "U219: ...naming the stage" "$(cat "$TMP/u171-err")" "stage log: merge end/start swapped (skill log order), accepted"
  else
    check "U219: a partial run with no swapped pair is not reused" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
    lacks "U219: ...and says nothing about a swap" "$(cat "$TMP/u171-err")" "end/start swapped"
  fi
done
unset DS_STATE_ROOT

# --- U175: reviews stop after two proof failures in a row ---------------------------
# run_stop calls the script directly: the helpers above clear ds-review-stop, but these
# cases need the failure count to survive between calls (it clears ds-review-last-run
# only, so every call still runs a fresh review).
run_stop() { (cd "$TMP/repo" && rm -f "$(git rev-parse --git-dir)/ds-review-last-run" && "$RU" "$@"); }
RS175="$TMP/repo/.git/ds-review-stop"
printf 'builder-review claude opus elevate\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
rm -f "$RFILE" "$RS175"
"$ROOT/bin/lib/alerts.sh" "$SD/alerts.json" resolve "review-stopped:main"
: > "$CLAUDE_LOG"

# Two proof failures in a row: each runs the reviewer and says what is left.
# The stub runs the skill but withholds finish-input.json, so proof fails without
# tripping U194's answered-without-a-skill retry (a retry would run the reviewer
# twice per call here).
PROOF_CASE=missing-finish run_stop "$LBL" >/dev/null 2>"$TMP/stop-err"; rc=$?
check "U175: a first proof failure exits 4" "4" "$rc"
check "U175: ...runs the reviewer" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
has   "U175: ...saying one more stops reviews" "$(cat "$TMP/stop-err")" "1 more such failure stops reviews for this unit"
check "U175: ...records one failure" "1" "$(cut -f1 "$RS175")"

# A dirty tree is the Builder's own cause: it fails but does not count.
echo dirty > "$TMP/repo/uncommitted.txt"
: > "$CLAUDE_LOG"
run_stop "$LBL" >/dev/null 2>"$TMP/stop-err"; rc=$?
check "U175: a dirty tree still exits 4" "4" "$rc"
has   "U175: ...naming the cause" "$(cat "$TMP/stop-err")" "uncommitted changes"
check "U175: ...does not count" "1" "$(cut -f1 "$RS175")"
rm -f "$TMP/repo/uncommitted.txt"

# A moved HEAD is the Builder's own cause too: claude limited falls back to muse,
# whose stub commits mid-review (muse never runs as a primary review agent).
printf 'builder-review claude opus elevate - muse:muse-spark-1.3\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
: > "$CLAUDE_LOG"
STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_COMMIT=1 MUSE_SKILLS="$CE_ROW" run_stop "$LBL" >/dev/null 2>"$TMP/stop-err"; rc=$?
check "U175: a moved HEAD still exits 4" "4" "$rc"
has   "U175: ...naming the cause" "$(cat "$TMP/stop-err")" "HEAD changed during the review"
check "U175: ...does not count" "1" "$(cut -f1 "$RS175")"
printf 'builder-review claude opus elevate\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"

# The second proof failure stops reviews and writes one alert.
: > "$CLAUDE_LOG"
PROOF_CASE=missing-finish run_stop "$LBL" >/dev/null 2>"$TMP/stop-err"; rc=$?
check "U175: a second proof failure exits 4" "4" "$rc"
check "U175: ...runs the reviewer again" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
has   "U175: ...saying reviews stop now" "$(cat "$TMP/stop-err")" "reviews stop now"
check "U175: ...records two failures" "2" "$(cut -f1 "$RS175")"
has   "U175: ...writing the stopped alert" "$("$ROOT/bin/lib/alerts.sh" "$SD/alerts.json" list)" "review-stopped:main"

# The third call runs nothing and exits 6.
: > "$CLAUDE_LOG"
out="$(run_stop "$LBL" 2>"$TMP/stop-err")"; rc=$?
check "U175: a stopped unit exits 6" "6" "$rc"
check "U175: ...without running the reviewer" "0" "$(grep -c '^args:' "$CLAUDE_LOG")"
check "U175: ...prints no report" "" "$out"
has   "U175: ...telling the Builder to stop" "$(cat "$TMP/stop-err")" "Do not run the review again: tell your Lead"
check "U175: ...keeping one alert" "1" "$("$ROOT/bin/lib/alerts.sh" "$SD/alerts.json" list | grep -c .)"
# U250: the stop question carries the facts: the last clean receipt, the commits since, every failure.
has   "U250: ...naming the last clean receipt" "$(cat "$TMP/stop-err")" "last clean receipt:"
has   "U250: ...naming the commits since (or none)" "$(cat "$TMP/stop-err")" "commits since:"
has   "U250: ...naming the failures" "$(cat "$TMP/stop-err")" "failures:"
has   "U250: ...both failures, not just the last" "$(cat "$TMP/stop-err")" " || "
# With a clean receipt on an earlier commit: its commit and the commits since, each with a --stat.
git -C "$TMP/repo" rev-list --count HEAD > "$TMP/n"
if [ "$(cat "$TMP/n")" -gt 1 ]; then
  printf '%s\t1\t-\t3\tclaude:opus\tproof=1\n' "$(git -C "$TMP/repo" rev-parse HEAD~1)" > "$TMP/repo/.git/ds-review"
  run_stop "$LBL" >/dev/null 2>"$TMP/stop-err"
  has "U250: a receipt is named with its findings" "$(cat "$TMP/stop-err")" "(3 findings, claude:opus)"
  has "U250: the commits since are named"           "$(cat "$TMP/stop-err")" "commits since: "
  rm -f "$TMP/repo/.git/ds-review"
fi
has   "U250: ...the card text carries the facts" "$("$ROOT/bin/lib/alerts.sh" "$SD/alerts.json" list)" "last clean receipt:"

# U199: the card names the unit. No squad file yet: it names the branch and says so.
stop199="$("$ROOT/bin/lib/alerts.sh" "$SD/alerts.json" list)"
has "U199: no unit found names the branch" "$stop199" "branch main (no squad unit found)"
has "U199: ...kind review_stopped" "$(jq -r '.alerts[0].kind' "$SD/alerts.json")" "review_stopped"
# A squad unit whose builder_wt is this worktree: title, text, fields and the cd option name it.
WT199="$(git -C "$TMP/repo" rev-parse --show-toplevel)"
mkdir -p "$SD/squads"
printf '{"units":[{"slug":"u9-thing","plan_unit":"U9","status":"dispatched","builder_wt":"abc::%s"}]}\n' "$WT199" > "$SD/squads/zz199.json"
run_stop "$LBL" >/dev/null 2>&1
a199="$SD/alerts.json"
check "U199: the title names squad and unit" "Reviews stopped: zz199 U9" "$(jq -r '.alerts[0].title' "$a199")"
check "U199: the fields carry squad, unit, slug, branch, wt" "zz199 U9 u9-thing main $WT199" \
  "$(jq -r '.alerts[0] | "\(.squad) \(.unit) \(.slug) \(.branch) \(.wt)"' "$a199")"
has "U199: the option cds into the worktree" "$(jq -r '.alerts[0].options[0] // .alerts[0].option // .alerts[0].suggestion' "$a199")" "cd $WT199 && review-unit.sh"
has "U199: the text starts with the unit" "$(jq -r '.alerts[0].question' "$a199")" "zz199 U9"
rm -rf "$SD/squads"

# A changed skill copy lifts the stop: the next call reviews again from count 1.
echo "# U175 probe change" >> "$PLUG_HEALTHY/skills/ce-code-review/SKILL.md"
: > "$CLAUDE_LOG"
PROOF_CASE=missing-finish run_stop "$LBL" >/dev/null 2>"$TMP/stop-err"; rc=$?
check "U175: a new skill copy lifts the stop" "4" "$rc"
check "U175: ...running the reviewer again" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
check "U175: ...restarting the count" "1" "$(cut -f1 "$RS175")"

# --retry allows exactly one more run, then the stop is back.
: > "$CLAUDE_LOG"
PROOF_CASE=missing-finish run_stop "$LBL" --retry "cause fixed" >/dev/null 2>"$TMP/stop-err"; rc=$?
check "U175: --retry runs one more review" "4" "$rc"
check "U175: ...running the reviewer once" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
has   "U175: ...logging the reason" "$(cat "$TMP/repo/.git/ds-review-log")" "$(printf 'retry\tcause fixed')"
: > "$CLAUDE_LOG"
out="$(run_stop "$LBL" 2>"$TMP/stop-err")"; rc=$?
check "U175: ...then the stop is back" "6" "$rc"
check "U175: ...running nothing" "0" "$(grep -c '^args:' "$CLAUDE_LOG")"
run_stop "$LBL" --retry >/dev/null 2>&1; rc=$?
check "U175: --retry needs a reason" "2" "$rc"

# A receipt clears the count and resolves the alert.
: > "$CLAUDE_LOG"
run_stop "$LBL" --retry "cause fixed" >/dev/null 2>"$TMP/stop-err"; rc=$?
check "U175: a retry that passes exits 0" "0" "$rc"
check "U175: ...writing the receipt" "$(git -C "$TMP/repo" rev-parse HEAD)" "$(cut -f1 "$RFILE" 2>/dev/null)"
check "U175: ...clearing the count" "absent" "$([ -e "$RS175" ] && echo present || echo absent)"
check "U175: ...resolving the alert" "" "$("$ROOT/bin/lib/alerts.sh" "$SD/alerts.json" list)"

# --- U194: a reviewer that answers without running the skill gets one stricter retry ---
printf 'builder-review claude opus elevate\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
# Prose first (no run folder), a real run on the retry: receipt, exit 0, log says retried.
rm -f "$PF"; SKIP194="$TMP/skip-first"; rm -f "$SKIP194"; : > "$CLAUDE_LOG"
REVIEW_SKIP_FIRST_CALL="$SKIP194" proof_run trunk; rc=$?
check "U194: a skipped skill retried writes a receipt" "0" "$rc"
check "U194: ...stamping HEAD" "$(git -C "$RP" rev-parse HEAD)" "$(cut -f1 "$PF")"
check "U194: ...running the reviewer twice" "2" "$(grep -c '^args:' "$CLAUDE_LOG")"
first194="$(grep '^args:' "$CLAUDE_LOG" | head -1)"; second194="$(grep '^args:' "$CLAUDE_LOG" | tail -1)"
lacks "U194: ...first prompt has no stricter line" "$first194" "Your previous answer did not run"
has "U194: ...retry leads with the stricter line" "$second194" "--append-system-prompt Your previous answer did not run the ce-code-review skill and was rejected. Run the skill now; do not answer directly."
has "U194: ...logging the retry" "$(cat "$RP/.git/ds-review-log")" "retried: answered without a skill run"
# Prose both times: exit 4 with the new message, counting one stop failure.
run_nostop194() { (cd "$RP" && rm -f "$(git rev-parse --git-dir)/ds-review-last-run" && "$RU" "$LBL" "$@") >"$TMP/proof-out" 2>"$TMP/err"; }
rm -f "$PF" "$RP/.git/ds-review-stop"; : > "$CLAUDE_LOG"
STUB_OUT='not json at all' run_nostop194 trunk; rc=$?
check "U194: no folder on retry exits 4" "4" "$rc"
check "U194: ...writing no receipt" "absent" "$([ -e "$PF" ] && echo present || echo absent)"
check "U194: ...running the reviewer twice" "2" "$(grep -c '^args:' "$CLAUDE_LOG")"
has "U194: ...naming the skipped skill" "$(cat "$TMP/err")" "reviewer answered without running ce-code-review (no run folder for HEAD $(git -C "$RP" rev-parse HEAD) since"
check "U194: ...counting one failure" "1" "$(cut -f1 "$RP/.git/ds-review-stop")"
has "U194: ...stop file holds the new message" "$(cat "$RP/.git/ds-review-stop")" "reviewer answered without running ce-code-review"
has "U194: ...proof log holds the new message" "$(cat "$SD/review-proof-errors.log")" "reviewer answered without running ce-code-review"
check "U2: ...as an off-script failure" "off-script" "$(cut -f5 "$RP/.git/ds-review-stop")"
# U2: off-script failures stop at the third: the second says one more, the third stops, a fourth exits 6.
: > "$CLAUDE_LOG"
STUB_OUT='not json at all' run_nostop194 trunk; rc=$?
check "U194: a second skipped skill exits 4" "4" "$rc"
has "U2: ...saying one more stops reviews" "$(cat "$TMP/err")" "1 more such failure stops reviews for this unit (off-script)"
check "U194: ...counting two failures" "2" "$(cut -f1 "$RP/.git/ds-review-stop")"
: > "$CLAUDE_LOG"
STUB_OUT='not json at all' run_nostop194 trunk; rc=$?
check "U2: a third skipped skill exits 4" "4" "$rc"
has "U194: ...saying reviews stop now" "$(cat "$TMP/err")" "reviews stop now (3 off-script failures in a row)"
check "U2: ...counting three failures" "3" "$(cut -f1 "$RP/.git/ds-review-stop")"
: > "$CLAUDE_LOG"
STUB_OUT='not json at all' run_nostop194 trunk; rc=$?
check "U194: ...then the stop exits 6" "6" "$rc"
check "U194: ...running nothing" "0" "$(grep -c '^args:' "$CLAUDE_LOG")"
check "U194: ...printing no report" "" "$(cat "$TMP/proof-out")"
has "U2: ...naming the off-script class" "$(cat "$TMP/err")" "after 3 off-script failures in a row"
stopped2="$(jq -c '[.alerts[] | select(.kind == "review_stopped")] | last' "$SD/alerts.json")"
check "U2: ...the alert names the class" "off-script" "$(jq -r '.class' <<<"$stopped2")"
has "U2: ...and says the reviewer left the skill" "$(jq -r '.question' <<<"$stopped2")" "off-script failures in a row: the reviewer left ce-code-review"
"$ROOT/bin/lib/alerts.sh" "$SD/alerts.json" resolve "$(jq -r '.id' <<<"$stopped2")"
rm -f "$RP/.git/ds-review-stop"

# --- U2: a reviewer that leaves the skill part-way gets one retry, one model step up ---------
# The unit at $RP has no tier, so its review starts on builder-review-standard (sonnet); the retry
# runs on builder-review (opus). Three shapes: a skill folder stalled at scope, a hand-made
# `…-delta` folder, an older folder's review.json rewritten.
printf 'builder-review claude opus elevate\nbuilder-review-standard claude sonnet elevate medium\n' > "$SD/roles.conf"
OLD2="$REVIEW_FIXTURES/20261101-000000-0123abcd"; mkdir -p "$OLD2"; echo '{"status":"complete"}' > "$OLD2/review.json"
LEAVE2="$TMP/leave-first"
for shape in scope delta delta-branch rewrite; do
  rm -f "$PF" "$LEAVE2" "$RP/.git/ds-review-stop"; : > "$CLAUDE_LOG"
  REVIEW_LEAVE_SKILL=$shape REVIEW_LEAVE_SKILL_FLAG="$LEAVE2" REVIEW_LEAVE_REWRITE="$OLD2" proof_run trunk; rc=$?
  check "U2 $shape: left the skill, then a passing retry writes a receipt" "0" "$rc"
  check "U2 $shape: ...stamping HEAD" "$(git -C "$RP" rev-parse HEAD)" "$(cut -f1 "$PF" 2>/dev/null)"
  check "U2 $shape: ...running the reviewer twice" "2" "$(grep -c '^args:' "$CLAUDE_LOG")"
  has "U2 $shape: ...first on the standard row" "$(grep '^args:' "$CLAUDE_LOG" | head -1)" "--model sonnet"
  has "U2 $shape: ...the retry one step up" "$(grep '^args:' "$CLAUDE_LOG" | tail -1)" "--model opus"
  has "U2 $shape: ...the retry told why" "$(grep '^args:' "$CLAUDE_LOG" | tail -1)" "Your previous run left the ce-code-review skill part-way"
  has "U2 $shape: ...saying so" "$(cat "$TMP/err")" "the reviewer left ce-code-review at stage"
  has "U2 $shape: ...logging the retry" "$(tail -1 "$RP/.git/ds-review-log")" "retried: left the skill"
  check "U2 $shape: ...counting nothing" "absent" "$([ -e "$RP/.git/ds-review-stop" ] && echo present || echo absent)"
done
has "U2: the stalled shape names its stage" "$(REVIEW_LEAVE_SKILL=scope run_nostop194 trunk; cat "$TMP/err")" "left ce-code-review at stage scope and wrote its own result ("
has "U2: ...after one retry" "$(cat "$TMP/err")" "), after one retry — no receipt written (2 more such failures stop reviews for this unit (off-script))"
check "U2: ...recorded as off-script" "1	off-script" "$(cut -f1,5 "$RP/.git/ds-review-stop")"
has "U2: ...stop file holds the message" "$(cut -f4 "$RP/.git/ds-review-stop")" "reviewer left ce-code-review at stage scope"
REVIEW_LEAVE_SKILL="delta" run_nostop194 trunk
check "U2: the second off-script failure does not stop" "2	off-script" "$(cut -f1,5 "$RP/.git/ds-review-stop")"
lacks "U2: ...nor says so" "$(cat "$TMP/err")" "reviews stop now"
has "U2: the hand-made folder is named" "$(cat "$TMP/err")" "-delta), after one retry"
# The rewritten shape, every time, is a third off-script failure: reviews stop.
cp "$RP/.git/ds-review-stop" "$TMP/stop-at-2"
REVIEW_LEAVE_SKILL="rewrite" REVIEW_LEAVE_REWRITE="$OLD2" run_nostop194 trunk
check "U2: a third, rewritten-folder failure counts 3 off-script" "3	off-script" "$(cut -f1,5 "$RP/.git/ds-review-stop")"
has "U2: ...reviews stop now" "$(cat "$TMP/err")" "reviews stop now (3 off-script failures in a row)"
has "U2: ...naming the rewritten folder" "$(cat "$TMP/err")" "at stage none and wrote its own result ($OLD2), after one retry"
"$ROOT/bin/lib/alerts.sh" "$SD/alerts.json" resolve "$(jq -r '[.alerts[] | select(.kind == "review_stopped")] | last | .id' "$SD/alerts.json")"
cp "$TMP/stop-at-2" "$RP/.git/ds-review-stop"
# A hand-made folder that also records the branch is not taken as the run.
REVIEW_LEAVE_SKILL="delta-branch" run_nostop194 trunk
has "U2: a hand-made folder with the branch is still leaving the skill" "$(cat "$TMP/err")" "-delta), after one retry"
check "U2: ...writing no receipt" "absent" "$([ -e "$PF" ] && echo present || echo absent)"
cp "$TMP/stop-at-2" "$RP/.git/ds-review-stop"
# A failure of the other class starts a fresh count.
PROOF_CASE=missing-finish run_nostop194 trunk
check "U2: a tooling failure after two off-script ones counts 1" "1	tooling" "$(cut -f1,5 "$RP/.git/ds-review-stop")"
has "U2: ...one more of it stops" "$(cat "$TMP/err")" "1 more such failure stops reviews for this unit (tooling)"
# A stop file from before the class field is a tooling count.
printf '1\t%s\t%s\tolder error\n' "$(date +%s)" "$(cut -f3 "$RP/.git/ds-review-stop")" > "$RP/.git/ds-review-stop"
(cd "$RP" && rm -f .git/ds-review-last-run && PROOF_CASE=missing-finish "$RU" "$LBL" trunk) >/dev/null 2>"$TMP/err"
check "U2: a classless stop file counts as tooling: two stop" "2	tooling" "$(cut -f1,5 "$RP/.git/ds-review-stop")"
has "U2: ...reviews stop now" "$(cat "$TMP/err")" "reviews stop now (2 tooling failures in a row)"
(cd "$RP" && rm -f .git/ds-review-last-run && "$RU" "$LBL" trunk) >/dev/null 2>"$TMP/err"; rc=$?
check "U2: two tooling failures still exit 6" "6" "$rc"
has "U2: ...naming the tooling class" "$(cat "$TMP/err")" "after 2 tooling failures in a row"
"$ROOT/bin/lib/alerts.sh" "$SD/alerts.json" resolve "$(jq -r '[.alerts[] | select(.kind == "review_stopped")] | last | .id' "$SD/alerts.json")"
rm -f "$RP/.git/ds-review-stop"
# A complete run is taken as it is: one call, no retry.
: > "$CLAUDE_LOG"; proof_run trunk; rc=$?
check "U2: a complete run passes" "0" "$rc"
check "U2: ...with one reviewer call" "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
lacks "U2: ...and no retry" "$(cat "$TMP/err")" "left ce-code-review"

echo "review-unit-stop: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
