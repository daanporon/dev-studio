#!/usr/bin/env bash
# restart-squads.sh (U153/U158) — it writes one restart wish per member and calls no
# backend; suspended squads are skipped. --resume is accepted and ignored: a restart
# always starts fresh.
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
cat > "$S/fx/squads/t2.json" <<'EOF'
{"topic":"t2","repo":"fx","type":"feature","status":"suspended","run_id":"run2","lead_wt":"wtl2","worktrees":["wtl2"],
 "members":[{"role":"lead","wt":"wtl2"}],"units":[]}
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

out="$(run bin/commands/restart-squads.sh fx 2>/dev/null)" || { ck "squads: exits 0" "$?" "0"; }
ck "squads: no backend call" "$(cat "$FAKE_LOG")" ""
ck "squads: both t1 members wished" "$(sql "SELECT COUNT(*) FROM members WHERE squad = 't1' AND restart_at IS NOT NULL")" "2"
ck "squads: suspended t2 skipped" "$(sql "SELECT COUNT(*) FROM members WHERE squad = 't2' AND restart_at IS NOT NULL")" "0"
ck "squads: says the loop restarts them" "$(printf '%s' "$out" | grep -c 'the loop restarts them' || true)" "1"

# --topic and --role narrow it.
"$bun" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1]); d.run("UPDATE members SET restart_at = NULL")' "$S/loop.db"
run bin/commands/restart-squads.sh fx --topic t1 --role lead >/dev/null 2>&1 || ck "squads --role: exits 0" "$?" "0"
ck "squads --role lead: only the Lead" "$(sql "SELECT role FROM members WHERE restart_at IS NOT NULL")" "lead"

# --resume is the same wish now (U158), not a conversation-keeping backend path.
"$bun" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1]); d.run("UPDATE members SET restart_at = NULL")' "$S/loop.db"
run bin/commands/restart-squads.sh fx --topic t1 --resume >/dev/null 2>&1 || ck "squads --resume: exits 0" "$?" "0"
ck "squads --resume: same restart wishes, no backend" "$(sql "SELECT COUNT(*) FROM members WHERE squad = 't1' AND restart_at IS NOT NULL") $(cat "$FAKE_LOG")" "2 "

echo "restart-squads.sh: $pass passed, $fail failed"
[ "$fail" = 0 ]
