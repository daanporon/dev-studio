#!/usr/bin/env bash
# loop-proof.sh — U17: the loop on a real throwaway squad, under a hermetic state root (KTD11, R30).
# What the fake-Orca tests cannot show: real Orca calls, crash settle, the board service, rollback.
#
#   tests/loop-proof.sh --run            (in an Orca terminal, from the main checkout)
#   tests/loop-proof.sh --run --crash [N] (only the kill -9 mid-start, N times, default 20: U38)
#
# It starts real Claude workers on real accounts and opens and merges one real PR into a throwaway
# base branch, so it is never part of a test suite and does nothing without --run. No operator step:
# it merges its own PR (KTD17). KEEP=1 leaves the squad, the branches and the root for a look.
#
# The layout is tests/lifecycle-wishes.sh's: a temp dir whose bin/, conventions/, roles/ and web/ link
# to this checkout and whose state/ is the hermetic DS_STATE_ROOT, since the scripts find state/ beside
# bin/. The live state root, the cron sweep and the live squads are not touched: worktrees are named
# with DS_PREFIX=dsproof-, and the asker is a plain terminal of the proof's own, so this pane never
# binds a Run. Merging refuses any PR whose base is not the throwaway branch.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091 source=tests/lib.sh
. "$ROOT/tests/lib.sh"

[ "${1:-}" = --run ] || { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
CRASH_RUNS=""
if [ "${2:-}" = --crash ]; then
  CRASH_RUNS="${3:-20}"
  case "$CRASH_RUNS" in ''|*[!0-9]*) echo "loop-proof: --crash takes a number of runs" >&2; exit 2 ;; esac
fi

BUN="$(command -v bun 2>/dev/null || true)"
[ -n "$BUN" ] || BUN="$HOME/.bun/bin/bun"
for t in jq gh git curl orca "$BUN"; do command -v "$t" >/dev/null || { echo "loop-proof: needs $t" >&2; exit 1; }; done
if [ ! -f "$ROOT/bin/loop/main.ts" ]; then echo "loop-proof: needs a main checkout" >&2; exit 1; fi

ID="$(date +%s)-$$"
TOPIC="loop-proof-$ID"
BASE="loop-proof-base-$ID"
LABEL=dev-studio
PORT="$(( 18700 + $$ % 1000 ))"
B="$ROOT/bin/backend/orca.sh"
REPO_DIR="$(cd "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
REPO="path:$REPO_DIR"
[ "$(basename "$REPO_DIR")" = "$LABEL" ] || { echo "loop-proof: the repo dir must be named $LABEL, got $REPO_DIR" >&2; exit 1; }
H="$(mktemp -d)"
S="$H/state"
SF="$S/$LABEL/squads/$TOPIC.json"

export DS_TOKEN_DIR="$HOME/.claude/projects" DS_STATE_ROOT="$S" DS_PREFIX=dsproof- DS_LOOP_TICK_S=2 DS_LOOP_GITHUB_S=15 DS_SWEEP_TOKENS_MIN=1
# The liveness clocks in minutes, shortened so a killed member shows within the run. SILENT_MIN stays
# long until the hung-Lead step: this Lead is told to stay idle, so it may leave mail unread.
export DS_SWEEP_SPAWN_GRACE_MIN=1 DS_SWEEP_SILENT_MIN=60 DS_SWEEP_RECHECK_MIN=1
unset DS_LOOP_CHILD DS_NOW BACKEND DS_WHO

LOOP_PID=""; SENDER=""; BASE_PUSHED=""; CLOSED=""; STEP=0; STOPPED=""
log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
pass() { STEP=$((STEP + 1)); log "PASS $STEP: $*"; }

# q <sql>: tab-separated rows from loop.db, read-only.
q() {
  "$BUN" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
    for (const r of d.query(process.argv[2]).values()) console.log(r.map((v) => v ?? "").join("\t"))' "$S/loop.db" "$1"
}
ds() { "$H/bin/ds" "$@"; }

transcript() {
  [ -f "$S/loop.db" ] || return 0
  echo; echo "=== findings ==="
  cat "$H/findings" 2>/dev/null || echo "(none)"
  echo; echo "=== events ==="
  q "SELECT id, datetime(at, 'unixepoch'), kind, COALESCE(squad, ''), COALESCE(member, ''), CASE WHEN kind LIKE '%failed' OR kind LIKE '%pending' THEN payload ELSE substr(COALESCE(payload, ''), 1, 200) END FROM events WHERE kind != 'spend' ORDER BY id" || true
  echo; echo "=== the Lead's worker and episodes ==="
  q "SELECT state, unread, last_output_at, datetime(observed_at, 'unixepoch') FROM observed_workers WHERE wt = '${LEAD_WT:-}'" || true
  q "SELECT kind, subject, state, count, datetime(started_at, 'unixepoch'), datetime(ended_at, 'unixepoch') FROM episodes WHERE subject LIKE '%lead%' ORDER BY started_at" || true
  echo; echo "=== orca_calls ==="
  q "SELECT id, op, state, retry_id, COALESCE(dispatch, ''), datetime(at, 'unixepoch'), key FROM orca_calls ORDER BY id" || true
  echo; echo "=== what the loop's children asked Orca, orphans too ==="
  cat "$H/proof/orca-calls" 2>/dev/null || echo "(none)"
  echo; echo "=== services ==="
  q "SELECT id, name, project, port, want, status, pid, started_at, restarts FROM services" || true
  echo; echo "=== services history ==="
  q "SELECT id, datetime(at, 'unixepoch'), kind, payload FROM events WHERE kind LIKE 'service%' ORDER BY id" || true
  echo; echo "=== answered questions ==="
  q "SELECT seq, id, status, answered_via, answer FROM questions WHERE status = 'answered' ORDER BY seq" || true
  echo; echo "=== restart requests ==="
  (cd "$S/$LABEL" 2>/dev/null && find requests -type f -exec sh -c 'printf "%s: " "$1"; cat "$1"' _ {} \;) || true
  echo; echo "=== squad-spent.tsv ==="
  cat "$S/$LABEL/loop/squad-spent.tsv" 2>/dev/null || echo "(none)"
  echo; echo "=== rollback sweep.log ==="
  cat "$H/rollback-sweep.log" 2>/dev/null || echo "(no rollback run)"
}

# To stderr: a wait_for inside $(…) must not swallow why the proof stopped.
report_failure() {
  {
    log "FAIL after step $STEP: $*"
    transcript
    [ ! -f "$H/loop.log" ] || { echo; echo "=== loop.log (tail) ==="; tail -n 30 "$H/loop.log"; }
  } >&2
  : > "$H/reported" # A file: die may run in a subshell.
}
die() { report_failure "$*"; exit 1; }

# This proof's worktrees on disk, by path: whatever the loop knows of them.
own_worktrees() { git -C "$REPO_DIR" worktree list --porcelain | sed -n 's/^worktree //p' | grep -F "$TOPIC" || true; }

# This proof's transcript folders: the system account's, and those of each Orca-managed account.
own_transcripts() {
  local d
  for d in "$HOME/.claude/projects"/*"$TOPIC"*/ "${ORCA_USER_DATA_PATH:-$HOME/.config/orca}"/claude-profiles/*/home/projects/*"$TOPIC"*/; do
    if [ -d "$d" ]; then printf '%s\n' "${d%/}"; fi
  done
}

# What teardown should have removed and did not.
leftovers() {
  own_worktrees
  git -C "$REPO_DIR" for-each-ref --format='%(refname)' refs/heads | grep -F "$ID"
  local remote
  if remote="$(git -C "$REPO_DIR" ls-remote --heads origin "*$ID*")"; then
    if [ -n "$remote" ]; then printf '%s\n' "$remote" | cut -f2; fi
  else
    echo "could not list origin's branches"
  fi
  own_transcripts
  ls "$HOME/.dev-studio/state/$LABEL/journals/$TOPIC"-*.md 2>/dev/null
}

# wait_for <seconds> <what> <command…>: until the command prints something, or the proof fails.
wait_for() {
  local secs="$1" what="$2" end out; shift 2
  end=$(( $(date +%s) + secs ))
  while :; do
    out="$("$@" 2>/dev/null || true)"
    if [ -n "$out" ]; then printf '%s' "$out"; return 0; fi
    [ "$(date +%s)" -lt "$end" ] || die "timed out after ${secs}s waiting for $what"
    sleep 2
  done
}

start_loop() {
  local at; at="$(date +%s)"
  (
    while read -r v; do unset "$v"; done < <(compgen -e | grep '^ORCA_')
    # close-role.sh finds state/ beside its own bin/, so the loop's retire has to run this root's.
    PATH="$H/proof/shim:$PATH" DS_CLOSE_ROLE="$H/bin/commands/close-role.sh" exec "$BUN" "$ROOT/bin/loop/main.ts"
  ) >>"$H/loop.log" 2>&1 &
  LOOP_PID=$!
  wait_for 60 "the loop's first tick" q "SELECT tick_no FROM health WHERE id = 1 AND pid = $LOOP_PID AND tick_at >= $at" >/dev/null
}

cleanup() {
  local rc=$? wt branch
  trap - EXIT
  set +e # Teardown runs to its end: one failed step must not leave the rest behind.
  [ "$rc" = 0 ] || [ -e "$H/reported" ] || report_failure "a command exited $rc"
  # shellcheck disable=SC2086  # a list of pids
  [ -z "$STOPPED" ] || kill -CONT $STOPPED 2>/dev/null || true
  if [ -n "${KEEP:-}" ]; then log "KEEP: root $H, topic $TOPIC, base $BASE, loop pid ${LOOP_PID:-none}"; exit "$rc"; fi
  stop_own "$LOOP_PID"
  if [ -f "$S/loop.db" ]; then
    local bp; bp="$(q "SELECT pid FROM services WHERE name = 'board' AND project = '$LABEL'" 2>/dev/null || true)"
    # Only the pid the loop recorded for this root's board, and only while it is a board-server.
    case "$bp" in ''|*[!0-9]*) ;; *) if grep -q board-server "/proc/$bp/cmdline" 2>/dev/null; then kill "$bp" 2>/dev/null || true; fi ;; esac
    q "SELECT DISTINCT branch FROM observed_worktrees WHERE branch LIKE '%$TOPIC%'" 2>/dev/null > "$H/branches" || true
    if [ -z "$CLOSED" ]; then
      for wt in $(q "SELECT wt FROM members WHERE squad = '$TOPIC' AND wt IS NOT NULL" 2>/dev/null || true) $(q "SELECT lead_wt FROM squads WHERE topic = '$TOPIC'" 2>/dev/null || true); do
        "$B" terminal-close-worktree "id:$wt" >/dev/null 2>&1 || true
        "$B" worktree-rm "id:$wt" force >/dev/null 2>&1 || true
      done
    fi
    while read -r branch; do
      case "$branch" in
        *"$TOPIC"*)
          git -C "$REPO_DIR" push origin --delete "$branch" >/dev/null 2>&1 || true
          git -C "$REPO_DIR" branch -D "$branch" >/dev/null 2>&1 || true ;;
      esac
    done < "$H/branches"
  fi
  # What the loop never recorded, such as the second worktree of a start that a crash raced.
  for wt in $(own_worktrees); do
    "$B" terminal-close-worktree "path:$wt" >/dev/null 2>&1 || true
    "$B" worktree-rm "path:$wt" force >/dev/null 2>&1 || true
  done
  git -C "$REPO_DIR" for-each-ref --format='%(refname:short)' refs/heads | grep -F "$TOPIC" | while read -r branch; do
    git -C "$REPO_DIR" push origin --delete "$branch" >/dev/null 2>&1 || true
    git -C "$REPO_DIR" branch -D "$branch" >/dev/null 2>&1 || true
  done
  # One more try after a failed delete; a branch still there is reported by leftovers below.
  if [ -n "$BASE_PUSHED" ] && ! git -C "$REPO_DIR" push origin --delete "$BASE" >/dev/null 2>&1; then
    sleep "${DS_PROOF_RETRY_S:-5}"
    git -C "$REPO_DIR" push origin --delete "$BASE" >/dev/null 2>&1 || true
  fi
  local left=""
  [ -z "$SENDER" ] || orca terminal close --terminal "$SENDER" >/dev/null 2>&1 || left="terminal $SENDER"
  # A real Lead reads role docs that name ~/.dev-studio: its journal is the one stray this topic can leave.
  rm -f "$HOME/.dev-studio/state/$LABEL/journals/$TOPIC"-*.md
  own_transcripts | while read -r d; do rm -rf "$d"; done
  rm -rf "$H"
  left="${left:+$left$'\n'}$(leftovers)"
  if [ -n "$left" ]; then
    log "FAIL: teardown left behind:"; printf '%s\n' "$left"
    [ "$rc" != 0 ] || rc=1
  else
    log "cleaned up, nothing left behind: root, squad, branches, terminal, journal and transcripts of $TOPIC"
  fi
  exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------------------- setup
for f in bin conventions roles web AGENTS.md; do ln -s "$ROOT/$f" "$H/$f"; done
mkdir -p "$S/$LABEL/squads" "$H/proof"
jq -n --arg r "$REPO" --arg l "$LABEL" '{home_repo: $r, label: $l}' > "$S/$LABEL/dispatcher.json"
# Between the loop's children and Orca. An orphan's answer goes to a dead pipe and a later success
# overwrites a call's result, so only here can a request_mismatch be seen every time. proof/wt-slow
# holds seconds to wait before a real worktree create: a wider window for the race U38 closes.
mkdir -p "$H/proof/shim"
cat > "$H/proof/shim/orca" <<EOF
#!/usr/bin/env bash
case "\${1:-} \${2:-}" in
  "worktree create"|"terminal create"|"orchestration worker-start") ;;
  *) exec "$(command -v orca)" "\$@" ;;
esac
what="\$1 \$2"; a=("\$@"); o="\$(mktemp "$H/proof/out.XXXXXX")"; e="\$(mktemp "$H/proof/err.XXXXXX")"
for ((i = 2; i < \${#a[@]} - 1; i++)); do
  case "\${a[i]}" in --name|--worktree|--terminal|--retry-request) what+=" \${a[i]}=\${a[i+1]}" ;; esac
done
if [ "\$what" != "\${what#worktree create}" ] && [ -s "$H/proof/wt-slow" ]; then sleep "\$(cat "$H/proof/wt-slow")"; fi
rc=0
"$(command -v orca)" "\$@" >"\$o" 2>"\$e" || rc=\$?
mark=""
if grep -qs request_mismatch "\$o" "\$e"; then mark=" request_mismatch"; printf '%s\n' "\$what" >> "$H/proof/mismatches"; fi
printf '%s pid=%s rc=%s %s%s\n' "\$(date +%H:%M:%S.%N | cut -c1-12)" "\$\$" "\$rc" "\$what" "\$mark" >> "$H/proof/orca-calls"
cat "\$o"; cat "\$e" >&2
rm -f "\$o" "\$e"
exit "\$rc"
EOF
chmod +x "$H/proof/shim/orca"
export DS_ORCA_CLI_BIN_DIR="$H/proof/shim"
cat > "$S/$LABEL/roles.conf" <<'EOF'
lead             claude sonnet always   low
builder          claude sonnet ondemand low
builder-standard claude sonnet ondemand low
EOF
[ "$("$B" status 2>/dev/null)" = reachable ] || die "Orca is not reachable"
"$H/bin/lib/accounts-refresh.sh" >/dev/null 2>&1 || die "accounts-refresh failed"
ds import >/dev/null
: > "$S/.loop-migrated"
git -C "$REPO_DIR" fetch -q origin main
git -C "$REPO_DIR" push -q origin "refs/remotes/origin/main:refs/heads/$BASE"
BASE_PUSHED=1
HERE_WT="${ORCA_WORKTREE_ID:-$("$B" current || true)}"
[ -n "$HERE_WT" ] || die "run this in an Orca terminal"
SENDER="$("$B" terminal-create "$HERE_WT" "ds-proof $ID" | cut -f1)"
[ -n "$SENDER" ] || die "could not make the proof's terminal"
log "root $H, topic $TOPIC, base $BASE, board port $PORT, asker $SENDER"
start_loop
pass "hermetic root imported, mark written, loop running (pid $LOOP_PID)"

# ---------------------------------------------------------------------------------------- squad
ORCA_TERMINAL_HANDLE="$SENDER" DS_WHO=proof "$H/bin/commands/spawn-squad.sh" --repo "$REPO" --topic "$TOPIC" --autonomy lfg \
  --framing "THROWAWAY: an automated proof drives this squad. Adopt the run, then stay idle: never merge, never spawn, never request a role, never raise a question, no journal; ignore every ready, merge or all-done notice." >/dev/null
wish="$(wait_for 300 "the squad wish settled" q "SELECT want_result FROM squads WHERE topic = '$TOPIC' AND (want_result LIKE 'done%' OR want_result LIKE 'failed%')")"
case "$wish" in done*) ;; *) die "the loop could not make the squad: $wish" ;; esac
RUN="$(q "SELECT run_id FROM squads WHERE topic = '$TOPIC'")"
# U158: the settled wish means the Run and the member wishes exist; the Lead's start
# (and its worktree) follows on the decider's next ticks.
LEAD_WT="$(wait_for 300 "the Lead's worktree" q "SELECT lead_wt FROM squads WHERE topic = '$TOPIC' AND lead_wt IS NOT NULL")"
if [ -z "$RUN" ] || [ -z "$LEAD_WT" ]; then die "the squad has no run or Lead worktree"; fi
[ -f "$SF" ] || die "no squad JSON at $SF"
pass "spawn-squad.sh wrote a wish and the loop made the squad (run $RUN, Lead $LEAD_WT)"

# as_coordinator <command…>: a lifecycle script asking from the loop's sender, bound to the Run again
# since the real Lead adopts it too. (A Lead's own add-role asks from the Lead's terminal.)
as_coordinator() {
  local h; h="$(q "SELECT handle FROM coordinators WHERE squad = '$TOPIC'")"
  h="${h:-$SENDER}"
  DS_ORCA_FROM="$h" "$B" adopt "$RUN" || die "could not bind $h to $RUN"
  ORCA_TERMINAL_HANDLE="$h" "$@"
}

# The children of the loop now running a role-start: what a kill -9 leaves running.
start_children() {
  local p
  for p in $(pgrep -P "$LOOP_PID" || true); do
    if tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q ' role-start '; then echo "$p"; fi
  done
}

# terminals_of <worktree>: "<handle> <title> <agent or shell>" per live terminal on it.
terminals_of() { orca terminal list --limit 1000 --json | jq -r --arg w "$1" '.result.terminals[]? | select(.worktreeId == $w and .connected == true) | "\(.handle) \(.title // "-") \(.agentIdentity // "shell")"'; }
agent_tabs() { terminals_of "$1" | awk '$NF != "shell"'; }

RACED=0
# crash_start <suffix> <seconds before the kill> <account or empty: the ladder's>: kill -9 the loop
# with this Builder's role-start in flight, restart it, and hold the outcome to U38: one worktree, one
# terminal, one retry id, the member running, and no request_mismatch even in the orphan's answers.
crash_start() {
  local su="$1" delay="$2" account="$3" mid call call_id retry orphans p wish wt n c settled by end stray left mism failed
  "$H/bin/role/squad-state.sh" "$SF" add-unit "$su" --tier standard --hold >/dev/null
  if [ -n "$account" ]; then
    # What the board's override writes, without a board: this member on this account.
    "$BUN" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1]); d.run("PRAGMA busy_timeout = 5000"); d.run(process.argv[2])' "$S/loop.db" \
      "INSERT INTO overrides (member, account, set_by, set_at) VALUES ('$LABEL/$TOPIC/builder/$su', '$account', 'proof', $(date +%s))"
  fi
  ds request builder --unit "$su" --squad "$LABEL/$TOPIC" --by proof --spec "You are a throwaway Builder in an automated proof. Do nothing: no commands, no worker_done. End your turn." >/dev/null
  mid="$(q "SELECT id FROM members WHERE squad = '$TOPIC' AND role = 'builder' AND suffix = '$su'")"
  end=$(( $(date +%s) + 120 )); call=""
  while [ -z "$call" ]; do
    call="$(q "SELECT id, retry_id FROM orca_calls WHERE member IS NULL AND key LIKE 'start:$mid:%' AND state = 'sent' AND settled_at IS NULL" || true)"
    [ -n "$call" ] || [ "$(date +%s)" -lt "$end" ] || die "no start call in flight for Builder $su"
  done
  sleep "$delay"
  orphans="$(start_children)"
  kill -9 "$LOOP_PID"; wait "$LOOP_PID" 2>/dev/null || true
  call_id="${call%%	*}"; retry="${call#*	}"
  if [ "$(q "SELECT state, settled_at IS NULL FROM orca_calls WHERE id = $call_id")" != "sent	1" ]; then
    # Only a kill with no wait has to find it in flight: a later one may come after the start ended.
    [ "$delay" != 0 ] || die "the call was not left in flight by the kill"
    log "note: Builder $su's call settled before the kill, $delay s in"
  fi
  [ -z "$orphans" ] || RACED=$((RACED + 1))
  pass "the loop was killed -9 $delay s into $su's role-start (orca_calls $call_id, retry $retry, orphan: ${orphans:-none}, account: ${account:-ladder}, wt-slow: $(cat "$H/proof/wt-slow" 2>/dev/null || echo 0))"
  start_loop
  wait_for 300 "the call settled" q "SELECT 1 FROM orca_calls WHERE id = $call_id AND state = 'completed' AND settled_at IS NOT NULL" >/dev/null
  wish="$(wait_for 300 "Builder $su's wish settled" q "SELECT want_result FROM members WHERE id = $mid AND want_result IS NOT NULL")"
  case "$wish" in failed*) die "Builder $su's start failed for good after the crash: ${wish:0:300}" ;; esac
  wt="$(wait_for 300 "Builder $su running" q "SELECT wt FROM members WHERE squad = '$TOPIC' AND role = 'builder' AND suffix = '$su' AND status = 'running' AND wt IS NOT NULL")"
  n="$("$B" run-workers "$RUN" | awk -F'\t' -v w="$wt" '$1 == w && $2 == "yes"' | wc -l | tr -d ' ')"
  [ "$n" = 1 ] || die "Builder $su's worktree has $n live workers, want 1"
  c="$(q "SELECT COUNT(*) FROM orca_calls WHERE key LIKE 'start:$mid:%'")"
  [ "$c" = 1 ] || die "the start of $su took $c calls, want one id replayed"
  settled="$(q "SELECT COUNT(*) FROM events WHERE kind = 'orca_call_settled' AND json_extract(payload, '\$.retry') = '$retry'")"
  if [ "$settled" -ge 1 ]; then by="request-show"; else by="the replay"; fi
  # Whatever the orphan does, it has done by now: only then do the counts below say anything.
  end=$(( $(date +%s) + 180 ))
  for p in $orphans; do
    while kill -0 "$p" 2>/dev/null; do
      [ "$(date +%s)" -lt "$end" ] || die "the orphan $p of Builder $su's start is still running after 180 s"
      sleep 1
    done
  done
  stray="$(own_worktrees | grep -F "builder-$su-" | grep -vxF "${wt#*::}" || true)"
  [ -z "$stray" ] || die "a start crashed mid-flight left a second worktree no one owns: $stray"
  # The worktree create's own shell is no second terminal of the member: any start has it.
  wait_for 60 "Builder $su's agent terminal" agent_tabs "$wt" >/dev/null
  left="$(terminals_of "$wt")"
  if [ "$(printf '%s\n' "$left" | awk '$NF != "shell"' | wc -l | tr -d ' ')" != 1 ] || [ "$(printf '%s\n' "$left" | awk '$NF == "shell"' | wc -l | tr -d ' ')" -gt 1 ]; then
    die "Builder $su's worktree has other terminals than one agent and its first shell: $left"
  fi
  mism="$(cat "$H/proof/mismatches" 2>/dev/null || true)"
  [ -z "$mism" ] || die "Orca answered request_mismatch: $mism"
  mism="$(q "SELECT COUNT(*) FROM events WHERE payload LIKE '%request_mismatch%'")"
  [ "$mism" = 0 ] || die "$mism events name a request_mismatch"
  failed="$(q "SELECT COUNT(*) FROM events WHERE kind = 'member_start_failed'")"
  [ "$failed" = 0 ] || die "$failed member_start_failed events"
  pass "after the restart $by settled $su's call: one retry id, one worktree, one agent terminal ($(printf '%s' "$left" | awk '{ print $2 "/" $NF }' | tr '\n' ' ')), one live worker, no request_mismatch"
  inroster() { jq -e --arg s "$su" '.members[]? | select(.role == "builder" and .suffix == $s)' "$SF" >/dev/null && echo yes; }
  wait_for 60 "Builder $su in the exported roster" inroster >/dev/null
  as_coordinator "$H/bin/commands/close-role.sh" "$LABEL" "$TOPIC" "builder-$su" --cancel --why "proof" --wait 300 >/dev/null || die "close-role of $su failed"
  pass "Builder $su retired with close-role.sh"
}

close_squad() {
  DS_ORCA_FROM="$SENDER" "$B" adopt "$RUN" || die "could not bind the proof's terminal to $RUN"
  ORCA_TERMINAL_HANDLE="$SENDER" "$H/bin/commands/close-squad.sh" "$LABEL" "$TOPIC" --force --wait 300 >/dev/null || die "close-squad failed"
  [ "$(q "SELECT status FROM squads WHERE topic = '$TOPIC'")" = closed ] || die "the squad is not closed"
  CLOSED=1
  pass "close-squad.sh wrote a wish and the loop closed the squad"
}

if [ -n "$CRASH_RUNS" ]; then
  # Every mix over the runs: both accounts' paths (a managed one opens its own tab, the system one
  # does not), the kill early and late in the start, and the worktree create slowed past the restart.
  MANAGED="$(awk -F'\t' '$1 == "claude" && $2 != "system" { print $2; exit }' "$S/accounts.tsv" 2>/dev/null || true)"
  [ -n "$MANAGED" ] || log "note: no managed Claude account on this host, every run takes the ladder's"
  KILLS=(0 0.3 0.6 1 1.5); SLOWS=(0 3 6)
  for ((i = 1; i <= CRASH_RUNS; i++)); do
    log "--- crash run $i of $CRASH_RUNS"
    printf '%s\n' "${SLOWS[i % 3]}" > "$H/proof/wt-slow"
    if [ $((i % 2)) = 0 ]; then acct="$MANAGED"; else acct=""; fi
    crash_start "c$i" "${KILLS[i % 5]}" "$acct"
  done
  [ "$RACED" -gt 0 ] || die "none of $CRASH_RUNS kills left an orphan running: this proved nothing about the race"
  pass "$CRASH_RUNS runs of kill -9 mid-start, $RACED with an orphan still running: no second worktree, no request_mismatch, no member_start_failed, one agent terminal each"
  close_squad
  transcript
  log "CRASH PROOF PASSED ($STEP steps)"
  exit 0
fi

ds nudge poke --project "$LABEL" --squad "$TOPIC" --member "$LEAD_WT" --key "proof-ping-$ID" --by proof \
  --json '{"text":"dev-studio proof ping: nothing to do, do not reply."}' --wait 120 >/dev/null || die "ds nudge poke did not land"
pass "ds nudge poke reached the Lead's terminal through the loop"

# ---------------------------------------------------------------------------------------- board
"$H/bin/board/board.sh" "$LABEL" --serve "$PORT" >/dev/null
boardpid() { q "SELECT pid FROM services WHERE name = 'board' AND project = '$LABEL' AND status = 'running' AND pid IS NOT NULL"; }
P1="$(wait_for 90 "the board service" boardpid)"
wait_for 30 "/healthz" curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null
kill -9 "$P1"
newboard() { local p; p="$(boardpid)"; [ -n "$p" ] && [ "$p" != "$P1" ] && printf '%s' "$p"; }
P2="$(wait_for 90 "the board restarted" newboard)"
wait_for 30 "/healthz after the restart" curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null
pass "board.sh --serve wished the board; the loop started it (pid $P1) and restarted it after kill -9 (pid $P2)"

# ------------------------------------------------------------------------- the Builder and its PR
Q1="proof-q1-$ID"; Q2="proof-q2-$ID"; A1="terminal-answer-$ID"; A2="board-answer-$ID"
cat > "$H/proof/ask.sh" <<EOF
#!/usr/bin/env bash
# ask.sh <question id>: raise one operator question on the hermetic root.
export DS_STATE_ROOT="$S"
rc=0
"$H/bin/role/ask-operator.sh" "$SF" "\$1" builder false --title "proof question \$1" --question "A throwaway proof question." \\
  --option yes "the proof goes on" --option no "the proof goes on too" --recommend 1 --why "automated proof" || rc=\$?
# 3: on the board, only the card note failed.
[ "\$rc" = 3 ] && exit 0
exit "\$rc"
EOF
cat > "$H/proof/pr.sh" <<EOF
#!/usr/bin/env bash
# pr.sh: one trivial commit on this worktree's branch, as a PR into the throwaway base.
set -euo pipefail
git fetch -q origin "$BASE"
git reset -q --hard "origin/$BASE"
branch="\$(git rev-parse --abbrev-ref HEAD)"
echo "$TOPIC" > ".loop-proof-$ID"
git add ".loop-proof-$ID"
git commit -qm "chore: throwaway loop proof $ID"
git push -qu origin "\$branch"
gh pr create --base "$BASE" --head "\$branch" --title "chore: throwaway loop proof $ID" --body "Throwaway PR of tests/loop-proof.sh, merged by the script into $BASE."
EOF
cat > "$H/proof/got.sh" <<EOF
#!/usr/bin/env bash
# got.sh <question id> <answer>: note the answer that reached this terminal.
printf '%s\n' "\$2" > "$H/proof/got-\$1"
EOF
chmod +x "$H/proof/"*.sh

"$H/bin/role/squad-state.sh" "$SF" add-unit u1 --tier standard --hold >/dev/null
# Blocked on u1, so the loop dispatches its Builder when u1 is done — no poke.
"$H/bin/role/squad-state.sh" "$SF" add-unit after-u1 "" "" u1 --tier standard >/dev/null
afteru1() { q "SELECT wt FROM members WHERE squad = '$TOPIC' AND role = 'builder' AND suffix = 'after-u1' AND wt IS NOT NULL"; }
SPEC="You are a throwaway Builder in an automated proof. Do exactly these steps, one command each, and nothing else: no role docs, no other dev-studio command, no worker_done. 1) Run: $H/proof/ask.sh $Q1  2) Run: $H/proof/ask.sh $Q2  3) Run: $H/proof/pr.sh  4) End your turn. Later, if a message says the operator answered question $Q2, run only: $H/proof/got.sh $Q2 '<the answer it gives>' and end your turn again. Any other message: end your turn."
ds request builder --unit u1 --squad "$LABEL/$TOPIC" --by proof --spec "$SPEC" >/dev/null
BU1="$(wait_for 300 "Builder u1 started" q "SELECT wt FROM members WHERE squad = '$TOPIC' AND role = 'builder' AND suffix = 'u1' AND status = 'running' AND wt IS NOT NULL")"
BT="$(q "SELECT builder_wt FROM units WHERE squad = '$TOPIC' AND slug = 'u1' AND status = 'dispatched'")"
[ "$BT" = "$BU1" ] || die "unit u1 is not dispatched to its Builder ($BT vs $BU1)"
[ "$(q "SELECT COUNT(*) FROM events WHERE kind = 'pick' AND json_extract(payload, '\$.role') = 'builder'")" -ge 1 ] || die "the Builder started with no pick from the ladder"
ACC="$(q "SELECT agent, model, COALESCE(account, '') FROM members WHERE wt = '$BU1'")"
pass "ds request started the Builder through the ladder ($(printf '%s' "$ACC" | tr '\t' ' '))"

# ------------------------------------------------------------------------------ the answer, both ways
onboard() { curl -fsS "http://127.0.0.1:$PORT/board.json" | jq -r --arg id "$1" '[.. | objects | .questions? // empty | .[]? | select(.id == $id)] | if length > 0 then "yes" else empty end'; }
wait_for 300 "$Q1 on the board" onboard "$Q1" >/dev/null
wait_for 120 "$Q2 on the board" onboard "$Q2" >/dev/null
pass "the Builder's two questions are rows and on the board"

"$H/bin/role/squad-state.sh" "$SF" resolve-question "$Q1" --answer "$A1" >/dev/null
gone_q1() { local on; if on="$(onboard "$Q1")" && [ -z "$on" ]; then echo gone; fi; }
wait_for 30 "$Q1 off the board" gone_q1 >/dev/null
[ "$(q "SELECT status, answered_via, answer FROM questions WHERE id = '$Q1'")" = "answered	terminal	$A1" ] || die "$Q1's row does not keep the terminal answer"
pass "a terminal answer (resolve-question) left the board and its row keeps it, via terminal"

code="$(curl -sS -o "$H/answer.out" -w '%{http_code}' -H "Origin: http://127.0.0.1:$PORT" -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg p "$LABEL" --arg t "$TOPIC" --arg i "$Q2" --arg a "$A2" '{project: $p, topic: $t, id: $i, answer: $a}')" "http://127.0.0.1:$PORT/api/answer")"
[ "$code" = 202 ] || die "/api/answer said $code: $(cat "$H/answer.out")"
[ "$(q "SELECT status, answered_via, answer FROM questions WHERE id = '$Q2'")" = "answered	board	$A2" ] || die "$Q2's row does not keep the board answer"
got_q2() { grep -sF "$A2" "$H/proof/got-$Q2"; }
wait_for 300 "the board answer in the Builder's terminal" got_q2 >/dev/null
pass "a board answer reached the asking terminal (the Builder acted on it) and its row keeps it, via board"

# ------------------------------------------------------------------------------ PR, merge, done, retired
PR="$(wait_for 300 "the PR recorded on the unit" q "SELECT pr FROM units WHERE squad = '$TOPIC' AND slug = 'u1' AND pr IS NOT NULL")"
pass "the loop observed PR #$PR and recorded it on unit u1"
wait_for 300 "PR #$PR merge-ready" q "SELECT verdict FROM observed_prs WHERE project = '$LABEL' AND pr = $PR AND verdict = 'ready'" >/dev/null
info="$(gh pr view "$PR" --json baseRefName,headRefName -q '.baseRefName + " " + .headRefName')"
[ "${info%% *}" = "$BASE" ] || die "PR #$PR has base '${info%% *}', refusing to merge anything but $BASE"
case "${info#* }" in *"$TOPIC"*) ;; *) die "PR #$PR has head '${info#* }', not this proof's" ;; esac
gh pr merge "$PR" --squash >/dev/null
MERGED_AT="$(date +%s)"
pass "the script merged PR #$PR into $BASE once merge-ready (KTD17)"
wait_for 180 "unit u1 done" q "SELECT 1 FROM units WHERE squad = '$TOPIC' AND slug = 'u1' AND status = 'done'" >/dev/null
pass "the loop marked unit u1 done, $(( $(date +%s) - MERGED_AT ))s after the merge"
retired() { [ "$(q "SELECT COUNT(*) FROM members WHERE squad = '$TOPIC' AND wt = '$BU1' AND COALESCE(status, '') NOT IN ('gone', 'closed')")" = 0 ] && echo gone; }
wait_for 300 "Builder u1 retired" retired >/dev/null
pass "the loop retired Builder u1, $(( $(date +%s) - MERGED_AT ))s after the merge"
wait_for 120 "Builder after-u1 dispatched" afteru1 >/dev/null

# ------------------------------------------------------------------------------ killed mid-start
crash_start u2 0 ""

# ------------------------------------------------------------------------------ add-role, close-role
# u3 is held so only the explicit add-role wish dispatches it (the loop never wishes a held unit).
"$H/bin/role/squad-state.sh" "$SF" add-unit u3 --tier standard --hold >/dev/null
as_coordinator "$H/bin/commands/add-role.sh" "$LABEL" "$TOPIC" builder u3 --spec "You are a throwaway Builder in an automated proof. Do nothing: no commands, no worker_done. End your turn." >/dev/null || die "add-role failed"
BU3="$(wait_for 300 "Builder u3 started" q "SELECT wt FROM members WHERE squad = '$TOPIC' AND role = 'builder' AND suffix = 'u3' AND wt IS NOT NULL")"
[ -n "$BU3" ] || die "add-role left no member row"
pass "add-role.sh wrote a wish and the loop started Builder u3 ($BU3)"

# ------------------------------------------------------------------------------ a killed member
request_for() { grep -rlsF "restart $1 of $TOPIC" "$S/$LABEL/requests/$2" | head -n 1; }
sleep "$(( 60 + 2 * DS_LOOP_TICK_S ))" # out of the spawn grace
"$B" terminal-close-worktree "id:$BU3" >/dev/null || die "could not kill Builder u3's terminal"
RF="$(wait_for 180 "the restart request for the killed Builder" request_for builder-u3 "$TOPIC")"
grep -qE "^restart builder-u3 of $TOPIC \((dead|exited) since " "$RF" || die "the request has the wrong text: $(cat "$RF")"
pass "a killed Builder got the sweep's restart request ($(cat "$RF"))"
as_coordinator "$H/bin/commands/restart-role.sh" "$LABEL" "$TOPIC" builder u3 >/dev/null || die "restart-role of u3 failed"
rm -f "$RF"
[ -n "$(q "SELECT 1 FROM members WHERE squad = '$TOPIC' AND suffix = 'u3' AND restart_at IS NOT NULL")" ] || die "restart-role left no restart wish on Builder u3 (U153)"
live_u3() { "$B" run-workers "$RUN" | awk -F'\t' -v w="$BU3" '$1 == w && $2 == "yes"'; }
wait_for 120 "Builder u3's live worker" live_u3 >/dev/null
pass "acting on the request, restart-role.sh wrote a wish and the loop restarted Builder u3"

as_coordinator "$H/bin/commands/close-role.sh" "$LABEL" "$TOPIC" builder-u3 --cancel --why "proof" --wait 300 >/dev/null || die "close-role of u3 failed"
for script in restart-role close-role; do
  acted="$(q "SELECT COUNT(*) FROM events WHERE kind = 'action' AND squad = '$TOPIC' AND json_extract(payload, '\$.kind') = 'role' AND json_extract(payload, '\$.subject') LIKE 'role:$script:%builder-u3%'")"
  [ "$acted" -ge 1 ] || die "events show the loop making no call for the $script wish of u3"
done
[ "$(q "SELECT COUNT(*) FROM events WHERE kind = 'action' AND squad = '$TOPIC' AND json_extract(payload, '\$.kind') = 'role' AND json_extract(payload, '\$.subject') LIKE 'role:add-role:%builder-u3%'")" = 0 ] || die "add-role left a replay wish"
pass "close-role.sh retired Builder u3; events show the loop acting on the restart and close wishes, and add-role wrote no replay"

# ------------------------------------------------------------------------------ a Lead not responding
# Stopped, the real Lead stays idle with the mail unread, so the sequence runs on real Orca facts.
LEAD_DIR="${LEAD_WT#*::}"
for d in /proc/[0-9]*; do
  [ "$(readlink "$d/cwd" 2>/dev/null)" = "$LEAD_DIR" ] || continue
  [ "$(cat "$d/comm" 2>/dev/null)" = claude ] && STOPPED="$STOPPED ${d#/proc/}"
done
[ -n "$STOPPED" ] || die "found no Lead process in $LEAD_DIR"
stop_own "$LOOP_PID"; export DS_SWEEP_SILENT_MIN=1; start_loop
# Idle first: stopped mid-turn it would stay `working`, which only the 30-minute hung clock reads.
lead_idle() { q "SELECT 1 FROM observed_workers WHERE wt = '$LEAD_WT' AND gone_at IS NULL AND state IN ('idle', 'done') AND COALESCE(last_output_at, 0) < unixepoch() - 15"; }
wait_for 300 "the Lead idle and quiet" lead_idle >/dev/null
# shellcheck disable=SC2086  # a list of pids
kill -STOP $STOPPED
DS_ORCA_FROM="$SENDER" "$B" send-run-worker "$RUN" "$LEAD_WT" "proof" "dev-studio proof: unread on purpose." >/dev/null || die "could not mail the Lead"
lead_unread() { q "SELECT 1 FROM observed_workers WHERE wt = '$LEAD_WT' AND state IN ('idle', 'done') AND unread > 0"; }
wait_for 60 "the stopped Lead seen idle with unread mail" lead_unread >/dev/null
silentpokes() { q "SELECT COUNT(*) FROM events WHERE kind = 'action' AND squad = '$TOPIC' AND json_extract(payload, '\$.kind') = 'poke' AND json_extract(payload, '\$.episode') LIKE 'silent:%'"; }
RF="$(wait_for 420 "the restart request for the Lead" request_for lead _studio)"
[ "$(silentpokes)" -ge 1 ] || die "the Lead's restart request came with no poke before it"
grep -qF "(not responding since " "$RF" || die "the request has the wrong text: $(cat "$RF")"
pass "a Lead not responding got $(silentpokes) poke(s), then the restart request ($(cat "$RF"))"
rm -f "$RF"
# shellcheck disable=SC2086  # a list of pids
kill -CONT $STOPPED; STOPPED=""
stop_own "$LOOP_PID"; export DS_SWEEP_SILENT_MIN=60; start_loop

[ "$(q "SELECT COUNT(*) FROM members WHERE squad = '$TOPIC' AND role = 'builder' AND suffix = 'after-u1'")" = 1 ] || die "unit after-u1 got more than one Builder"
started_after="$(q "SELECT (SELECT want_at FROM members WHERE squad = '$TOPIC' AND role = 'builder' AND suffix = 'after-u1') > (SELECT MIN(at) FROM events WHERE kind = 'unit_done' AND squad = '$TOPIC')")"
[ "$started_after" = 1 ] || die "unit after-u1's Builder wish did not come after u1 went done"
pass "unit after-u1 got exactly one Builder, wished after u1 went done, across every tick since"

# Every account's projects/ is linked to the system login's, so the squad's real transcripts are all under
# DS_TOKEN_DIR by their own `-dsproof-` names: the loop's whole spend chain runs on what this squad really spent.
[ -n "$(own_transcripts)" ] || die "found no transcripts of this squad under any account"
while read -r d; do
  case "$(readlink -f "$d")/" in "$(readlink -f "$DS_TOKEN_DIR")"/*) ;; *) die "transcripts outside the scanned folder, so uncounted: $d" ;; esac
done < <(own_transcripts)
spend() { awk -F'\t' -v t="$TOPIC" '$1 == t && $3 > 0' "$S/$LABEL/loop/squad-spent.tsv" 2>/dev/null; }
SPEND="$(wait_for 240 "the squad's spend row, above zero" spend)"
pass "the loop wrote the squad's spend to squad-spent.tsv ($(printf '%s' "$SPEND" | tr '\t' ' '))"

# ------------------------------------------------------------------------------ rollback
stop_own "$LOOP_PID"; LOOP_PID=""
stale="$(ds export --project "$LABEL" --squad "$TOPIC" | jq -c '.written')"
[ "$stale" = "[]" ] || die "the exported squad JSON was not current: $stale"
pass "the loop stopped and the exported squad JSON is current"

# The historical switch proof exercised a rollback to the removed driver.
# Both current branches run the loop; that transcript remains in docs/solutions.
# ------------------------------------------------------------------------------ close
: > "$S/.loop-migrated"
start_loop
"$H/bin/board/board.sh" "$LABEL" --stop >/dev/null
close_squad
transcript
log "PROOF PASSED ($STEP steps)"
