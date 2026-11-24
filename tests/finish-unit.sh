#!/usr/bin/env bash
# finish-unit.sh — one call ends a unit: PR lookup, the merge-ready gate, set-unit-pr,
# journal, worker_done. A stub gh serves the PR list and the health GraphQL call (from
# GH_JSON / GH_HEALTH); a stub backend logs worker-done (the seam: the script never
# calls orca itself). squad-state.sh and journal.sh run for real against a scratch
# state tree, with the journal label cleaned up on exit. Health fixtures are the shared
# tests/fixtures/pr-health/*.json (same as tests/lib.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
TMP="$(mktemp -d)"
LABEL="finishunit-$$"; SD="$DS_STATE_ROOT/$LABEL"
state_root_on_exit 'rm -rf "$TMP" "$SD"'

export STUB_DIR="$TMP" BACKEND="$TMP/backend" DS_GH="$TMP/gh" GH_JSON='[]' BACKEND_FAIL=0 BACKEND_ERR="" GH_FAIL=0 GH_HEALTH=''
cat > "$TMP/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_DIR/gh-calls"
if [ "${1:-}" = pr ] && [ "${2:-}" = list ]; then printf '%s' "${GH_JSON:-[]}"; fi
if [ "${1:-}" = api ] && [ "${2:-}" = graphql ]; then
  [ "${GH_FAIL:-0}" = 1 ] && exit 1
  printf '%s' "${GH_HEALTH:-}"
fi
STUB
cat > "$TMP/backend" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_DIR/backend-calls"
if [ "${1:-}" = worker-done ]; then
  if [ "${BACKEND_FAIL:-0}" = 1 ]; then
    [ -n "${BACKEND_ERR:-}" ] && echo "$BACKEND_ERR" >&2
    exit 1
  fi
  echo "worker-done: completed task task_stub"
else exit 2; fi
STUB
chmod +x "$TMP/gh" "$TMP/backend"
: > "$TMP/gh-calls"; : > "$TMP/backend-calls"

# A repo carrying the GitHub remote (.repo points here) and two checkouts: the unit
# branch and main.
git init -q -b main "$TMP/repo"
git -C "$TMP/repo" remote add origin https://github.com/acme/widgets.git
git init -q -b u1-widget "$TMP/wt"
git init -q -b main "$TMP/wt-main"
# A real Builder worktree has commits (rev-parse reads HEAD); seed one in each.
for d in wt wt-main; do git -C "$TMP/$d" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init; done

STATE="$TMP/state/$LABEL/squads/regplan.json"
JFILE="$SD/journals/regplan-builder-U1-widget.md"
FU="$ROOT/bin/role/finish-unit.sh"
RFILE="$TMP/wt/.git/ds-review"
mkstate() {
  mkdir -p "$(dirname "$STATE")"
  jq -n --arg r "path:$TMP/repo" '{repo:$r,units:[{slug:"U1-widget",status:"dispatched"}]}' > "$STATE"
  # The default ship mode is ce-pipeline, whose gate wants a review receipt for HEAD.
  mkreceipt "$(git -C "$TMP/wt" rev-parse HEAD)"
}
mkreceipt() { # mkreceipt <sha> [<engine:model>] — stamp a receipt for <sha> in the unit worktree
  printf '%s\t%s\t%s\t%s\t%s\tproof=1\n' "$1" "$(date +%s)" "-" "0" "${2:-claude:opus}" > "$RFILE"
}
mkstate
health() { GH_HEALTH="$(cat "$ROOT/tests/fixtures/pr-health/$1")"; export GH_HEALTH; }

pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 (want [$3], got [$2])" >&2; fi; }
has() { if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
run_fu() { out=""; err=""; rc=0; out="$(cd "$TMP/wt" && "$FU" "$@" 2>"$TMP/err")" || rc=$?; err="$(cat "$TMP/err")"; }
run_fu_in() { local d="$1"; shift; out=""; err=""; rc=0; out="$(cd "$d" && "$FU" "$@" 2>"$TMP/err")" || rc=$?; err="$(cat "$TMP/err")"; }
reset_calls() { : > "$TMP/gh-calls"; : > "$TMP/backend-calls"; }
pr_of() { jq -r '.units[0].pr // empty' "$STATE"; }
wd_count() { grep -c '^worker-done ' "$TMP/backend-calls" || true; }
# finishes rows (U3 of orca-backend-alternatives) matching a WHERE clause, 0 before loop.db exists.
fin_count() {
  [ -f "$DS_STATE_ROOT/loop.db" ] || { echo 0; return; }
  bun -e 'const d = new (require("bun:sqlite").Database)(process.argv[1], { readonly: true }); console.log(d.query(`SELECT COUNT(*) AS n FROM finishes WHERE ${process.argv[2]}`).get().n)' "$DS_STATE_ROOT/loop.db" "$1"
}
fin_col() { # fin_col <column> <where> — the newest matching row's column
  bun -e 'const d = new (require("bun:sqlite").Database)(process.argv[1], { readonly: true }); console.log(d.query(`SELECT ${process.argv[2]} AS v FROM finishes WHERE ${process.argv[3]} ORDER BY id DESC`).get()?.v ?? "")' "$DS_STATE_ROOT/loop.db" "$1" "$2"
}

# --- refusals send nothing -------------------------------------------------------
run_fu 2>/dev/null; eq "usage with no args exits 2" "$rc" "2"

# U197: -h/--help prints the usage on stdout and stops before the PR lookup,
# the journal write, and worker_done.
for hflag in --help -h; do
  reset_calls; run_fu "$hflag"
  eq "$hflag exits 0" "$rc" "0"
  has "$hflag prints the usage on stdout" "$out" "usage: finish-unit.sh"
  eq "$hflag prints nothing on stderr" "$err" ""
  eq "$hflag never asks gh" "0" "$(wc -l < "$TMP/gh-calls" | tr -d ' ')"
  eq "$hflag sends nothing" "0" "$(wd_count)"
done
eq "help writes no journal" "absent" "$([ -e "$JFILE" ] && echo present || echo absent)"
reset_calls; run_fu "$STATE" U1-widget --help
eq "a trailing --help exits 0" "$rc" "0"
has "a trailing --help prints the usage" "$out" "usage: finish-unit.sh"
eq "a trailing --help sends nothing" "0" "$(wd_count)"

run_fu "$TMP/state/$LABEL/squads/missing.json" U1-widget
eq "missing state exits 1" "$rc" "1"
has "missing state names the file" "$err" "missing.json"
eq "missing state sends nothing" "$(wd_count)" "0"

printf '{not json' > "$TMP/bad.json"
run_fu "$TMP/bad.json" U1-widget
eq "corrupt state exits 1" "$rc" "1"
has "corrupt state says not valid JSON" "$err" "not valid JSON"
eq "corrupt state sends nothing" "$(wd_count)" "0"

run_fu "$STATE" U9-other
eq "unknown unit exits 1" "$rc" "1"
eq "unknown unit never asks gh" "$(wc -l < "$TMP/gh-calls" | tr -d ' ')" "0"
eq "unknown unit sends nothing" "$(wd_count)" "0"

run_fu "$STATE" U1-widget
eq "no PR exits 1" "$rc" "1"
has "no PR names the branch" "$err" "no PR for branch 'u1-widget'"
eq "no PR records nothing" "$(pr_of)" ""
eq "no PR sends nothing" "$(wd_count)" "0"
eq "no PR prints no receipt" "$out" ""

export GH_JSON='[{"number":4,"state":"CLOSED"}]';  reset_calls
run_fu "$STATE" U1-widget
eq "closed-only PR exits 1" "$rc" "1"
eq "closed-only PR sends nothing" "$(wd_count)" "0"

reset_calls
run_fu_in "$TMP/wt-main" "$STATE" U1-widget
eq "on main exits 1" "$rc" "1"
has "on main says to check out the unit branch" "$err" "check out the unit branch"
eq "on main sends nothing" "$(wd_count)" "0"

# --- the gate refuses anything but merge-ready ------------------------------------
export GH_JSON='[{"number":7,"state":"OPEN"}]'
refuse() { # refuse <fixture> <want-in-message> [extra gh setup]
  health "$1"; reset_calls; mkstate; rm -f "$JFILE"
  before="$(cat "$STATE")"
  run_fu "$STATE" U1-widget
  eq "$1 refuses with exit 1" "$rc" "1"
  has "$1 names the reasons" "$err" "PR #7 is not merge-ready: $2"
  has "$1 says to keep babysitting" "$err" "keep babysitting (ce-babysit-pr)"
  has "$1 points at --check" "$err" "--check shows the verdict"
  has "$1 points at the Lead for foreign blockers" "$err" "orch.sh ask your Lead"
  eq "$1 writes no state" "$(cat "$STATE")" "$before"
  eq "$1 records no PR" "$(pr_of)" ""
  eq "$1 writes no journal" "$([ -e "$JFILE" ] && echo present || echo absent)" "absent"
  eq "$1 sends nothing" "$(wd_count)" "0"
  eq "$1 prints no receipt" "$out" ""
}
refuse failing-check.json "checks-failing"
refuse status-failing.json "checks-failing"
refuse threads.json "threads:2"
refuse conflicting.json "conflicting"
refuse behind.json "behind"
refuse draft.json "draft"
refuse changes-requested.json "changes-requested"
refuse checks-running.json "checks still running"
refuse mergeable-unknown.json "GitHub is still computing mergeability — retry"
refuse unknown-plus-threads.json "mergeable-unknown,threads:1"
refuse closed.json "closed"
refuse required-missing.json "required check 'manual-gate' not reported yet — if CI posts it, wait; if the repo's AGENTS.md names a step that posts it, run that step"
refuse required-missing-comma.json "required checks 'a-gate', 'test (ubuntu-latest; 20)' not reported yet — if CI posts them, wait"
refuse required-pending.json "checks still running"
refuse required-classic-threads.json "required:Secret scan,mergeable-unknown,threads:1"
GH_FAIL=1; reset_calls; mkstate; rm -f "$JFILE"; before="$(cat "$STATE")"
run_fu "$STATE" U1-widget
eq "gh failure exits 1" "$rc" "1"
has "gh failure says to retry" "$err" "PR #7 is not merge-ready: couldn't read the PR's health from GitHub — retry"
eq "gh failure writes no state" "$(cat "$STATE")" "$before"
eq "gh failure sends nothing" "$(wd_count)" "0"
GH_FAIL=0

eq "refusals write no finish row" "$(fin_count 1)" "0"

# --- the happy path: a ready PR --------------------------------------------------
export GH_JSON='[{"number":7,"state":"OPEN"}]'; health ready.json; reset_calls; mkstate
DS_GEN=gen-7 run_fu "$STATE" U1-widget
eq "open PR exits 0" "$rc" "0"
eq "open PR recorded in state" "$(pr_of)" "7"
has "gh asked for this repo" "$(cat "$TMP/gh-calls")" "--repo acme/widgets"
has "gh asked for this branch" "$(cat "$TMP/gh-calls")" "--head u1-widget"
has "the gate asked graphql for this PR" "$(cat "$TMP/gh-calls")" "number=7"
eq "open PR sends exactly one worker_done" "$(wd_count)" "1"
has "worker_done subject names the PR" "$(cat "$TMP/backend-calls")" "finished U1-widget: PR #7"
has "worker_done body starts merge-ready" "$(cat "$TMP/backend-calls")" "PR #7 merge-ready"
has "worker_done body says it waits on the merge" "$(cat "$TMP/backend-calls")" "waits on the operator's merge"
has "worker_done body says to stay at the prompt" "$(cat "$TMP/backend-calls")" "Stay at your prompt"
has "worker_done body reports the review" "$(cat "$TMP/backend-calls")" "Reviewed at "
has "worker_done body reports 0 commits since" "$(cat "$TMP/backend-calls")" "0 commit(s) since"
has "journal names the PR" "$(cat "$JFILE")" "PR #7"
has "backend confirmation passes through" "$out" "worker-done: completed task task_stub"
has "receipt names the PR" "$out" "finished (PR #7)"
eq "open PR writes one ok finish row" "$(fin_count "outcome = 'ok'")" "1"
eq "the ok row names the Builder" "$(fin_col member "outcome = 'ok'")" "$LABEL/regplan/builder-U1-widget"
eq "the ok row carries DS_GEN" "$(fin_col gen "outcome = 'ok'")" "gen-7"
eq "the ok row names the unit" "$(fin_col unit "outcome = 'ok'")" "U1-widget"
has "the ok row's body is worker_done's" "$(fin_col body "outcome = 'ok'")" "PR #7 merge-ready"
DS_GEN=gen-7 run_fu "$STATE" U1-widget
eq "a re-run at the same HEAD writes no second ok row" "$(fin_count "outcome = 'ok'")" "1"

# --- required-only and zero checks pass -------------------------------------------
health required-only.json; reset_calls; mkstate
run_fu "$STATE" U1-widget
eq "failing non-required plus green required exits 0" "$rc" "0"
eq "failing non-required plus green required sends" "$(wd_count)" "1"

health zero-checks.json; reset_calls; mkstate
run_fu "$STATE" U1-widget
eq "zero checks exits 0" "$rc" "0"
eq "zero checks sends" "$(wd_count)" "1"

# --- the project's expected checks ----------------------------------------------------------
"$ROOT/bin/commands/limits.sh" set "$LABEL" expected_checks tests >/dev/null
health zero-checks.json; reset_calls; mkstate
run_fu "$STATE" U1-widget
eq "an absent expected check refuses" "$rc" "1"
eq "an absent expected check sends nothing" "$(wd_count)" "0"
has "the refusal names it" "$err" "required check 'tests' not reported yet"
health expected-skipped.json; reset_calls; mkstate
run_fu "$STATE" U1-widget --check
eq "a skipped expected check is not ready" "$rc" "1"
health expected-green.json; reset_calls; mkstate
run_fu "$STATE" U1-widget
eq "a green expected check exits 0" "$rc" "0"
eq "a green expected check sends" "$(wd_count)" "1"
"$ROOT/bin/commands/limits.sh" rm "$LABEL" expected_checks >/dev/null

# --- the base branch's required contexts: all reported, or no rules at all ---------------
health required-all-green.json; reset_calls; mkstate
run_fu "$STATE" U1-widget
eq "every required context green exits 0" "$rc" "0"
eq "every required context green sends" "$(wd_count)" "1"

health no-rules.json; reset_calls; mkstate
run_fu "$STATE" U1-widget
eq "a base with no rules exits 0" "$rc" "0"
eq "a base with no rules sends" "$(wd_count)" "1"

# --- sweep-1a parity: open beats merged, newest merged wins -------------------------
export GH_JSON='[{"number":9,"state":"MERGED"},{"number":8,"state":"OPEN"}]'; health ready.json; reset_calls; mkstate
run_fu "$STATE" U1-widget
eq "open beats a newer merged" "$(pr_of)" "8"
eq "precedence run sends one worker_done" "$(wd_count)" "1"

export GH_JSON='[{"number":5,"state":"MERGED"},{"number":6,"state":"MERGED"}]'; health merged.json; reset_calls; mkstate
run_fu "$STATE" U1-widget
eq "merged-only records the newest" "$(pr_of)" "6"
has "merged body starts already merged" "$(cat "$TMP/backend-calls")" "PR #6 already merged"
has "merged body says the loop marks it done" "$(cat "$TMP/backend-calls")" "the loop marks it done"

# --- --check: the verdict, with no side effects --------------------------------------
export GH_JSON='[{"number":7,"state":"OPEN"}]'; health ready.json; reset_calls; mkstate; rm -f "$JFILE"
before="$(cat "$STATE")"
run_fu "$STATE" U1-widget --check
eq "--check on ready exits 0" "$rc" "0"
has "--check on ready prints ready" "$out" "PR #7: ready"
has "--check on ready reports the review" "$out" "Reviewed at "
has "--check on ready reports 0 commits since" "$out" "0 commit(s) since"
eq "--check writes no state" "$(cat "$STATE")" "$before"
eq "--check records no PR" "$(pr_of)" ""
eq "--check writes no journal" "$([ -e "$JFILE" ] && echo present || echo absent)" "absent"
eq "--check sends nothing" "$(wd_count)" "0"

health threads.json; reset_calls; mkstate; rm -f "$JFILE"; before="$(cat "$STATE")"
run_fu "$STATE" U1-widget --check
eq "--check on blocked exits 1" "$rc" "1"
eq "--check on blocked prints the reasons" "$out" "PR #7: not ready — threads:2"
eq "--check on blocked writes no state" "$(cat "$STATE")" "$before"
eq "--check on blocked sends nothing" "$(wd_count)" "0"

health checks-running.json; reset_calls; mkstate
run_fu "$STATE" U1-widget --check
eq "--check on waiting prints checks still running" "$out" "PR #7: not ready — checks still running"

health required-missing.json; reset_calls; mkstate
run_fu "$STATE" U1-widget --check
eq "--check on a missing required context exits 1" "$rc" "1"
has "--check names the missing required context" "$out" "PR #7: not ready — required check 'manual-gate' not reported yet"

health required-all-green.json; reset_calls; mkstate
run_fu "$STATE" U1-widget --check
eq "--check with every required context green exits 0" "$rc" "0"
has "--check with every required context green prints ready" "$out" "PR #7: ready"

export GH_JSON='[{"number":6,"state":"MERGED"}]'; health merged.json; reset_calls; mkstate
run_fu "$STATE" U1-widget --check
eq "--check on merged exits 0" "$rc" "0"
eq "--check on merged prints merged" "$out" "PR #6: merged"

GH_FAIL=1; reset_calls; mkstate
run_fu "$STATE" U1-widget --check
eq "--check on unknown exits 1" "$rc" "1"
has "--check on unknown says to retry" "$out" "couldn't read the PR's health from GitHub — retry"
GH_FAIL=0

export GH_JSON='[]'; health ready.json; reset_calls; mkstate
run_fu "$STATE" U1-widget --check
eq "--check with no PR exits 1" "$rc" "1"
has "--check with no PR keeps the existing message" "$err" "no PR for branch 'u1-widget'"

# --- the review receipt (ce-pipeline mode) -------------------------------------------
export GH_JSON='[{"number":7,"state":"OPEN"}]'; health ready.json; reset_calls; mkstate; rm -f "$JFILE"
rm -f "$RFILE"; before="$(cat "$STATE")"
run_fu "$STATE" U1-widget
eq "no receipt exits 1" "$rc" "1"
has "no receipt says to run review-unit" "$err" "no review receipt — run review-unit.sh $LABEL origin/main, apply its findings, then re-run"
eq "no receipt writes no state" "$(cat "$STATE")" "$before"
eq "no receipt records no PR" "$(pr_of)" ""
eq "no receipt writes no journal" "$([ -e "$JFILE" ] && echo present || echo absent)" "absent"
eq "no receipt sends nothing" "$(wd_count)" "0"

# A receipt for HEAD passes (the happy path above); two review-fix commits after it pass too.
reset_calls; mkstate
git -C "$TMP/wt" -c user.email=t@t -c user.name=t commit -q --allow-empty -m fix1
git -C "$TMP/wt" -c user.email=t@t -c user.name=t commit -q --allow-empty -m fix2
run_fu "$STATE" U1-widget
eq "receipt plus 2 commits exits 0" "$rc" "0"
has "receipt plus 2 commits reports them" "$(cat "$TMP/backend-calls")" "2 commit(s) since"

# A proof=1 receipt names the engine; legacy four- and five-field receipts are refused.
HSHA="$(git -C "$TMP/wt" rev-parse HEAD)"
reset_calls; mkstate; mkreceipt "$HSHA" "muse:muse-spark-1.3"
run_fu "$STATE" U1-widget --check
eq "--check with proof=1 exits 0" "$rc" "0"
has "--check prints the engine" "$out" "on muse:muse-spark-1.3; 0 commit(s) since"
reset_calls; mkstate; mkreceipt "$HSHA" "claude:opus"
run_fu "$STATE" U1-widget
eq "a proven receipt finishes" "$rc" "0"
has "worker_done body names the engine" "$(cat "$TMP/backend-calls")" "on claude:opus; 0 commit(s) since"
for fields in 4 5; do
  reset_calls; mkstate; cut -f1-"$fields" "$RFILE" > "$TMP/legacy"; cp "$TMP/legacy" "$RFILE"
  run_fu "$STATE" U1-widget --check
  eq "legacy $fields-field --check refuses" "$rc" "1"
  has "legacy receipt explains proof upgrade" "$out" "legacy review receipt"
  run_fu "$STATE" U1-widget
  eq "legacy $fields-field finish refuses" "$rc" "1"
  eq "legacy receipt sends no worker_done" "$(wd_count)" "0"
  eq "legacy receipt stays unchanged" "$(cat "$RFILE")" "$(cat "$TMP/legacy")"
done

# A receipt for a sha off this branch's history refuses (a rebase needs a fresh review):
# stamp a commit that exists in the repo but on a side branch, never on this one.
reset_calls; mkstate; rm -f "$JFILE"; before="$(cat "$STATE")"
git -C "$TMP/wt" -c user.email=t@t -c user.name=t checkout -q -b side
git -C "$TMP/wt" -c user.email=t@t -c user.name=t commit -q --allow-empty -m side
mkreceipt "$(git -C "$TMP/wt" rev-parse HEAD)"
git -C "$TMP/wt" checkout -q u1-widget
run_fu "$STATE" U1-widget
eq "foreign receipt exits 1" "$rc" "1"
has "foreign receipt names the rebase" "$err" "not on this branch's history (rebased?) — re-run review-unit.sh"
eq "foreign receipt writes no state" "$(cat "$STATE")" "$before"
eq "foreign receipt sends nothing" "$(wd_count)" "0"

# Other ship modes skip the receipt check entirely (mode via the project's ship-mode row, U256).
mkdir -p "$SD"; "$ROOT/bin/commands/ship-mode.sh" "$LABEL" direct-PR >/dev/null
reset_calls; mkstate; rm -f "$RFILE"
run_fu "$STATE" U1-widget
eq "direct-PR with no receipt exits 0" "$rc" "0"
eq "direct-PR with no receipt sends" "$(wd_count)" "1"
if grep -qF "Reviewed at " "$TMP/backend-calls"; then fail=$((fail+1)); echo "  FAIL: direct-PR body reports no review (got [$(cat "$TMP/backend-calls")])" >&2; else pass=$((pass+1)); fi
"$ROOT/bin/commands/ship-mode.sh" "$LABEL" default >/dev/null

# A merged PR skips the receipt check: the review question is moot once merged.
export GH_JSON='[{"number":6,"state":"MERGED"}]'; health merged.json; reset_calls; mkstate; rm -f "$RFILE"
run_fu "$STATE" U1-widget
eq "merged with no receipt exits 0" "$rc" "0"
has "merged with no receipt says already merged" "$(cat "$TMP/backend-calls")" "PR #6 already merged"

# --check reports the receipt refusal with no side effects.
export GH_JSON='[{"number":7,"state":"OPEN"}]'; health ready.json; reset_calls; mkstate; rm -f "$JFILE"; rm -f "$RFILE"
before="$(cat "$STATE")"
run_fu "$STATE" U1-widget --check
eq "--check with no receipt exits 1" "$rc" "1"
has "--check with no receipt prints the refusal" "$out" "PR #7: not ready — no review receipt"
eq "--check with no receipt writes no state" "$(cat "$STATE")" "$before"
eq "--check with no receipt writes no journal" "$([ -e "$JFILE" ] && echo present || echo absent)" "absent"
eq "--check with no receipt sends nothing" "$(wd_count)" "0"

# --- --no-pr: local-only / no-code --------------------------------------------------
export GH_JSON='[]';  reset_calls; mkstate; rm -f "$RFILE"
run_fu "$STATE" U1-widget --no-pr
eq "--no-pr exits 0" "$rc" "0"
eq "--no-pr never asks gh" "$(wc -l < "$TMP/gh-calls" | tr -d ' ')" "0"
eq "--no-pr records no PR" "$(pr_of)" ""
eq "--no-pr sends one worker_done" "$(wd_count)" "1"
has "--no-pr subject says no PR" "$(cat "$TMP/backend-calls")" "finished U1-widget (no PR)"
has "--no-pr journal says no PR" "$(cat "$JFILE")" "without a PR"
eq "--no-pr writes one no-pr finish row" "$(fin_count "outcome = 'no-pr'")" "1"
eq "--no-pr row has no gen without DS_GEN" "$(fin_col "COALESCE(gen, '-')" "outcome = 'no-pr'")" "-"
run_fu "$STATE" U1-widget --no-pr
eq "a re-run --no-pr writes no second row" "$(fin_count "outcome = 'no-pr'")" "1"

run_fu "$STATE" U1-widget --bogus
eq "unknown flag is usage" "$rc" "2"
run_fu "$STATE" U1-widget --check --no-pr
eq "two flags is usage" "$rc" "2"

# --- --failed: a unit that cannot be built (U3 of orca-backend-alternatives) ----------
reset_calls; mkstate
run_fu "$STATE" U1-widget --failed
eq "--failed with no reason is usage" "$rc" "2"
eq "--failed with no reason sends nothing" "$(wd_count)" "0"
eq "--failed with no reason writes no row" "$(fin_count "outcome = 'failed'")" "0"
DS_GEN=gen-f run_fu "$STATE" U1-widget --failed "the API it needs does not exist"
eq "--failed exits 0" "$rc" "0"
eq "--failed never asks gh" "$(wc -l < "$TMP/gh-calls" | tr -d ' ')" "0"
eq "--failed records no PR" "$(pr_of)" ""
eq "--failed sends one worker_done" "$(wd_count)" "1"
has "--failed sends outcome failed" "$(cat "$TMP/backend-calls")" "worker-done --outcome failed failed U1-widget"
has "--failed body names the why" "$(cat "$TMP/backend-calls")" "cannot be built: the API it needs does not exist"
has "--failed journal says failed" "$(cat "$JFILE")" "unit failed: the API it needs does not exist"
has "--failed receipt says failed" "$out" "ended failed"
eq "--failed writes one failed row" "$(fin_count "outcome = 'failed'")" "1"
eq "the failed row carries DS_GEN" "$(fin_col gen "outcome = 'failed'")" "gen-f"
DS_GEN=gen-f run_fu "$STATE" U1-widget --failed "the API it needs does not exist"
eq "a re-run --failed writes no second row" "$(fin_count "outcome = 'failed'")" "1"
run_fu "$STATE" U1-widget --failed "x" --no-pr
eq "--failed with another flag is usage" "$rc" "2"

# --- a failed send keeps the recorded PR and says to re-run --------------------------
export GH_JSON='[{"number":7,"state":"OPEN"}]'; health ready.json; export BACKEND_FAIL=1; reset_calls; mkstate
run_fu "$STATE" U1-widget
eq "failed send exits 1" "$rc" "1"
eq "failed send keeps the recorded PR" "$(pr_of)" "7"
has "failed send says to re-run" "$err" "re-run"
export BACKEND_FAIL=0

# --- the backend's own stderr surfaces -------------------------------------------------
export BACKEND_FAIL=1 BACKEND_ERR="boom: backend exploded"; reset_calls; mkstate
run_fu "$STATE" U1-widget
eq "failed send with stderr exits 1" "$rc" "1"
has "failed send reprints the backend error" "$err" "boom: backend exploded"
export BACKEND_FAIL=0 BACKEND_ERR=""

# --- re-running after the dispatch settled exits 0 --------------------------------------
export BACKEND_FAIL=1 BACKEND_ERR="orca adapter: worker-done found no active dispatch for this terminal — run it in the dispatched worker's own terminal"; reset_calls; mkstate
run_fu "$STATE" U1-widget
eq "already-sent exits 0" "$rc" "0"
eq "already-sent keeps the recorded PR" "$(pr_of)" "7"
has "already-sent says nothing more to send" "$out" "worker_done was already sent for this dispatch"
export BACKEND_FAIL=0 BACKEND_ERR=""

# --- U11 (orca-backend-alternatives): a squad not on Orca sends no worker_done ----------
# DS_BACKEND is on every terminal the loop makes for such a squad: the finish row is the finish.
export GH_JSON='[{"number":7,"state":"OPEN"}]'; health ready.json; reset_calls; mkstate
ok_before="$(fin_count "outcome = 'ok'")"
DS_BACKEND=tmux DS_GEN=gen-t run_fu "$STATE" U1-widget
eq "non-Orca squad exits 0" "$rc" "0"
eq "non-Orca squad records the PR" "$(pr_of)" "7"
eq "non-Orca squad sends no worker_done" "$(wd_count)" "0"
has "non-Orca squad says why" "$out" "squad on backend tmux: no worker_done"
has "non-Orca receipt names the PR" "$out" "finished (PR #7)"
has "non-Orca squad records its finish" "$out" "finish"
eq "non-Orca squad's finish is the ok row of this unit and head (no second one)" "$(fin_count "outcome = 'ok'")" "$ok_before"
has "non-Orca journal does not claim worker_done" "$(tail -3 "$JFILE")" "no worker_done (no Run)"

# --- a journal that can't be written warns but doesn't block --------------------------
mkdir -p "$SD"; rm -rf "$SD/journals"; touch "$SD/journals"; reset_calls; mkstate
run_fu "$STATE" U1-widget
eq "journal failure still exits 0" "$rc" "0"
eq "journal failure still sends worker_done" "$(wd_count)" "1"
has "journal failure warns" "$err" "warning"

echo "finish-unit: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
