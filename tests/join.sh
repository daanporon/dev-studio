#!/usr/bin/env bash
# join.sh — `ds join <main-url>` on a throwaway checkout and HOME (side-loop-host U12): it names what is
# missing, installs a side host (no Orca), makes the host key, asks a real link server, waits for
# `ds host accept`, probes a real tmux server, starts the real side loop and sees its link come up.
# gh, crontab and systemctl are fakes; git, tmux, bun, the link server and the side loop are real.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
command -v tmux >/dev/null || { echo "skip: no tmux on PATH, ds join is not tested"; exit 0; }
# An agent's terminal sets these; ds join refuses an agent, and the side root must be the checkout's own.
unset DS_MEMBER DS_GEN DS_WT DS_MAIN_URL DS_STATE_ROOT DS_PREFIX DS_BACKEND TMUX TMUX_PANE
unset DS_HERDR_BIN XDG_DATA_HOME
# shellcheck source=tests/lib/install-setup.sh
. "$ROOT/tests/lib/install-setup.sh"
cp "$ROOT/systemd/ds-side-loop.service" "$REPO/systemd/"
cp -r "$ROOT/conventions" "$REPO/conventions"
SIDE_STATE="$REPO/state"
# Servers run detached (no unit on the host), tmux sockets stay in this test's folder.
export DS_SERVER_SYSTEMD=0 DS_LOOP_SYSTEMD=0 DS_TICK_SECONDS=1 DS_JOIN_POLL_MS=200
export TMUX_TMPDIR="$TMP/tmux"; mkdir -p "$TMUX_TMPDIR"

rm "$STUB/git"
for t in git tmux sh setsid env; do ln -s "$(command -v "$t")" "$STUB/$t"; done
cat > "$STUB/gh" <<'FAKE'
#!/usr/bin/env bash
[ "$1 $2" = "auth status" ] && exit "${FAKE_GH_DOWN:-0}"
exit 1
FAKE
chmod +x "$STUB/gh"
rm "$STUB/orca"   # a side host has no Orca
STUB_NOTMUX="$TMP/stub-notmux"; cp -a "$STUB" "$STUB_NOTMUX"; rm "$STUB_NOTMUX/tmux"
rm "$STUB_NOBUN/orca"

join_run() { ( cd "$REPO" && PATH="${JOIN_PATH:-$STUB}" ./bin/ds join "$@" 2>&1 ); }
has() { if grep -qF -- "$2" <<<"$3"; then good; else bad "$1: want [$2] in: $3"; fi; }
free_port() { "$BUN_REAL" -e 'const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }); console.log(s.port); s.stop(true);'; }
loop_pid() { cat "$SIDE_STATE/loop.pid" 2>/dev/null || true; }
untouched() { if [ ! -e "$SIDE_STATE" ] && [ ! -s "$CRONTAB" ]; then good; else bad "$1 must change nothing"; fi; }

# --- what is missing is named, and nothing is written --------------------------------------------
mkdir -p "$TMP/home-nobun"
rc=0; out="$(cd "$REPO" && HOME="$TMP/home-nobun" PATH="$STUB_NOBUN" ./bin/ds join 127.0.0.1:1 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then good; else bad "no bun must fail"; fi
has "no bun" "ds needs bun" "$out"

rc=0; out="$(FAKE_GH_DOWN=1 JOIN_PATH="$STUB_NOTMUX" join_run 127.0.0.1:1 --name laptop --repo "$TMP/no-such-repo.git")" || rc=$?
eq "missing: exit" "$rc" 1
has "missing tmux" "missing tmux" "$out"
has "gh logged out" "missing git push rights — gh is not logged in" "$out"
has "refused push" "this host cannot push to $TMP/no-such-repo.git" "$out"
untouched "a failed check"

rc=0; out="$(join_run)" || rc=$?
eq "no url: exit" "$rc" 2
rc=0; out="$(join_run 127.0.0.1:1 --name local)" || rc=$?
eq "the name 'local': exit" "$rc" 2
rc=0; out="$(cd "$REPO" && DS_MEMBER=p/s/builder PATH="$STUB" ./bin/ds join 127.0.0.1:1 2>&1)" || rc=$?
eq "an agent: exit" "$rc" 2
untouched "a refusal"

# A host with a main's project stays a main.
mkdir -p "$SIDE_STATE/proj"; echo '{}' > "$SIDE_STATE/proj/dispatcher.json"
rc=0; out="$(join_run 127.0.0.1:1 --name laptop)" || rc=$?
eq "a main host: exit" "$rc" 2
has "a main host" "runs the main loop of project 'proj'" "$out"
rm "$SIDE_STATE/proj/dispatcher.json"; rmdir "$SIDE_STATE/proj" "$SIDE_STATE"

# --- main unreachable: the side install is done, and the fix on main is said ----------------------
git init -q --bare "$TMP/push-target.git"
PORT="$(free_port)"
rc=0; out="$(join_run "127.0.0.1:$PORT" --name laptop --repo "$TMP/push-target.git")" || rc=$?
eq "unreachable: exit" "$rc" 1
has "unreachable" "cannot reach 127.0.0.1:$PORT" "$out"
has "the link_listen hint" "(port $PORT); turn it on with \`ds config set <project> limits.conf link_listen on\`" "$out"
SIDE_UNIT="$HOME/.config/systemd/user/ds-side-loop.service"
has "the side unit" "bin/loop/main.ts --role side" "$(cat "$SIDE_UNIT" 2>/dev/null || true)"
eq "no main unit" "$([ -e "$UNIT" ] && echo there || echo none)" none
has "the watchdog line" "$REPO/bin/loop/loop.sh --ensure" "$(cat "$CRONTAB")"
eq "key mode" "$(stat -c %a "$SIDE_STATE/link/host.key")" 600
eq "no loop before main accepted" "$(loop_pid)" ""

# --- a real link server on a main state root ------------------------------------------------------
MAIN_STATE="$TMP/main/state"; mkdir -p "$MAIN_STATE"
DS_STATE_ROOT="$MAIN_STATE" "$BUN_REAL" "$ROOT/bin/link/server.ts" 127.0.0.1 "$PORT" > "$TMP/server.log" 2>&1 &
OWN_PIDS="$OWN_PIDS $!"
for _ in $(seq 100); do grep -q "link: listening" "$TMP/server.log" && break; "$BUN_REAL" -e 'await Bun.sleep(100)'; done
main_ds() { DS_STATE_ROOT="$MAIN_STATE" "$ROOT/bin/ds" "$@"; }

# Nobody accepts: join gives up when the request's time is over.
rc=0; out="$(DS_JOIN_WAIT_S=2 join_run "127.0.0.1:$PORT" --name laptop)" || rc=$?
eq "not accepted: exit" "$rc" 1
has "not accepted" "not accepted within" "$out"

join_run "127.0.0.1:$PORT" --name laptop > "$TMP/join.log" &
JOIN_PID=$!; OWN_PIDS="$OWN_PIDS $JOIN_PID"
for _ in $(seq 200); do grep -q "join: waiting" "$TMP/join.log" && break; "$BUN_REAL" -e 'await Bun.sleep(100)'; done
FP="$(sed -n 's/^join: fingerprint //p' "$TMP/join.log")"
has "main shows the same fingerprint" "$FP" "$(main_ds host list)"
if [ -n "$FP" ] && kill -0 "$JOIN_PID" 2>/dev/null; then good; else bad "join must wait for the accept: $(cat "$TMP/join.log")"; fi
main_ds host accept laptop >/dev/null
rc=0; wait "$JOIN_PID" || rc=$?
LOOP="$(loop_pid)"; OWN_PIDS="$OWN_PIDS $LOOP"
out="$(cat "$TMP/join.log")"
eq "accepted: exit" "$rc" 0
has "the backend probe" "tmux server starts as a detached process" "$out"
has "connected" "join: connected: 'laptop' is a side host of 127.0.0.1:$PORT" "$out"
has "the side loop runs as side" "main.ts --role side" "$(tr '\0' ' ' < "/proc/${LOOP:-0}/cmdline" 2>/dev/null || true)"
eq "its link status" "$(jq -r .state "$SIDE_STATE/link/status.json")" up
if [ -S "$SIDE_STATE/loop/link.sock" ]; then good; else bad "the relay socket is missing"; fi
if [ -z "$(tmux -L "ds-join-probe-$JOIN_PID" list-sessions 2>/dev/null || true)" ]; then good; else bad "the probe server must be gone"; fi
PRIVATE="$(sed -n 2p "$SIDE_STATE/link/host.key")"
if [ -n "$PRIVATE" ] && ! grep -rqaF "$PRIVATE" "$MAIN_STATE" "$TMP/join.log" "$TMP/server.log"; then good; else bad "the private key left the side host"; fi

# Again: an accepted host goes straight back to a connected side loop.
rc=0; out="$(join_run "127.0.0.1:$PORT" --name laptop)" || rc=$?
LOOP="$(loop_pid)"; OWN_PIDS="$OWN_PIDS $LOOP"
eq "rejoin: exit" "$rc" 0
has "rejoin" "already accepted" "$out"
has "rejoin connected" "join: connected" "$out"

# The cron watchdog's command keeps a side loop a side loop; ds up is refused here.
has "ensure" "loop: running (pid $LOOP)" "$(cd "$REPO" && PATH="$STUB" ./bin/loop/loop.sh --ensure 2>&1)"
rc=0; out="$(cd "$REPO" && PATH="$STUB" ./bin/ds up https://example.invalid/some/repo 2>&1)" || rc=$?
eq "ds up on a side host: exit" "$rc" 2
has "ds up on a side host" "this is a side host" "$out"
( cd "$REPO" && PATH="$STUB" ./bin/ds loop-ts --stop >/dev/null 2>&1 )
if [ ! -S "$SIDE_STATE/loop/link.sock" ]; then good; else bad "a stopped side loop must remove its relay socket"; fi

echo "join: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
