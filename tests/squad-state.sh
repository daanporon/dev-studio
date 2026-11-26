#!/usr/bin/env bash
# Self-test for bin/role/squad-state.sh (no framework; plain asserts).
# Usage: tests/squad-state.sh  -> exits 0 if all pass, non-zero otherwise.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -n "${SQUAD_STATE_MARKED:-}" ] || . "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT (the marked re-run gets its own from the parent): no write to the live state (U253)
: "${DS_STATE_ROOT:?squad-state.sh: no temp state root}"
SS="$ROOT/bin/role/squad-state.sh"
# shellcheck source=tests/lib/twins.sh
. "$ROOT/tests/lib/twins.sh"
# Every temp file and dir of this run lives under one root that goes away on exit. The marked
# re-run (section 8) already gets its root from the parent, which removes it.
if [ -z "${SQUAD_STATE_MARKED:-}" ]; then
  TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/squad-state-run.XXXXXX")"; export TMPDIR
  state_root_on_exit 'rm -rf "$TMPDIR"'
  # Section 8's marked-root re-run of this whole suite starts now and is collected there, so the two runs
  # overlap instead of running one after the other. It has its own root and shares nothing with this run.
  MK="$(mktemp -d "$TMPDIR/squad-state-marked.XXXXXX")"; : > "$MK/.loop-migrated"
  SQUAD_STATE_MARKED=1 DS_STATE_ROOT="$MK" TMPDIR="$MK" bash "$0" > "$MK.out" 2>&1 &
  MARKED_PID=$!
fi
PASS=0
FAIL=0

tmp() { mktemp "${TMPDIR:-/tmp}/squad-state-test.XXXXXX"; }
# debrief-in-needs-you pages U1: a feature squad needs a current Try it page next to its file before done.
tryit() { local f="${1//\"/}"; printf '# Try it — t\n\n## 2026-11-23 — a\n\n1. Open the board; see the squad.\n' > "${f%.json}-try-it.md"; }
# fixture dir <name>: a temp dir for squad files; on the marked re-run (section 8) a squads/ dir
# under the marked root, so its files are served from the store.
fixdir() { local d; d="$(mktemp -d "${TMPDIR:-/tmp}/$1.XXXXXX")"; [ -z "${SQUAD_STATE_MARKED:-}" ] || { d="$d/squads"; mkdir -p "$d"; }; printf '%s' "$d"; }
# hand <file> <jq args...>: edit a squad file by hand (legacy data). On a marked root the file is the
# loop's export, never read back, so the edit is imported into the store the way the install
# migration imports today's files.
hand() {
  local f="$1"; shift
  jq "$@" "$f" > "$f.hand" && mv "$f.hand" "$f" || return 1
  [ -z "${SQUAD_STATE_MARKED:-}" ] || "$(command -v bun || echo "$HOME/.bun/bin/bun")" -e '
    const [root, file] = process.argv.slice(1), path = require("node:path");
    const { open } = require(path.join(root, "bin/loop/core/store.ts")), { squadRows } = require(path.join(root, "bin/loop/db/import-json.ts"));
    const project = path.basename(path.dirname(path.dirname(file))), topic = path.basename(file, ".json");
    open().fact("squad_state", squadRows(project, topic, file), { project, squad: topic });' "$ROOT" "$f"
}
# observe_pr <file> <slug> <pr> <state>: the loop observed the unit's PR in <state> (OPEN, CLOSED,
# MERGED). On a marked root set-unit-status done needs it MERGED; the file backend never reads it.
observe_pr() {
  [ -z "${SQUAD_STATE_MARKED:-}" ] || "$(command -v bun || echo "$HOME/.bun/bin/bun")" -e '
    const [root, file, slug, pr, state] = process.argv.slice(1), path = require("node:path");
    const { open } = require(path.join(root, "bin/loop/core/store.ts"));
    const project = path.basename(path.dirname(path.dirname(file))), topic = path.basename(file, ".json");
    open().upsert("observed_prs", { project, ref: `${topic}/${slug}` }, { pr: Number(pr), state, observed_at: 1 });' "$ROOT" "$1" "$2" "$3" "$4"
}
if [ -n "${SQUAD_STATE_MARKED:-}" ]; then
  tmp() { mkdir -p "$TMPDIR/p/squads"; mktemp --suffix=.json "$TMPDIR/p/squads/t.XXXXXX"; }
fi

check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3" >&2
  fi
}

# 1. Reading a missing file yields a well-formed empty state.
f="$(tmp)"; rm -f "$f"
check "missing file -> valid json" "ok" "$("$SS" "$f" get | jq -e . >/dev/null 2>&1 && echo ok || echo bad)"
check "missing file -> default status running" "running" "$("$SS" "$f" get | jq -r '.status')"
check "missing file -> empty queue" "0" "$("$SS" "$f" get | jq '.waiting_on_you | length')"

# 2. set-task records the task id.
f="$(tmp)"
"$SS" "$f" set-task "task-123" >/dev/null
check "set-task records id" "task-123" "$("$SS" "$f" get | jq -r '.task_id')"

# 3. set-status then get returns the new status.
f="$(tmp)"
"$SS" "$f" set-status "blocked" >/dev/null
check "set-status round-trips" "blocked" "$("$SS" "$f" get | jq -r '.status')"
"$SS" "$f" set-status "suspended" >/dev/null
check "set-status accepts suspended" "suspended" "$("$SS" "$f" get | jq -r '.status')"

# 3b. set-status done refuses while a unit is dispatched (a unit is done when its PR
# merges); other statuses, and done with only planned/done/cancelled units, still work.
d="$(tmp)"
"$SS" "$d" add-unit "a" >/dev/null 2>&1
"$SS" "$d" set-unit-status "a" "dispatched" "wt_a" >/dev/null
"$SS" "$d" set-unit-pr "a" "81" >/dev/null
"$SS" "$d" add-unit "b" >/dev/null 2>&1
"$SS" "$d" set-unit-status "b" "dispatched" "wt_b" >/dev/null
before="$(cat "$d")"
"$SS" "$d" set-status "done" >/dev/null 2>"$d.err"; rc=$?
check "done with dispatched units refuses" "1" "$rc"
check "done refusal leaves state unchanged" "$before" "$(cat "$d")"
check "done refusal names each dispatched unit" "1" "$(grep -c 'refusing done: unit(s) still dispatched — a (PR #81), b (no PR)' "$d.err")"
check "done refusal names the settle command for a dispatched unit" "1" "$(grep -c "merge its PR, or cancel-unit <slug> --why" "$d.err")"
"$SS" "$d" set-status "blocked" >/dev/null
check "another status with dispatched units still works" "blocked" "$("$SS" "$d" get | jq -r '.status')"
observe_pr "$d" a 81 MERGED; "$SS" "$d" set-unit-status "a" "done" >/dev/null
"$SS" "$d" cancel-unit "b" >/dev/null 2>&1
# debrief-in-needs-you U2: done needs no debrief (the loop asks for it at archive); set-debrief refuses an empty one.
tryit "$d"
"$SS" "$d" set-status "done" >/dev/null 2>"$d.err"; rc=$?
check "done without a debrief works" "0" "$rc"
# debrief-in-needs-you pages U1: done on a feature squad needs a current Try it page (a squads/ file; the file backend checks existence only).
if [ -n "${SQUAD_STATE_MARKED:-}" ]; then
  ty="$(tmp)"; "$SS" "$ty" add-unit "a" >/dev/null 2>&1; "$SS" "$ty" set-unit-status "a" "dispatched" "wt_a" >/dev/null
  "$SS" "$ty" set-unit-pr "a" "81" >/dev/null; observe_pr "$ty" a 81 MERGED; "$SS" "$ty" set-unit-status "a" "done" >/dev/null
  "$SS" "$ty" set-status "done" >/dev/null 2>"$ty.err"; rc=$?
  check "done without a Try it page is refused" "1" "$rc"
  check "the Try it refusal names the page path" "1" "$(grep -c -- "-try-it.md is missing" "$ty.err")"
  check "the Try it refusal says the Thinker writes it" "1" "$(grep -c "the Thinker writes it" "$ty.err")"
  check "a refused done leaves the squad running" "running" "$("$SS" "$ty" get | jq -r '.status')"
  # an older page than the last unit_done is refused; a newer one passes
  bun -e 'const path = require("node:path"), { open } = require(path.join(process.argv[1], "bin/loop/core/store.ts")), file = process.argv[2];
    const project = path.basename(path.dirname(path.dirname(file))), topic = path.basename(file, ".json");
    open().db.query("INSERT INTO events (project, squad, unit, kind, at) VALUES (?, ?, ?, ?, ?)").run(project, topic, "a", "unit_done", Math.floor(Date.now() / 1000) + 3600)' "$ROOT" "$ty" 2>/dev/null
  tryit "$ty"
  "$SS" "$ty" set-status "done" >/dev/null 2>"$ty.err"; rc=$?
  check "done with a Try it page older than the last unit done is refused" "1" "$rc"
  check "the stale refusal says out of date" "1" "$(grep -c "out of date" "$ty.err")"
  touch -d "@$(( $(date +%s) + 7200 ))" "${ty%.json}-try-it.md"
  "$SS" "$ty" set-status "done" >/dev/null 2>"$ty.err"; rc=$?
  check "done with a current Try it page passes" "0" "$rc"
fi
"$SS" "$d" set-status "running" >/dev/null 2>&1
before="$(cat "$d")"
"$SS" "$d" set-debrief "" >/dev/null 2>"$d.err"; rc=$?
check "set-debrief refuses an empty text" "1" "$rc"
check "set-debrief names the refusal" "1" "$(grep -c 'refusing an empty debrief' "$d.err")"
"$SS" "$d" set-debrief "   " >/dev/null 2>&1; rc=$?
check "set-debrief refuses a blank text" "1" "$rc"
check "a refused debrief leaves state unchanged" "$before" "$(cat "$d")"
"$SS" "$d" set-status "failed" >/dev/null 2>&1; rc=$?
check "failed is not gated on a debrief" "0" "$rc"
"$SS" "$d" set-status "blocked" >/dev/null 2>&1; rc=$?
check "blocked is not gated on a debrief" "0" "$rc"
"$SS" "$d" set-debrief "  set out: x
shipped: #81  " >/dev/null
check "set-debrief stores the trimmed text" "set out: x
shipped: #81" "$("$SS" "$d" get | jq -r '.debrief')"
printf 'from a file\nTry it: nothing to try by hand — x\n\n' > "$d.txt"
"$SS" "$d" set-debrief --file "$d.txt" >/dev/null
check "set-debrief --file stores the file's text" "from a file
Try it: nothing to try by hand — x" "$("$SS" "$d" get | jq -r '.debrief')"
"$SS" "$d" set-debrief --file "$d.missing" >/dev/null 2>&1; rc=$?
check "set-debrief --file refuses a missing file" "1" "$rc"
rm -f "$d.txt"
# U2: a planned unit refuses done too, and the refusal names the unit and its command.
"$SS" "$d" add-unit "c" >/dev/null 2>&1
before="$(cat "$d")"
tryit "$d"
"$SS" "$d" set-status "done" >/dev/null 2>"$d.err"; rc=$?
check "done with an unheld planned unit refuses" "1" "$rc"
check "planned refusal leaves state unchanged" "$before" "$(cat "$d")"
check "planned refusal names the unit and cancel-unit" "1" "$(grep -c 'unit c is planned and not started — cancel-unit c --why' "$d.err")"
check "refusal ends by saying it is not done" "1" "$(grep -c 'or leave the squad parked; it is not done' "$d.err")"
# one case per hold kind: each refuses and names its own way out
hk="$(tmp)"
"$SS" "$hk" add-unit "fup" --hold >/dev/null 2>&1
"$SS" "$hk" add-unit "frozen" >/dev/null 2>&1
"$SS" "$hk" set-unit-hold "frozen" on --why "wait for the ruling" >/dev/null 2>&1
printf 'U9 — Held by plan — deps: none — Tier: standard — HELD\n' > "$hk.plan"
"$SS" "$hk" register-plan "$hk.plan" >/dev/null 2>&1
phs="$("$SS" "$hk" get | jq -r '.units[]|select(.plan_unit=="U9").slug')"
"$SS" "$hk" set-debrief "d
Try it: nothing to try by hand — x" >/dev/null
before="$(cat "$hk")"
tryit "$hk"
"$SS" "$hk" set-status "done" >/dev/null 2>"$hk.err"; rc=$?
check "done with held units refuses" "1" "$rc"
check "held refusal leaves state unchanged" "$before" "$(cat "$hk")"
check "follow-up hold names add-role" "1" "$(grep -c 'unit fup is a held follow-up — promote it with add-role.sh' "$hk.err")"
check "reasoned hold names set-unit-hold off" "1" "$(grep -c 'unit frozen is held (wait for the ruling) — set-unit-hold frozen off' "$hk.err")"
check "plan hold names dropping HELD" "1" "$(grep -c "unit $phs is held by its plan — drop HELD" "$hk.err")"
check "every held unit offers cancel-unit" "3" "$(grep -c 'cancel-unit .* --why' "$hk.err")"
"$SS" "$hk" cancel-unit fup --why x >/dev/null 2>&1; "$SS" "$hk" cancel-unit frozen --why x >/dev/null 2>&1; "$SS" "$hk" cancel-unit "$phs" --why x >/dev/null 2>&1
tryit "$hk"
"$SS" "$hk" set-status "done" >/dev/null 2>&1; rc=$?
check "done once every held unit is cancelled works" "0" "$rc"
# all done plus a Tester member, and no units at all, still succeed
tm="$(tmp)"
"$SS" "$tm" add-unit "a" >/dev/null 2>&1
"$SS" "$tm" set-unit-status "a" "done" --no-pr >/dev/null 2>&1
"$SS" "$tm" add-member tester 1 wt_t >/dev/null 2>&1
"$SS" "$tm" set-debrief "d
Try it: nothing to try by hand — x" >/dev/null
tryit "$tm"
"$SS" "$tm" set-status "done" >/dev/null 2>&1; rc=$?
check "done with all units done (and a Tester) works" "0" "$rc"
nu="$(tmp)"
"$SS" "$nu" set-debrief "d
Try it: nothing to try by hand — x" >/dev/null
tryit "$nu"
"$SS" "$nu" set-status "done" >/dev/null 2>&1; rc=$?
check "done with no units works" "0" "$rc"
"$SS" "$d" cancel-unit "c" --why "not needed" >/dev/null 2>&1
tryit "$d"
"$SS" "$d" set-status "done" >/dev/null 2>&1; rc=$?
check "done with only done/cancelled units works" "0" "$rc"
check "done with only done/cancelled units sticks" "done" "$("$SS" "$d" get | jq -r '.status')"

# 3c. set-status done journals the finish in the Lead's journal; a refusal writes nothing.
JL="sstate-jrnl-$$"; JD="${DS_STATE_ROOT:-$DS_STATE_ROOT}/$JL"; mkdir -p "$JD/squads"
JF="$JD/journals/topic-lead.md"
"$SS" "$JD/squads/topic.json" add-unit "a" >/dev/null 2>&1
"$SS" "$JD/squads/topic.json" set-unit-status "a" "dispatched" "wt_a" >/dev/null
"$SS" "$JD/squads/topic.json" set-unit-pr "a" "81" >/dev/null
"$SS" "$JD/squads/topic.json" set-status "done" >/dev/null 2>&1
check "done refusal writes no journal" "absent" "$([ -e "$JF" ] && echo present || echo absent)"
"$SS" "$JD/squads/topic.json" set-status "blocked" >/dev/null
check "non-done status writes no journal" "absent" "$([ -e "$JF" ] && echo present || echo absent)"
observe_pr "$JD/squads/topic.json" a 81 MERGED; "$SS" "$JD/squads/topic.json" set-unit-status "a" "done" >/dev/null
tryit "$JD/squads/topic.json"
"$SS" "$JD/squads/topic.json" set-status "done" >/dev/null 2>&1
check "set-status done lands one lead decision" "1" "$(grep -c '\[decision\] squad set to done' "$JF" 2>/dev/null)"
tryit "$JD/squads/topic.json"
"$SS" "$JD/squads/topic.json" set-status "done" >/dev/null 2>&1
check "a repeated done adds no second decision" "1" "$(grep -c '\[decision\] squad set to done' "$JF")"
# best-effort: an unwritable journal dir warns but the status still sticks
rm -rf "$JD/journals"; : > "$JD/journals"
"$SS" "$JD/squads/topic.json" set-status "running" >/dev/null
tryit "$JD/squads/topic.json"
"$SS" "$JD/squads/topic.json" set-status "done" >/dev/null 2>"$JD/err"; rc=$?
check "journal failure doesn't block done" "0" "$rc"
check "journal failure still sets done" "done" "$("$SS" "$JD/squads/topic.json" get | jq -r '.status')"
check "journal failure warns" "1" "$(grep -c 'journal note failed' "$JD/err")"
rm -rf "$JD"

# 4. enqueue-question adds a blocking entry; resolve-question removes it by id.
f="$(tmp)"
"$SS" "$f" enqueue-question "q1" "builder" "true" "Which auth lib?" >/dev/null
check "enqueue adds one" "1" "$("$SS" "$f" get | jq '.waiting_on_you | length')"
check "enqueue marks blocking" "true" "$("$SS" "$f" get | jq -r '.waiting_on_you[0].blocking')"
"$SS" "$f" resolve-question "q1" >/dev/null
check "resolve removes by id" "0" "$("$SS" "$f" get | jq '.waiting_on_you | length')"
# ask-operator sets waiting-on-you; answering the LAST question must set it back to running
# (it used to stick, leaving a red badge with nothing to answer). Not while one is still open,
# and never touch another status (suspended, blocked).
f="$(tmp)"
"$SS" "$f" set-status waiting-on-you >/dev/null
"$SS" "$f" enqueue-question qa lead true "a?" >/dev/null
"$SS" "$f" enqueue-question qb lead true "b?" >/dev/null
"$SS" "$f" resolve-question qa >/dev/null
check "one still open -> stays waiting-on-you" "waiting-on-you" "$("$SS" "$f" get | jq -r '.status')"
"$SS" "$f" resolve-question qb >/dev/null
check "last answered -> back to running" "running" "$("$SS" "$f" get | jq -r '.status')"
f="$(tmp)"
"$SS" "$f" set-status suspended >/dev/null
"$SS" "$f" enqueue-question qc lead true "c?" >/dev/null
"$SS" "$f" resolve-question qc >/dev/null
check "resolve leaves suspended alone" "suspended" "$("$SS" "$f" get | jq -r '.status')"

# 5. log-assumption appends without dropping prior entries.
f="$(tmp)"
"$SS" "$f" log-assumption "chose pg" "no db named" >/dev/null
"$SS" "$f" log-assumption "retry 3x" "network flaky" >/dev/null
check "assumptions append" "2" "$("$SS" "$f" get | jq '.lfg_assumptions | length')"
check "first assumption kept" "chose pg" "$("$SS" "$f" get | jq -r '.lfg_assumptions[0].decision')"

# 5b. type defaults to feature and set-type round-trips.
f="$(tmp)"; rm -f "$f"
check "type defaults to feature" "feature" "$("$SS" "$f" get | jq -r '.type')"
"$SS" "$f" set-type "testing" >/dev/null
check "set-type round-trips" "testing" "$("$SS" "$f" get | jq -r '.type')"

# 5c. run_id and autonomy round-trip; autonomy defaults to checkpoints.
f="$(tmp)"; rm -f "$f"
check "autonomy defaults to checkpoints" "checkpoints" "$("$SS" "$f" get | jq -r '.autonomy')"
"$SS" "$f" set-run "run_abc" >/dev/null
"$SS" "$f" set-autonomy "lfg" >/dev/null
check "set-run round-trips" "run_abc" "$("$SS" "$f" get | jq -r '.run_id')"
check "set-autonomy round-trips" "lfg" "$("$SS" "$f" get | jq -r '.autonomy')"

# 5d. units: add-unit is an idempotent upsert; set-unit-status transitions + records builder.
f="$(tmp)"; rm -f "$f"
check "units default empty" "0" "$("$SS" "$f" get | jq '.units | length')"
"$SS" "$f" add-unit "deposit" >/dev/null 2>&1
"$SS" "$f" add-unit "deposit" >/dev/null 2>&1
check "add-unit upserts (no dup)" "1" "$("$SS" "$f" get | jq '.units | length')"
check "new unit is planned" "planned" "$("$SS" "$f" get | jq -r '.units[0].status')"
"$SS" "$f" set-unit-status "deposit" "dispatched" "wt_b1" >/dev/null
check "status transitions" "dispatched" "$("$SS" "$f" get | jq -r '.units[0].status')"
check "builder recorded" "wt_b1" "$("$SS" "$f" get | jq -r '.units[0].builder_wt')"
"$SS" "$f" set-unit-status "deposit" "done" --no-pr >/dev/null
check "status to done keeps builder" "wt_b1" "$("$SS" "$f" get | jq -r '.units[0].builder_wt')"
check "bad unit status rejected" "2" "$("$SS" "$f" set-unit-status deposit bogus >/dev/null 2>&1; echo $?)"
# set-unit-pr records the PR (stripping a leading #); "" clears it.
"$SS" "$f" set-unit-pr "deposit" "#16349" >/dev/null
check "set-unit-pr strips # and records" "16349" "$("$SS" "$f" get | jq -r '.units[0].pr')"
"$SS" "$f" set-unit-pr "deposit" "https://github.com/o/r/pull/77/" >/dev/null
check "set-unit-pr stores a PR URL as its number" "77" "$("$SS" "$f" get | jq -r '.units[0].pr')"
"$SS" "$f" set-unit-pr "deposit" "12" >/dev/null
for bad in abc 12x "https://github.com/o/r/issues/5" "https://github.com/o/r/pull/x"; do
  check "set-unit-pr rejects '$bad'" "1" "$("$SS" "$f" set-unit-pr deposit "$bad" >/dev/null 2>&1; echo $?)"
done
check "set-unit-pr rejection writes nothing" "12" "$("$SS" "$f" get | jq -r '.units[0].pr')"
"$SS" "$f" set-unit-pr "deposit" "" >/dev/null
check "set-unit-pr clears with empty" "null" "$("$SS" "$f" get | jq -r '.units[0].pr // "null"')"

# 5d-quater. done needs a recorded PR (a Builder that stopped without one is not done);
# --no-pr states it truly has none (local-only, no-code units).
d="$(tmp)"
"$SS" "$d" add-unit "noprlib" >/dev/null 2>&1
before="$(cat "$d")"
"$SS" "$d" set-unit-status "noprlib" "done" >/dev/null 2>"$d.err"; rc=$?
check "done without a PR refuses" "1" "$rc"
check "done without a PR leaves state unchanged" "$before" "$(cat "$d")"
check "the refusal names set-unit-pr and --no-pr" "1" "$(grep -c "has no PR — record it with set-unit-pr, or pass --no-pr" "$d.err")"
"$SS" "$d" set-unit-status "noprlib" "done" --no-pr >/dev/null 2>&1
check "done --no-pr works" "done" "$("$SS" "$d" get | jq -r '.units[0].status')"
check "--no-pr is not stored as builder_wt" "" "$("$SS" "$d" get | jq -r '.units[0].builder_wt')"
"$SS" "$d" set-unit-status "noprlib" "dispatched" "wt_d" >/dev/null
"$SS" "$d" set-unit-pr "noprlib" "77" >/dev/null
observe_pr "$d" noprlib 77 MERGED; "$SS" "$d" set-unit-status "noprlib" "done" >/dev/null 2>&1
check "done with a PR works" "done" "$("$SS" "$d" get | jq -r '.units[0].status')"
"$SS" "$d" set-unit-status "noprlib" "dispatched" "wt_d" >/dev/null
"$SS" "$d" set-unit-pr "noprlib" "" >/dev/null
"$SS" "$d" set-unit-status "noprlib" "done" "wt_d" --no-pr >/dev/null 2>&1
check "done takes --no-pr after a builder wt" "done/wt_d" "$("$SS" "$d" get | jq -r '.units[0] | "\(.status)/\(.builder_wt)"')"
"$SS" "$d" set-unit-status "ghost" "done" >/dev/null 2>&1; rc=$?
check "done on an unknown unit stays a silent no-op" "0" "$rc"

# 5d-quinquies (U4). On the loop's store a unit with a recorded PR is done only once the loop observed
# that PR MERGED (the loop marks it done on the merge); open, closed and unobserved are refused with
# nothing written, and --no-pr does not skip it. The file backend has no loop, so it keeps the old rule.
d="$(tmp)"
"$SS" "$d" add-unit "prg" >/dev/null 2>&1
"$SS" "$d" set-unit-status "prg" "dispatched" "wt_p" >/dev/null
"$SS" "$d" set-unit-pr "prg" "55" >/dev/null
if [ -n "${SQUAD_STATE_MARKED:-}" ]; then
  for st in none OPEN CLOSED; do
    [ "$st" = none ] || observe_pr "$d" prg 55 "$st"
    before="$("$SS" "$d" get)"
    "$SS" "$d" set-unit-status "prg" "done" >/dev/null 2>"$d.err"; rc=$?
    check "PR $st: done refused" "1" "$rc"
    check "PR $st: nothing written" "$before" "$("$SS" "$d" get)"
    check "PR $st: the refusal names the PR" "1" "$(grep -c "unit 'prg' is not done — its PR #55 " "$d.err")"
  done
  check "PR CLOSED: the refusal says closed" "1" "$(grep -c "is closed" "$d.err")"
  "$SS" "$d" set-unit-status "prg" "done" --no-pr >/dev/null 2>&1; rc=$?
  check "PR recorded: --no-pr does not skip the merge check" "1" "$rc"
  observe_pr "$d" prg 55 MERGED
fi
"$SS" "$d" set-unit-status "prg" "done" >/dev/null 2>&1; rc=$?
check "PR merged (or the file backend): done works" "0/done" "$rc/$("$SS" "$d" get | jq -r '.units[0].status')"

# approve-plan / plan-approved: durable operator approval, the Lead's restart-safe gate.
check "plan unapproved by default"   "no"  "$("$SS" "$f" plan-approved "plans/x.md")"
check "empty plan reads approved (ad-hoc)" "yes" "$("$SS" "$f" plan-approved "")"
"$SS" "$f" approve-plan "plans/x.md" >/dev/null
check "approve-plan records it"      "yes" "$("$SS" "$f" plan-approved "plans/x.md")"
check "a different plan stays unapproved" "no" "$("$SS" "$f" plan-approved "plans/y.md")"
"$SS" "$f" approve-plan "plans/x.md" >/dev/null
check "approve-plan dedupes"         "1"   "$("$SS" "$f" get | jq '.approved_plans | length')"
# revoke-plan (hold-cancels-queue-undo-approval U2) on the JSON backend: the doc change only.
check "revoke-plan needs --why"      "2"   "$("$SS" "$f" revoke-plan "plans/x.md" >/dev/null 2>&1; echo $?)"
out="$("$SS" "$f" revoke-plan "plans/x.md" --why "approved by mistake" 2>/dev/null)"
check "revoke-plan says what it took back" "1" "$(printf '%s\n' "$out" | grep -c '^revoked: .*plans/x\.md$')"
check "revoke-plan drops the approval" "no" "$("$SS" "$f" plan-approved "plans/x.md")"
check "revoke-plan keeps who and why" '["approved by mistake",true]' "$("$SS" "$f" get | jq -c '[.revoked_plans[0].why, (.revoked_plans[0].plan | endswith("plans/x.md"))]')"
check "a second revoke-plan is a no-op" "1" "$("$SS" "$f" revoke-plan "plans/x.md" --why again 2>/dev/null | grep -c '^not approved: ')"
check "..and records nothing more"   "1"   "$("$SS" "$f" get | jq '.revoked_plans | length')"
"$SS" "$f" approve-plan "plans/x.md" >/dev/null
check "approve-plan again restores it" "yes" "$("$SS" "$f" plan-approved "plans/x.md")"

# propose-squad / set-proposal-status: a testing squad's triaged fix-squad proposals.
"$SS" "$f" propose-squad "fix-1" "escrow-bug" "path:/r" "U2 _msgSender frozen" >/dev/null
check "proposal recorded"            "escrow-bug" "$("$SS" "$f" get | jq -r '.proposed_squads[0].topic')"
check "proposal starts proposed"     "proposed"   "$("$SS" "$f" get | jq -r '.proposed_squads[0].status')"
check "proposal keeps the framing"   "U2 _msgSender frozen" "$("$SS" "$f" get | jq -r '.proposed_squads[0].framing')"
"$SS" "$f" propose-squad "fix-1" "escrow-bug-v2" "path:/r" "reframed" >/dev/null
check "re-proposing same id upserts" "1" "$("$SS" "$f" get | jq '.proposed_squads | length')"
check "upsert replaced the topic"    "escrow-bug-v2" "$("$SS" "$f" get | jq -r '.proposed_squads[0].topic')"
"$SS" "$f" set-proposal-status "fix-1" spawned >/dev/null
check "proposal status updated"      "spawned" "$("$SS" "$f" get | jq -r '.proposed_squads[0].status')"
rc=0; "$SS" "$f" set-proposal-status "fix-1" bogus >/dev/null 2>&1 || rc=$?
check "invalid proposal status rejected" "2" "$rc"

# add-unit records deps (a DAG); ready-units returns planned units whose deps are all done.
g="$(tmp)"
"$SS" "$g" add-unit "u1" >/dev/null 2>&1
"$SS" "$g" add-unit "u2" >/dev/null 2>&1
"$SS" "$g" add-unit "u3" "" "plans/p.md" "u1" >/dev/null 2>&1
check "unit records its deps"        "u1" "$("$SS" "$g" get | jq -r '.units[] | select(.slug=="u3") | .deps | join(",")')"
check "no-dep unit gets empty deps"  "0"  "$("$SS" "$g" get | jq -r '.units[] | select(.slug=="u1") | .deps | length')"
# u1,u2 have no deps -> ready; u3 waits on u1 -> NOT ready yet.
check "independent units are ready"  "u1 u2" "$("$SS" "$g" ready-units | tr '\n' ' ' | sed 's/ $//')"
# Finish u1 -> u3 becomes ready (the moment its OWN dep is done, not a whole phase).
"$SS" "$g" set-unit-status "u1" "done" --no-pr >/dev/null
check "dependent unblocks when its dep is done" "u2 u3" "$("$SS" "$g" ready-units | tr '\n' ' ' | sed 's/ $//')"

# 5d-bis. add-unit --hold marks a minor follow-up unit (R10): it carries hold:true and ready-units
# NEVER returns it even with deps met; hold gates only the auto-picker, so explicit dispatch works.
h="$(tmp)"
"$SS" "$h" add-unit "minor" --hold >/dev/null 2>&1
check "add-unit --hold sets hold:true" "true" "$("$SS" "$h" get | jq -r '.units[]|select(.slug=="minor").hold')"
"$SS" "$h" add-unit "normal" >/dev/null 2>&1
check "add-unit without --hold is not held" "false" "$("$SS" "$h" get | jq -r '.units[]|select(.slug=="normal").hold')"
check "ready-units excludes a held unit" "normal" "$("$SS" "$h" ready-units | tr '\n' ' ' | sed 's/ $//')"
"$SS" "$h" set-unit-status "minor" dispatched "wt_x" >/dev/null
check "a held unit can still be dispatched explicitly" "dispatched" "$("$SS" "$h" get | jq -r '.units[]|select(.slug=="minor").status')"

# U136. A reasoned hold freezes planned work without taking over a parked follow-up.
h="$(tmp)"; hp="$(tmp)"
printf 'U1 — Hold fixture — deps: none — Tier: standard\n' > "$hp"
"$SS" "$h" register-plan "$hp" >/dev/null
hs="u1-hold-fixture"
check "reasoned hold starts ready" "$hs" "$("$SS" "$h" ready-units)"
check "on without why refuses" "2" "$("$SS" "$h" set-unit-hold "$hs" on >/dev/null 2>&1; echo $?)"
check "on with blank why refuses" "2" "$("$SS" "$h" set-unit-hold "$hs" on --why '  ' >/dev/null 2>&1; echo $?)"
check "hold planned unit succeeds" "0" "$("$SS" "$h" set-unit-hold "$hs" on --why 'operator freeze' >/dev/null 2>&1; echo $?)"
check "hold records reason" "true operator freeze" "$("$SS" "$h" get | jq -r '.units[0] | "\(.hold) \(.hold_reason)"')"
check "ready-units skips reasoned hold" "" "$("$SS" "$h" ready-units)"
before="$(cat "$h")"
check "same reason is idempotent" "0" "$("$SS" "$h" set-unit-hold "$hs" on --why 'operator freeze' >/dev/null 2>&1; echo $?)"
check "same reason leaves JSON unchanged" "$before" "$(cat "$h")"
check "different reason refuses" "1" "$("$SS" "$h" set-unit-hold "$hs" on --why 'different' >/dev/null 2>&1; echo $?)"
check "refusal keeps original hold" "$before" "$(cat "$h")"
"$SS" "$h" register-plan "$hp" >/dev/null
check "register-plan preserves reasoned hold" "true operator freeze" "$("$SS" "$h" get | jq -r '.units[0] | "\(.hold) \(.hold_reason)"')"
check "release succeeds" "0" "$("$SS" "$h" set-unit-hold "$hs" off >/dev/null 2>&1; echo $?)"
check "release clears hold and removes reason" "false false" "$("$SS" "$h" get | jq -r '.units[0] | "\(.hold) \(has("hold_reason"))"')"
check "released unit is ready again" "$hs" "$("$SS" "$h" ready-units)"
before="$(cat "$h")"
check "repeated release succeeds" "0" "$("$SS" "$h" set-unit-hold "$hs" off >/dev/null 2>&1; echo $?)"
check "repeated release leaves JSON unchanged" "$before" "$(cat "$h")"
for st in dispatched "done" cancelled; do
  hand "$h" --arg st "$st" '.units[0].status = $st'
  before="$(cat "$h")"
  check "on refuses $st unit" "1" "$("$SS" "$h" set-unit-hold "$hs" on --why freeze >/dev/null 2>&1; echo $?)"
  check "on refusal leaves $st unit unchanged" "$before" "$(cat "$h")"
done
"$SS" "$h" add-unit parked --hold >/dev/null 2>&1
before="$(cat "$h")"
check "on refuses parked hold" "1" "$("$SS" "$h" set-unit-hold parked on --why freeze >/dev/null 2>&1; echo $?)"
"$SS" "$h" set-unit-hold parked off >/dev/null 2>"$hp.err"; rc=$?
check "off refuses parked hold" "1" "$rc"
check "parked refusal points to promotion path" "1" "$(grep -c 'set-unit-status.*dispatched.*conventions/state.md' "$hp.err")"
check "parked refusals leave JSON unchanged" "$before" "$(cat "$h")"
rm -f "$hp" "$hp.err"

# U6 (squad-done-definition). register-plan keeps title/about/done/check from the indented lines under a unit line.
ut="$(tmp)"
printf 'U1 — First — deps: none — Tier: standard\n  Done: it works.\n  Check: run `tests/x.sh`\n  and see it pass.\n  What: does the\n  first thing.\n  Why after U0: nothing.\n\nU2 — Second — deps: U1 — Tier: standard\n' > "$ut.plan"
"$SS" "$ut" register-plan "$ut.plan" >/dev/null 2>&1
check "register-plan stores title, about, done, check" "First|does the first thing.|it works.|run \`tests/x.sh\` and see it pass." "$("$SS" "$ut" get | jq -r '.units[0] | "\(.title)|\(.about)|\(.done)|\(.check)"')"
check "register-plan: a unit with no text under it stores only its title" "Second false false false" "$("$SS" "$ut" get | jq -r '.units[1] | "\(.title) \(has("about")) \(has("done")) \(has("check"))"')"
printf 'U1 — First — deps: none — Tier: standard\n  Done: changed.\n  What: new text.\n\nU2 — Second — deps: U1 — Tier: standard\n' > "$ut.plan"
check "register-plan re-run with new text is updated" "u1-first	updated" "$("$SS" "$ut" register-plan "$ut.plan" 2>/dev/null | awk -F'\t' '$1=="u1-first"{print $1"\t"$2}')"
check "register-plan re-run replaces the text and drops a field the plan lost" "new text.|changed.|false" "$("$SS" "$ut" get | jq -r '.units[0] | "\(.about)|\(.done)|\(has("check"))"')"
long="$(printf 'x%.0s' $(seq 1 1500))"
printf 'U1 — First — deps: none — Tier: standard\n  What: %s\n  Done: %s\n' "$long" "$long" > "$ut.plan"
"$SS" "$ut" register-plan "$ut.plan" >/dev/null 2>&1
check "register-plan caps about at 1200 and done at 400" "1200 400" "$("$SS" "$ut" get | jq -r '.units[0] | "\(.about|length) \(.done|length)"')"
# unit-detail-cleanup U1. register-plan reads every unit text style: indented, flush, bullet (bold label, blank lines, continuation), Goal:.
us="$(tmp)"
cat > "$us.plan" <<'PLAN'
## Units

U1 — Indented — deps: none — Tier: standard
  What: does the
  first thing.
  Done: it works.
  Check: run `tests/x.sh`
  and see it pass.

U2 — Flush — deps: none — Tier: standard
What: flush what.
Done: flush done
  that goes on.
Check: flush check.

U3 — Bullets — deps: none — Tier: standard

- **Linear:** PRD-1. Put it in the title.

- **Goal:** fix the defect,
  on two lines.
- **What it does:** ignored, Goal won.
- **Files:** `a.ts`, `b.ts`
  more files.
- **Done:** bullet done.
- **Check:** bullet check line one
  line two
- Note: a bullet that is no label
  stray line.
**Done:** bold flush done.

U4 — Other labels only — deps: none — Tier: standard
  Files: x.ts
  Linear: PRD-2
  Risk: none

---

Text after the rule: Done: not stored.
PLAN
"$SS" "$us" register-plan "$us.plan" >/dev/null 2>&1
check "register-plan: indented form as before" "does the first thing.|it works.|run \`tests/x.sh\` and see it pass." "$("$SS" "$us" get | jq -r '.units[0] | "\(.about)|\(.done)|\(.check)"')"
check "register-plan: flush labels with a continuation" "flush what.|flush done that goes on.|flush check." "$("$SS" "$us" get | jq -r '.units[1] | "\(.about)|\(.done)|\(.check)"')"
check "register-plan: bullet, bold, blank line before, Goal first, continuation, other labels not stored" "fix the defect, on two lines.|bullet done. bold flush done.|bullet check line one line two" "$("$SS" "$us" get | jq -r '.units[2] | "\(.about)|\(.done)|\(.check)"')"
check "register-plan: a block of other labels stores no text" "false false false" "$("$SS" "$us" get | jq -r '.units[3] | "\(has("about")) \(has("done")) \(has("check"))"')"

ua="$(tmp)"
"$SS" "$ua" add-unit adhoc-one "" "" "" --tier standard --about "does a thing   on two lines" >/dev/null 2>&1
check "add-unit --about stores about" "does a thing on two lines" "$("$SS" "$ua" get | jq -r '.units[0].about')"

# unit-info-link U1: `Link:` lines in a unit block become the unit's links; add-unit --link does the same.
ul="$(tmp)"; "$SS" "$ul" init >/dev/null 2>&1
lp="$(tmp)"
printf 'U1 — First — deps: none — Tier: standard\n  Done: it works.\n  Link: https://tracker.example/issue/ABC-1, https://github.com/acme/app/issues/7\n  Links: not read.\n\nU2 — Second — deps: none — Tier: standard\n- **Link:** https://tracker.example/issue/ABC-3\n  https://tracker.example/issue/ABC-4 https://tracker.example/issue/ABC-3\n**Link:** http://example.org/page\n' > "$lp"
"$SS" "$ul" register-plan "$lp" >/dev/null 2>&1
check "register-plan stores the Link: URLs" '["https://tracker.example/issue/ABC-1","https://github.com/acme/app/issues/7"]' "$("$SS" "$ul" get | jq -c '.units[0].links')"
check "..a continuation and a second Link: line add up, a repeat counts once" '["https://tracker.example/issue/ABC-3","https://tracker.example/issue/ABC-4","http://example.org/page"]' "$("$SS" "$ul" get | jq -c '.units[1].links')"
printf 'U1 — First — deps: none — Tier: standard\n  Done: it works.\n\nU2 — Second — deps: none — Tier: standard\n  Link: https://tracker.example/issue/ABC-5\n' > "$lp"
"$SS" "$ul" register-plan "$lp" >/dev/null 2>&1
check "register-plan drops links the plan lost and replaces changed ones" 'false ["https://tracker.example/issue/ABC-5"]' "$("$SS" "$ul" get | jq -r '"\(.units[0] | has("links")) \(.units[1].links | tojson)"')"
before="$("$SS" "$ul" get | jq -Sc .units)"
many="$(printf 'https://tracker.example/issue/ABC-%s ' 1 2 3 4 5 6)"
long="https://tracker.example/$(printf '%0500d' 0)"
for bad in 'javascript:alert(1)' 'not a url' 'https://' 'ftp://tracker.example/x' "$many" "$long" '`bin/x.ts` exposes it'; do
  printf 'U1 — First — deps: none — Tier: standard\n  Done: changed.\n  Link: %s\n' "$bad" > "$lp"
  err="$("$SS" "$ul" register-plan "$lp" 2>&1 >/dev/null)"; rc=$?
  check "register-plan refuses Link: ${bad:0:30}, naming the line" "1 yes" "$rc $(case "$err" in *"line 3: Link:"*) echo yes ;; *) echo "$err" ;; esac)"
done
check "..and a refused plan writes nothing" "$before" "$("$SS" "$ul" get | jq -Sc .units)"
"$SS" "$ul" add-unit linked "" "" "" --tier standard --link https://tracker.example/issue/ABC-2 --link https://example.org/page >/dev/null 2>&1
check "add-unit --link stores the links" '["https://tracker.example/issue/ABC-2","https://example.org/page"]' "$("$SS" "$ul" get | jq -c '.units[] | select(.slug=="linked") | .links')"
"$SS" "$ul" add-unit badlink "" "" "" --tier standard --link 'javascript:alert(1)' >/dev/null 2>&1
check "add-unit --link refuses a non-web URL and adds nothing" "2 0" "$? $("$SS" "$ul" get | jq '[.units[] | select(.slug=="badlink")] | length')"
# A URL with a login is refused, and the password never shows in the refusal.
before="$("$SS" "$ul" get | jq -Sc .units)"
printf 'U1 — First — deps: none — Tier: standard\n  Done: changed.\n  Link: https://user:s3cretpw@tracker.example/issue/ABC-1\n' > "$lp"
err="$("$SS" "$ul" register-plan "$lp" 2>&1 >/dev/null)"; rc=$?
check "register-plan refuses a Link: with a login, naming the line" "1 yes" "$rc $(case "$err" in *s3cretpw*) echo "$err" ;; *"line 3: Link: a URL must not carry a login"*) echo yes ;; *) echo "$err" ;; esac)"
check "..and writes nothing" "$before" "$("$SS" "$ul" get | jq -Sc .units)"
for pw in 's3cretpw,tail' 's3cretpw tail'; do
  printf 'U1 — First — deps: none — Tier: standard\n  Done: changed.\n  Link: https://user:%s@tracker.example/x\n' "$pw" > "$lp"
  err="$("$SS" "$ul" register-plan "$lp" 2>&1 >/dev/null)"; rc=$?
  check "a password split on a comma or space is not quoted ($pw)" "1 yes" "$rc $(case "$err" in *s3cretpw*) echo "$err" ;; *"line 3: Link:"*) echo yes ;; *) echo "$err" ;; esac)"
done
err="$("$SS" "$ul" add-unit loginlink "" "" "" --tier standard --link https://user@tracker.example/x 2>&1 >/dev/null)"; rc=$?
check "add-unit --link refuses a login and adds nothing" "2 yes 0" "$rc $(case "$err" in *"must not carry a login"*) echo yes ;; *) echo "$err" ;; esac) $("$SS" "$ul" get | jq '[.units[] | select(.slug=="loginlink")] | length')"
for bad in 'ftp://user:s3cretpw@tracker.example/x' 'https://user:s3cretpw@tracker.example:bad/x' 'user:s3cretpw@tracker.example'; do
  err="$("$SS" "$ul" add-unit loginlink "" "" "" --tier standard --link "$bad" 2>&1 >/dev/null)"; rc=$?
  check "a refused non-web value does not show its login (${bad%%:*})" "2 yes" "$rc $(case "$err" in *s3cretpw*) echo "$err" ;; *"takes http(s) URLs"*) echo yes ;; *) echo "$err" ;; esac)"
done

# U1 (adaptive-builder-capacity). Lane: light|normal [(rule: <id>)] on a unit line -> lane / lane_rule on the unit.
ln="$(tmp)"
printf 'U1 — Contracts — deps: none — Lane: light (rule: contracts-only) — Tier: standard\nU2 — Plain — deps: none — Tier: standard\n' > "$ln.plan"
"$SS" "$ln" register-plan "$ln.plan" >/dev/null 2>&1
check "register-plan stores lane and lane_rule" "light contracts-only" "$("$SS" "$ln" get | jq -r '.units[0] | "\(.lane) \(.lane_rule)"')"
check "register-plan: no Lane: field stores nothing (normal)" "false false" "$("$SS" "$ln" get | jq -r '.units[1] | "\(has("lane")) \(has("lane_rule"))"')"
printf 'U1 — Contracts — deps: none — Lane: light (rule: contracts-only) — Tier: standard\nU2 — Plain — deps: none — Tier: standard — LANE: Light\n' > "$ln.plan"
check "register-plan re-run with a new lane is updated" "u2-plain	updated" "$("$SS" "$ln" register-plan "$ln.plan" 2>/dev/null | awk -F'\t' '$1=="u2-plain"{print $1"\t"$2}')"
check "register-plan: new lane stored, no rule" "light false" "$("$SS" "$ln" get | jq -r '.units[1] | "\(.lane) \(has("lane_rule"))"')"
printf 'U1 — Contracts — deps: none — Tier: standard\nU2 — Plain — deps: none — Lane: normal — Tier: standard\n' > "$ln.plan"
"$SS" "$ln" register-plan "$ln.plan" >/dev/null 2>&1
check "register-plan: dropping the field clears lane and rule" "false false normal" "$("$SS" "$ln" get | jq -r '[(.units[0] | has("lane"), has("lane_rule")), .units[1].lane] | flatten | map(tostring) | join(" ")' | paste -sd' ' -)"
printf 'U1 — Fast — deps: none — Lane: fast — Tier: standard\n' > "$ln.bad"
lerr="$("$SS" "$(tmp)" register-plan "$ln.bad" 2>&1 >/dev/null)"; lrc=$?
check "register-plan: Lane: fast refuses, naming the line" "1 1" "$([ "$lrc" = 1 ] && echo -n "1 "; grep -c 'line 1: U1 Lane: must be light or normal' <<< "$lerr")"

# U168. An urgent unit gets the next Builder place, even at the limit.
u="$(tmp)"
printf 'U1 — Urgent fixture — deps: none — Tier: standard\n' > "$u.plan"
"$SS" "$u" register-plan "$u.plan" >/dev/null
us="u1-urgent-fixture"
check "urgent on writes urgent:true and the reason" "true operator need" "$("$SS" "$u" set-unit-urgent "$us" on --why 'operator need' >/dev/null 2>&1; "$SS" "$u" get | jq -r '.units[0] | "\(.urgent) \(.urgent_why)"')"
check "urgent unit stays ready" "$us" "$("$SS" "$u" ready-units)"
"$SS" "$u" register-plan "$u.plan" >/dev/null
check "register-plan preserves urgent" "true operator need" "$("$SS" "$u" get | jq -r '.units[0] | "\(.urgent) \(.urgent_why)"')"
check "urgent off removes urgent and the reason" "false false" "$("$SS" "$u" set-unit-urgent "$us" off >/dev/null 2>&1; "$SS" "$u" get | jq -r '.units[0] | "\(has("urgent")) \(has("urgent_why"))"')"
before="$(cat "$u")"
check "repeated off succeeds" "0" "$("$SS" "$u" set-unit-urgent "$us" off >/dev/null 2>&1; echo $?)"
check "repeated off leaves JSON unchanged" "$before" "$(cat "$u")"
check "on without why succeeds" "0" "$("$SS" "$u" set-unit-urgent "$us" on >/dev/null 2>&1; echo $?)"
check "on without why writes urgent with no reason" "true false" "$("$SS" "$u" get | jq -r '.units[0] | "\(.urgent) \(has("urgent_why"))"')"
"$SS" "$u" set-unit-urgent "$us" off >/dev/null 2>&1
"$SS" "$u" set-unit-status "$us" dispatched wt_x >/dev/null
check "on works on a dispatched unit" "true" "$("$SS" "$u" set-unit-urgent "$us" on --why 'need first' >/dev/null 2>&1; "$SS" "$u" get | jq -r '.units[0].urgent')"
check "off works on a dispatched unit" "false" "$("$SS" "$u" set-unit-urgent "$us" off >/dev/null 2>&1; "$SS" "$u" get | jq -r '.units[0] | "\(has("urgent"))"')"
for st in "done" "cancelled"; do
  hand "$u" --arg st "$st" '.units[0].status = $st'
  before="$(cat "$u")"
  check "on refuses $st unit" "1" "$("$SS" "$u" set-unit-urgent "$us" on --why need >/dev/null 2>&1; echo $?)"
  check "on refusal leaves $st unit unchanged" "$before" "$(cat "$u")"
  check "off refuses $st unit" "1" "$("$SS" "$u" set-unit-urgent "$us" off >/dev/null 2>&1; echo $?)"
done
check "unknown unit refuses" "1" "$("$SS" "$u" set-unit-urgent nope on >/dev/null 2>&1; echo $?)"
check "bad mode refuses" "2" "$("$SS" "$u" set-unit-urgent "$us" maybe >/dev/null 2>&1; echo $?)"
rm -f "$u.plan"

# 5d-ter. unit tiers: --tier on add-unit, unit-tier reads it (missing = hard), set-unit-tier
# raising standard -> hard marks the unit escalated.
t="$(tmp)"
"$SS" "$t" add-unit u1 --tier standard >/dev/null 2>&1
check "add-unit --tier stores the tier" "standard" "$("$SS" "$t" get | jq -r '.units[]|select(.slug=="u1").tier')"
check "unit-tier prints the stored tier" "standard" "$("$SS" "$t" unit-tier u1)"
"$SS" "$t" add-unit u2 "" "plans/p.md" "u1" >/dev/null 2>&1
check "untagged unit reads as hard" "hard" "$("$SS" "$t" unit-tier u2)"
check "unknown unit reads as hard" "hard" "$("$SS" "$t" unit-tier nope)"
before="$(cat "$t")"
"$SS" "$t" add-unit u3 --tier easy >/dev/null 2>&1; rc=$?
check "add-unit with an invalid tier exits 2" "2" "$rc"
check "add-unit with an invalid tier writes nothing" "$before" "$(cat "$t")"
"$SS" "$t" set-unit-tier u1 hard >/dev/null
check "set-unit-tier changes the tier" "hard" "$("$SS" "$t" unit-tier u1)"
check "raising standard -> hard sets escalated" "true" "$("$SS" "$t" get | jq -r '.units[]|select(.slug=="u1").escalated')"
"$SS" "$t" add-unit u4 --tier hard >/dev/null 2>&1
"$SS" "$t" set-unit-tier u4 hard >/dev/null
check "set-unit-tier on a hard unit leaves escalated unset" "null" "$("$SS" "$t" get | jq -r '.units[]|select(.slug=="u4").escalated')"
"$SS" "$t" set-unit-tier u4 medium >/dev/null 2>&1; rc=$?
check "set-unit-tier with an invalid tier exits 2" "2" "$rc"
"$SS" "$t" set-unit-tier u1 standard >/dev/null
check "setting a unit back to standard clears escalated" "null" "$("$SS" "$t" get | jq -r '.units[]|select(.slug=="u1").escalated')"
"$SS" "$t" add-unit u5 --tier >/dev/null 2>&1; rc=$?
check "add-unit --tier without a value exits 2" "2" "$rc"

# set-member-model updates a member's stored model in place (restart keeps the board true).
"$SS" "$t" add-member builder u1 wt_m1 --owns u1 --model sonnet >/dev/null
m1_before="$("$SS" "$t" get)"
"$SS" "$t" set-member-model wt_m1 opus >/dev/null
check "set-member-model changes .model" "opus" "$("$SS" "$t" get | jq -r '.members[]|select(.wt=="wt_m1").model')"
check "set-member-model keeps .owns" "u1" "$("$SS" "$t" get | jq -r '.members[]|select(.wt=="wt_m1").owns[0]')"
# ...and stamps .started, the start a crash window and spawn grace date from (U64); .since stays the first spawn.
"$SS" "$t" mark-member-restarting wt_m1 >/dev/null
check "mark-member-restarting stamps .restarting (U64)" "1" "$("$SS" "$t" get | jq -r '[.members[]|select(.wt=="wt_m1").restarting | fromdateiso8601? | select(. > now - 120)] | length')"
check "set-member-model stamps .started" "1" "$("$SS" "$t" get | jq -r '[.members[]|select(.wt=="wt_m1").started | fromdateiso8601? | select(. > now - 120)] | length')"
check "set-member-model keeps .since" "$(jq -r '.members[]|select(.wt=="wt_m1").since // "none"' <<<"$m1_before")" "$("$SS" "$t" get | jq -r '.members[]|select(.wt=="wt_m1").since // "none"')"
"$SS" "$t" set-member-model wt_m1 opus high >/dev/null
check "set-member-model sets effort when given" "high" "$("$SS" "$t" get | jq -r '.members[]|select(.wt=="wt_m1").effort')"
"$SS" "$t" set-member-model wt_nope opus >/dev/null 2>&1; rc=$?
check "set-member-model on an unknown wt fails" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"

# 5e. load() fails LOUD on a corrupt file (never silently resets, which would lose units).
f="$(tmp)"; printf 'not json{' > "$f"
check "corrupt file -> non-zero exit" "1" "$("$SS" "$f" get >/dev/null 2>&1; echo $?)"
check "corrupt file left untouched" "not json{" "$(cat "$f")"
"$SS" "$f" set-status running >/dev/null 2>&1 || true
check "corrupt file not overwritten by a write" "not json{" "$(cat "$f")"

# 5f. members roster: 1:1 with worktrees; owns is a list; worktrees[]/assignments[] derived.
f="$(tmp)"; rm -f "$f"
"$SS" "$f" add-member lead "" wt_lead --model fable >/dev/null
"$SS" "$f" add-member thinker onboarding wt_t1 --owns planA.md --owns planB.md >/dev/null
"$SS" "$f" add-member builder checkout wt_b1 --owns checkout --for onboarding >/dev/null
check "members recorded" "3" "$("$SS" "$f" get | jq '.members | length')"
check "thinker owns a list of plans" "2" "$("$SS" "$f" get | jq '.members[]|select(.role=="thinker")|.owns|length')"
check "worktrees derived from members" "wt_b1 wt_lead wt_t1" "$("$SS" "$f" get | jq -r '.worktrees|sort|join(" ")')"
check "assignments derived (builder->thinker)" "onboarding" "$("$SS" "$f" get | jq -r '.assignments[0].thinker')"
# upsert by worktree (no dup), owns replaced
"$SS" "$f" add-member builder checkout wt_b1 --owns checkout --owns login --for onboarding >/dev/null
check "add-member upserts by wt (no dup)" "3" "$("$SS" "$f" get | jq '.members | length')"
check "builder owns updated to 2" "2" "$("$SS" "$f" get | jq '.members[]|select(.role=="builder")|.owns|length')"
# add-member-owns appends a plan to a thinker
"$SS" "$f" add-member-owns wt_t1 planC.md >/dev/null
check "add-member-owns appends" "3" "$("$SS" "$f" get | jq '.members[]|select(.wt=="wt_t1")|.owns|length')"
# set-member-for fixes a builder's routing in place, without wiping other fields
"$SS" "$f" set-member-for wt_b1 structures >/dev/null
check "set-member-for updates .for" "structures" "$("$SS" "$f" get | jq -r '.members[]|select(.wt=="wt_b1")|.for')"
check "set-member-for keeps .suffix" "checkout" "$("$SS" "$f" get | jq -r '.members[]|select(.wt=="wt_b1")|.suffix')"
check "set-member-for keeps .owns" "2" "$("$SS" "$f" get | jq '.members[]|select(.wt=="wt_b1")|.owns|length')"
check "set-member-for re-derives assignments" "structures" "$("$SS" "$f" get | jq -r '.assignments[0].thinker')"
# remove-member drops it and re-derives worktrees
"$SS" "$f" remove-member wt_b1 >/dev/null
check "remove-member drops it" "2" "$("$SS" "$f" get | jq '.members | length')"
check "worktrees re-derived after remove" "wt_lead wt_t1" "$("$SS" "$f" get | jq -r '.worktrees|sort|join(" ")')"
check "assignments empty after builder removed" "0" "$("$SS" "$f" get | jq '.assignments | length')"

# 5f-bis. RESTART dedup: a restarted member keeps its LABEL (role-suffix) but gets a NEW wt. add-member
# must upsert by LABEL (not wt) — one row per label — else a stale GONE twin lingers and close-role
# retires the wrong worker. owns is carried forward when the restart doesn't re-supply it.
"$SS" "$f" add-member builder u4 wt_old --owns u4 --for onboarding >/dev/null
check "builder added (pre-restart)" "3" "$("$SS" "$f" get | jq '.members | length')"
"$SS" "$f" add-member builder u4 wt_new >/dev/null   # restart: same label, new wt, no owns re-supplied
check "restart upserts by label (no twin)"   "3"      "$("$SS" "$f" get | jq '.members | length')"
check "restart points to the NEW worktree"   "wt_new" "$("$SS" "$f" get | jq -r '.members[]|select(.role=="builder")|.wt')"
check "restart carries owns forward"          "u4"    "$("$SS" "$f" get | jq -r '.members[]|select(.role=="builder")|.owns[0]')"
check "old builder worktree is gone"          "0"     "$("$SS" "$f" get | jq '[.worktrees[]|select(.=="wt_old")]|length')"
"$SS" "$f" remove-member wt_new >/dev/null

# 5g. spawn params for replication.
f="$(tmp)"; rm -f "$f"
"$SS" "$f" set-spawn name:acme saved:env1 "manual testing" >/dev/null
check "repo recorded" "name:acme" "$("$SS" "$f" get | jq -r '.repo')"
check "host recorded" "saved:env1" "$("$SS" "$f" get | jq -r '.host')"
check "framing recorded" "manual testing" "$("$SS" "$f" get | jq -r '.framing')"
"$SS" "$f" set-host "" >/dev/null
check "empty host -> null" "null" "$("$SS" "$f" get | jq -r '.host')"

# 5h2. cleanup commands append (unique) for teardown.
f="$(tmp)"; rm -f "$f"
check "cleanup defaults empty" "0" "$("$SS" "$f" get | jq '.cleanup | length')"
"$SS" "$f" add-cleanup "echo stop1" >/dev/null
"$SS" "$f" add-cleanup "echo stop1" >/dev/null
"$SS" "$f" add-cleanup "echo stop2" >/dev/null
check "add-cleanup appends unique" "2" "$("$SS" "$f" get | jq '.cleanup | length')"

# 5h. add-unit records the source plan, canonical absolute (U181: a relative plan is anchored
# at the dev-studio root, so it matches the approval whatever was typed).
f="$(tmp)"; rm -f "$f"
"$SS" "$f" add-unit deposit wt_b1 planA.md >/dev/null 2>&1
check "unit records its plan" "$(cd "$(dirname "${DS_STATE_ROOT:-$DS_STATE_ROOT}")" && pwd -P)/planA.md" "$("$SS" "$f" get | jq -r '.units[0].plan')"

# 5i. rekey-member: Orca rotated a worktree id — repoint the member in place, preserving its
# role/suffix/owns/for, and follow the id through lead_wt, units[].builder_wt, worktrees[].
f="$(tmp)"; rm -f "$f"
"$SS" "$f" set-lead wtLead >/dev/null
"$SS" "$f" add-member lead "" wtLead >/dev/null
"$SS" "$f" add-member builder checkout wtB --owns checkout --for structures >/dev/null
"$SS" "$f" add-unit checkout wtB planA.md >/dev/null 2>&1
"$SS" "$f" rekey-member wtB wtB2 >/dev/null
check "rekey repoints the member wt"        "wtB2" "$("$SS" "$f" get | jq -r '.members[]|select(.suffix=="checkout").wt')"
check "rekey preserves the member for"      "structures" "$("$SS" "$f" get | jq -r '.members[]|select(.wt=="wtB2").for')"
check "rekey preserves the member owns"     "checkout" "$("$SS" "$f" get | jq -r '.members[]|select(.wt=="wtB2").owns[0]')"
check "rekey follows units.builder_wt"      "wtB2" "$("$SS" "$f" get | jq -r '.units[]|select(.slug=="checkout").builder_wt')"
check "rekey rebuilds worktrees[]"          "wtB2,wtLead" "$("$SS" "$f" get | jq -r '.worktrees|sort|join(",")')"
check "rekey leaves other members alone"    "wtLead" "$("$SS" "$f" get | jq -r '.members[]|select(.role=="lead").wt')"
"$SS" "$f" rekey-member wtLead wtLead2 >/dev/null
check "rekey follows lead_wt"               "wtLead2" "$("$SS" "$f" get | jq -r '.lead_wt')"

# 6. Writes always leave valid JSON and no stray temp file.
f="$(tmp)"
"$SS" "$f" set-debrief "d
Try it: nothing to try by hand — x" >/dev/null
tryit "$f"
"$SS" "$f" set-status "done" >/dev/null
check "write leaves valid json" "ok" "$(jq -e . "$f" >/dev/null 2>&1 && echo ok || echo bad)"
check "no stray temp left" "0" "$(find "$(dirname "$f")" -name '.squad-state.*' 2>/dev/null | wc -l | tr -d ' ')"

# A question raised with a card note (ask-operator passes the pinged worktree) clears that note
# once it is answered (resolve-question) — but not while another open question still uses it.
f="$(tmp)"; "$SS" "$f" init demo t > /dev/null 2>&1 || true
cl="$(tmp)"; cs="$(tmp)"; printf '#!/usr/bin/env bash\necho "$*" >> "%s"\n' "$cl" > "$cs"; chmod +x "$cs"
BACKEND="$cs" "$SS" "$f" enqueue-question qa thinker true "A?" wtTh >/dev/null
BACKEND="$cs" "$SS" "$f" enqueue-question qb thinker false "B?" wtTh >/dev/null
check "enqueue records the card worktree" "wtTh" "$("$SS" "$f" get | jq -r '.waiting_on_you[0].card_wt')"
BACKEND="$cs" "$SS" "$f" resolve-question qa >/dev/null
check "answering one keeps the card while another question uses it" "0" "$(grep -c '^ping' "$cl")"
BACKEND="$cs" "$SS" "$f" resolve-question qb >/dev/null
check "answering the last one clears its card note" "1" "$(grep -cx 'ping wtTh ' "$cl")"
"$SS" "$f" enqueue-question qc builder true "C?" >/dev/null; : > "$cl"
BACKEND="$cs" "$SS" "$f" resolve-question qc >/dev/null
check "a question with no card note pings nothing" "0" "$(grep -c . "$cl")"
rm -f "$f" "$cl" "$cs"

# enqueue-question is an upsert by id: re-asking the same question replaces it, never twins it.
f="$(tmp)"
"$SS" "$f" enqueue-question qx thinker true "first" >/dev/null
"$SS" "$f" enqueue-question qx thinker true "second" >/dev/null
check "re-enqueue same id -> one entry" "1" "$("$SS" "$f" get | jq '.waiting_on_you | length')"
check "re-enqueue same id -> newest text" "second" "$("$SS" "$f" get | jq -r '.waiting_on_you[0].question')"

# suggestion/why ride along as optional 6th/7th args (after card_wt); omitted -> no keys.
f="$(tmp)"
"$SS" "$f" enqueue-question qs lead true "v2?" "" "yes" "only new endpoints" >/dev/null
check "enqueue stores suggestion" "yes" "$("$SS" "$f" get | jq -r '.waiting_on_you[0].suggestion')"
check "enqueue stores why" "only new endpoints" "$("$SS" "$f" get | jq -r '.waiting_on_you[0].why')"
check "empty card_wt stays absent" "null" "$("$SS" "$f" get | jq -r '.waiting_on_you[0].card_wt')"
"$SS" "$f" enqueue-question qt lead true "plain?" >/dev/null
check "no suggestion -> no key" "false" "$("$SS" "$f" get | jq '.waiting_on_you[1] | has("suggestion") or has("why")')"

# options ride along as an optional 8th arg ('A|B|C' -> an array); omitted -> no key.
f="$(tmp)"
"$SS" "$f" enqueue-question qo lead true "which db?" "" "Postgres" "we run it" "Postgres|SQLite|both" >/dev/null
check "enqueue stores options" '["Postgres","SQLite","both"]' "$("$SS" "$f" get | jq -c '.waiting_on_you[0].options')"
"$SS" "$f" enqueue-question qp lead true "plain?" >/dev/null
check "no options -> no key" "false" "$("$SS" "$f" get | jq '.waiting_on_you[1] | has("options")')"

# accounts: member account/fallback (absent = default login), unit wait_until holds a unit out of ready-units.
a="$(tmp)"; rm -f "$a"
"$SS" "$a" add-member builder u1 wtA --account b --fallback --model sonnet >/dev/null
"$SS" "$a" add-member builder u2 wtB >/dev/null
check "member account recorded"            "b/true" "$("$SS" "$a" get | jq -r '.members[]|select(.wt=="wtA")|"\(.account)/\(.fallback)"')"
check "no account: key absent (default)"   "null/null" "$("$SS" "$a" get | jq -r '.members[]|select(.wt=="wtB")|"\(.account)/\(.fallback)"')"
"$SS" "$a" add-unit u1 >/dev/null; "$SS" "$a" add-unit u2 >/dev/null 2>&1
"$SS" "$a" set-unit-wait u1 "$(( $(date +%s) + 3600 ))" >/dev/null
check "waiting unit skipped by ready-units" "u2" "$("$SS" "$a" ready-units | tr '\n' ' ' | sed 's/ $//')"
"$SS" "$a" set-unit-wait u1 "$(( $(date +%s) - 5 ))" >/dev/null
check "wait passed: ready again"           "u1 u2" "$("$SS" "$a" ready-units | tr '\n' ' ' | sed 's/ $//')"
"$SS" "$a" set-unit-wait u1 "$(( $(date +%s) + 3600 ))" >/dev/null
"$SS" "$a" set-unit-status u1 dispatched wtA >/dev/null
check "dispatching clears wait_until"      "null" "$("$SS" "$a" get | jq -r '.units[]|select(.slug=="u1")|.wait_until')"
"$SS" "$a" set-unit-wait u2 100 >/dev/null; "$SS" "$a" set-unit-wait u2 "" >/dev/null
check "set-unit-wait '' clears"            "null" "$("$SS" "$a" get | jq -r '.units[]|select(.slug=="u2")|.wait_until')"
check "set-unit-wait rejects non-digits"   "2" "$("$SS" "$a" set-unit-wait u1 soon >/dev/null 2>&1; echo $?)"

# ext_deps: a unit waits on another squad's unit (<squad>/<slug>), resolved against the sibling
# state files and archives of the same label dir. Fail-closed: a missing peer blocks.
L="$(mktemp -d "${TMPDIR:-/tmp}/squad-state-ext.XXXXXX")"; mkdir -p "$L/squads" "$L/archive"
A="$L/squads/a.json"; B="$L/squads/b.json"
"$SS" "$B" add-unit y >/dev/null 2>&1
"$SS" "$A" add-unit x --ext-dep b/y --tier standard >/dev/null 2>&1
"$SS" "$A" add-unit w >/dev/null 2>&1
check "add-unit --ext-dep stores ext_deps"   '["b/y"]' "$("$SS" "$A" get | jq -c '.units[]|select(.slug=="x").ext_deps')"
check "no --ext-dep -> no ext_deps key"      "false" "$("$SS" "$A" get | jq '.units[]|select(.slug=="w")|has("ext_deps")')"
check "ext dep planned -> unit not ready"    "w" "$("$SS" "$A" ready-units | tr '\n' ' ' | sed 's/ $//')"
check "ext-deps-status shows the peer status" "$(printf 'b/y\tplanned')" "$("$SS" "$A" ext-deps-status x)"
"$SS" "$B" set-unit-status y "done" --no-pr >/dev/null
check "peer unit done -> unit ready"         "x w" "$("$SS" "$A" ready-units | tr '\n' ' ' | sed 's/ $//')"
check "ext-deps-status says done"            "$(printf 'b/y\tdone')" "$("$SS" "$A" ext-deps-status x)"
# The peer squad closed: close-squad archived it with .topic and a timestamped name.
jq '.status="closed" | .topic="b"' "$B" > "$L/archive/b-20261001-120000.json"; rm -f "$B"
check "archived peer with unit done -> ready" "x w" "$("$SS" "$A" ready-units | tr '\n' ' ' | sed 's/ $//')"
check "ext-deps-status says closed-done"     "$(printf 'b/y\tclosed-done')" "$("$SS" "$A" ext-deps-status x)"
# An archive of a different squad whose name starts with "b-" does not count.
mv "$L/archive/b-20261001-120000.json" "$L/archive/b-two-20261001-120000.json"
jq '.topic="b-two"' "$L/archive/b-two-20261001-120000.json" > "$L/t" && mv "$L/t" "$L/archive/b-two-20261001-120000.json"
check "another squad's archive is not b's"    "missing" "$("$SS" "$A" ext-deps-status x | cut -f2)"
"$SS" "$A" add-ext-dep x c/z >/dev/null
"$SS" "$A" add-ext-dep x c/z >/dev/null
check "add-ext-dep appends (unique)"         '["b/y","c/z"]' "$("$SS" "$A" get | jq -c '.units[]|select(.slug=="x").ext_deps')"
check "missing peer squad -> missing"        "$(printf 'b/y\tmissing\nc/z\tmissing')" "$("$SS" "$A" ext-deps-status x)"
check "missing peer -> unit not ready"       "w" "$("$SS" "$A" ready-units | tr '\n' ' ' | sed 's/ $//')"
"$SS" "$A" drop-ext-dep x b/y >/dev/null
"$SS" "$A" drop-ext-dep x c/z >/dev/null
check "dropping the last ext dep removes the key" "false" "$("$SS" "$A" get | jq '.units[]|select(.slug=="x")|has("ext_deps")')"
check "drop-ext-dep -> unit ready"           "x w" "$("$SS" "$A" ready-units | tr '\n' ' ' | sed 's/ $//')"
check "bad ext dep ref rejected"             "2" "$("$SS" "$A" add-ext-dep x nope >/dev/null 2>&1; echo $?)"
check "ext dep ref with two slashes rejected" "2" "$("$SS" "$A" add-unit v --ext-dep a/b/c >/dev/null 2>&1; echo $?)"
check "add-ext-dep on an unknown unit fails" "1" "$("$SS" "$A" add-ext-dep nope b/y >/dev/null 2>&1; echo $?)"
# A same-squad dep and an ext dep both have to be met.
"$SS" "$L/squads/b.json" add-unit y >/dev/null 2>&1; "$SS" "$L/squads/b.json" set-unit-status y "done" --no-pr >/dev/null 2>&1
"$SS" "$A" add-unit v "" "" w --ext-dep b/y >/dev/null 2>&1
check "ext dep done but same-squad dep not -> not ready" "x w" "$("$SS" "$A" ready-units | tr '\n' ' ' | sed 's/ $//')"

# Every state shape the script writes validates against state/SCHEMA.json (additionalProperties:false
# is strict, so a key the schema misses breaks readers that validate). A small jq validator for the
# subset the schema uses: type, required, additionalProperties:false, properties, items, enum, pattern.
schema_errors() { # schema_errors <state-file> -> one line per violation
  jq -r --slurpfile S "$ROOT/state/SCHEMA.json" '
    def v($s; $p):
      . as $x | type as $t
      | ( if $s.type and ([$s.type] | flatten | index($t) | not) then "\($p): type \($t)" else empty end ),
      ( if $s.enum and ($s.enum | index([$x]) | not) then "\($p): \($x) not in enum" else empty end ),
      ( if $s.pattern and type=="string" and (test($s.pattern) | not) then "\($p): \(.) !~ \($s.pattern)" else empty end ),
      ( if type=="object" then
          (($s.required // [])[] as $k | if has($k) then empty else "\($p): missing \($k)" end),
          (keys[] as $k | if ($s.properties // {}) | has($k) then (.[$k] | v($s.properties[$k]; "\($p).\($k)"))
                          elif $s.additionalProperties == false then "\($p): unknown key \($k)" else empty end)
        else empty end ),
      ( if type=="array" and $s.items then to_entries[] | .key as $i | .value | v($s.items; "\($p)[\($i)]") else empty end );
    v($S[0]; "$")' "$1"
}
"$SS" "$A" set-unit-tier x hard >/dev/null
"$SS" "$A" set-unit-pr x 12 >/dev/null
"$SS" "$A" add-ext-dep x b/y >/dev/null
"$SS" "$A" set-unit-wait w 100 >/dev/null
"$SS" "$A" add-member builder x wtX --owns x --for t --account acc --fallback >/dev/null
"$SS" "$A" enqueue-question q1 lead true "?" wtX "yes" "why" "A|B" "title" '[{"label":"A","does":"a"}]' >/dev/null
"$SS" "$A" approve-plan p.md >/dev/null
"$SS" "$A" propose-squad f1 t r fr >/dev/null
"$SS" "$A" log-assumption d r >/dev/null
"$SS" "$A" set-status suspended >/dev/null
check "full fixture has deps/tier/pr/ext_deps" "true" "$("$SS" "$A" get | jq '.units[]|select(.slug=="x")|has("deps") and has("tier") and has("pr") and has("ext_deps")')"
check "full fixture validates against SCHEMA.json" "" "$(schema_errors "$A")"
"$SS" "$A" set-debrief "set out / shipped / learned / open / cost
Try it: nothing to try by hand — x" >/dev/null
check "a debrief validates against SCHEMA.json" "" "$(schema_errors "$A")"
"$SS" "$A" set-unit-urgent x on --why 'need first' >/dev/null
check "urgent unit validates against SCHEMA.json" "" "$(schema_errors "$A")"
"$SS" "$A" revoke-plan p.md --why 'approved by mistake' >/dev/null
check "a revoked plan validates against SCHEMA.json" "" "$(schema_errors "$A")"
jq '.units[0].lane = "light" | .units[0].lane_rule = "contracts-only"' "$A" > "$L/lane.json"
check "a unit with lane and lane_rule validates against SCHEMA.json" "" "$(schema_errors "$L/lane.json")"
jq '.units[0].lane = "fast"' "$A" > "$L/lane-bad.json"
check "schema check catches an unknown lane" "1" "$(schema_errors "$L/lane-bad.json" | wc -l | tr -d ' ')"
jq '.units[0].ext_deps = ["bad"] | .units[0].bogus = 1' "$A" > "$L/bad.json"
check "schema check catches a bad ext dep and an unknown key" "2" "$(schema_errors "$L/bad.json" | wc -l | tr -d ' ')"
rm -rf "$L"

# U220. wait-on: a started unit waits on another; blocks: in a plan does it at register-plan.
w="$(tmp)"
"$SS" "$w" add-unit fix --tier standard >/dev/null 2>&1; "$SS" "$w" add-unit job --tier standard >/dev/null 2>&1; "$SS" "$w" add-unit done1 --tier standard >/dev/null 2>&1
"$SS" "$w" set-unit-status job dispatched >/dev/null; "$SS" "$w" set-unit-status done1 "done" --no-pr >/dev/null 2>&1
check "wait-on adds the dep and the reason" "fix|fix first" "$("$SS" "$w" wait-on job fix --why 'fix first' >/dev/null 2>&1; "$SS" "$w" get | jq -r '.units[] | select(.slug == "job") | "\(.deps | join(","))|\(.wait_on.fix)"')"
before="$(cat "$w")"
check "wait-on again exits 0" "0" "$("$SS" "$w" wait-on job fix --why 'again' >/dev/null 2>&1; echo $?)"
check "wait-on again changes nothing" "$before" "$(cat "$w")"
check "wait-on needs --why" "2" "$("$SS" "$w" wait-on job fix >/dev/null 2>&1; echo $?)"
check "wait-on refuses itself" "1" "$("$SS" "$w" wait-on job job --why x >/dev/null 2>&1; echo $?)"
check "wait-on refuses an unknown dep" "1" "$("$SS" "$w" wait-on job nope --why x >/dev/null 2>&1; echo $?)"
check "wait-on refuses an unknown unit" "1" "$("$SS" "$w" wait-on nope fix --why x >/dev/null 2>&1; echo $?)"
check "wait-on refuses a done unit" "1" "$("$SS" "$w" wait-on done1 fix --why x >/dev/null 2>&1; echo $?)"
"$SS" "$w" set-unit-status fix dispatched >/dev/null
check "wait-on refuses a cycle" "1" "$("$SS" "$w" wait-on fix job --why x >/dev/null 2>&1; echo $?)"
"$SS" "$w" wait-off job fix >/dev/null 2>&1
check "wait-off removes the dep and the reason" "0 false" "$("$SS" "$w" get | jq -r '.units[] | select(.slug == "job") | "\(.deps | length) \(has("wait_on"))"')"
check "wait-on state validates against SCHEMA.json" "" "$("$SS" "$w" wait-on job fix --why x >/dev/null 2>&1; schema_errors "$w")"
w="$(tmp)"
printf 'U1 — Job — deps: none — Tier: standard\nU2 — Fix first — deps: none — Tier: standard — blocks: U1\n' > "$w.plan"
"$SS" "$w" register-plan "$w.plan" >/dev/null 2>&1
"$SS" "$w" set-unit-status u1-job dispatched >/dev/null
"$SS" "$w" register-plan "$w.plan" >/dev/null 2>&1
check "register-plan blocks: makes the named unit wait" "u2-fix-first" "$("$SS" "$w" get | jq -r '.units[] | select(.slug == "u1-job") | .deps | join(",")')"
check "register-plan blocks: reason is the plan" "1" "$("$SS" "$w" get | jq -r '.units[] | select(.slug == "u1-job") | .wait_on["u2-fix-first"]' | grep -c 'blocked by U2')"
"$SS" "$w" register-plan "$w.plan" >/dev/null 2>&1
check "register-plan re-run keeps the wait" "u2-fix-first" "$("$SS" "$w" get | jq -r '.units[] | select(.slug == "u1-job") | .deps | join(",")')"
check "register-plan: u1 is not ready, u2 is" "u2-fix-first" "$("$SS" "$w" ready-units | paste -sd' ' -)"
for bad in "U9" "U2" "none"; do
  printf 'U1 — Job — deps: none — Tier: standard\nU2 — Fix first — deps: none — Tier: standard — blocks: %s\n' "$bad" > "$w.bad"
  check "register-plan blocks: $bad is refused" "1" "$("$SS" "$(tmp)" register-plan "$w.bad" >/dev/null 2>&1; echo $?)"
done
w2="$(tmp)"; printf 'U1 — Job — deps: none — Tier: standard\n' > "$w.p2"
"$SS" "$w2" register-plan "$w.p2" >/dev/null 2>&1; "$SS" "$w2" set-unit-status u1-job "done" --no-pr >/dev/null 2>&1
printf 'U1 — Job — deps: none — Tier: standard\nU2 — Fix first — deps: none — Tier: standard — blocks: U1\n' > "$w.p2"
check "register-plan blocks: a done unit is refused and nothing is written" "1 0" "$("$SS" "$w2" register-plan "$w.p2" >/dev/null 2>&1; echo -n "$? "; "$SS" "$w2" get | jq -r '.units | map(select(.slug == "u2-fix-first")) | length')"

# register-plan: a plan's unit lines -> one unit each (plan, plan_unit, deps as slugs, tier), all-or-nothing.
R="$(fixdir squad-state-rp)"
FX="$ROOT/tests/fixtures"
cp "$FX/register-plan.md" "$R/plan.md"; P="$(realpath "$R/plan.md")"
s="$R/s.json"
out="$("$SS" "$s" register-plan "$R/plan.md" 2>"$R/err")"; rc=$?
check "register-plan exits 0" "0" "$rc"
check "register-plan: one unit per U<n> line" "u1-work-units-hide-finished u2-board-shows-untagged-tier u3-dep-less-docs-work u24b-parser-edge-case" \
  "$("$SS" "$s" get | jq -r '[.units[].slug] | join(" ")')"
check "register-plan prints slug/status/tier/deps" "$(printf 'u1-work-units-hide-finished\tadded\tstandard\t-')" "$(head -n1 <<< "$out")"
check "register-plan records plan (canonical) + plan_unit" "$P U24b" "$("$SS" "$s" get | jq -r '.units[3] | "\(.plan) \(.plan_unit)"')"
check "register-plan: deps resolve to slugs" "u1-work-units-hide-finished" "$("$SS" "$s" get | jq -r '.units[1].deps | join(",")')"
check "register-plan: deps on two units" "u2-board-shows-untagged-tier,u3-dep-less-docs-work" "$("$SS" "$s" get | jq -r '.units[3].deps | join(",")')"
check "register-plan: tiers (Hard because … reads hard)" "standard hard standard hard" "$("$SS" "$s" get | jq -r '[.units[].tier] | join(" ")')"
check "register-plan: (HELD) after the tier sets hold" "false false true false" "$("$SS" "$s" get | jq -r '[.units[].hold] | join(" ")')"
check "register-plan: a held unit is skipped by ready-units" "u1-work-units-hide-finished" "$("$SS" "$s" ready-units | tr '\n' ' ' | sed 's/ $//')"
check "register-plan: unapproved plan -> note on stderr" "1" "$(grep -c 'is not approved yet' "$R/err")"
check "register-plan state validates against SCHEMA.json" "" "$(schema_errors "$s")"
# The tier -> roster row rule (builder-standard / builder): tests/loop/pick.test.ts.
# A second run changes nothing.
before="$(cat "$s")"
out="$("$SS" "$s" approve-plan "$R/plan.md" >/dev/null; "$SS" "$s" register-plan "$R/plan.md" 2>"$R/err")"
check "re-run says unchanged for every unit" "unchanged unchanged unchanged unchanged" "$(cut -f2 <<< "$out" | tr '\n' ' ' | sed 's/ $//')"
check "re-run adds nothing" "4" "$("$SS" "$s" get | jq '.units | length')"
check "re-run on an approved plan prints no note" "" "$(cat "$R/err")"
check "re-run leaves the units as they were" "$(jq -c '.units' <<< "$before")" "$("$SS" "$s" get | jq -c '.units')"
# A revised plan updates the same slugs; dispatch fields stay; an escalated unit stays hard.
"$SS" "$s" set-unit-status u1-work-units-hide-finished dispatched wtU1 >/dev/null
"$SS" "$s" set-unit-pr u1-work-units-hide-finished 42 >/dev/null
"$SS" "$s" set-unit-tier u1-work-units-hide-finished hard >/dev/null
cp "$FX/register-plan-revised.md" "$R/plan.md"
out="$("$SS" "$s" register-plan "$R/plan.md" 2>"$R/err")"
check "revised plan keeps the slugs" "u1-work-units-hide-finished u2-board-shows-untagged-tier u3-dep-less-docs-work u24b-parser-edge-case" \
  "$("$SS" "$s" get | jq -r '[.units[].slug] | join(" ")')"
# U6: the title is stored on the unit now, so a renamed title is an update (the slug and the escalated tier stay).
check "renamed title + escalated -> updated, slug and tier kept" "$(printf 'u1-work-units-hide-finished\tupdated\thard\t-')" "$(head -n1 <<< "$out")"
check "dispatched unit keeps status/builder_wt/pr" "dispatched wtU1 42" "$("$SS" "$s" get | jq -r '.units[0] | "\(.status) \(.builder_wt) \(.pr)"')"
check "escalated unit stays hard" "hard true" "$("$SS" "$s" get | jq -r '.units[0] | "\(.tier) \(.escalated)"')"
check "changed deps -> updated" "$(printf 'u2-board-shows-untagged-tier\tupdated\thard\t-')" "$(sed -n 2p <<< "$out")"
check "changed tier + deps -> updated" "$(printf 'u24b-parser-edge-case\tupdated\tstandard\tu2-board-shows-untagged-tier')" "$(sed -n 3p <<< "$out")"
check "a unit with no line in the plan is left as is" "planned true" "$("$SS" "$s" get | jq -r '.units[2] | "\(.status) \(.hold)"')"
check "... and stderr says so" "1" "$(grep -c "'u3-dep-less-docs-work' has no unit line in .* — left as is" "$R/err")"
check "re-run does not clear a hold" "true" "$("$SS" "$s" get | jq -r '.units[2].hold')"

# Refusals: exit 1 and the state file is byte-identical.
refuse() { # refuse <description> <plan text> [state file]
  local st="${3:-$s}" pre rc
  printf '%s\n' "$2" > "$R/bad.md"; pre="$(cat "$st")"
  "$SS" "$st" register-plan "$R/bad.md" >/dev/null 2>"$R/err"; rc=$?
  check "refuse $1: exit 1" "1" "$rc"
  check "refuse $1: state untouched" "$pre" "$(cat "$st")"
  check "refuse $1: says why" "1" "$(grep -c 'register-plan: ' "$R/err")"
}
refuse "missing Tier"      "U1 — fine — deps: none — Tier: hard
U2 — no tier — deps: none"
check "the refusal names the line" "1" "$(grep -c 'line 2: U2 has no Tier' "$R/err")"
refuse "unknown tier"      "U1 — x — deps: none — Tier: medium"
refuse "unknown dep"       "U1 — x — deps: U9 — Tier: hard"
refuse "duplicate id"      "U1 — x — deps: none — Tier: hard
U1 — y — deps: none — Tier: hard"
refuse "malformed line"    "U1 — x — deps: none — Tier: hard
- U2 —no space — deps: none — Tier: hard"
refuse "E1 dep"            "U1 — x — deps: E1 — Tier: hard"
refuse "external dep"      "U1 — x — deps: external auth work — Tier: hard"
refuse "self dep"          "U1 — x — deps: U1 — Tier: hard"
refuse "field after Tier"  "U1 — x — deps: none — Tier: hard — oops"
refuse "no unit lines"     "### U1. Heading only
U1 gains one item."
pre="$(cat "$s")"; "$SS" "$s" register-plan "$R/nope.md" >/dev/null 2>&1; rc=$?
check "refuse a missing plan file" "1 yes" "$rc $([ "$pre" = "$(cat "$s")" ] && echo yes)"

# Adoption: a non-done u<n>- unit with no plan_unit and an empty (or this) plan is this plan's U<n>.
cp "$FX/register-plan.md" "$R/plan.md"
a="$R/adopt.json"
"$SS" "$a" add-unit U1-legacy wtL >/dev/null 2>&1
"$SS" "$a" add-unit u2-full "" "$R/plan.md" "" --tier hard >/dev/null 2>&1
"$SS" "$a" set-unit-status u2-full dispatched wt2 >/dev/null
"$SS" "$a" add-unit u3-was-done --tier standard >/dev/null 2>&1
"$SS" "$a" set-unit-status u3-was-done "done" --no-pr >/dev/null
out="$("$SS" "$a" register-plan "$R/plan.md" 2>"$R/err")"
check "adopts a legacy unit with an empty plan" "U1 adopted" "$("$SS" "$a" get | jq -r '.units[]|select(.slug=="U1-legacy")|.plan_unit' | tr '\n' ' ')$(grep -P '^U1-legacy\t' <<< "$out" | cut -f2)"
check "adopts a unit added in the full form (this plan)" "U2 dispatched" "$("$SS" "$a" get | jq -r '.units[]|select(.slug=="u2-full")|"\(.plan_unit) \(.status)"')"
check "stderr says adopted" "2" "$(grep -cE 'adopted (U1-legacy as U1|u2-full as U2)' "$R/err")"
check "a done unit is not adopted" "null u3-dep-less-docs-work" "$("$SS" "$a" get | jq -r '(.units[]|select(.slug=="u3-was-done")|.plan_unit), (.units[]|select(.plan_unit=="U3")|.slug)' | tr '\n' ' ' | sed 's/ $//')"
check "adopted deps resolve to the adopted slug" "U1-legacy" "$("$SS" "$a" get | jq -r '.units[]|select(.slug=="u2-full")|.deps|join(",")')"
x="$R/amb.json"
"$SS" "$x" add-unit u1-a >/dev/null 2>&1; "$SS" "$x" add-unit U1-b >/dev/null 2>&1
refuse "ambiguous adoption" "U1 — x — deps: none — Tier: hard" "$x"

# Cross-plan deps: a dep id not in this plan resolves to a unit in state (by plan_unit, then a unique u<n>- slug).
c="$R/cross.json"
printf '%s\n' "U19 — rail payout — deps: none — Tier: hard" > "$R/rail.md"
"$SS" "$c" register-plan "$R/rail.md" >/dev/null 2>&1
"$SS" "$c" add-unit u7-old-thing --tier hard >/dev/null 2>&1
printf '%s\n' "U21 — rotation — deps: U19, U7 — Tier: standard" > "$R/rot.md"
"$SS" "$c" register-plan "$R/rot.md" >/dev/null 2>&1
check "dep on another plan's unit resolves to its slug" "u19-rail-payout,u7-old-thing" "$("$SS" "$c" get | jq -r '.units[]|select(.plan_unit=="U21")|.deps|join(",")')"
# A slug taken by another plan's unit gets -2.
printf '%s\n' "U19 — rail payout — deps: none — Tier: hard" > "$R/rail2.md"
"$SS" "$c" register-plan "$R/rail2.md" >/dev/null 2>&1
check "slug clash with another plan -> -2" "u19-rail-payout-2" "$("$SS" "$c" get | jq -r --arg p "$(realpath "$R/rail2.md")" '.units[]|select(.plan==$p)|.slug')"
check "slug from a backticked u<n>- token" "u5-my-slug" \
  "$(printf '%s\n' "U5 — build \`u5-my-slug\` here — deps: none — Tier: hard" > "$R/bt.md"; "$SS" "$R/bt.json" register-plan "$R/bt.md" 2>/dev/null | cut -f1)"
check "a backticked token that is not a valid slug is ignored" "u8-take-u8-bad-slug" \
  "$(printf '%s\n' "U8 — take \`u8-bad slug\` — deps: none — Tier: hard" > "$R/bt8.md"; "$SS" "$R/bt8.json" register-plan "$R/bt8.md" 2>/dev/null | cut -f1)"
check "slug capped at 32 chars, no trailing -" "u6-aaaaaaaaaa-bbbbbbbbbb-cccccc" \
  "$(printf '%s\n' 'U6 — aaaaaaaaaa bbbbbbbbbb cccccc dddd eeee — deps: none — Tier: hard' > "$R/long.md"; "$SS" "$R/long.json" register-plan "$R/long.md" 2>/dev/null | cut -f1)"

# approve-plan / plan-approved compare canonical paths (~/, absolute and relative against the
# dev-studio root: a relative entry is stored absolute, so both sides match whatever was typed).
p="$R/ap.json"
# shellcheck disable=SC2088  # a literal ~/ the way a Lead might pass it quoted
"$SS" "$p" approve-plan "~/ds-rp-test-$$.md" >/dev/null
check "approve-plan ~/x.md then plan-approved /home/…/x.md" "yes" "$("$SS" "$p" plan-approved "$HOME/ds-rp-test-$$.md")"
# shellcheck disable=SC2016  # $x is a jq variable
hand "$p" --arg x "$R/sub/../old.md" '.approved_plans += [$x]'
check "an older non-canonical entry still matches" "yes" "$("$SS" "$p" plan-approved "$R/old.md")"
dev="$(cd "$(dirname "${DS_STATE_ROOT:-$DS_STATE_ROOT}")" && pwd -P)"
"$SS" "$p" approve-plan "plans/rel.md" >/dev/null
check "a relative plan is stored absolute (dev-studio root anchored)" "$dev/plans/rel.md" "$("$SS" "$p" get | jq -r '.approved_plans[] | select(endswith("rel.md"))')"
check "a relative plan matches from another directory" "yes" "$(cd "$R" && "$SS" "$p" plan-approved "plans/rel.md")"
check "an absolute plan matches its relative form" "yes" "$("$SS" "$p" plan-approved "$dev/plans/rel.md")"
check "another plan stays unapproved" "no" "$("$SS" "$p" plan-approved "$R/other.md")"
"$SS" "$R/au.json" add-unit u3-rel "" plans/rel.md --tier standard 2>/dev/null
check "add-unit stores a relative plan absolute" "$dev/plans/rel.md" "$("$SS" "$R/au.json" get | jq -r '.units[] | select(.slug=="u3-rel") | .plan')"

# add-unit warns (stderr, exit 0) when a field the Lead would need is missing.
w="$R/warn.json"
"$SS" "$w" add-unit u1-x "" plans/p.md 2>"$R/err"; rc=$?
check "add-unit without --tier warns, exits 0" "0 1" "$rc $(grep -c "warning: no --tier, unit 'u1-x' reads as hard" "$R/err")"
"$SS" "$w" add-unit u2-x --tier hard 2>"$R/err"
check "add-unit without a plan warns" "1" "$(grep -c "warning: no plan for 'u2-x' — plan-approved will read it as ad-hoc" "$R/err")"
"$SS" "$w" add-unit u3-x "" plans/p.md --tier hard 2>"$R/err"
check "add-unit with plan + tier is quiet" "" "$(cat "$R/err")"
"$SS" "$w" add-unit u4-x --hold --tier standard 2>"$R/err"
check "a --hold unit without a plan is quiet" "" "$(cat "$R/err")"
rm -rf "$R"

# 7. cancel-unit: fold a unit elsewhere (or drop it). --into takes a slug, U<n>, #N/PR#N, or nothing.
C="$(fixdir squad-state-cancel)"
c="$C/mt.json"
z="$(tmp)"; rm -f "$z"
check "missing file -> empty leftovers" "0" "$("$SS" "$z" get | jq '.leftovers | length')"
"$SS" "$c" add-unit u2 --tier standard >/dev/null 2>&1
"$SS" "$c" add-unit u3 "" "" u2 --tier standard >/dev/null 2>&1
"$SS" "$c" add-member builder u2 wtB2 --owns u2 --for t >/dev/null
"$SS" "$c" set-unit-status u2 dispatched wtB2 >/dev/null
out="$("$SS" "$c" cancel-unit u2 --into u3 --why "folded into u3" 2>"$C/err")"
check "cancel prints cancelled <slug> -> <into>" "cancelled u2 -> u3" "$(head -n1 <<< "$out")"
check "cancel prints the dependent line" "dependent u3: now ready" "$(sed -n 2p <<< "$out")"
check "cancel marks the unit cancelled" "cancelled" "$("$SS" "$c" get | jq -r '.units[]|select(.slug=="u2").status')"
check "cancel records superseded_by" "u3" "$("$SS" "$c" get | jq -r '.units[]|select(.slug=="u2").superseded_by')"
check "cancel records the reason" "folded into u3" "$("$SS" "$c" get | jq -r '.units[]|select(.slug=="u2").cancel_reason')"
check "cancel stamps cancelled_at" "true" "$("$SS" "$c" get | jq -r '.units[]|select(.slug=="u2").cancelled_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")')"
check "cancel retains the member until the loop closes it" "1" "$("$SS" "$c" get | jq '.members | length')"
check "cancel keeps the recorded worktree" "1" "$("$SS" "$c" get | jq '.worktrees | length')"
check "cancel keeps the recorded assignment" "1" "$("$SS" "$c" get | jq '.assignments | length')"
check "cancel has no manual retirement warning" "0" "$(grep -c "retire the Builder" "$C/err")"
# --into U<n> resolves via plan_unit; #N and PR#N both store PR#N; absent = dropped.
hand "$c" '(.units[]|select(.slug=="u3")|.plan_unit)="U3"'
"$SS" "$c" add-unit u4 --tier standard >/dev/null 2>&1
check "cancel --into U<n> resolves via plan_unit" "cancelled u4 -> u3" "$("$SS" "$c" cancel-unit u4 --into U3 2>/dev/null)"
"$SS" "$c" add-unit u5 --tier standard >/dev/null 2>&1
"$SS" "$c" cancel-unit u5 --into '#19717' >/dev/null 2>&1
check "cancel --into #N stores PR#N" "PR#19717" "$("$SS" "$c" get | jq -r '.units[]|select(.slug=="u5").superseded_by')"
"$SS" "$c" add-unit u6 --tier standard >/dev/null 2>&1
"$SS" "$c" cancel-unit u6 --into PR#41 >/dev/null 2>&1
check "cancel --into PR#N stores PR#N" "PR#41" "$("$SS" "$c" get | jq -r '.units[]|select(.slug=="u6").superseded_by')"
"$SS" "$c" add-unit u7 --tier standard >/dev/null 2>&1
"$SS" "$c" add-unit u8 "" "" u7 --tier standard >/dev/null 2>&1
out="$("$SS" "$c" cancel-unit u7 2>"$C/err7")"
check "cancel without --into prints no arrow" "cancelled u7" "$(head -n1 <<< "$out")"
check "cancel without --into leaves superseded_by absent" "false" "$("$SS" "$c" get | jq '.units[]|select(.slug=="u7")|has("superseded_by")')"
check "a dropped dep prints work dropped" "dependent u8: now blocked by u7 (cancelled, work dropped — drop the dep or replan)" "$(sed -n 2p <<< "$out")"
check "no member row -> no state-only note" "" "$(cat "$C/err7")"
"$SS" "$c" add-unit u9 --tier standard >/dev/null 2>&1
"$SS" "$c" set-unit-wait u9 9999999999 >/dev/null
"$SS" "$c" cancel-unit u9 >/dev/null 2>&1
check "cancel clears wait_until" "false" "$("$SS" "$c" get | jq '.units[]|select(.slug=="u9")|has("wait_until")')"

# 7b. cancel-unit refusals: exit 1, state byte-identical.
"$SS" "$c" add-unit uD --tier standard >/dev/null 2>&1
"$SS" "$c" set-unit-status uD "done" --no-pr >/dev/null
pre="$(cat "$c")"; "$SS" "$c" cancel-unit uD >/dev/null 2>"$C/err"; rc=$?
check "cancel refuses a done unit" "1" "$rc"
check "the done refusal says merged work can't be cancelled" "1" "$(grep -c "merged work can't be cancelled" "$C/err")"
check "the done refusal writes nothing" "$pre" "$(cat "$c")"
pre="$(cat "$c")"; "$SS" "$c" cancel-unit ghost >/dev/null 2>&1; rc=$?
check "cancel refuses an unknown slug" "1" "$rc"
check "the unknown-slug refusal writes nothing" "$pre" "$(cat "$c")"
pre="$(cat "$c")"; "$SS" "$c" cancel-unit u3 --into u3 >/dev/null 2>&1; rc=$?
check "cancel refuses --into itself" "1" "$rc"
check "the self refusal writes nothing" "$pre" "$(cat "$c")"
pre="$(cat "$c")"; "$SS" "$c" cancel-unit u3 --into nope >/dev/null 2>&1; rc=$?
check "cancel refuses --into an unknown unit" "1" "$rc"
check "the unknown-into refusal writes nothing" "$pre" "$(cat "$c")"
pre="$(cat "$c")"; "$SS" "$c" cancel-unit u3 --into U9 >/dev/null 2>&1; rc=$?
check "cancel refuses a U<n> that matches nothing" "1" "$rc"
check "the unmatched-U refusal writes nothing" "$pre" "$(cat "$c")"
"$SS" "$c" add-unit u4b --tier standard >/dev/null 2>&1
hand "$c" '(.units[]|select(.slug=="u4b")|.plan_unit)="U3"'
pre="$(cat "$c")"; "$SS" "$c" cancel-unit u3 --into U3 >/dev/null 2>"$C/err"; rc=$?
check "cancel refuses an ambiguous U<n>" "1" "$rc"
check "the ambiguous refusal says use the slug" "1" "$(grep -c "ambiguous — use the slug" "$C/err")"
check "the ambiguous refusal writes nothing" "$pre" "$(cat "$c")"

# 7c. --check validates and prints into= without writing (close-role's preflight).
pre="$(cat "$c")"
check "check prints into=<slug>" "into=u3" "$("$SS" "$c" cancel-unit u8 --into u3 --check)"
check "check writes nothing" "$pre" "$(cat "$c")"
check "check prints into=PR#N" "into=PR#19717" "$("$SS" "$c" cancel-unit u8 --into '#19717' --check)"
check "check without --into prints into=none" "into=none" "$("$SS" "$c" cancel-unit u8 --check)"
check "check writes nothing (none)" "$pre" "$(cat "$c")"
"$SS" "$c" cancel-unit uD --check >/dev/null 2>&1; rc=$?
check "check refuses a done unit" "1" "$rc"

# 7d. Re-running on a cancelled unit updates --into/--why only.
a1="$("$SS" "$c" get | jq -r '.units[]|select(.slug=="u5").cancelled_at')"
"$SS" "$c" cancel-unit u5 --into u3 --why "actually folded" >/dev/null 2>&1; rc=$?
check "re-run exits 0" "0" "$rc"
check "re-run updates superseded_by" "u3" "$("$SS" "$c" get | jq -r '.units[]|select(.slug=="u5").superseded_by')"
check "re-run updates cancel_reason" "actually folded" "$("$SS" "$c" get | jq -r '.units[]|select(.slug=="u5").cancel_reason')"
check "re-run keeps cancelled_at" "$a1" "$("$SS" "$c" get | jq -r '.units[]|select(.slug=="u5").cancelled_at')"
check "re-run stays cancelled" "cancelled" "$("$SS" "$c" get | jq -r '.units[]|select(.slug=="u5").status')"
"$SS" "$c" cancel-unit u5 >/dev/null 2>&1
check "re-run without flags keeps superseded_by" "u3" "$("$SS" "$c" get | jq -r '.units[]|select(.slug=="u5").superseded_by')"

# 7e. cancel-unit clears the sweep's questions about the dropped Builder (exact id match).
Q="$(fixdir squad-state-questions)"
q="$Q/mt.json"
"$SS" "$q" add-unit u2 --tier standard >/dev/null 2>&1
"$SS" "$q" add-member builder u2 wtB --owns u2 --for t >/dev/null
"$SS" "$q" set-unit-status u2 dispatched wtB >/dev/null
"$SS" "$q" set-status waiting-on-you >/dev/null
"$SS" "$q" enqueue-question sweep-mt.builder-u2-123 sweep false "restart builder-u2 of mt (exited)" >/dev/null
"$SS" "$q" enqueue-question sweep-mt.builder-u2-124 sweep false "recheck" >/dev/null
"$SS" "$q" enqueue-question 'sweep-mt.builder-u2|recheck-5' sweep false "recheck form" >/dev/null
"$SS" "$q" enqueue-question sweep-mt.builder-u2-fix-9 sweep false "sibling unit" >/dev/null
"$SS" "$q" enqueue-question other lead true "operator question" >/dev/null
"$SS" "$q" cancel-unit u2 --into PR#19717 >/dev/null 2>&1
check "cancel resolves the sweep questions about the Builder" "2" "$("$SS" "$q" get | jq '.waiting_on_you | length')"
check "the sibling builder-u2-fix entry survives" "1" "$("$SS" "$q" get | jq '[.waiting_on_you[]|select(.id=="sweep-mt.builder-u2-fix-9")] | length')"
check "a literal |recheck id clears too" "0" "$("$SS" "$q" get | jq '[.waiting_on_you[]|select(.id=="sweep-mt.builder-u2|recheck-5")] | length')"
check "a non-sweep question survives" "1" "$("$SS" "$q" get | jq '[.waiting_on_you[]|select(.id=="other")] | length')"
check "a non-empty queue stays waiting-on-you" "waiting-on-you" "$("$SS" "$q" get | jq -r '.status')"
q2="$Q/mt2.json"
"$SS" "$q2" add-unit u3 --tier standard >/dev/null 2>&1
"$SS" "$q2" add-member builder u3 wtB3 --owns u3 --for t >/dev/null
"$SS" "$q2" set-unit-status u3 dispatched wtB3 >/dev/null
"$SS" "$q2" set-status waiting-on-you >/dev/null
"$SS" "$q2" enqueue-question sweep-mt2.builder-u3-7 sweep false "restart" >/dev/null
"$SS" "$q2" cancel-unit u3 >/dev/null 2>&1
check "clearing the last question returns to running" "running" "$("$SS" "$q2" get | jq -r '.status')"
check "the queue is empty" "0" "$("$SS" "$q2" get | jq '.waiting_on_you | length')"
"$SS" "$q2" add-unit u4 --tier standard >/dev/null 2>&1
"$SS" "$q2" set-status waiting-on-you >/dev/null
"$SS" "$q2" enqueue-question sweep-mt2.builder-u4-8 sweep false "restart" >/dev/null
"$SS" "$q2" cancel-unit u4 >/dev/null 2>&1
check "no member row: falls back to builder-<slug>" "0" "$("$SS" "$q2" get | jq '.waiting_on_you | length')"
# Regex chars in the topic match literally: with topic my.topic, a myXtopic entry survives.
q3="$Q/my.topic.json"
"$SS" "$q3" add-unit u2 --tier standard >/dev/null 2>&1
"$SS" "$q3" add-member builder u2 wtB --owns u2 --for t >/dev/null
"$SS" "$q3" set-unit-status u2 dispatched wtB >/dev/null
"$SS" "$q3" enqueue-question sweep-my.topic.builder-u2-1 sweep false "restart" >/dev/null
"$SS" "$q3" enqueue-question sweep-myXtopic.builder-u2-1 sweep false "other topic" >/dev/null
"$SS" "$q3" cancel-unit u2 >/dev/null 2>&1
check "a dotted topic matches literally" "sweep-myXtopic.builder-u2-1" "$("$SS" "$q3" get | jq -r '.waiting_on_you[].id')"

# 7f. ready-units counts a cancelled dep only when its work landed elsewhere.
D="$(fixdir squad-state-deps)"
d="$D/mt.json"
"$SS" "$d" add-unit u1 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit u2 "" "" u1 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit u3 --tier standard >/dev/null 2>&1
"$SS" "$d" cancel-unit u1 --into u3 >/dev/null 2>&1
check "into-unit planned -> dependent not ready" "u3" "$("$SS" "$d" ready-units 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
"$SS" "$d" set-unit-status u3 dispatched wtX >/dev/null
check "into-unit dispatched -> dependent not ready" "" "$("$SS" "$d" ready-units 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
"$SS" "$d" set-unit-pr u3 99 >/dev/null; observe_pr "$d" u3 99 MERGED; "$SS" "$d" set-unit-status u3 "done" >/dev/null
check "into-unit done -> dependent ready" "u2" "$("$SS" "$d" ready-units 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
"$SS" "$d" add-unit u4 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit u5 "" "" u4 --tier standard >/dev/null 2>&1
"$SS" "$d" cancel-unit u4 --into PR#41 >/dev/null 2>&1
check "into-PR unmerged -> dependent not ready" "u2" "$("$SS" "$d" ready-units 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
"$SS" "$d" set-into-merged u4 >/dev/null
check "into-PR merged -> dependent ready" "u2 u5" "$("$SS" "$d" ready-units 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
"$SS" "$d" add-unit u6 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit u7 "" "" u6 --tier standard >/dev/null 2>&1
out="$("$SS" "$d" cancel-unit u6 --into u7 2>/dev/null)"
check "folded into its dependent counts as satisfied" "dependent u7: now ready" "$(sed -n 2p <<< "$out")"
check "the folded-into dependent is listed" "1" "$("$SS" "$d" ready-units 2>/dev/null | grep -c u7)"
"$SS" "$d" add-unit u8 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit u9 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit u10 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit u11 "" "" u8 --tier standard >/dev/null 2>&1
"$SS" "$d" cancel-unit u8 --into u9 >/dev/null 2>&1
"$SS" "$d" cancel-unit u9 --into u10 >/dev/null 2>&1
check "chain: end planned -> dependent not ready" "0" "$("$SS" "$d" ready-units 2>/dev/null | grep -c u11)"
"$SS" "$d" set-unit-status u10 "done" --no-pr >/dev/null
check "chain of two cancelled resolves when the end is done" "1" "$("$SS" "$d" ready-units 2>/dev/null | grep -c u11)"
"$SS" "$d" add-unit u12 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit u13 "" "" u12 --tier standard >/dev/null 2>&1
out="$("$SS" "$d" cancel-unit u12 2>/dev/null)"
check "dropped work: dependent line says work dropped" "dependent u13: now blocked by u12 (cancelled, work dropped — drop the dep or replan)" "$(sed -n 2p <<< "$out")"
check "dropped work: dependent not ready" "0" "$("$SS" "$d" ready-units 2>/dev/null | grep -c u13)"
check "ready-units says work dropped on stderr" "1" "$("$SS" "$d" ready-units 2>&1 >/dev/null | grep -c "blocked by u12 (cancelled, work dropped")"
"$SS" "$d" add-unit uh1 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit uh2 "" "" uh1 --hold --tier standard >/dev/null 2>&1
out="$("$SS" "$d" cancel-unit uh1 --into u3 2>/dev/null)"
check "a held dependent reports blocked (held)" "dependent uh2: now blocked (held)" "$(sed -n 2p <<< "$out")"
"$SS" "$d" add-unit uw1 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit uw2 "" "" uw1 --tier standard >/dev/null 2>&1
"$SS" "$d" set-unit-wait uw2 9999999999 >/dev/null
out="$("$SS" "$d" cancel-unit uw1 --into u3 2>/dev/null)"
check "a waiting dependent reports blocked (waiting)" "dependent uw2: now blocked (waiting)" "$(sed -n 2p <<< "$out")"
"$SS" "$d" add-unit ux1 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit ux2 "" "" ux1 --ext-dep mt2/nope --tier standard >/dev/null 2>&1
out="$("$SS" "$d" cancel-unit ux1 --into u3 2>/dev/null)"
check "an ext-blocked dependent names the ext ref" "dependent ux2: now blocked by mt2/nope" "$(sed -n 2p <<< "$out")"
"$SS" "$d" add-unit um1 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit um2 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit um3 "" "" um1 --tier standard >/dev/null 2>&1
"$SS" "$d" cancel-unit um1 --into um2 >/dev/null 2>&1
"$SS" "$d" cancel-unit um2 --into PR#77 >/dev/null 2>&1
check "chain into an unmerged PR -> not ready" "0" "$("$SS" "$d" ready-units 2>/dev/null | grep -c um3)"
"$SS" "$d" set-into-merged um2 >/dev/null
check "a chain ending in a merged PR unblocks" "1" "$("$SS" "$d" ready-units 2>/dev/null | grep -c um3)"
"$SS" "$d" add-unit uc1 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit uc2 --tier standard >/dev/null 2>&1
"$SS" "$d" add-unit uc3 "" "" uc1 --tier standard >/dev/null 2>&1
"$SS" "$d" cancel-unit uc1 --into uc2 >/dev/null 2>&1
"$SS" "$d" cancel-unit uc2 --into uc1 >/dev/null 2>&1
check "a cancel cycle terminates unsatisfied" "0" "$("$SS" "$d" ready-units 2>/dev/null | grep -c uc3)"
check "a cancelled unit itself is never listed" "0" "$("$SS" "$d" ready-units 2>/dev/null | grep -cw u6)"

# 7g. set-unit-status refuses done/dispatched on a cancelled unit; planned revives it.
E="$(fixdir squad-state-revive)"
e="$E/mt.json"
"$SS" "$e" add-unit u2 --tier standard >/dev/null 2>&1
"$SS" "$e" cancel-unit u2 --into PR#5 --why "x" >/dev/null 2>&1
"$SS" "$e" set-into-merged u2 >/dev/null
pre="$(cat "$e")"; "$SS" "$e" set-unit-status u2 "done" --no-pr >/dev/null 2>"$E/err"; rc=$?
check "done on a cancelled unit refuses" "1" "$rc"
check "the refusal says set it planned to revive it" "1" "$(grep -c "unit is cancelled — set it planned to revive it" "$E/err")"
check "the done-on-cancelled refusal writes nothing" "$pre" "$(cat "$e")"
"$SS" "$e" set-unit-status u2 dispatched wtX >/dev/null 2>&1; rc=$?
check "dispatched on a cancelled unit refuses" "1" "$rc"
"$SS" "$e" set-unit-status u2 planned >/dev/null
check "planned revives a cancelled unit" "planned" "$("$SS" "$e" get | jq -r '.units[0].status')"
check "reviving clears the four cancel fields" "false false false false" "$("$SS" "$e" get | jq -r '.units[0] | [has("superseded_by"),has("cancel_reason"),has("cancelled_at"),has("into_merged")] | join(" ")')"

# 7h. set-into-merged only touches a cancelled unit.
"$SS" "$e" add-unit u3 --tier standard >/dev/null 2>&1
pre="$(cat "$e")"; "$SS" "$e" set-into-merged u3 >/dev/null 2>&1; rc=$?
check "set-into-merged refuses a planned unit" "1" "$rc"
check "the set-into-merged refusal writes nothing" "$pre" "$(cat "$e")"
"$SS" "$e" set-into-merged ghost >/dev/null 2>&1; rc=$?
check "set-into-merged refuses an unknown unit" "1" "$rc"

# 7i. leftovers round-trip: add (upsert by wt) / list / drop.
L="$(fixdir squad-state-leftovers)"
l="$L/mt.json"
"$SS" "$l" add-leftover 'u1::/tmp/wt1' /tmp/wt1 feat 'uncommitted changes' 'PR#41' --unit u2 --file a.txt --file b.txt --n-files 2 --unpushed 1 >/dev/null
check "leftovers lists the record" "$(printf 'u1::/tmp/wt1\t/tmp/wt1\tfeat\t2\t1\tPR#41')" "$("$SS" "$l" leftovers)"
check "leftover records the unit + files" "u2 2" "$("$SS" "$l" get | jq -r '.leftovers[0] | "\(.unit) \(.files|length)"')"
check "leftover stamps recorded_at" "true" "$("$SS" "$l" get | jq -r '.leftovers[0].recorded_at | test("^[0-9]{4}")')"
"$SS" "$l" add-leftover 'u1::/tmp/wt1' /tmp/wt1 feat 'both' 'PR#41' --unit u2 >/dev/null
check "add-leftover upserts by wt" "1 both" "$("$SS" "$l" get | jq -r '.leftovers | "\(length) \(.[0].reason)"')"
"$SS" "$l" add-leftover wt2 /tmp/wt2 main 'unpushed commits' 'u3' >/dev/null
check "a bare add-leftover defaults files/n_files/unpushed" "0 0 0" "$("$SS" "$l" get | jq -r '.leftovers[]|select(.wt=="wt2") | "\(.files|length) \(.n_files) \(.unpushed)"')"
check "two records list as two lines" "2" "$("$SS" "$l" leftovers | wc -l | tr -d ' ')"
"$SS" "$l" drop-leftover 'u1::/tmp/wt1' >/dev/null
check "drop-leftover removes it" "wt2" "$("$SS" "$l" get | jq -r '.leftovers[].wt')"
"$SS" "$l" drop-leftover wt-missing >/dev/null; rc=$?
check "drop-leftover on an unknown wt is a silent no-op" "0" "$rc"
fargs=(); for i in $(seq 1 25); do fargs+=(--file "f$i.txt"); done
"$SS" "$l" add-leftover wt3 /p b r w "${fargs[@]}" >/dev/null
check "files keeps the first 20" "20 f1.txt f20.txt" "$("$SS" "$l" get | jq -r '.leftovers[]|select(.wt=="wt3") | "\(.files|length) \(.files[0]) \(.files[19])"')"
check "n_files defaults to the full count" "25" "$("$SS" "$l" get | jq -r '.leftovers[]|select(.wt=="wt3").n_files')"
"$SS" "$l" add-leftover wtX /p b r w --n-files soon >/dev/null 2>&1; rc=$?
check "add-leftover rejects a non-numeric --n-files" "2" "$rc"

# 7j. add-member clears a leftover its wt reuses; rekey-member follows it.
"$SS" "$l" add-member builder u2 wt2 --owns u2 >/dev/null
check "add-member drops the leftover on its wt" "wt3" "$("$SS" "$l" get | jq -r '.leftovers[].wt')"
"$SS" "$l" rekey-member wt3 wt3new >/dev/null
check "rekey-member repoints the leftover wt" "wt3new" "$("$SS" "$l" get | jq -r '.leftovers[].wt')"

# 7k. wt_probe: dirty/unpushed counts for one worktree, ours-files excluded, unsafe on failure.
W="$(mktemp -d "${TMPDIR:-/tmp}/wt-probe.XXXXXX")"
R="$W/repo"; git init -q -b main "$R"
git -C "$R" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
if out="$(wt_probe "$R")"; then rc=0; else rc=$?; fi
check "wt_probe on a clean repo exits 0" "0" "$rc"
check "wt_probe on a clean repo: 0 files, 1 unpushed" "0 1" "$(head -n1 <<< "$out" | tr '\t' ' ')"
git init -q --bare "$W/origin.git"; git -C "$R" remote add origin "$W/origin.git"; git -C "$R" push -q origin main
check "wt_probe reports 0 unpushed once pushed" "0 0" "$(wt_probe "$R" | head -n1 | tr '\t' ' ')"
echo x > "$R/a.txt"; echo y > "$R/b.txt"
out="$(wt_probe "$R")"
check "wt_probe counts dirty files" "2" "$(head -n1 <<< "$out" | cut -f1)"
check "wt_probe lists the dirty names" "a.txt b.txt" "$(tail -n +2 <<< "$out" | sort | tr '\n' ' ' | sed 's/ $//')"
rm "$R/a.txt" "$R/b.txt"
touch "$R/CLAUDE.local.md"; mkdir -p "$R/.claude"; touch "$R/.claude/settings.local.json"
check "wt_probe ignores dev-studio's own files" "0" "$(wt_probe "$R" | head -n1 | cut -f1)"
rm -rf "$R/CLAUDE.local.md" "$R/.claude"
if out="$(wt_probe "$W/nonexistent")"; then rc=0; else rc=$?; fi
check "wt_probe on a missing path fails (unsafe)" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
if out="$(wt_probe "$W")"; then rc=0; else rc=$?; fi
check "wt_probe on a non-repo dir fails" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
rm -rf "$W"

# 7l. An ext dep on a sibling squad's cancelled unit stays fail-closed.
LX="$(mktemp -d "${TMPDIR:-/tmp}/squad-state-cancel-ext.XXXXXX")"; mkdir -p "$LX/squads"
AX="$LX/squads/a.json"; BX="$LX/squads/b.json"
"$SS" "$BX" add-unit y --tier standard >/dev/null 2>&1
"$SS" "$BX" cancel-unit y >/dev/null 2>&1
"$SS" "$AX" add-unit x --ext-dep b/y --tier standard >/dev/null 2>&1
check "ext-deps-status prints cancelled" "$(printf 'b/y\tcancelled')" "$("$SS" "$AX" ext-deps-status x)"
check "a cancelled peer blocks (fail-closed)" "" "$("$SS" "$AX" ready-units 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
"$SS" "$AX" drop-ext-dep x b/y >/dev/null
check "drop-ext-dep unblocks it" "x" "$("$SS" "$AX" ready-units 2>/dev/null)"
rm -rf "$LX"

# 7m. register-plan re-runs keep a cancelled unit cancelled.
RP="$(fixdir squad-state-cancel-rp)"
printf '%s\n' "U1 — first work — deps: none — Tier: standard" "U2 — second work — deps: U1 — Tier: standard" > "$RP/plan.md"
rp="$RP/s.json"
"$SS" "$rp" register-plan "$RP/plan.md" >/dev/null 2>&1
"$SS" "$rp" cancel-unit u1-first-work --into u2-second-work >/dev/null 2>&1
"$SS" "$rp" register-plan "$RP/plan.md" >/dev/null 2>&1
check "register-plan keeps a cancelled unit cancelled" "cancelled u2-second-work" "$("$SS" "$rp" get | jq -r '.units[]|select(.slug=="u1-first-work") | "\(.status) \(.superseded_by)"')"
rm -rf "$RP"

# 7n. Cancelled units + leftovers validate against state/SCHEMA.json.
VS="$(tmp)"
"$SS" "$VS" add-unit u2 --tier standard >/dev/null 2>&1
"$SS" "$VS" add-unit u3 "" "" u2 --tier standard >/dev/null 2>&1
"$SS" "$VS" cancel-unit u2 --into PR#7 --why "folded" >/dev/null 2>&1
"$SS" "$VS" set-into-merged u2 >/dev/null
"$SS" "$VS" add-leftover 'u1::/tmp/wt' /tmp/wt feat 'uncommitted changes' 'PR#7' --unit u2 --file a.txt --n-files 3 --unpushed 1 >/dev/null
check "cancelled + leftover fixture validates against SCHEMA.json" "" "$(schema_errors "$VS")"
rm -f "$VS"

rm -rf "$C" "$Q" "$D" "$E" "$L"

# 7o. plan-hold-release: dropping HELD from an approved plan releases the plan hold; relative plan paths.
ph="$(tmp)"; pp="$(tmp)"
printf 'U1 — Held one — deps: none — Tier: standard — HELD\nU2 — Held two — deps: none — Tier: standard — HELD\nU3 — Free — deps: none — Tier: standard\n' > "$pp"
"$SS" "$ph" register-plan "$pp" >/dev/null 2>&1
check "7o(a) HELD line adds hold_by plan" "true plan" "$("$SS" "$ph" get | jq -r '.units[]|select(.plan_unit=="U1")|"\(.hold) \(.hold_by)"')"
"$SS" "$ph" register-plan "$pp" >/dev/null 2>&1
check "7o(b) a line that still says HELD stays held" "true true" "$("$SS" "$ph" get | jq -r '[.units[]|select(.plan_unit=="U1" or .plan_unit=="U2").hold]|map(tostring)|join(" ")')"
check "7o(g) set-unit-hold off on a plan hold refuses (exit 1)" "1" "$("$SS" "$ph" set-unit-hold u1-held-one off >/dev/null 2>&1; echo $?)"
check "7o(g) refusal names the plan line" "yes" "$(msg="$("$SS" "$ph" set-unit-hold u1-held-one off 2>&1)"; grep -qE "is a plan hold — drop HELD from its line in .*$(basename "$pp") and re-run register-plan" <<<"$msg" && echo yes || echo no)"
"$SS" "$ph" approve-plan "$pp"
printf 'U1 — Held one — deps: none — Tier: standard\nU2 — Held two — deps: none — Tier: standard — HELD\nU3 — Free — deps: none — Tier: standard\n' > "$pp"
rows="$("$SS" "$ph" register-plan "$pp" 2>"$pp.err")"
check "7o(a) dropping HELD releases the unit" "false false" "$("$SS" "$ph" get | jq -r '.units[]|select(.plan_unit=="U1")|"\(.hold) \(has("hold_by"))"')"
check "7o(a) release prints the note" "yes" "$(grep -qF "note: released plan hold on u1-held-one (HELD dropped from $pp)" "$pp.err" && echo yes || echo no)"
check "7o(a) the row reads updated" "u1-held-one	updated" "$(printf '%s\n' "$rows" | awk -F'\t' '$1=="u1-held-one"{print $1"\t"$2}')"
check "7o(a) ready-units lists it" "yes" "$(rdy="$("$SS" "$ph" ready-units)"; grep -q u1-held-one <<<"$rdy" && echo yes || echo no)"
check "7o(b) U2 stays held" "true" "$("$SS" "$ph" get | jq -r '.units[]|select(.plan_unit=="U2").hold')"
printf 'U1 — Held one — deps: none — Tier: standard — HELD\nU2 — Held two — deps: none — Tier: standard — HELD\nU3 — Free — deps: none — Tier: standard\n' > "$pp"
"$SS" "$ph" register-plan "$pp" >/dev/null 2>&1
check "7o no re-hold when HELD is added later" "false" "$("$SS" "$ph" get | jq -r '.units[]|select(.plan_unit=="U1").hold')"
# (c) no marker, matched by (plan, plan_unit): the plan holds that exist today
hand "$ph" '(.units[]|select(.plan_unit=="U2")) |= del(.hold_by)'
printf 'U1 — Held one — deps: none — Tier: standard\nU2 — Held two — deps: none — Tier: standard\nU3 — Free — deps: none — Tier: standard\n' > "$pp"
"$SS" "$ph" register-plan "$pp" >/dev/null 2>&1
check "7o(c) an unmarked plan hold is released on a match" "false" "$("$SS" "$ph" get | jq -r '.units[]|select(.plan_unit=="U2").hold')"
# (d) a parked follow-up adopted by a plan line
pk="$(tmp)"; pkp="$(tmp)"
"$SS" "$pk" add-unit u1-parked --hold >/dev/null 2>&1
printf 'U1 — Parked — deps: none — Tier: standard\n' > "$pkp"
"$SS" "$pk" register-plan "$pkp" >/dev/null 2>&1
check "7o(d) adopted --hold unit stays held, marked parked" "true parked" "$("$SS" "$pk" get | jq -r '.units[0]|"\(.hold) \(.hold_by)"')"
"$SS" "$pk" register-plan "$pkp" >/dev/null 2>&1
check "7o(d) and on a second run" "true parked" "$("$SS" "$pk" get | jq -r '.units[0]|"\(.hold) \(.hold_by)"')"
# (e) a reasoned freeze survives
fz="$(tmp)"; fzp="$(tmp)"
printf 'U1 — Frozen — deps: none — Tier: standard — HELD\n' > "$fzp"
"$SS" "$fz" register-plan "$fzp" >/dev/null 2>&1
printf 'U1 — Frozen — deps: none — Tier: standard\n' > "$fzp"
hand "$fz" '(.units[0]) |= (.hold_reason="freeze"|del(.hold_by))'
"$SS" "$fz" register-plan "$fzp" >/dev/null 2>&1
check "7o(e) a reasoned freeze stays, with its reason" "true freeze" "$("$SS" "$fz" get | jq -r '.units[0]|"\(.hold) \(.hold_reason)"')"
# (h) U3: a "revalidate after resume" hold goes only when the plan is approved AGAIN: approve-plan
# marks it revalidated and the next register-plan frees it. A re-registration with no new approval,
# another reason, and a unit the plan no longer lists stay held.
rv="$(tmp)"; rvp="$(tmp)"
printf 'U1 — Kept — deps: none — Tier: standard\nU2 — Frozen — deps: none — Tier: standard\nU3 — Dropped — deps: none — Tier: standard\n' > "$rvp"
"$SS" "$rv" register-plan "$rvp" >/dev/null 2>&1
"$SS" "$rv" approve-plan "$rvp"
hand "$rv" '.units |= map(.hold = true | .hold_reason = (if .plan_unit == "U2" then "freeze" else "revalidate after resume" end))'
printf 'U1 — Kept — deps: none — Tier: standard\nU2 — Frozen — deps: none — Tier: standard\n' > "$rvp"
"$SS" "$rv" register-plan "$rvp" >/dev/null 2>&1
check "7o(h) re-registering with no new approval keeps the hold" "true" "$("$SS" "$rv" get | jq -r '.units[]|select(.plan_unit=="U1").hold')"
"$SS" "$rv" approve-plan "$rvp"
check "7o(h) approve-plan marks its held units revalidated" "true true" "$("$SS" "$rv" get | jq -r '[.units[]|select(.plan_unit=="U1" or .plan_unit=="U3").revalidated]|map(tostring)|join(" ")')"
check "7o(h) a marked unit validates against SCHEMA.json" "" "$(schema_errors "$rv")"
check "7o(h) another reason is not marked" "null" "$("$SS" "$rv" get | jq -r '.units[]|select(.plan_unit=="U2").revalidated')"
"$SS" "$rv" register-plan "$rvp" >/dev/null 2>"$rvp.err"
check "7o(h) register-plan of the re-approved plan frees it" "false false false" "$("$SS" "$rv" get | jq -r '.units[]|select(.plan_unit=="U1")|"\(.hold) \(has("hold_reason")) \(has("revalidated"))"')"
check "7o(h) the release prints the note" "yes" "$(grep -qF 'note: released the "revalidate after resume" hold on u1-kept' "$rvp.err" && echo yes || echo no)"
check "7o(h) another reason stays" "true freeze" "$("$SS" "$rv" get | jq -r '.units[]|select(.plan_unit=="U2")|"\(.hold) \(.hold_reason)"')"
check "7o(h) a unit the plan dropped stays held" "true" "$("$SS" "$rv" get | jq -r '.units[]|select(.plan_unit=="U3").hold')"
# (f) a blocks: wait survives the release
bk="$(tmp)"; bkp="$(tmp)"
printf 'U1 — Blocker — deps: none — Tier: standard — blocks: U2\nU2 — Blocked — deps: none — Tier: standard — HELD\n' > "$bkp"
"$SS" "$bk" register-plan "$bkp" >/dev/null 2>&1
printf 'U1 — Blocker — deps: none — Tier: standard — blocks: U2\nU2 — Blocked — deps: none — Tier: standard\n' > "$bkp"
"$SS" "$bk" register-plan "$bkp" >/dev/null 2>&1
check "7o(f) a blocks: wait survives the release" "false u1-blocker" "$("$SS" "$bk" get | jq -r '.units[]|select(.plan_unit=="U2")|"\(.hold) \(.wait_on|keys|join(","))"')"
# (h) a relative path from another directory matches what the absolute path registered
rd="$(mktemp -d "${TMPDIR:-/tmp}/relplan.XXXXXX")"; rs="$(tmp)"
printf 'U1 — Rel — deps: none — Tier: standard\nU2 — Rel two — deps: none — Tier: standard\n' > "$rd/rel-plan.md"
"$SS" "$rs" register-plan "$rd/rel-plan.md" >/dev/null 2>&1
check "7o(h) relative path from elsewhere: unchanged rows" "unchanged unchanged" "$(cd "$rd" && "$SS" "$rs" register-plan rel-plan.md 2>/dev/null | awk -F'\t' '{print $2}' | tr '\n' ' ' | sed 's/ $//')"
check "7o(h) and no -2 copies" "2 0" "$("$SS" "$rs" get | jq -r '"\(.units|length) \([.units[].slug|select(test("-2$"))]|length)"')"
# (i) the duplicate guard: the same plan file name under another directory
mkdir -p "$rd/other"; { cat "$rd/rel-plan.md"; printf 'U3 — Extra — deps: none — Tier: standard\n'; } > "$rd/other/rel-plan.md"
before="$(cat "$rs")"
check "7o(i) same plan name under another dir refuses (exit 1)" "1" "$("$SS" "$rs" register-plan "$rd/other/rel-plan.md" >/dev/null 2>&1; echo $?)"
check "7o(i) the refusal writes nothing" "$before" "$(cat "$rs")"

# 8. The loop's store (U13a). Once the state root carries .loop-migrated, a squad file under
# <root>/<project>/squads/ is served from loop.db. The suite runs again on a marked root (tmp and
# fixdir put its squad files under it), then the store-only checks.
if [ -z "${SQUAD_STATE_MARKED:-}" ]; then
  bun="$(command -v bun 2>/dev/null || true)"
  [ -n "$bun" ] || [ ! -x "$HOME/.bun/bin/bun" ] || bun="$HOME/.bun/bin/bun"
  wait "$MARKED_PID"; rc=$?
  out="$(cat "$MK.out")"
  check "the suite passes on a marked root" "0" "$rc"
  [ "$rc" -eq 0 ] || printf '%s\n' "$out" | grep -A2 '^FAIL' >&2
  check "the marked re-run used the store" "yes" "$("${bun:-bun}" -e 'const { Database } = require("bun:sqlite");
    console.log(new Database(process.argv[1], { readonly: true }).query("SELECT COUNT(*) AS n FROM squads").get().n > 20 ? "yes" : "no")' "$MK/loop.db" 2>/dev/null)"
  rm -rf "$MK"

  sql() { "${bun:-bun}" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
    for (const r of d.query(process.argv[2]).values()) console.log(r.map((v) => v ?? "").join("\t"))' "$MK/loop.db" "$1"; }
  steps() { # steps <file> — one sequence of writes, run on the marked and the unmarked root
    "$SS" "$1" set-task t-1 && "$SS" "$1" set-lead wt-l && "$SS" "$1" add-member lead "" wt-l \
      && "$SS" "$1" add-member builder u1 wt-b --owns u1 --for thinker \
      && "$SS" "$1" add-unit u1 wt-b /p.md --tier standard && "$SS" "$1" add-unit u2 "" /p.md u1 --tier hard \
      && "$SS" "$1" set-unit-status u1 dispatched && "$SS" "$1" enqueue-question q1 lead true "Ship?" wt-b "" "" "" "Ship it" \
      && "$SS" "$1" enqueue-question q2 lead false "Later?" && "$SS" "$1" set-status waiting-on-you
  } >/dev/null 2>&1
  stamp() { jq 'walk(if type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T") then "TS" else . end)' "$1"; }
  MK="$(mktemp -d "${TMPDIR:-/tmp}/squad-state-store.XXXXXX")"; : > "$MK/.loop-migrated"; mkdir -p "$MK/p/squads"
  UM="$(mktemp -d "${TMPDIR:-/tmp}/squad-state-unmarked.XXXXXX")"; mkdir -p "$UM/p/squads"
  S="$MK/p/squads/s.json"; U="$UM/p/squads/s.json"
  export DS_STATE_ROOT="$MK"; steps "$S"; DS_STATE_ROOT="$UM" steps "$U"
  check "marked: the write is a fact in loop.db"   "t-1	wt-l" "$(sql "SELECT task_id, lead_wt FROM squads WHERE project = 'p' AND topic = 's'")"
  check "marked: the units are rows"              "u1	dispatched,u2	planned" "$(sql "SELECT slug, status FROM units WHERE squad = 's' ORDER BY ord" | paste -sd, -)"
  check "marked: one events row per write"        "10" "$(sql "SELECT COUNT(*) FROM events WHERE kind = 'squad_state' AND squad = 's'")"
  check "marked: the export equals the unmarked JSON" "$(stamp "$U")" "$(stamp "$S")"
  check "unmarked: no loop.db"                    "no" "$([ -e "$UM/loop.db" ] && echo yes || echo no)"
  "$SS" "$S" set-unit-hold u2 on --why freeze >/dev/null 2>&1
  check "marked: hold and reason reach loop.db" "1	freeze" "$(sql "SELECT hold, json_extract(doc, '$.hold_reason') FROM units WHERE squad = 's' AND slug = 'u2'")"
  "$SS" "$S" set-unit-hold u2 off >/dev/null 2>&1
  check "marked: release reaches loop.db" "0	" "$(sql "SELECT hold, json_extract(doc, '$.hold_reason') FROM units WHERE squad = 's' AND slug = 'u2'")"
  jq '.task_id = "hand" | .waiting_on_you = []' "$S" > "$S.new" && mv "$S.new" "$S"
  check "marked: reads come from SQLite, not the file" "t-1 q1,q2" "$("$SS" "$S" get | jq -r '"\(.task_id) \([.waiting_on_you[].id] | join(","))"')"
  "$SS" "$S" resolve-question q1 --answer yes --via board >/dev/null 2>&1
  check "marked: resolve leaves no waiting_on_you entry" "q2" "$(jq -r '[.waiting_on_you[].id] | join(",")' "$S")"
  check "marked: the question row is answered"   "answered	yes	board	1" "$(sql "SELECT status, answer, answered_via, answered_at IS NOT NULL FROM questions WHERE id = 'q1'")"
  check "marked: answered-questions prints it"   "q1	board	Ship it	yes" "$("$SS" "$S" answered-questions | cut -f2,4-)"
  "$SS" "$S" resolve-question q1 --answer no >/dev/null 2>&1
  check "marked: re-resolving keeps the first answer" "yes" "$(sql "SELECT answer FROM questions WHERE id = 'q1'")"
  check "marked: a bad --via exits 2"            "2" "$("$SS" "$S" resolve-question q2 --via nope >/dev/null 2>&1; echo $?)"
  # U146: ready-units hands out only the unit a free Builder slot goes to (max_builders). s's Builder u1
  # is live (running, not observed yet), so limit 2 leaves one slot: only the older of t's two units.
  T2="$MK/p/squads/t.json"; "$SS" "$T2" set-run r-t >/dev/null 2>&1
  "$SS" "$T2" add-unit ta "" /p.md >/dev/null 2>&1; "$SS" "$T2" add-unit tb "" /p.md >/dev/null 2>&1
  check "max_builders unset: every unblocked unit is ready" "ta tb" "$("$SS" "$T2" ready-units | paste -sd' ' -)"
  sqlw() { "${bun:-bun}" -e 'const { Database } = require("bun:sqlite"); new Database(process.argv[1]).run(process.argv[2]);' "$MK/loop.db" "$1"; }
  sqlw "INSERT INTO config (project, file, key, value, observed_at) VALUES ('p', 'limits.conf', 'max_builders', '2', 1)"
  check "max_builders 2 with one live Builder: only the oldest unit is ready" "ta" "$("$SS" "$T2" ready-units | paste -sd' ' -)"
  sqlw "UPDATE config SET value = '1' WHERE key = 'max_builders'"
  check "at the limit no unit is ready" "" "$("$SS" "$T2" ready-units | paste -sd' ' -)"
  sqlw "DELETE FROM config WHERE key = 'max_builders'"
  rm -f "$S"; "$SS" "$S" set-run r-new >/dev/null 2>&1   # close-squad.sh removes the file; a re-spawn reuses the topic
  check "marked: a removed file starts from the default" "r-new null 0 0" "$(jq -r '"\(.run_id) \(.task_id) \(.units | length) \(.waiting_on_you | length)"' "$S")"
  check "marked: its open question is answered via reality" "reality" "$(sql "SELECT answered_via FROM questions WHERE id = 'q2'")"
  unset DS_STATE_ROOT
  check "unmarked: resolve-question --answer exits 0" "0" "$("$SS" "$U" resolve-question q1 --answer x >/dev/null 2>&1; echo $?)"
  check "unmarked: answered-questions prints nothing" "" "$("$SS" "$U" answered-questions)"
  rm -rf "$MK" "$UM"
fi

# U46. A plan unit line names another squad's unit in `— ext-deps: <squad>/<slug>`; register-plan records ext_deps.
L2="$(mktemp -d "${TMPDIR:-/tmp}/squad-state-extplan.XXXXXX")"; mkdir -p "$L2/squads"
PA="$L2/squads/a.json"; PB="$L2/squads/b.json"; PP="$L2/p.md"
"$SS" "$PB" add-unit peer >/dev/null 2>&1
printf 'U1 — Good ref — deps: none — ext-deps: b/peer — Tier: standard\nU2 — Typo ref — deps: none — ext-deps: b/pere, zz/none — Tier: standard\nU3 — Plain — deps: none — Tier: standard\n' > "$PP"
err="$("$SS" "$PA" register-plan "$PP" 2>&1 >/dev/null)"
check "plan ext-deps recorded as ext_deps"       '["b/peer"]' "$("$SS" "$PA" get | jq -c '.units[]|select(.plan_unit=="U1").ext_deps')"
check "a missing ref is recorded too"            '["b/pere","zz/none"]' "$("$SS" "$PA" get | jq -c '.units[]|select(.plan_unit=="U2").ext_deps')"
check "a missing ref is reported by name"        "2" "$(printf '%s\n' "$err" | grep -c 'is not a known squad unit')"
check "the rest of the plan still registers"     "3" "$("$SS" "$PA" get | jq '.units|length')"
check "a plan without the field has no ext_deps" "false" "$("$SS" "$PA" get | jq '.units[]|select(.plan_unit=="U3")|has("ext_deps")')"
check "only the unit with no ext dep is ready"   "u3-plain" "$("$SS" "$PA" ready-units)"
"$SS" "$PB" set-unit-status peer "done" --no-pr >/dev/null
check "peer done -> the good-ref unit is ready"  "u1-good-ref u3-plain" "$("$SS" "$PA" ready-units | sort | tr '\n' ' ' | sed 's/ $//')"
"$SS" "$PA" register-plan "$PP" >/dev/null 2>&1
check "re-registering keeps the ext dep"         '["b/peer"]' "$("$SS" "$PA" get | jq -c '.units[]|select(.plan_unit=="U1").ext_deps')"
"$SS" "$PA" drop-ext-dep u2-typo-ref b/pere >/dev/null; "$SS" "$PA" drop-ext-dep u2-typo-ref zz/none >/dev/null
check "drop-ext-dep still works on a plan ref"   "false" "$("$SS" "$PA" get | jq '.units[]|select(.plan_unit=="U2")|has("ext_deps")')"
printf 'U1 — Bad — deps: none — ext-deps: a/b/c — Tier: standard\n' > "$PP"
check "a ref with two slashes refuses the plan"  "1" "$("$SS" "$PA" register-plan "$PP" >/dev/null 2>&1; echo $?)"
rm -rf "$L2"

# approve-plan saves a byte-for-byte .approved.md copy beside the plan (plan-approval-view revisions U1).
AC="$(fixdir apcopy)"; af="$AC/s.json"; "$SS" "$af" init >/dev/null 2>&1
printf '# plan v1\n' > "$AC/a-plan.md"
"$SS" "$af" approve-plan "$AC/a-plan.md" >/dev/null
check "approve-plan writes an identical copy"   "same" "$(cmp -s "$AC/a-plan.md" "$AC/a-plan.approved.md" && echo same)"
printf '# plan v2\n' > "$AC/a-plan.md"
"$SS" "$af" approve-plan "$AC/a-plan.md" >/dev/null
check "approve-plan overwrites an older copy"   "same" "$(cmp -s "$AC/a-plan.md" "$AC/a-plan.approved.md" && echo same)"
check "no temp file is left behind"             "0" "$(find "$AC" -name '*tmp-*' | wc -l | tr -d ' ')"
"$SS" "$af" approve-plan "$AC/missing-plan.md" >/dev/null 2>&1
check "a missing plan path still records the approval" "yes" "$("$SS" "$af" plan-approved "$AC/missing-plan.md")"
check "..and writes no copy"                    "no" "$([ -e "$AC/missing-plan.approved.md" ] && echo yes || echo no)"
rm -rf "$AC"

# U5 (retest1 fixes). register-plan takes only <file> and <plan>: anything after <plan> exits 2 and writes nothing.
x="$(tmp)"; xp="$(tmp)"; "$SS" "$x" init >/dev/null 2>&1
printf 'U1 — Extra args — deps: none — Tier: standard\n' > "$xp"
cp "$x" "$x.before"
"$SS" "$x" register-plan "$xp" --dry-run >/dev/null 2>"$x.err"; rc=$?
check "register-plan --dry-run exits 2" "2" "$rc"
check "..and leaves the state file unchanged" "same" "$(cmp -s "$x" "$x.before" && echo same)"
check "..names the argument and points at a scratch copy" "1 1" "$(grep -c -- 'extra argument.*--dry-run' "$x.err") $(grep -c 'no dry run.*scratch copy' "$x.err")"
"$SS" "$x" register-plan "$xp" extra more >/dev/null 2>"$x.err"; rc=$?
check "register-plan with extra arguments exits 2" "2" "$rc"
check "..and leaves the state file unchanged" "same" "$(cmp -s "$x" "$x.before" && echo same)"
check "..names them, with no dry-run hint" "1 0" "$(grep -c 'extra argument.*extra more' "$x.err") $(grep -c 'dry run' "$x.err")"
"$SS" "$x" register-plan "$xp" >/dev/null 2>&1; rc=$?
check "register-plan with only <plan> still registers" "0 u1-extra-args" "$rc $("$SS" "$x" get | jq -r '.units[].slug')"

echo "squad-state: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
