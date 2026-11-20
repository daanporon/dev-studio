#!/usr/bin/env bash
# restart-role.sh (U153) — a plain restart is a wish writer: it writes restart_at (mode now,
# by restart-role) on the member through `ds want`, calls no backend, and needs no Orca
# sender terminal. --agent/--model/--account/--effort are gone (exit 2, naming the pin
# command); --limited/--phase/--wt are accepted and ignored. --resume is accepted and ignored (U158: a restart always starts fresh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
for f in bin conventions roles AGENTS.md; do ln -s "$ROOT/$f" "$TMP/$f"; done
S="$TMP/state"; mkdir -p "$S/fx/squads"
echo '{"home_repo":"fx"}' > "$S/fx/dispatcher.json"
cat > "$S/fx/squads/t1.json" <<'EOF'
{"topic":"t1","repo":"fx","type":"feature","status":"running","run_id":"run1","lead_wt":"wtl","worktrees":["wtl","wtb"],
 "members":[{"role":"lead","wt":"wtl"},{"role":"builder","suffix":"u1","wt":"wtb"}],"units":[{"slug":"u1","status":"dispatched","tier":"hard"}]}
EOF
cat > "$TMP/fakeb" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
echo '{}'
FAKE
chmod +x "$TMP/fakeb"
export FAKE_LOG="$TMP/log" BACKEND="$TMP/fakeb" DS_STATE_ROOT="$S" DS_NOW=1800000000
unset ORCA_TERMINAL_HANDLE DS_LOOP_CHILD DS_WHO
: > "$FAKE_LOG"
bun="$(command -v bun 2>/dev/null || true)"; [ -n "$bun" ] || bun="$HOME/.bun/bin/bun"
"$TMP/bin/ds" import >/dev/null
sql() { "$bun" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
  for (const r of d.query(process.argv[2]).values()) console.log(r.map((v) => v ?? "").join("\t"))' "$S/loop.db" "$1"; }
pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }

run() { (cd "$TMP" && "$@"); }
run bin/commands/restart-role.sh fx t1 builder u1 >/dev/null 2>"$TMP/err" || { ck "restart: exits 0" "$?: $(cat "$TMP/err")" "0"; }
ck "restart: no backend call" "$(cat "$FAKE_LOG")" ""
ck "restart: restart_at mode now by restart-role" "$(sql "SELECT restart_mode, restart_by FROM members WHERE suffix = 'u1'")" "now	restart-role"
ck "restart: restart_at set" "$(sql "SELECT restart_at IS NOT NULL FROM members WHERE suffix = 'u1'")" "1"

# --wt resolves the member by its worktree; --limited/--phase are ignored.
run bin/commands/restart-role.sh fx t1 builder --wt wtb --limited claude:a=1 --phase build >/dev/null 2>"$TMP/err" || ck "restart --wt: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "restart --wt: no backend call" "$(cat "$FAKE_LOG")" ""
ck "restart --wt: same member" "$(sql "SELECT COUNT(*) FROM members WHERE suffix = 'u1' AND restart_at IS NOT NULL")" "1"

# Placement flags are gone.
if run bin/commands/restart-role.sh fx t1 builder u1 --model sonnet >/dev/null 2>"$TMP/err"; then ck "restart --model: refused" "0" "2"; else ck "restart --model: refused" "$?" "2"; fi
ck "restart --model: says pin" "$(grep -c 'ds want member' "$TMP/err" || true)" "1"
if run bin/commands/restart-role.sh fx t1 builder u1 --agent codex >/dev/null 2>&1; then ck "restart --agent: refused" "0" "2"; else ck "restart --agent: refused" "$?" "2"; fi

echo "restart-role.sh: $pass passed, $fail failed"
[ "$fail" = 0 ]
