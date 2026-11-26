#!/usr/bin/env bash
# account-muse.sh — issue #125 U12: Muse keeps one login. `ds account add --agent muse` is refused with the
# kind's reason (also with --dir): no folder, no request, no muse run, and the made-up token in the system
# login's auth.json reaches neither the output nor loop.db. Never a real muse.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=tests/lib/state-root.sh
. "$ROOT/tests/lib/state-root.sh"
S="$DS_STATE_ROOT"
unset ORCA_TERMINAL_HANDLE DS_LOOP_CHILD DS_WHO DS_NOW XDG_CONFIG_HOME META_API_KEY
pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
has() { if grep -qF -- "$3" <<<"$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
bun="$(command -v bun 2>/dev/null || true)"; [ -n "$bun" ] || bun="$HOME/.bun/bin/bun"
sql() { "$bun" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1]);
  const r = d.query(process.argv[2]).all(); if (r.length) console.log(r.map((x) => Object.values(x).join("|")).join("\n"))' "$S/loop.db" "$1"; }
add() { rc=0; out="$(HOME="$home" PATH="$bin:$PATH" "$ROOT/bin/ds" account add "$@" 2>&1)" || rc=$?; }

sentinel="zz-sentinel-muse-login"
home="$DS_STATE_PARENT/home"; bin="$DS_STATE_PARENT/bin"; logged="$DS_STATE_PARENT/logged"
mkdir -p "$home/.config/muse" "$bin" "$logged"
printf '{"providers":{"meta":{"access_token":"%s"}}}\n' "$sentinel" | tee "$home/.config/muse/auth.json" > "$logged/auth.json"
printf '#!/bin/sh\ntouch "%s"\n' "$DS_STATE_PARENT/muse-ran" > "$bin/muse"
chmod +x "$bin/muse"

seen="$(HOME="$home" "$ROOT/bin/ds" account list 2>&1)"      # makes loop.db
now="$(date +%s)"
sql "INSERT INTO projects (label, studio_wt, observed_at) VALUES ('fx', 'wt-fx', $now)"
sql "INSERT INTO health (id, pid, started_at, tick_at, progress_at) VALUES (1, 1, $now, $now, $now)"

for dir in "" "$logged"; do
  add second --agent muse --project fx ${dir:+--dir "$dir"}
  seen="$seen$out"
  ck "refused${dir:+ with --dir}: exit 2" "$rc" "2"
  has "refused${dir:+ with --dir}: the reason" "$out" "ds account add: Muse keeps one login (~/.config/muse). Nothing made."
done
ck "no request filed" "$(sql "SELECT COUNT(*) FROM requests WHERE kind = 'account-add'")" "0"
ck "no folder made" "$(test -e "$S/accounts" && echo made || echo none)" "none"
ck "muse never ran" "$(test -e "$DS_STATE_PARENT/muse-ran" && echo ran || echo no)" "no"
ck "no second Muse row" "$(sql "SELECT COUNT(*) FROM accounts WHERE agent = 'muse' AND account != 'default'")" "0"

seen="$seen$(HOME="$home" "$ROOT/bin/ds" account list 2>&1)"
dump="$(sql "SELECT * FROM accounts"; sql "SELECT * FROM requests"; sql "SELECT * FROM events")"
ck "no token in the output or loop.db" "$(grep -cF -- "$sentinel" <<<"$seen$dump" || true)" "0"
ck "no token under the state root" "$(grep -rlF -- "$sentinel" "$S" | wc -l | tr -d ' ')" "0"

echo "account-muse: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
