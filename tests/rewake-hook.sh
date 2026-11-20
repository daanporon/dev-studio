#!/usr/bin/env bash
# rewake-hook.sh — the single wake mechanism. Exercises its exit paths against a FAKE
# watch.sh (FAKE_MSG=1 -> a message; else the empty-inbox placeholder), so the contract is
# pinned: a message wakes (exit 2), a Lead's empty window reconciles (exit 2), a Thinker's
# empty window stops (exit 0), and an unacked message backs off + re-arms (never exit 0).
set -euo pipefail
# shellcheck source=tests/lib/hook-tree.sh
. "$(dirname "$0")/lib/hook-tree.sh"

SRC="$(cd "$(dirname "$0")/.." && pwd)/bin/hooks/rewake-hook.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/ds/bin/hooks" "$TMP/ds/bin/lib"
cp "$SRC" "$TMP/ds/bin/hooks/rewake-hook.sh"
hook_tree "$TMP/ds"
cat > "$TMP/ds/bin/lib/watch.sh" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${WATCH_ARGS:-/dev/null}"
if [ "${FAKE_READ_FAIL:-0}" = 1 ]; then
  [ -z "${FAKE_REQ:-}" ] || printf 'REQUESTS:\n  ↻ request\t%s\n' "$FAKE_REQ"
  echo "INBOX READ FAILED: invalid_argument: Unknown flag --full" >&2
  exit 1
fi
if [ "${FAKE_MSG:-0}" = 1 ]; then echo "MESSAGES:"; { [ -n "${FAKE_MID:-}" ] && printf '  • [msg] wtLead — ping  (id=%s)\n' "$FAKE_MID"; } || echo "  m"; else echo "(none — timeout; do a check-in and re-arm)"; fi
[ -n "${FAKE_UNASKED:-}" ] && printf '  ❓ unasked\tthinker\twtTh\t%s\t(since 222)\n' "$FAKE_UNASKED"
[ -n "${FAKE_SIT:-}" ] && printf '  ⏸ sitting\tu1\twtSit\t20m idle\t%s\t(since 10:05)\n' "$FAKE_SIT"
[ -n "${FAKE_BANG:-}" ] && printf '  ‼ merged\t%s\twtBang\tPR #%s MERGED\tthe loop has not marked it done yet: it does on its next PR read; if this stays after a tick, mark it done (refused until the loop has read the merge), and it retires the Builder\n' "${FAKE_BANG%% *}" "${FAKE_BANG#* }"
[ -n "${FAKE_FIN:-}" ] && printf '  ★ finished\t%s\t%s\tall units merged: do the testability handoff\n' "${FAKE_FIN%% *}" "${FAKE_FIN#* }"
[ -n "${FAKE_STALLED:-}" ] && printf '  ⚠ sweep stalled\t-\t-\tlast full run %s\tno merges marked, no Builders retired — tell the operator\t(since %s)\n' "$FAKE_STALLED" "$FAKE_STALLED"
[ -n "${FAKE_MERGED:-}" ] && printf '  ✓ merged\t%s\tPR #%s\t(at 10:05)\n' "${FAKE_MERGED%% *}" "${FAKE_MERGED#* }"
[ -n "${FAKE_READY:-}" ] && printf '  ▶ ready\t%s\t%s\t(dispatch it or hold it)\n' "${FAKE_READY%% *}" "${FAKE_READY#* }"
[ -n "${FAKE_REQ:-}" ] && printf 'REQUESTS:\n  ↻ request\t%s\n' "$FAKE_REQ"
[ -n "${FAKE_REQ2:-}" ] && printf '  ↻ request\t%s\n' "$FAKE_REQ2"
true
FAKE
chmod +x "$TMP/ds/bin/hooks/rewake-hook.sh" "$TMP/ds/bin/lib/watch.sh"
H="$TMP/ds/bin/hooks/rewake-hook.sh"
# POLL_GAP=0 so the empty-window cases don't actually sleep 20s each.
export DS_REWAKE_LOG=none DS_REWAKE_WINDOW_SEC=1 DS_REWAKE_POLL_GAP_SEC=0 DS_REWAKE_BACKOFF_SEC=0

pass=0; fail=0
# shellcheck disable=SC2086  # $1 is a watch-arg string that must split into the hook's args
rc() { printf '{%s}' "${2:-}" | FAKE_MSG="${3:-0}" "$H" $1 >/dev/null 2>&1; echo $?; }
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 (want $3, got $2)" >&2; fi; }

# A state file with two Builders' units: one done, one still working — for the done-check.
ST="$TMP/sq.json"
printf '{"units":[{"slug":"a","builder_wt":"wtDone","status":"done"},{"slug":"b","builder_wt":"wtWork","status":"dispatched"}]}' > "$ST"

eq "a message wakes a Lead (exit 2)"              "$(rc 'acme topic' '' 1)"                 "2"
eq "a message wakes a Thinker (exit 2)"          "$(rc '--worktree' '' 1)"                  "2"
eq "Lead empty window -> reconcile (exit 2)"      "$(rc 'acme topic' '' 0)"                  "2"
eq "Thinker empty window -> stays wakeable (exit 2)" "$(rc '--worktree' '' 0)"              "2"
eq "Builder empty window, unit DONE -> go dark (exit 0)"      "$(rc "--worktree --done-check $ST wtDone" '' 0)" "0"
eq "Builder empty window, unit NOT done -> stays wakeable (exit 2)" "$(rc "--worktree --done-check $ST wtWork" '' 0)" "2"
eq "stop_hook_active + handled -> re-arm, stays wakeable (exit 2, --worktree)" "$(rc '--worktree' '"stop_hook_active":true' 0)" "2"
eq "stop_hook_active + unhandled -> back off + re-arm, wakes (exit 2), not 0" "$(rc 'acme topic' '"stop_hook_active":true' 1)" "2"

# The hook must peek NON-BLOCKING (watch.sh --poll), never park in an inbox-wait long-poll.
export WATCH_ARGS="$TMP/wargs"; : > "$WATCH_ARGS"
_wake="$(rc 'acme topic' '' 0)"; [ -n "$_wake" ]  # run the hook once (same pattern as above)
if grep -q -- '--poll' "$WATCH_ARGS"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: hook must call watch.sh --poll (non-blocking)" >&2; fi
if grep -qE '[0-9]{4,}' "$WATCH_ARGS"; then fail=$((fail+1)); echo "  FAIL: hook must NOT pass a long blocking timeout" >&2; else pass=$((pass+1)); fi
unset WATCH_ARGS

# A sitting Builder wakes the Lead once per stage (nudge, then restart) — not every peek.
export DS_REWAKE_SEEN="$TMP/seen"
sit() { printf '{}' | FAKE_SIT="$1" "$H" acme topic 2>&1 >/dev/null | grep -c 'a Builder is sitting' || true; }
eq "a newly sitting Builder wakes the Lead"           "$(sit 'nudge it')" "1"
eq "the same sitting stage does not wake it again"    "$(sit 'nudge it')" "0"
eq "the restart stage wakes the Lead once more"       "$(sit 'restart')"  "1"
eq "a Thinker hook ignores sitting Builders"          "$(printf '{}' | FAKE_SIT=x "$H" --worktree 2>&1 >/dev/null | grep -c 'a Builder is sitting' || true)" "0"

# A pending restart request (the removed sweep) wakes the Studio / Lead like a message does.
# shellcheck disable=SC2086  # $1 is a watch-arg string that must split into the hook's args
req() { printf '{%s}' "${2:-}" | FAKE_REQ=1 "$H" $1 2>&1 >/dev/null | grep -c 'restart request is waiting' || true; }
eq "a restart request wakes the Studio"              "$(req '--worktree --requests p')" "1"
eq "a restart request wakes a Lead"                  "$(req 'acme topic')" "1"
eq "an unhandled request backs off, then wakes again" "$(req '--worktree --requests p' '"stop_hook_active":true')" "1"
eq "no request, no message: no 'waiting' wake"       "$(printf '{}' | "$H" --worktree --requests p 2>&1 >/dev/null | grep -c 'is waiting' || true)" "0"

# A request filed AFTER the banner the agent acted on re-wakes at once — no 15-minute
# backoff. The hook records what each WAKE banner showed; on stop_hook_active a peek holding
# anything not shown skips the sleep. DS_REWAKE_BACKOFF_SEC=120 + timeout 30 prove it: a
# backoff would be killed (124), an immediate re-wake exits 2 with the NEW-item log line.
export DS_REWAKE_PIDDIR="$TMP/pids-new"
RLOG="$TMP/rehook.log"
wake_req() { if [ $# -ge 2 ]; then printf '{}' | FAKE_REQ="$1" FAKE_REQ2="$2" "$H" --worktree --requests p >/dev/null 2>&1; else printf '{}' | FAKE_REQ="$1" "$H" --worktree --requests p >/dev/null 2>&1; fi || true; }
stop_req() { : > "$RLOG"; if [ $# -ge 2 ]; then printf '{"stop_hook_active":true}' | DS_REWAKE_LOG="$RLOG" DS_REWAKE_BACKOFF_SEC=120 FAKE_REQ="$1" FAKE_REQ2="$2" timeout 30 "$H" --worktree --requests p >/dev/null 2>&1; else printf '{"stop_hook_active":true}' | DS_REWAKE_LOG="$RLOG" DS_REWAKE_BACKOFF_SEC=120 FAKE_REQ="$1" timeout 30 "$H" --worktree --requests p >/dev/null 2>&1; fi; echo $?; }
wake_req "restart lead of mt (dead since 03:00)"
eq "a new request since the wake re-wakes at once (exit 2)" "$(stop_req 'board: the operator asks you to run: /ds-close-squad mt')" "2"
eq "the new request logs the re-wake branch" "$(grep -c 'NEW item since last wake' "$RLOG")" "1"
wake_req "restart lead of mt (dead since 03:00)"
eq "old + new request still counts as new (exit 2)" "$(stop_req 'restart lead of mt (dead since 03:00)' 'board: the operator asks you to run: /ds-close-squad mt')" "2"
eq "old + new logs the re-wake branch" "$(grep -c 'NEW item since last wake' "$RLOG")" "1"
# Same content, nothing new: still backs off (here 0 so the suite stays fast), then wakes.
: > "$RLOG"
eq "the same request still backs off, then wakes" "$(printf '{"stop_hook_active":true}' | DS_REWAKE_LOG="$RLOG" DS_REWAKE_BACKOFF_SEC=0 FAKE_REQ="restart lead of mt (dead since 03:00)" FAKE_REQ2="board: the operator asks you to run: /ds-close-squad mt" "$H" --worktree --requests p 2>&1 >/dev/null | grep -c 'restart request is waiting' || true)" "1"
eq "the same request logs the backoff branch" "$(grep -c 'backoff then re-arm' "$RLOG")" "1"
# Message ids work the same way: a new id re-wakes, the same id backs off.
wake_mid() { printf '{}' | FAKE_MSG=1 FAKE_MID="$1" "$H" --worktree >/dev/null 2>&1 || true; }
stop_mid() { : > "$RLOG"; printf '{"stop_hook_active":true}' | DS_REWAKE_LOG="$RLOG" DS_REWAKE_BACKOFF_SEC=120 FAKE_MSG=1 FAKE_MID="$1" timeout 30 "$H" --worktree >/dev/null 2>&1; echo $?; }
wake_mid "m1"
eq "a new message id re-wakes at once (exit 2)" "$(stop_mid 'm2')" "2"
wake_mid "m1"
: > "$RLOG"
eq "the same message id still backs off, then wakes" "$(printf '{"stop_hook_active":true}' | DS_REWAKE_LOG="$RLOG" DS_REWAKE_BACKOFF_SEC=0 FAKE_MSG=1 FAKE_MID="m1" "$H" --worktree >/dev/null 2>&1; echo $?)" "2"
eq "the same message id logs the backoff branch" "$(grep -c 'backoff then re-arm' "$RLOG")" "1"

unasked() { printf '{}' | FAKE_UNASKED="$1" "$H" acme topic 2>&1 >/dev/null | grep -c 'unasked question' || true; }
eq "an unasked question wakes the Lead"            "$(unasked 'Drop U14?')" "1"
eq "the same unasked question does not wake it again" "$(unasked 'Drop U14?')" "0"

# A live merged PR that remains dispatched wakes the Lead once per unit and PR.
bang() { printf '{}' | FAKE_BANG="$1" "$H" acme topic 2>&1 >/dev/null | grep -c 'a PR has merged' || true; }
eq "a newly merged PR wakes the Lead"            "$(bang 'u9 85')" "1"
eq "the same merged PR does not wake it again"    "$(bang 'u9 85')" "0"
eq "another merged PR on the unit wakes the Lead" "$(bang 'u9 86')" "1"
eq "a merged PR on another unit wakes the Lead"  "$(bang 'u10 86')" "1"
eq "a Thinker hook ignores merged PRs"           "$(printf '{}' | FAKE_BANG='u11 87' "$H" --worktree 2>&1 >/dev/null | grep -c 'a PR has merged' || true)" "0"

# Other PR and ready events are delivered by the loop; obsolete watch lines never wake.
for obsolete in MERGED READY STALLED; do
  eq "legacy $obsolete line does not wake the Lead" \
    "$(printf '{}' | env "FAKE_$obsolete=u9 79" "$H" acme topic 2>&1 >/dev/null | grep -c 'no message):' || true)" "0"
done

fin() { printf '{}' | FAKE_FIN="$1" "$H" acme topic 2>&1 >/dev/null | grep -c 'the squad finished' || true; }
# the key is the topic plus the finish token (hash of run id, unit slugs, member roles)
eq "a finished squad wakes the Lead"           "$(fin 'topicA tok-ab')" "1"
eq "the same finish does not wake it again"    "$(fin 'topicA tok-ab')" "0"
eq "a finish with more units wakes it again"   "$(fin 'topicA tok-abc')" "1"
eq "a new run id on the topic wakes it"        "$(fin 'topicA tok-ab-run2')" "1"
eq "a finish after the tester is retired wakes it" "$(fin 'topicA tok-ab-notester')" "1"
eq "another finished squad wakes it"           "$(fin 'topicB tok-ab')" "1"
eq "a Thinker hook ignores finished squads"    "$(printf '{}' | FAKE_FIN='topicC tok' "$H" --worktree 2>&1 >/dev/null | grep -c 'the squad finished' || true)" "0"

# One hook per worktree: a new Stop fire must replace the previous hook, not stack on it
# (503 leaked hooks once pinned the server's CPU with peek/ps calls).
export DS_REWAKE_PIDDIR="$TMP/pids"
mkdir -p "$TMP/wtA" "$TMP/wtB"
printf '{}' > "$TMP/stop.json"
# exec so $! is the hook itself, not a wrapping subshell.
long() { (cd "$1" && DS_REWAKE_WINDOW_SEC=60 DS_REWAKE_POLL_GAP_SEC=1 exec "$H" --worktree <"$TMP/stop.json" >/dev/null 2>&1) & echo $!; }
alive() { kill -0 "$1" 2>/dev/null && echo yes || echo no; }
a1="$(long "$TMP/wtA")"; sleep 1
b1="$(long "$TMP/wtB")"; sleep 1
a2="$(long "$TMP/wtA")"; sleep 1
eq "a second hook in the same worktree kills the first" "$(alive "$a1")" "no"
eq "the new hook keeps running"                          "$(alive "$a2")" "yes"
eq "a hook in another worktree is left alone"            "$(alive "$b1")" "yes"
kill "$a2" "$b1" 2>/dev/null || true; wait 2>/dev/null || true

# The wake banner tells the reader the exact READ and ACK commands.
b="$(printf '{}' | FAKE_MSG=1 "$H" --worktree 2>&1 >/dev/null || true)"
case "$b" in *"READ: "*"watch.sh --worktree 4000"*) r=ok ;; *) r=no ;; esac
eq "Thinker banner has a READ line"            "$r" "ok"
case "$b" in *"ACK: "*"--ack "*) r=ok ;; *) r=no ;; esac
eq "Thinker banner has an ACK line"            "$r" "ok"
b="$(printf '{}' | FAKE_MSG=1 "$H" acme topic 2>&1 >/dev/null || true)"
case "$b" in *"READ: "*"watch.sh acme topic 4000"*) r=ok ;; *) r=no ;; esac
eq "Lead banner READ line names project topic" "$r" "ok"

# U74: when the loop runs the squad (a coordinators row with a run_id) the hook is off:
# exit 0 at once, no watch call, one `off` log line. No row, empty run_id, no db, the Studio: as today.
mkdir -p "$TMP/ds/state"
mkdb() { rm -f "$TMP/ds/state/loop.db"; bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database(process.argv[1], { create: true });
  db.run("CREATE TABLE coordinators (project TEXT, squad TEXT, run_id TEXT, handle TEXT, PRIMARY KEY (project, squad))");
  db.run("INSERT INTO coordinators VALUES (?,?,?,?)", ["acme", "topic", process.argv[2], "h"]);' "$TMP/ds/state/loop.db" "$1"; }
off() {  # off <cwd-worktree-name> <args...> -> "<rc> <watch-calls> <off-lines>"
  local wt="$1"; shift
  export WATCH_ARGS="$TMP/wargs2" DS_REWAKE_LOG="$TMP/hook.log"; : > "$WATCH_ARGS"; : > "$DS_REWAKE_LOG"
  local r=0; printf '{}' | CLAUDE_PROJECT_DIR="/x/$wt" FAKE_MSG=1 "$H" "$@" >/dev/null 2>&1 || r=$?
  echo "$r $(wc -l < "$WATCH_ARGS" | tr -d ' ') $(grep -c 'loop runs acme/topic: off' "$DS_REWAKE_LOG" || true)"
  export DS_REWAKE_LOG=none; unset WATCH_ARGS
}
mkdb run1
eq "bound squad: Lead hook is off"        "$(off ds-acme-lead-topic acme topic)"        "0 0 1"
eq "bound squad: Thinker hook is off"     "$(off ds-acme-thinker-topic --worktree)"     "0 0 1"
eq "bound squad: Builder hook is off"     "$(off ds-acme-builder-u1-topic --worktree --done-check "$ST" wtWork)" "0 0 1"
eq "bound squad: legacy suffix-last name is off" "$(off ds-acme-builder-topic-u1 --worktree)" "0 0 1"
eq "bound squad: DS_PREFIX is honoured"   "$(DS_PREFIX=x- off x-acme-thinker-topic --worktree)" "0 0 1"
bun -e 'import { Database } from "bun:sqlite"; new Database(process.argv[1]).run("INSERT INTO coordinators VALUES (?,?,?,?)", ["acme", "sweep-topic", "", "h"]);' "$TMP/ds/state/loop.db"
eq "longer unbound squad ending the same way wins: as today" "$(off ds-acme-builder-u1-sweep-topic --worktree)" "2 1 0"
eq "other squad in same project: as today" "$(off ds-acme-thinker-other --worktree)"    "2 1 0"
eq "Studio worktree: as today"            "$(off ds-acme-studio --worktree)"            "2 1 0"
eq "Lead of an unbound squad: as today"   "$(off ds-acme-lead-other acme other)"        "2 1 0"
mkdb ""
eq "empty run_id: as today"               "$(off ds-acme-lead-topic acme topic)"        "2 1 0"
rm -f "$TMP/ds/state/loop.db"
eq "no db: as today"                      "$(off ds-acme-lead-topic acme topic)"        "2 1 0"
printf 'garbage' > "$TMP/ds/state/loop.db"
eq "unreadable db: as today"              "$(off ds-acme-lead-topic acme topic)"        "2 1 0"
rm -f "$TMP/ds/state/loop.db"

# A zero window still peeks once and handles mail before the elapsed-window branch.
eq "zero window: mail wakes an unbound Lead after one peek" "$(DS_REWAKE_WINDOW_SEC=0 off ds-acme-lead-other acme other)" "2 1 0"
eq "zero window: mail takes the wake branch" "$(grep -c -- '-> WAKE (exit 2)' "$TMP/hook.log" || true)" "1"
zero_empty() {
  local branch="$1"; shift
  local r=0
  : > "$TMP/zero-wargs"; : > "$TMP/zero.log"
  printf '{}' | WATCH_ARGS="$TMP/zero-wargs" DS_REWAKE_LOG="$TMP/zero.log" \
    DS_REWAKE_WINDOW_SEC=0 DS_REWAKE_POLL_GAP_SEC=20 \
    timeout 5 "$H" "$@" >/dev/null 2>&1 || r=$?
  echo "$r $(wc -l < "$TMP/zero-wargs" | tr -d ' ') $(grep -c -- "$branch" "$TMP/zero.log" || true)"
}
eq "zero window: empty Lead peeks once, reconciles without sleeping" "$(zero_empty 'periodic reconcile' acme other)" "2 1 1"
eq "zero window: empty Thinker peeks once, keeps alive without sleeping" "$(zero_empty 'stay wakeable, re-arm' --worktree)" "2 1 1"
eq "zero window: done Builder peeks once, goes dark without sleeping" "$(zero_empty 'unit done -> go dark' --worktree --done-check "$ST" wtDone)" "0 1 1"

# A failed poll leaves stdout empty: neither hook branch treats failure as mail or as clear.
for active in false true; do
  flog="$TMP/failed-$active.log"
  printf '{"stop_hook_active":%s}' "$active" | FAKE_READ_FAIL=1 DS_REWAKE_LOG="$flog" "$H" --worktree >/dev/null 2>&1 || true
  eq "failed poll $active does not wake for mail" "$(grep -c 'MESSAGE present\|-> WAKE' "$flog" || true)" 0
  eq "failed poll $active is never clear" "$(grep -c 'inbox clear\|inbox empty' "$flog" || true)" 0
  eq "failed poll $active is recognized as empty failed output" "$(grep -c 'EMPTY (watch failed?)' "$flog" || true)" 1
done
for active in false true; do
  flog="$TMP/failed-request-$active.log"
  request="restart lead after failed read ($active)"
  printf '{"stop_hook_active":%s}' "$active" | FAKE_READ_FAIL=1 FAKE_REQ="$request" DS_REWAKE_LOG="$flog" "$H" --worktree --requests p >/dev/null 2>&1 || true
  eq "failed poll $active wakes for a real request" "$(grep -c -- '-> WAKE (exit 2)' "$flog" || true)" 1
  eq "failed poll $active treats the request as the wake item" "$(grep -c 'MESSAGE present' "$flog" || true)" 1
done

echo "rewake-hook: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
