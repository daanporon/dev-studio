#!/usr/bin/env bash
# up-backend.sh — `ds up` from a fresh clone to a running project, on Orca and off it (orca-backend-alternatives U53),
# and `ds up <label> --backend <x>` moving a project's Studio to another backend (U54).
# A temp state root, a stub Orca for `ds up`'s own calls, and tests/lib/up-loop.ts beside it: real loop ticks
# (observers, the Studio reconciler, the actuator and fulfillers) on the same state root over the fake Orca or
# the fake tmux. The install check, the install and `loop --ensure` are stood in for (DS_UP_INSTALL_CHECK,
# DS_UP_INSTALL, DS_UP_LOOP), so the host's own install and loop are never touched.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=tests/lib/state-root.sh
. "$ROOT/tests/lib/state-root.sh"
tmp="$(mktemp -d)"
pass=0; fail=0
good() { pass=$((pass + 1)); }
bad() { echo "FAIL: $1"; fail=$((fail + 1)); }
check() { if [ "$2" = "$3" ]; then good; else bad "$1"; echo "  expected: $2"; echo "  actual:   $3"; fi; }
has() { if grep -qF -- "$2" <<<"$3"; then good; else bad "$1"; echo "  wanted: $2"; echo "  in: $3"; fi; }

loop_pid=""
stop_loop() { if [ -n "$loop_pid" ]; then kill "$loop_pid" 2>/dev/null; wait "$loop_pid" 2>/dev/null; loop_pid=""; fi; }
# shellcheck disable=SC2016
state_root_on_exit 'stop_loop; rm -rf "$tmp" "$ROOT/repos/zzup" "$ROOT/repos/zzup-tmux" "$ROOT/repos/zzup-down"'

export DS_WORKTREE_ROOT="$tmp/wts" DS_BIND=127.0.0.1 DS_BOARD_SERVE_WAIT=0 DS_UP_START_WAIT_S=30 DS_LOOP_RETRY_S=1
export DS_CLAUDE_SYSTEM_JSON_DIR="$tmp/home"; mkdir -p "$tmp/home"; printf '{"numStartups":3}\n' > "$tmp/home/.claude.json"

# A repo to clone, reached as a URL (a path ending in .git).
src="$tmp/src/realp.git"
git init -q -b main "$tmp/seed" && git -C "$tmp/seed" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
git clone -q --bare "$tmp/seed" "$src"

# The stub Orca `ds up` calls: the worktree is wt_zzup; loop-terminals lists $STUB_TERMS.
stub="$tmp/orca-stub.sh"; ulog="$tmp/stub.log"
cat > "$stub" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1" in
  worktree-ensure) echo "wt_zzup" ;;
  loop-terminals) printf '%s\n' "${STUB_TERMS:-{\"result\":{\"terminals\":[]\}\}}" ;;
  studio-start) echo "term_direct" ;;
esac
exit 0
EOF
chmod +x "$stub"
export BACKEND="$stub" STUB_LOG="$ulog"

# Not installed (the check fails), the install marks it installed; the loop "starts".
installed="$tmp/installed"
export DS_UP_INSTALL_CHECK="test -e '$installed'" DS_UP_INSTALL="echo installing >> '$tmp/install.log'; touch '$installed'" DS_UP_LOOP=true
up() { "$ROOT/bin/ds" up-ts "$@" 2>&1; }
start_loop() { "$(command -v bun)" "$ROOT/tests/lib/up-loop.ts" "$1" "$2" "$tmp/sum-$1" & loop_pid=$!; }
summary() { cat "$tmp/sum-$1" 2>/dev/null; }

# 1. Orca, a host that is not installed: install, loop, project, the Studio started by the loop, the board.
: > "$ulog"; start_loop zzup orca
out="$(up "$src" --label zzup)"; rc=$?
check "orca: exit 0" "0" "$rc"
check "orca: installed once" "1" "$(grep -c installing "$tmp/install.log" 2>/dev/null)"
check "orca: cloned into repos/<label>" "yes" "$([ -d "$ROOT/repos/zzup/.git" ] && echo yes || echo no)"
check "orca: studio_wt recorded" "wt_zzup" "$(jq -r .studio_wt "$DS_STATE_ROOT/zzup/dispatcher.json")"
check "orca: no studio_backend (Orca)" "null" "$(jq -r .studio_backend "$DS_STATE_ROOT/zzup/dispatcher.json")"
check "orca: ds up started no Studio itself" "0" "$(grep -c '^studio-start' "$ulog")"
has "orca: asked the loop" "asked the loop to start the Studio" "$out"
sum="$(summary zzup)"
has "orca: the loop started one Studio" "starts=1 " "$sum"
handle="$(sed -n 's/.*handle=\(term_[0-9]*\).*/\1/p' <<<"$sum")"
has "orca: ds up names the loop's terminal" "started the Studio ($handle)" "$out"
has "orca: the board's address" "open http://127.0.0.1:" "$out"
has "orca: open it in Orca" "worktree in the Orca UI" "$out"

# 2. A second run changes nothing: installed, the Studio runs (Orca lists it), no second start.
: > "$ulog"
out="$(STUB_TERMS="{\"result\":{\"terminals\":[{\"handle\":\"$handle\",\"worktreeId\":\"wt_zzup\",\"title\":\"claude\",\"agentIdentity\":\"claude\",\"connected\":true}]}}" up "$src" --label zzup)"; rc=$?
check "orca again: exit 0" "0" "$rc"
check "orca again: no second install" "1" "$(grep -c installing "$tmp/install.log")"
has "orca again: the Studio left alone" "already runs in wt_zzup ($handle): left alone" "$out"
sleep 1
has "orca again: still one Studio start" "starts=1 " "$(summary zzup)"
stop_loop

# 3. --force-new, or another repo, on a label already up: refused.
other="$tmp/src/other.git"; git clone -q --bare "$tmp/seed" "$other"
out="$(up "$other" --label zzup --force-new)"; rc=$?
check "another repo on zzup: refused" "2" "$rc"
has "another repo on zzup: says why" "already up with" "$out"

# 4. Orca with the loop stopped: the Studio is started directly, with a note.
rm -f "$DS_STATE_ROOT/zzup/dispatcher.json"
: > "$ulog"
out="$(DS_UP_LOOP='exit 1' up "$src" --label zzup)"; rc=$?
check "orca, loop down: exit 0" "0" "$rc"
check "orca, loop down: studio-start directly" "1" "$(grep -c '^studio-start wt_zzup ' "$ulog")"
has "orca, loop down: the note" "the loop is not running, so the Studio is started directly" "$out"
check "orca, loop down: studio_handle recorded" "term_direct" "$(jq -r .studio_handle "$DS_STATE_ROOT/zzup/dispatcher.json")"

# 5. tmux on a roster with a role tmux cannot start (the shipped Muse builder): refused before anything is made.
out="$(up "$src" --backend tmux --label zzup-tmux)"; rc=$?
check "tmux, a Muse builder: refused" "2" "$rc"
has "tmux, a Muse builder: settings' reason" "backend tmux can start only claude" "$out"
check "tmux, a Muse builder: nothing cloned" "no" "$([ -e "$ROOT/repos/zzup-tmux" ] && echo yes || echo no)"
check "tmux, a Muse builder: no dispatcher.json" "no" "$([ -e "$DS_STATE_ROOT/zzup-tmux/dispatcher.json" ] && echo yes || echo no)"
"$ROOT/bin/ds" config set zzup-tmux roles.conf builder claude opus ondemand high claude:sonnet >/dev/null 2>&1

# 6. tmux: a second project from the same URL, with its own clone, state, worktree and Studio on tmux.
: > "$ulog"; start_loop zzup-tmux tmux
out="$(up "$src" --backend tmux --label zzup-tmux)"; rc=$?
check "tmux: exit 0" "0" "$rc"
check "tmux: its own clone" "yes" "$([ -d "$ROOT/repos/zzup-tmux/.git" ] && echo yes || echo no)"
disp="$DS_STATE_ROOT/zzup-tmux/dispatcher.json"
check "tmux: studio_backend tmux" "tmux" "$(jq -r .studio_backend "$disp")"
wt="$(jq -r .studio_wt "$disp")"
check "tmux: a local:: worktree from git" "yes" "$(case "$wt" in local::"$DS_WORKTREE_ROOT"/*) [ -d "${wt#local::}" ] && echo yes ;; *) echo "no ($wt)" ;; esac)"
check "tmux: Orca untouched" "0" "$(grep -cE '^(worktree-ensure|studio-start|repo-ensure)' "$ulog")"
check "tmux: default_backend written" "tmux" "$("$ROOT/bin/ds" config get zzup-tmux limits.conf default_backend 2>/dev/null | jq -r .value)"
has "tmux: the loop started one Studio" "starts=1 live=1 " "$(summary zzup-tmux)"
has "tmux: how to attach" "tmux -L ds-zzup-tmux attach -t _studio" "$out"
check "zzup is untouched" "wt_zzup" "$(jq -r .studio_wt "$DS_STATE_ROOT/zzup/dispatcher.json")"

# 7. tmux again: reconciled, no second Studio.
out="$(up zzup-tmux)"; rc=$?
check "tmux again: exit 0" "0" "$rc"
sleep 1
has "tmux again: still one Studio" "starts=1 live=1 " "$(summary zzup-tmux)"
check "tmux again: the same worktree" "$wt" "$(jq -r .studio_wt "$disp")"

# 7b. U54: `ds up zzup-tmux --backend herdr` moves the project. A paused squad refuses it, naming the squad, and
# nothing changes; with no open squad the Studio moves to herdr in its own worktree, keeping its member row
# (account history). herdr is a stub binary: the loop's fake herdr runs the terminals.
printf '#!/bin/sh\nexit 0\n' > "$tmp/herdr"; chmod +x "$tmp/herdr"; export DS_HERDR_BIN="$tmp/herdr"
sql() { "$(command -v bun)" -e 'import { open } from "'"$ROOT"'/bin/loop/core/store.ts"; const s = open(); const r = s.db.query(process.argv[1]).all(); s.close(); for (const x of r) console.log(Object.values(x as object).join("|"));' "$1"; }
sql "INSERT INTO squads (project, topic, status, observed_at, updated_at) VALUES ('zzup-tmux', 'zzparked', 'suspended', 1, 1)" >/dev/null
member="$(sql "SELECT id FROM members WHERE project = 'zzup-tmux' AND squad = '_studio'")"
out="$(up zzup-tmux --backend herdr)"; rc=$?
check "move, a paused squad: refused" "2" "$rc"
has "move, a paused squad: names it" "open squad on tmux: zzparked (a paused squad counts)" "$out"
check "move, a paused squad: still on tmux" "tmux" "$(jq -r .studio_backend "$disp")"
check "move, a paused squad: the same worktree" "$wt" "$(jq -r .studio_wt "$disp")"
has "move, a paused squad: still one Studio on tmux" "live=1 handle=" "$(summary zzup-tmux)"
sql "UPDATE squads SET status = 'closed' WHERE project = 'zzup-tmux' AND topic = 'zzparked'" >/dev/null
out="$(up zzup-tmux --backend herdr)"; rc=$?
check "move: exit 0" "0" "$rc"
has "move: says it moved" "moved 'zzup-tmux' from tmux to herdr" "$out"
check "move: studio_backend herdr" "herdr" "$(jq -r .studio_backend "$disp")"
wt2="$(jq -r .studio_wt "$disp")"
check "move: a new local:: worktree" "yes" "$(case "$wt2" in local::"$DS_WORKTREE_ROOT"/*-studio-herdr) [ -d "${wt2#local::}" ] && echo yes ;; *) echo "no ($wt2)" ;; esac)"
check "move: default_backend herdr" "herdr" "$("$ROOT/bin/ds" config get zzup-tmux limits.conf default_backend 2>/dev/null | jq -r .value)"
sleep 1
sum="$(summary zzup-tmux)"
has "move: none left on tmux" "live=0 " "$sum"
has "move: one Studio on herdr" "herdr=1" "$sum"
check "move: the same member row, now in the new worktree" "$member|$wt2" "$(sql "SELECT id, wt FROM members WHERE project = 'zzup-tmux' AND squad = '_studio'")"
check "move: the old worktree left for cleanup" "yes" "$([ -d "${wt#local::}" ] && echo yes || echo no)"
out="$("$ROOT/bin/ds" config set zzup-tmux limits.conf default_backend tmux 2>&1)"; rc=$?
check "default_backend tmux after the move: refused" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
has "default_backend tmux after the move: names ds up" "ds up zzup-tmux --backend tmux" "$out"
wt="$wt2"
stop_loop
# A reconcile with no --worktree keeps the project's stored worktree_provider (here treehouse, which this host
# lacks), not the backend's default: refused, the Studio's worktree unchanged.
printf '#!/bin/sh\nexit 0\n' > "$tmp/treehouse"; chmod +x "$tmp/treehouse"
DS_TREEHOUSE_BIN="$tmp/treehouse" "$ROOT/bin/ds" config set zzup-tmux limits.conf worktree_provider treehouse >/dev/null 2>&1
check "tmux, stored treehouse: set" "treehouse" "$("$ROOT/bin/ds" config get zzup-tmux limits.conf worktree_provider 2>/dev/null | jq -r .value)"
out="$(DS_TREEHOUSE_BIN="$tmp/no-treehouse" up zzup-tmux)"; rc=$?
check "tmux, stored treehouse: refused" "2" "$rc"
has "tmux, stored treehouse: the provider's reason" "worktree_provider treehouse needs 'treehouse'" "$out"
check "tmux, stored treehouse: the same worktree" "$wt" "$(jq -r .studio_wt "$disp")"

# 8. Off Orca with the loop down: stops with the loop's error.
"$ROOT/bin/ds" config set zzup-down roles.conf builder claude opus ondemand high claude:sonnet >/dev/null 2>&1
out="$(DS_UP_LOOP='exit 1' up "$src" --backend tmux --label zzup-down)"; rc=$?
check "tmux, loop down: exit 1" "1" "$rc"
has "tmux, loop down: says only the loop starts it" "only the loop can start a Studio on tmux" "$out"

# 9. A bad --worktree for the backend is refused before anything is made.
out="$(up "$src" --backend orca --worktree treehouse --label zzup-bad)"; rc=$?
check "orca + treehouse: refused" "2" "$rc"
check "orca + treehouse: no state" "no" "$([ -e "$DS_STATE_ROOT/zzup-bad/dispatcher.json" ] && echo yes || echo no)"

echo "up-backend: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
