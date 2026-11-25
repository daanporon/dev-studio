#!/usr/bin/env bash
# team.sh — the roster view joins members[] (role/suffix/owns/for) with the backend's live
# worker-states (state + displayName) and the phone book's live terminal tokens (directory.sh
# list --json, stubbed here), stays backend-agnostic, flags a gone worktree, and acts on a
# role's terminal (switch/close).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
LBL="zzteam_$$"; SD="$DS_STATE_ROOT/$LBL"
TMP="$(mktemp -d)"
state_root_on_exit 'rm -rf "$SD" "$TMP"'
mkdir -p "$SD/squads"
printf '{"run_id":"run_9","members":[
  {"role":"lead","wt":"wtLead","owns":[],"for":""},
  {"role":"thinker","wt":"wtTbase","owns":["issue-1-onboarding"],"for":""},
  {"role":"thinker","suffix":"structures","wt":"wtTstr","owns":["plans/structures.md"],"for":""},
  {"role":"builder","suffix":"console","wt":"wtB","owns":["U4"],"for":"structures"},
  {"role":"tester","suffix":"env","wt":"wtDead","owns":["b"],"for":""}]}' > "$SD/squads/mt.json"

# A second squad, so the all-squads vs auto-scoped-to-my-squad distinction is observable.
printf '{"run_id":"run_other","members":[{"role":"lead","wt":"wtOther","owns":[],"for":""}]}' > "$SD/squads/other.json"

cat > "$TMP/fakeb" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${TEAM_LOG:-/dev/null}"
case "$1" in
  current)       echo "${FAKE_CURRENT:-}" ;;   # which worktree THIS terminal is in
  worker-states) printf '%s\n' \
    "wtLead	waiting	ds-x-lead-mt" \
    "wtTbase	waiting	ds-x-thinker-mt" \
    "wtTstr	working	ds-x-thinker-structures-mt" \
    "wtB	working	ds-x-builder-console-mt" ;;
  worker-detail) printf '%s\n' \
    "wtLead	term_lead" \
    "wtTstr	term_str1" \
    "wtTstr	term_str2" \
    "wtB	term_b" ;;   # wtTbase has no live terminal; wtTstr has TWO (duplicate)
  terminal-switch) : ;;
  focus) [ "$2" = wtTbase ] && [ -n "${FAKE_FOCUS:-}" ] ;;   # a live agent terminal outside the run
  terminal-reap)   echo 3 ;;
  *) echo '{}' ;;
esac
FAKE
chmod +x "$TMP/fakeb"

# The phone book stub: the same members + live terminals the roster asserts on (wtTstr has
# TWO, wtTbase none). team.sh resolves both through it, never from backend worker lists.
cat > "$TMP/fakedir" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${DIR_LOG:-/dev/null}"
cat <<'JSON'
[{"squad":"mt","role":"lead","name":"lead","wt":"wtLead","live":true,"terminals":["term_lead"]},
 {"squad":"mt","role":"thinker","name":"thinker","wt":"wtTbase","live":true,"terminals":[]},
 {"squad":"mt","role":"thinker","name":"thinker-structures","wt":"wtTstr","live":true,"terminals":["term_str1","term_str2"]},
 {"squad":"mt","role":"builder","name":"builder-console","wt":"wtB","live":true,"terminals":["term_b"]},
 {"squad":"mt","role":"tester","name":"tester-env","wt":"wtDead","live":false,"terminals":[]},
 {"squad":"other","role":"lead","name":"lead","wt":"wtOther","live":true,"terminals":["term_o"]}]
JSON
FAKE
chmod +x "$TMP/fakedir"
export DIRECTORY="$TMP/fakedir" DIR_LOG="$TMP/dirlog" TEAM_LOG="$TMP/log"
: > "$DIR_LOG"; : > "$TEAM_LOG"

pass=0; fail=0
has(){ if grep -qE -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — missing /$3/" >&2; fi; }
no(){ if grep -qE -- "$3" <<<"$2"; then fail=$((fail+1)); echo "  FAIL: $1 — unexpected /$3/" >&2; else pass=$((pass+1)); fi; }

out="$(BACKEND="$TMP/fakeb" "$ROOT/bin/commands/team.sh" "$LBL" --topic mt 2>&1)"
has "names the squad + run"              "$out" "TEAM — mt   \(run run_9\)"
has "scoped thinker distinguished"       "$out" "thinker-structures +working +ds-x-thinker-structures-mt"
has "base thinker owns issue-1"          "$out" "thinker .*owns: issue-1-onboarding"
has "builder shows who it reports to"    "$out" "builder-console .*for:structures"
has "deleted worktree flagged GONE"      "$out" "tester-env +GONE +\(worktree gone\)"
has "single live terminal handle shown"  "$out" "ds-x-builder-console-mt.*\[term term_b\]"
has "duplicate live terminals flagged"   "$out" "ds-x-thinker-structures-mt.*⚠ 2 live terminals"
base_line="$(printf '%s\n' "$out" | grep -F 'ds-x-thinker-mt' | grep -vF structures || true)"
no "no terminal column when none live"    "$base_line" "\[term"
has "roster resolves members via the phone book" "$(cat "$DIR_LOG")" "list --project $LBL --json"
no  "roster never asks the backend for worker-detail" "$(cat "$TEAM_LOG")" "worker-detail"

# --switch on a single-terminal role calls terminal-switch with its handle.
: > "$TMP/log"; : > "$DIR_LOG"; TEAM_LOG="$TMP/log" BACKEND="$TMP/fakeb" "$ROOT/bin/commands/team.sh" "$LBL" --topic mt --switch builder-console >/dev/null 2>&1
has "switch calls terminal-switch w/ the handle" "$(cat "$TMP/log")" "terminal-switch term_b"
has "switch resolves the member via the phone book" "$(cat "$DIR_LOG")" "list --project $LBL --json"
no  "switch never asks the backend for worker-detail" "$(cat "$TMP/log")" "worker-detail"

# --switch on a DUPLICATE role jumps to the OWNER (the newest/first active handle).
: > "$TMP/log"; TEAM_LOG="$TMP/log" BACKEND="$TMP/fakeb" "$ROOT/bin/commands/team.sh" "$LBL" --topic mt --switch thinker-structures >/dev/null 2>&1
has "switch on duplicate goes to the owner" "$(cat "$TMP/log")" "terminal-switch term_str1"
no  "switch on duplicate skips the stray"   "$(cat "$TMP/log")" "terminal-switch term_str2"

# --switch on a role with no live terminal errors (and does NOT call terminal-switch).
: > "$TMP/log"; rc=0; TEAM_LOG="$TMP/log" BACKEND="$TMP/fakeb" "$ROOT/bin/commands/team.sh" "$LBL" --topic mt --switch thinker >/dev/null 2>&1 || rc=$?
has "switch with no live terminal exits non-zero" "$rc" "^[1-9]"
no  "switch with no terminal never calls switch"  "$(cat "$TMP/log")" "terminal-switch"

# A role alive in a terminal the run doesn't list (restarted/reloaded Lead): fall back to the
# worktree's live agent terminal instead of saying "no live terminal".
: > "$TMP/log"; rc=0; out="$(FAKE_FOCUS=1 TEAM_LOG="$TMP/log" BACKEND="$TMP/fakeb" "$ROOT/bin/commands/team.sh" "$LBL" --topic mt --switch thinker 2>&1)" || rc=$?
has "switch falls back to focus by worktree"   "$(cat "$TMP/log")" "focus wtTbase"
has "fallback switch exits 0"                  "$rc" "^0$"
has "fallback switch says it switched"         "$out" "switched to thinker"

# --reap keeps each owner and closes the rest, via terminal-reap, reporting the count.
: > "$TMP/log"; reap="$(TEAM_LOG="$TMP/log" BACKEND="$TMP/fakeb" "$ROOT/bin/commands/team.sh" "$LBL" --topic mt --reap 2>&1)"
has "reap calls terminal-reap for the run"  "$(cat "$TMP/log")" "terminal-reap run_9"
has "reap reports the closed count"         "$reap" "closed 3 stale terminal"
has "reap says it kept the owners"          "$reap" "kept the owners"

# Run from INSIDE squad mt (current worktree wtTstr) with NO --topic -> auto-scope to mt only,
# never the sibling squad 'other'. (A Lead must not reap siblings.)
: > "$TMP/log"; FAKE_CURRENT=wtTstr TEAM_LOG="$TMP/log" BACKEND="$TMP/fakeb" "$ROOT/bin/commands/team.sh" "$LBL" --reap >/dev/null 2>&1
has "bare --reap inside a squad scopes to it"  "$(cat "$TMP/log")" "terminal-reap run_9"
no  "bare --reap inside a squad skips siblings" "$(cat "$TMP/log")" "terminal-reap run_other"

# Run from OUTSIDE any squad (Studio: current matches no roster) with no --topic -> all squads.
: > "$TMP/log"; FAKE_CURRENT=wtStudio TEAM_LOG="$TMP/log" BACKEND="$TMP/fakeb" "$ROOT/bin/commands/team.sh" "$LBL" --reap >/dev/null 2>&1
has "bare --reap from the Studio sweeps mt"     "$(cat "$TMP/log")" "terminal-reap run_9"
has "bare --reap from the Studio sweeps other"  "$(cat "$TMP/log")" "terminal-reap run_other"

echo "team: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
