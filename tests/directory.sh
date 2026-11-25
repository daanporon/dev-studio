#!/usr/bin/env bash
# directory.sh — the phone book joins the squad state files with the backend's live wt-terminals:
# reach picks run (a Lead) / worktree (same squad) / worktree-run (another squad), exit 2 for an
# unknown or closed squad/role, exit 3 for a member that isn't running (no live terminal), exit 4
# with the address row when liveness is unknown; list shows every member with live + the command
# that reaches it, and --json carries the live terminal handles for team.sh and the board.
# send-role.sh sends by the resolved kind. Stub $BACKEND, temp state root; never touches ~/.dev-studio.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
# A state root of its own: finding the project scans every label in it, so another test's label
# (tests/ci.sh runs them side by side) must not be in it.
TMP="$(mktemp -d)"
export DS_STATE_ROOT="$TMP/state"
LBL="zzdir_$$"; SD="$DS_STATE_ROOT/$LBL"
SD2="$DS_STATE_ROOT/${LBL}x"   # a second label, so finding the project from the worktree is real
state_root_on_exit 'rm -rf "$TMP"'
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3" >&2; fi; }

mkdir -p "$SD/squads" "$SD/archive"
printf '{"run_id":"run_a","status":"running","members":[
  {"role":"lead","suffix":"","wt":"wtAL"},
  {"role":"thinker","suffix":"","wt":"wtAT"},
  {"role":"builder","suffix":"x","wt":"wtAB"}]}' > "$SD/squads/a.json"
printf '{"run_id":"run_b","status":"waiting-on-you","members":[
  {"role":"lead","suffix":"","wt":"wtBL"},
  {"role":"thinker","suffix":"","wt":"wtBT"},
  {"role":"tester","suffix":"env","wt":"wtBTe"}]}' > "$SD/squads/b.json"
printf '{"run_id":"run_c","status":"closed","members":[{"role":"thinker","suffix":"","wt":"wtCT"}]}' > "$SD/squads/c.json"
printf '{"run_id":"run_e","status":"running","members":[{"role":"lead","suffix":"","wt":"wtEL"},{"role":"thinker","suffix":"","wt":"wtET"}]}' > "$SD/squads/e.json"
printf '{"run_id":"run_f","status":"failed","members":[{"role":"lead","suffix":"","wt":"wtFL"}]}' > "$SD/squads/f.json"
printf '{"run_id":"run_s","status":"suspended","members":[{"role":"lead","suffix":"","wt":"wtSL"}]}' > "$SD/squads/s.json"
printf '{"run_id":"run_d","status":"closed","members":[{"role":"lead","suffix":"","wt":"wtDL"}]}' > "$SD/archive/d-20261001-120000.json"

cat > "$TMP/fakeb" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DIR_LOG"
case "$1" in
  current) echo "${FAKE_CURRENT:-}" ;;
  run-workers)
    # Every dispatch completed (the F1 bug shape) — the phone book must not care: it never
    # asks this op at all.
    printf 'wtX\tno\t-\n' ;;
  wt-terminals)
    [ "${FAKE_BLIND:-0}" = 1 ] && exit 2   # the backend can't list terminals (outage, op missing)
    printf 'wtAL\nwtAT\nwtBT\n' ;;   # wtAB, wtBTe and wtBL have no live terminal
  worker-detail)
    case "$2" in
      run_a) printf 'wtAL\tterm_al\nwtAT\tterm_at1\nwtAT\tterm_at2\n' ;;
      run_b) printf 'wtBT\tterm_b\n' ;;
      *) exit 2 ;;
    esac ;;
  run-coordinator) [ "${FAKE_HOLDER-term_lead}" = "?" ] && exit 1; echo "${FAKE_HOLDER-term_lead}" ;;
  send) echo "send: delivered to run:$2" ;;
  agent-handles) [ -n "${FAKE_AGENTS:-}" ] || exit 1; printf '%b' "$FAKE_AGENTS" ;;
  send-worker) echo "send-worker: delivered to $2 (msg_1)" ;;
  send-run-worker) echo "send-run-worker: delivered to term_x (msg_2)" ;;
  *) exit 2 ;;
esac
FAKE
chmod +x "$TMP/fakeb"
export DIR_LOG="$TMP/log"; : > "$DIR_LOG"
D() { BACKEND="$TMP/fakeb" "$ROOT/bin/lib/directory.sh" "$@"; }

check "same squad -> worktree" "worktree	wtAT" "$(D reach a thinker --project "$LBL" --from a | cut -f1,2)"
check "other squad -> worktree-run wt" "worktree-run	wtBT" "$(D reach b thinker --project "$LBL" --from a | cut -f1,2)"
check "reach carries run + worktree" "worktree-run	wtBT	run_b	wtBT" "$(D reach b thinker --project "$LBL" --from a)"
check "a Lead -> its run" "run	run_b" "$(D reach b lead --project "$LBL" --from a | cut -f1,2)"
check "own Lead -> run too" "run	run_a" "$(D reach a lead --project "$LBL" --from a | cut -f1,2)"
check "no caller squad (Studio) -> worktree-run" "worktree-run	wtAT" "$(D reach a thinker --project "$LBL" --from '' | cut -f1,2)"

D reach b tester-env --project "$LBL" --from a >/dev/null 2>&1; check "not live -> exit 3" "3" "$?"
check "not live names the missing terminal" "1" "$(D reach b tester-env --project "$LBL" --from a 2>&1 | grep -c 'no live terminal')"
D reach a builder-x --project "$LBL" --from a >/dev/null 2>&1; check "not live in own squad -> exit 3" "3" "$?"
D reach b reviewer --project "$LBL" --from a >/dev/null 2>&1;  check "unknown role -> exit 2" "2" "$?"
D reach nope thinker --project "$LBL" >/dev/null 2>&1;         check "unknown squad -> exit 2" "2" "$?"
D reach c thinker --project "$LBL" >/dev/null 2>&1;            check "closed squad -> exit 2" "2" "$?"
D reach s lead --project "$LBL" >/dev/null 2>&1;               check "suspended squad -> exit 2" "2" "$?"
check "failed squad -> spawn failed" "1" "$(D reach f lead --project "$LBL" 2>&1 | grep -c 'squad spawn failed')"
check "archived squad says closed" "1" "$(D reach d lead --project "$LBL" 2>&1 | grep -c 'closed')"
check "a name sharing an archive's prefix is unknown, not closed" "1" "$(D reach d-board lead --project "$LBL" 2>&1 | grep -c "no squad 'd-board'")"
FAKE_BLIND=1 D reach e thinker --project "$LBL" >/dev/null 2>&1; check "wt-terminals failed -> exit 4" "4" "$?"
check "blind still prints the address row" "worktree-run	wtET	run_e	wtET" "$(FAKE_BLIND=1 D reach e thinker --project "$LBL" 2>/dev/null)"
check "wt-terminals failed: a Lead is still reachable" "run	run_e" "$(FAKE_BLIND=1 D reach e lead --project "$LBL" | cut -f1,2)"
D reach a >/dev/null 2>&1; check "reach needs squad + role" "2" "$?"

# The caller's squad comes from this terminal's worktree: roster first, then the worktree name.
check "from = roster of current wt" "worktree	wtBT" "$(FAKE_CURRENT=wtBT D reach b thinker --project "$LBL" | cut -f1,2)"
check "from = worktree name" "worktree" "$(FAKE_CURRENT="uuid::/w/ds-$LBL-builder-y-a" D reach a thinker --project "$LBL" | cut -f1)"
printf '{"run_id":"run_bb","members":[{"role":"lead","suffix":"","wt":"wtBBL"}]}' > "$SD/squads/big-b.json"
check "from = name of another label sharing the prefix -> no caller" "worktree-run" "$(FAKE_CURRENT="uuid::/w/ds-$LBL-feedback-thinker-b" D reach b thinker --project "$LBL" | cut -f1)"
check "from = longest topic ending the name" "worktree-run" "$(FAKE_CURRENT="uuid::/w/ds-$LBL-thinker-big-b" D reach b thinker --project "$LBL" | cut -f1)"
rm "$SD/squads/big-b.json"
mkdir -p "$SD2/squads"; printf '{"run_id":"run_z","members":[{"role":"lead","suffix":"","wt":"wtZL"}]}' > "$SD2/squads/z.json"
check "project = label holding current wt" "run	run_a" "$(FAKE_CURRENT=wtAT D reach a lead | cut -f1,2)"
check "project = label holding current wt (not the last squad file)" "run	run_a" "$(FAKE_CURRENT=wtAL D reach a lead | cut -f1,2)"
check "project = the other label" "run	run_z" "$(FAKE_CURRENT=wtZL D reach z lead | cut -f1,2)"
check "two labels, no hint -> can't tell" "1" "$(D reach a lead 2>&1 | grep -c "can't tell the project")"
rm "$SD2/squads/z.json"   # a label whose squads all closed leaves an empty squads dir: not counted
check "empty squads dir doesn't count as a label" "run	run_a" "$(D reach a lead | cut -f1,2)"

# list --json: one entry per member (open, closed and suspended squads), with live.
: > "$DIR_LOG"
j="$(D list --project "$LBL" --from a --json)"
check "list --json: one entry per member" "11" "$(printf '%s' "$j" | jq 'length')"
check "list --json: every entry has a boolean live" "11" "$(printf '%s' "$j" | jq '[.[] | select(.live | type == "boolean")] | length')"
check "list asks wt-terminals once (host-wide)" "1" "$(grep -c '^wt-terminals$' "$DIR_LOG")"
check "list never asks run-workers (dispatch status is not liveness)" "0" "$(grep -c '^run-workers' "$DIR_LOG")"
check "list asks worker-detail once per open run" "1 1 1 0 0" "$(for r in run_a run_b run_e run_c run_s; do grep -c "^worker-detail $r\$" "$DIR_LOG"; done | paste -sd' ')"
bj="$(FAKE_BLIND=1 D list --project "$LBL" --from a --json)"
check "list --json: wt-terminals failed -> live null" "null" "$(printf '%s' "$bj" | jq -c '.[] | select(.wt=="wtET") | .live')"
check "list --json: blind still carries the wt address" "wtET" "$(printf '%s' "$bj" | jq -r '.[] | select(.wt=="wtET") | .address')"
check "list --json: in-squad Lead send command" 'orch.sh send run_a "<subject>" "<body>"' "$(printf '%s' "$j" | jq -r '.[] | select(.wt=="wtAL") | .send')"
check "list --json: a not-live member still carries its wt address" "wtBTe" "$(printf '%s' "$j" | jq -r '.[] | select(.wt=="wtBTe") | .address')"
check "list --json: live from wt-terminals" "true false" "$(printf '%s' "$j" | jq -r '[(.[] | select(.squad=="b" and .name=="thinker") | .live), (.[] | select(.name=="tester-env") | .live)] | map(tostring) | join(" ")')"
check "list --json: role/suffix split" "builder x" "$(printf '%s' "$j" | jq -r '.[] | select(.wt=="wtAB") | "\(.role) \(.suffix)"')"
check "list --json: closed squad not running" "false squad closed" "$(printf '%s' "$j" | jq -r '.[] | select(.squad=="c") | "\(.live) \(.reason)"')"
check "list --json: in-squad send command" 'orch.sh send-worker wtAT "<subject>" "<body>"' "$(printf '%s' "$j" | jq -r '.[] | select(.wt=="wtAT") | .send')"
check "list --json: cross-squad send command" 'send-peer.sh b thinker "<subject>" "<body>"' "$(printf '%s' "$j" | jq -r '.[] | select(.wt=="wtBT") | .send')"
check "list --json: terminals newest-first" '["term_at1","term_at2"]' "$(printf '%s' "$j" | jq -c '.[] | select(.wt=="wtAT") | .terminals')"
check "list --json: single terminal" '["term_b"]' "$(printf '%s' "$j" | jq -c '.[] | select(.wt=="wtBT") | .terminals')"
check "list --json: no terminals -> []" '[]' "$(printf '%s' "$j" | jq -c '.[] | select(.wt=="wtAB") | .terminals')"
check "list --json: backend blind -> []" '[]' "$(printf '%s' "$j" | jq -c '.[] | select(.wt=="wtET") | .terminals')"
check "list --json: closed squad has no terminals" '[]' "$(printf '%s' "$j" | jq -c '.[] | select(.wt=="wtCT") | .terminals')"
: > "$DIR_LOG"
D reach b thinker --project "$LBL" --from a >/dev/null
check "reach asks no worker-detail" "0" "$(grep -c '^worker-detail' "$DIR_LOG")"
check "reach asks wt-terminals once" "1" "$(grep -c '^wt-terminals$' "$DIR_LOG")"

t="$(D list --project "$LBL" --from a)"
check "list text: closed squad says not running" "1" "$(printf '%s\n' "$t" | grep -c 'not running (squad closed)')"
check "list text: suspended squad says not running" "1" "$(printf '%s\n' "$t" | grep -c 'not running (squad suspended)')"
bt="$(FAKE_BLIND=1 D list --project "$LBL" --from a)"
check "list text: wt-terminals failed says unknown for every open member" "8" "$(printf '%s\n' "$bt" | grep -c 'unknown (backend wt-terminals failed)')"
check "list text: live member" "1" "$(printf '%s\n' "$t" | grep -E '^  b +thinker +live$' -c)"

# send-role resolves through the phone book and sends by the returned kind.
SR() { BACKEND="$TMP/fakeb" "$ROOT/bin/role/send-role.sh" "$@"; }
: > "$DIR_LOG"
out="$(SR a thinker subj body --project "$LBL" --from a)"
check "send-role same squad -> send-worker" "1" "$(grep -c '^send-worker wtAT subj body$' "$DIR_LOG")"
check "send-role receipt names squad/role + kind" "1" "$(printf '%s' "$out" | grep -c 'send-role: delivered to a/thinker (worktree)')"
# U267 (4): with the member's agent terminal listed, send-role sends to that handle in the squad's Run,
# never to `@worktree:` (which can land in a plain shell or the Setup tab the agent never reads).
: > "$DIR_LOG"
out="$(FAKE_AGENTS='wtBT\tterm_b\tclaude\nwtAT\tterm_rev\tclaude -p review\nwtAT\tterm_at2\tclaude\nwtAT\tterm_at1\tclaude\n' SR a thinker subj body --project "$LBL" --from a)"
check "send-role same squad, agent listed -> its newest agent terminal, not a claude -p child" "1" "$(grep -c '^send-run-worker --to term_at2 run_a wtAT subj body$' "$DIR_LOG")"
check "send-role same squad, agent listed -> no @worktree send" "0" "$(grep -c '^send-worker' "$DIR_LOG")"
check "send-role same squad, agent listed -> receipt" "1" "$(printf '%s' "$out" | grep -c 'send-role: delivered to a/thinker (worktree)')"
: > "$DIR_LOG"
FAKE_AGENTS='wtBT\tterm_b\tclaude\n' SR a thinker subj body --project "$LBL" --from a >/dev/null
check "send-role same squad, no agent of that worktree -> send-worker" "1" "$(grep -c '^send-worker wtAT subj body$' "$DIR_LOG")"
: > "$DIR_LOG"
out="$(SR b lead subj body --project "$LBL" --from a)"
check "send-role other squad's lead -> send run" "1" "$(grep -c '^send run_b subj body$' "$DIR_LOG")"
: > "$DIR_LOG"
out="$(SR b thinker subj body --project "$LBL" --from a)"
check "send-role other squad's thinker -> send-run-worker" "1" "$(grep -c '^send-run-worker run_b wtBT subj body$' "$DIR_LOG")"
check "send-role receipt names the worktree-run kind" "1" "$(printf '%s' "$out" | grep -c 'send-role: delivered to b/thinker (worktree-run)')"
# U61: no pane holds the Lead's Run (nobody reads its Run inbox) -> the Lead's worktree in its Run,
# once; unknown holder -> the Run inbox, as before.
: > "$DIR_LOG"
out="$(FAKE_HOLDER="" SR b lead subj body --project "$LBL" --from a)"
check "send-role lead, no Run holder -> its worktree" "1" "$(grep -c '^send-run-worker run_b wtBL subj body$' "$DIR_LOG")"
check "send-role lead, no Run holder: no Run send" "0" "$(grep -c '^send run_b' "$DIR_LOG")"
check "send-role lead, no Run holder: receipt says worktree-run" "1" "$(printf '%s' "$out" | grep -c 'delivered to b/lead (worktree-run)')"
: > "$DIR_LOG"
FAKE_HOLDER="" SR b lead subj body --project "$LBL" >/dev/null   # the Studio: no --from
check "Studio send-role lead, no Run holder -> once to its worktree" "1" "$(grep -cE '^(send|send-worker|send-run-worker) ' "$DIR_LOG")"
check "Studio send-role lead, no Run holder: the Lead's worktree" "1" "$(grep -c '^send-run-worker run_b wtBL subj body$' "$DIR_LOG")"
: > "$DIR_LOG"
FAKE_HOLDER="?" SR b lead subj body --project "$LBL" --from a >/dev/null
check "send-role lead, holder unknown -> send run" "1" "$(grep -c '^send run_b subj body$' "$DIR_LOG")"
SR b tester-env subj body --project "$LBL" --from a >/dev/null 2>&1; check "send-role not running -> exit 3" "3" "$?"
: > "$DIR_LOG"
FAKE_BLIND=1 SR b thinker subj body --project "$LBL" --from a >/dev/null 2>&1; check "send-role blind -> exit 4 passes through" "4" "$?"
check "send-role blind: no backend send attempted" "0" "$(grep -cE '^(send|send-worker|send-run-worker) ' "$DIR_LOG")"
SR nope thinker subj body --project "$LBL" >/dev/null 2>&1; check "send-role unknown squad -> exit 2" "2" "$?"
: > "$DIR_LOG"; SR c thinker subj body --project "$LBL" >/dev/null 2>&1 || true
check "send-role closed squad: no backend send" "0" "$(grep -cE '^(send|send-worker|send-run-worker) ' "$DIR_LOG")"

# check (U75): reach's "is there such a member" from the state files, no backend call with --project.
: > "$DIR_LOG"
D check b thinker --project "$LBL" >/dev/null 2>&1; check "check: known member exits 0" "0" "$?"
D check nope thinker --project "$LBL" >/dev/null 2>&1; check "check: unknown squad exits 2" "2" "$?"
D check b ghost --project "$LBL" >/dev/null 2>&1; check "check: unknown role exits 2" "2" "$?"
D check c thinker --project "$LBL" >/dev/null 2>&1; check "check: closed squad exits 2" "2" "$?"
check "check: no backend call" "" "$(cat "$DIR_LOG")"

# Seam: the phone book only calls $BACKEND ops.
check "no direct orca call" "0" "$(grep -vE '^[[:space:]]*#' "$ROOT/bin/lib/directory.sh" | grep -cE 'orca[[:space:]]')"
check "no direct orca call in send-role" "0" "$(grep -vE '^[[:space:]]*#' "$ROOT/bin/role/send-role.sh" | grep -cE 'orca[[:space:]]')"

echo "directory: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
