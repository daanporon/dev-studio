#!/usr/bin/env bash
# account-add.sh — issue #125 U5: `ds account add` on a temp state root (the loop faked by a fresh health row):
# refusals that make nothing, the project default (the one live Studio), a filed request the CLI follows to its end,
# and the login line run under sh with a fake claude (the folder env, no browser, the exit file). Never a real claude.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=tests/lib/state-root.sh
. "$ROOT/tests/lib/state-root.sh"
S="$DS_STATE_ROOT"
unset ORCA_TERMINAL_HANDLE DS_LOOP_CHILD DS_WHO DS_NOW
export DS_ACCOUNT_ADD_POLL_MS=50
pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
has() { if grep -qF -- "$3" <<<"$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
bun="$(command -v bun 2>/dev/null || true)"; [ -n "$bun" ] || bun="$HOME/.bun/bin/bun"
sql() { "$bun" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1]);
  const r = d.query(process.argv[2]).all(); if (r.length) console.log(r.map((x) => Object.values(x).join("|")).join("\n"))' "$S/loop.db" "$1"; }
add() { rc=0; out="$("$ROOT/bin/ds" account add "$@" 2>&1)" || rc=$?; }
requests() { sql "SELECT COUNT(*) FROM requests WHERE kind = 'account-add'"; }

"$ROOT/bin/ds" account list >/dev/null      # makes loop.db
now="$(date +%s)"
sql "INSERT INTO projects (label, studio_wt, observed_at) VALUES ('fx', 'wt-fx', $now), ('fy', 'wt-fy', $now)"

# Refusals before anything is filed or made (the loop has never run here, so even a good one stops at the end).
add realp --agent nobody;          ck "unknown kind: exit 2" "$rc" "2"; has "unknown kind" "$out" "no account kind for agent 'nobody'"
add Bad_Name --project fx;         ck "bad name: exit 2" "$rc" "2"; has "bad name: nothing made" "$out" "Nothing made."
add system --project fx;           ck "reserved name: exit 2" "$rc" "2"
add realp;                         ck "no live Studio: exit 2" "$rc" "2"; has "no live Studio" "$out" "no project has a live Studio"
add realp --project nope;          ck "unknown project: exit 2" "$rc" "2"; has "unknown project" "$out" "no project 'nope'"
add realp --dir "$S/missing";      ck "--dir not a folder: exit 2" "$rc" "2"
mkdir -p "$S/plain"; touch "$S/plain/x"
add realp --dir "$S/plain";        ck "--dir not logged in: exit 2" "$rc" "2"; has "--dir not logged in" "$out" "it is not logged in"
ck "--dir not logged in: left alone" "$(ls -A "$S/plain")" "x"
add realp --project fx;            ck "loop never ran: exit 2" "$rc" "2"; has "loop never ran" "$out" "the loop has never run here"
ck "refusals filed nothing" "$(requests)" "0"
ck "refusals made no folder" "$(test -e "$S/accounts" && echo made || echo none)" "none"

# The project default: one live Studio is picked, several are refused.
sql "INSERT INTO health (id, pid, started_at, tick_at, progress_at) VALUES (1, 1, $now, $now, $now)"
sql "INSERT INTO members (project, squad, role, suffix, handle, observed_at, updated_at) VALUES ('fx', '_studio', 'studio', '', 'term-fx', $now, $now), ('fy', '_studio', 'studio', '', 'term-fy', $now, $now)"
add realp;                         ck "several Studios: exit 2" "$rc" "2"; has "several Studios" "$out" "several projects have a live Studio (fx, fy)"
sql "UPDATE members SET status = 'gone' WHERE project = 'fy'"
add realp --no-wait;               ck "one Studio: filed" "$rc" "0"; has "filed" "$out" "Filed the add of claude:realp"
ck "one Studio: the project" "$(sql "SELECT json_extract(payload, '\$.project') || '|' || json_extract(payload, '\$.name') FROM requests WHERE kind = 'account-add'")" "fx|realp"
ck "the CLI made no folder (the loop does)" "$(test -e "$S/accounts" && echo made || echo none)" "none"

# The CLI follows the request: progress lines, then the end and its exit code; a failed end exits 1.
mkdir -p "$S/logged"; echo '{}' > "$S/logged/.credentials.json"
( "$ROOT/bin/ds" account add other --dir "$S/logged" > "$S/follow.out" 2>&1 && echo 0 > "$S/follow.rc" || echo $? > "$S/follow.rc" ) &
for _ in $(seq 100); do id="$(sql "SELECT id FROM requests WHERE json_extract(payload, '\$.name') = 'other'")"; [ -n "$id" ] && break; sleep 0.05; done
sql "UPDATE requests SET result = '{\"state\":\"terminal_open\",\"text\":\"waiting for login: open https://example.test/x\"}' WHERE id = $id"
sleep 0.3
sql "UPDATE health SET progress_at = strftime('%s','now') WHERE id = 1"
sql "UPDATE requests SET done_at = strftime('%s','now'), result = '{\"state\":\"done\",\"ok\":true,\"text\":\"added claude:other\"}' WHERE id = $id"
wait
ck "follow: exit 0" "$(cat "$S/follow.rc")" "0"
has "follow: progress" "$(cat "$S/follow.out")" "  waiting for login: open https://example.test/x"
has "follow: the end" "$(cat "$S/follow.out")" "added claude:other"
( "$ROOT/bin/ds" account add third --dir "$S/logged" > "$S/follow.out" 2>&1 && echo 0 > "$S/follow.rc" || echo $? > "$S/follow.rc" ) &
for _ in $(seq 100); do id="$(sql "SELECT id FROM requests WHERE json_extract(payload, '\$.name') = 'third'")"; [ -n "$id" ] && break; sleep 0.05; done
sql "UPDATE requests SET done_at = strftime('%s','now'), result = '{\"state\":\"failed\",\"ok\":false,\"error\":\"login not finished\"}' WHERE id = $id"
wait
ck "follow failed: exit 1" "$(cat "$S/follow.rc")" "1"
has "follow failed: the error" "$(cat "$S/follow.out")" "ds account add: login not finished"

# The login line under sh: a fake claude sees the folder env and BROWSER=true; its exit code lands in the exit file.
bin="$DS_STATE_PARENT/bin"; mkdir -p "$bin"
cat > "$bin/claude" <<'EOF'
#!/bin/sh
echo "dir=$CLAUDE_CONFIG_DIR browser=$BROWSER args=$*" > "$CLAUDE_CONFIG_DIR/seen"
exit 7
EOF
chmod +x "$bin/claude"
folder="$S/it's here"; mkdir -p "$folder"
line="$(cd "$ROOT" && "$bun" -e 'const { loginLine } = await import("./bin/lib/account-folder.ts"); const { findKind } = await import("./bin/lib/account-kinds/index.ts");
  console.log(loginLine(findKind("claude"), process.argv[1]))' "$folder")"
PATH="$bin:$PATH" sh -c "$line"
ck "login line: the fake claude's view" "$(cat "$folder/seen")" "dir=$folder browser=true args=auth login --claudeai"
ck "login line: the exit file" "$(cat "$folder/.ds-login-exit")" "7"

echo "account-add: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
