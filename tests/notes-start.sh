#!/usr/bin/env bash
# notes-start.sh — a fresh role's start spec carries the command that prints ITS notes for ITS
# project, and the write trigger. The spec is roleSpec (bin/loop/reconcilers/requests.ts), the one source for
# add-role.sh's prompt and the loop's role requests (bin/loop/reconcilers/requests.ts).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
# shellcheck source=tests/lib/twins.sh
. "$ROOT/tests/lib/twins.sh"
LBL="zzns_$$"; OTHER="zzno_$$"; SD="$DS_STATE_ROOT/$LBL"
# shellcheck disable=SC2034  # TMP is read by the exit command below
TMP="$(mktemp -d)"
state_root_on_exit 'rm -rf "$SD" "$DS_STATE_ROOT/$OTHER" "$TMP"'
mkdir -p "$SD/squads" "$DS_STATE_ROOT/$OTHER"
printf '{"home_repo":"path:/x"}' > "$SD/dispatcher.json"
printf '{"run_id":"run_x","lead_wt":"wt_lead","status":"running"}' > "$SD/squads/nt.json"

pass=0; fail=0
eq(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
has(){ if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
hasnt(){ if grep -qF -- "$3" <<<"$2"; then fail=$((fail+1)); echo "  FAIL: $1 — [$2] has [$3]" >&2; else pass=$((pass+1)); fi; }

# Builder 1 leaves a note on project LBL; a note for another project must not show up.
"$ROOT/bin/role/notes.sh" "$LBL" builder add "run devenv before e2e" "e2e fails without it" >/dev/null
"$ROOT/bin/role/notes.sh" "$OTHER" builder add "other project secret tip" "elsewhere" >/dev/null

# A second Builder, with and without --spec: pull the command out of the start spec and run it.
for mode in spec nospec; do
  if [ "$mode" = spec ]; then args=("unit two"); else args=(); fi
  spec="$(ds_role_spec "$LBL" builder nt run_x "$SD/squads/nt.json" ${args[@]+"${args[@]}"})"
  cmd="$(printf '%s' "$spec" | grep -o '`[^`]*notes.sh [^`]* print`' | head -1 | tr -d '`')"
  has "builder ($mode) spec has a print command" "$cmd" "notes.sh $LBL builder print"
  out="$(bash -c "$cmd")"
  has "builder ($mode) command prints the first Builder's note" "$out" "run devenv before e2e"
  hasnt "builder ($mode) command shows no other project's note" "$out" "other project secret tip"
  has "builder ($mode) spec carries the add command" "$spec" "notes.sh $LBL builder add"
  has "builder ($mode) spec carries the write trigger" "$spec" "add a note before you finish"
done

# A Tester's spec names tester and carries the trigger too.
spec="$(ds_role_spec "$LBL" tester nt run_x "$SD/squads/nt.json")"
has "tester spec names its role" "$spec" "notes.sh $LBL tester print"
hasnt "tester spec is not a builder's" "$spec" "notes.sh $LBL builder print"
has "tester spec carries the write trigger" "$spec" "add a note before you finish"

# The sentence itself: label and role are what the caller passed.
s="$(ds_notes_note foo lead)"
has "lead sentence names label and role" "$s" "notes.sh foo lead print"

echo "notes-start: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
