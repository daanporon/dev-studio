#!/usr/bin/env bash
# side-host.sh — a side host from end to end on one machine (side-loop-host U22): two state roots and a loopback
# link. The side has its own checkout, HOME, key folder and tmux sockets: `ds join`, accepted with `ds host
# accept`, and the real side loop. Main is tests/lib/side-host-main.ts: the real loop, picker, link server and
# host jobs, with no observers. A fake `claude` in the side's tmux pane runs the commands the test hands it.
#   1. main's one Builder seat is taken, so the next Builder is placed on the side; it messages its Lead and
#      finishes through the side relay
#   2. the link is cut: the side member reads unknown, then main requeues its unit on `-r2` from the commit the
#      side pushed
#   3. the link is restored: main closes the old terminal, and the old Builder's late finish is refused
# The side's own grace is set past the test, so the old terminal is still open for main to close; the side
# fencing itself is tests/loop/side-fence.test.ts. Expose's stop on a side host and the picker hook there are
# not built yet (u8b-side-expose-stop-and-picker), so no step here uses them.
# git, tmux, bun, the link, both loops and bin/ds are real; gh, claude, crontab and systemctl are fakes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
command -v tmux >/dev/null || { echo "skip: no tmux on PATH, a side host is not tested"; exit 0; }
# An agent's terminal sets these; ds join refuses an agent, and both state roots are this test's own.
unset DS_ROOT DS_MEMBER DS_GEN DS_WT DS_MAIN_URL DS_STATE_ROOT DS_PREFIX DS_BACKEND TMUX TMUX_PANE
unset DS_HERDR_BIN XDG_DATA_HOME DS_ORCA_CLIENT
# shellcheck source=tests/lib/install-setup.sh
. "$ROOT/tests/lib/install-setup.sh"
cp "$ROOT/systemd/ds-side-loop.service" "$REPO/systemd/"
cp -r "$ROOT/conventions" "$REPO/conventions"
# Two state roots: main's is a temp root of its own, the side's is its checkout's (so DS_STATE_ROOT is unset here).
# shellcheck source=tests/lib/state-root.sh
. "$ROOT/tests/lib/state-root.sh"
MAIN_STATE="$DS_STATE_ROOT"; unset DS_STATE_ROOT
SIDE_STATE="$REPO/state"
MAIN="$TMP/main"
mkdir -p "$MAIN/home" "$MAIN/acct-a" "$TMP/tmux" "$TMP/agents"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com

rm "$STUB/git"
for t in git tmux sh setsid env touch mv chmod cp ls date tr cut sort uname id mktemp tail find stat wc; do
  [ -e "$STUB/$t" ] || ln -s "$(command -v "$t")" "$STUB/$t"
done
cat > "$STUB/gh" <<'FAKE'
#!/usr/bin/env bash
[ "$1 $2" = "auth status" ] && exit 0
exit 1
FAKE
chmod +x "$STUB/gh"
rm "$STUB/orca"   # neither host has Orca here
# The fake agent. A member's start leaves its environment in agents/<role-suffix>/ and then runs each file
# the test puts there as `cmd`, with that environment, from the member's worktree.
cat > "$STUB/claude" <<FAKE
#!/usr/bin/env bash
[ -n "\${DS_MEMBER:-}" ] || exit 0
d="$TMP/agents/\${DS_MEMBER##*/}"; mkdir -p "\$d"
export -p | grep -E ' (DS_MEMBER|DS_GEN|DS_WT|DS_MAIN_URL)=' > "\$d/env.sh"
pwd -P > "\$d/cwd"; echo \$\$ > "\$d/pid"
while :; do
  if [ -f "\$d/cmd" ]; then
    rc=0; bash "\$d/cmd" > "\$d/out" 2>&1 || rc=\$?
    rm "\$d/cmd"; echo "\$rc" > "\$d/rc"
  fi
  sleep 0.2
done
FAKE
chmod +x "$STUB/claude"

# --- both hosts' logins: the same Claude login id, each in its own folder --------------------------
mk_skills_home "$HOME"
printf '{"numStartups":3,"oauthAccount":{"accountUuid":"uuid-a"}}\n' > "$HOME/.claude.json"
printf '{}\n' > "$HOME/.claude/.credentials.json"
printf '{"numStartups":3}\n' > "$MAIN/home/.claude.json"

# --- the origin both hosts clone, and main's clone of it -------------------------------------------
git init -q --bare -b main "$TMP/origin.git"
git init -q -b main "$MAIN/repo"
git -C "$MAIN/repo" commit -q --allow-empty -m init
git -C "$MAIN/repo" remote add origin "$TMP/origin.git"
git -C "$MAIN/repo" push -q origin main

has() { if grep -qF -- "$2" <<<"$3"; then good; else bad "$1: want [$2] in: $3"; fi; }
free_port() { "$BUN_REAL" -e 'const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }); console.log(s.port); s.stop(true);'; }
LINK_PORT="$(free_port)"; PROXY_PORT="$(free_port)"
CUT="$TMP/link.cut"

# Everything main runs gets main's own HOME and roots, and none of the side's settings. A host grace of 0 minutes
# leaves main's own 60 s margin: it requeues 60 s after the link went down.
MAIN_ENV=(HOME="$MAIN/home" PATH="$STUB:/usr/bin:/bin" DS_STATE_ROOT="$MAIN_STATE" DS_WORKTREE_ROOT="$MAIN/wts"
  DS_CLAUDE_SYSTEM_JSON_DIR="$MAIN/home" DS_TOKEN_CACHE=0 DS_TOKEN_DIR="$MAIN/tokens" DS_LOOP_RETRY_S=1
  DS_LIMIT_LINK_LISTEN=off DS_LIMIT_HOST_GRACE_MIN=0 DS_SIDE_HOST_CUT="$CUT")
main_env() { env "${MAIN_ENV[@]}" "$@"; }
main_ds() { main_env "$ROOT/bin/ds" "$@"; }
driver() { main_env "$BUN_REAL" "$ROOT/tests/lib/side-host-main.ts" "$@"; }
q() { driver q "$1"; }
side_q() { DS_STATE_ROOT="$SIDE_STATE" "$BUN_REAL" "$ROOT/tests/lib/side-host-main.ts" q "$1"; }

stop_side() {
  ( cd "$REPO" && PATH="$STUB" ./bin/ds loop-ts --stop >/dev/null 2>&1 ) || true
  TMUX_TMPDIR="$TMP/tmux" tmux -L ds-fx kill-server >/dev/null 2>&1 || true
}
state_root_on_exit 'stop_side; cleanup'

dump() {
  echo "--- main driver log" >&2; tail -n 40 "$TMP/main.log" >&2 || true
  echo "--- side loop events" >&2
  side_q "SELECT kind, member, substr(payload, 1, 300) FROM events ORDER BY id DESC LIMIT 25" >&2 || true
  echo "--- main events" >&2; q "SELECT kind, member, substr(payload, 1, 300) FROM events ORDER BY id DESC LIMIT 30" >&2 || true
  echo "--- main members" >&2; q "SELECT id, role, suffix, host, status, want, wt FROM members" >&2 || true
}
# wait_for <seconds> <what> <command…>: until the command succeeds; a timeout ends the test with both logs.
wait_for() {
  local limit="$1" what="$2" end; shift 2
  end=$((SECONDS + limit))
  until "$@" >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$end" ]; then bad "$what (waited ${limit}s)"; dump; echo "side-host: $pass passed, $fail failed"; exit 1; fi
    sleep 0.5
  done
  good
}
nonempty() { [ -n "$(q "$1")" ]; }
member_col() { q "SELECT $2 FROM members WHERE project = 'fx' AND squad = 'ontmux' AND role = 'builder' AND suffix = '$1' ORDER BY id DESC LIMIT 1"; }
member_has_wt() { [[ "$(member_col "$1" wt)" == *::/* ]]; }
# agent <role-suffix> <script>: run the script in that member's pane; leaves AGENT_RC and AGENT_OUT.
agent() {
  local d="$TMP/agents/$1"
  rm -f "$d/rc"
  printf '%s\n' "$2" > "$d/cmd.new"; mv "$d/cmd.new" "$d/cmd"
  wait_for 90 "the $1 agent ran its command" test -f "$d/rc"
  AGENT_RC="$(cat "$d/rc")"; AGENT_OUT="$(cat "$d/out")"
}

# --- main: a squad on tmux, its one Builder seat taken ---------------------------------------------
driver setup "$MAIN/repo"
# env, not main_env: $! must be the driver's own PID, which the cleanup stops.
env "${MAIN_ENV[@]}" "$BUN_REAL" "$ROOT/tests/lib/side-host-main.ts" serve "$LINK_PORT" "$PROXY_PORT" > "$TMP/main.log" 2>&1 &
MAIN_PID=$!; OWN_PIDS="$OWN_PIDS $MAIN_PID"
wait_for 60 "main's loop started" grep -q "main: ready" "$TMP/main.log"
driver builder u0
wait_for 60 "the first Builder started on main" member_has_wt u0
has "the first Builder is on main" "local::" "$(member_col u0 wt)"
driver busy u0

# --- the side joins over the link and is accepted ---------------------------------------------------
join_env() {
  ( cd "$REPO" && PATH="$STUB" SHELL="$STUB/bash" TMUX_TMPDIR="$TMP/tmux" DS_ORCA_DATA="$TMP/orca" \
    DS_SERVER_SYSTEMD=0 DS_LOOP_SYSTEMD=0 DS_TICK_SECONDS=1 DS_JOIN_POLL_MS=200 DS_JOIN_SKILLS=true \
    DS_WORKTREE_ROOT="$TMP/side-wts" DS_SIDE_CLONE_ROOT="$TMP/side-clones" DS_TOKEN_CACHE=0 DS_TOKEN_DIR="$TMP/side-tokens" \
    DS_LIMIT_HOST_GRACE_MIN=30 DS_LINK_RESEND_MS=2000 ./bin/ds join "127.0.0.1:$PROXY_PORT" --name laptop 2>&1 )
}
join_env > "$TMP/join.log" &
JOIN_PID=$!; OWN_PIDS="$OWN_PIDS $JOIN_PID"
wait_for 60 "the side asked to join" grep -q "join: waiting" "$TMP/join.log"
main_ds host accept laptop >/dev/null
main_ds host set laptop builder_host_brake off >/dev/null   # this machine's load is not what is tested
rc=0; wait "$JOIN_PID" || rc=$?
SIDE_LOOP="$(cat "$SIDE_STATE/loop.pid" 2>/dev/null || true)"; OWN_PIDS="$OWN_PIDS $SIDE_LOOP"
eq "join: exit ($(cat "$TMP/join.log"))" "$rc" 0
has "join connected" "join: connected" "$(cat "$TMP/join.log")"
if [ "$MAIN_STATE" != "$SIDE_STATE" ] && [ -f "$SIDE_STATE/link/host.key" ] && [ ! -e "$MAIN_STATE/link/host.key" ]; then good
else bad "the side must keep its own key under its own state root"; fi
wait_for 60 "the side's machine sample came up the link" nonempty "SELECT 1 FROM observed_machine WHERE host = 'laptop'"
wait_for 60 "the side's login came up the link" nonempty "SELECT 1 FROM account_folders WHERE host = 'laptop' AND account = 'acct-a'"

# --- 1. placed on the side: it messages its Lead and finishes ---------------------------------------
driver builder u1
wait_for 120 "u1's Builder started" member_has_wt u1
has "u1 was placed on the side" "laptop::$TMP/side-wts/" "$(member_col u1 wt)"
eq "u1's host" "$(member_col u1 host)" laptop
wait_for 60 "u1's agent runs in the side's tmux" test -f "$TMP/agents/builder-u1/pid"
has "its calls go to the side relay" "unix:$SIDE_STATE/loop/link.sock" "$(cat "$TMP/agents/builder-u1/env.sh")"
# Nothing on main reads the side's tmux or processes: these rows came up the link.
wait_for 60 "u1's terminal row came up the link" nonempty "SELECT 1 FROM observed_terminals WHERE host = 'laptop'"
wait_for 60 "u1's worker row came up the link" nonempty "SELECT 1 FROM observed_workers WHERE host = 'laptop' AND wt = 'laptop::$(cat "$TMP/agents/builder-u1/cwd")'"
nonempty "SELECT 1 FROM events WHERE kind = 'host_link_up'" && good || bad "main never saw the link come up"

agent builder-u1 "'$REPO/bin/ds' msg send ontmux lead 'u1 from the side' 'the work is ready'"
eq "msg from the side: exit ($AGENT_OUT)" "$AGENT_RC" 0
eq "the Lead has it on main" "$(q "SELECT from_role, from_suffix, to_role FROM messages WHERE subject = 'u1 from the side'")" "$(printf 'builder\tu1\tlead')"
agent builder-u1 "'$REPO/bin/ds' finish u1 --outcome ok --body 'done on the side'"
eq "finish from the side: exit ($AGENT_OUT)" "$AGENT_RC" 0
eq "u1's finish is main's row" "$(q "SELECT unit, outcome, body FROM finishes WHERE unit = 'u1'")" "$(printf 'u1\tok\tdone on the side')"
eq "the side keeps no finish of its own" "$(side_q "SELECT COUNT(*) FROM finishes")" 0

# --- 2. a second side Builder pushes work, then the link is cut --------------------------------------
# u1 is finished: its Builder is closed, as after a merge, so the cut below finds one live side member.
driver gone u1
u1_gone() { [ "$(member_col u1 status)" = gone ]; }
wait_for 90 "u1's Builder was closed on the side" u1_gone
driver builder u2
wait_for 120 "u2's Builder started" member_has_wt u2
eq "u2's host" "$(member_col u2 host)" laptop
wait_for 60 "u2's agent runs" test -f "$TMP/agents/builder-u2/pid"
OLD_ID="$(member_col u2 id)"; OLD_AGENT="$(cat "$TMP/agents/builder-u2/pid")"; OLD_CWD="$(cat "$TMP/agents/builder-u2/cwd")"
cp "$TMP/agents/builder-u2/env.sh" "$TMP/old-u2.env"
BRANCH="$(git -C "$OLD_CWD" rev-parse --abbrev-ref HEAD)"
agent builder-u2 "git commit -q --allow-empty -m 'work on u2'"
SHA="$(git -C "$OLD_CWD" rev-parse HEAD)"
pushed() { [ "$(git -C "$TMP/origin.git" rev-parse -q --verify "refs/heads/$BRANCH" 2>/dev/null)" = "$SHA" ]; }
wait_for 90 "the side loop pushed u2's commit" pushed
# Main's seat is free again, so the requeued unit has somewhere to go.
driver gone u0

: > "$CUT"
CUT_AT=$SECONDS
unreachable() { nonempty "SELECT 1 FROM hosts WHERE name = 'laptop' AND unreachable_since IS NOT NULL"; }
wait_for 60 "main saw the link go down" unreachable

eq "u2's member while its host is unreachable" "$(driver reality "$OLD_ID")" unknown
eq "unknown is not requeued at once" "$(q "SELECT status = 'gone', fenced_at IS NULL FROM members WHERE id = $OLD_ID")" "$(printf '0\t1')"
agent builder-u2 "'$REPO/bin/ds' finish u2 --outcome ok --body 'finished while cut off'"
eq "a call while cut off: main unreachable ($AGENT_OUT)" "$AGENT_RC" 75

requeued() { nonempty "SELECT 1 FROM events WHERE kind = 'host_fenced'"; }
wait_for 150 "main fenced the lost host" requeued
if [ $((SECONDS - CUT_AT)) -ge 55 ]; then good; else bad "main requeued after $((SECONDS - CUT_AT))s, before its 60 s margin"; fi
eq "the old member is ended" "$(q "SELECT status, want, fenced_at IS NOT NULL, fence_closed_at IS NULL FROM members WHERE id = $OLD_ID")" "$(printf 'gone\tgone\t1\t1')"
eq "u2 is on its second attempt" "$(q "SELECT attempt, retry_from, retry_sha, retry_host FROM units WHERE slug = 'u2'")" "$(printf '2\t%s\t%s\tlaptop' "$BRANCH" "$SHA")"
requeued_on_main() { [ "$(member_col u2 id)" != "$OLD_ID" ] && [[ "$(member_col u2 wt)" == local::/* ]]; }
wait_for 90 "the requeued Builder started on main" requeued_on_main
NEW_WT="$(member_col u2 wt)"; NEW_WT="${NEW_WT#local::}"
eq "on the -r2 branch" "$(git -C "$NEW_WT" rev-parse --abbrev-ref HEAD)" "$BRANCH-r2"
eq "from the commit the side pushed" "$(git -C "$NEW_WT" rev-parse HEAD)" "$SHA"
if kill -0 "$OLD_AGENT" 2>/dev/null; then good; else bad "the old agent should still run while the link is cut"; fi

# --- 3. the link returns: the old terminal is closed and the old Builder's finish refused -------------
rm "$CUT"
returned() { nonempty "SELECT 1 FROM events WHERE kind = 'host_returned'"; }
wait_for 150 "main took the host back" returned
eq "main closed the old member's terminal" "$(q "SELECT fence_closed_at IS NOT NULL FROM members WHERE id = $OLD_ID")" 1
old_agent_gone() { ! kill -0 "$OLD_AGENT" 2>/dev/null; }
wait_for 30 "the old agent's process ended" old_agent_gone
# The old Builder's own environment and folder, as a process that outlived its terminal would have them.
rc=0
# shellcheck disable=SC1091  # written by the fake agent above
out="$(cd "$OLD_CWD" && . "$TMP/old-u2.env" && PATH="$STUB" "$REPO/bin/ds" finish u2 --outcome ok --body 'late' 2>&1)" || rc=$?
eq "late finish: exit ($out)" "$rc" 78
has "late finish" "you were replaced" "$out"
eq "no finish for u2" "$(q "SELECT COUNT(*) FROM finishes WHERE unit = 'u2'")" 0

stop_side
echo "side-host: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
