#!/usr/bin/env bash
# suspend-squad.sh — U158: a wish writer. Suspend writes the squad's suspended wish,
# --resume its running wish; the loop checkpoints, closes and removes (or, on resume,
# restarts fresh). No backend call on any path, dirty worktrees included (the loop
# records a leftover instead of the old refusal).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
for f in bin conventions roles AGENTS.md; do ln -s "$ROOT/$f" "$TMP/$f"; done
S="$TMP/state"; mkdir -p "$S/fx/squads"
echo '{"home_repo":"fx"}' > "$S/fx/dispatcher.json"
cat > "$S/fx/squads/t1.json" <<'EOF'
{"topic":"t1","repo":"fx","type":"feature","status":"running","run_id":"run1","lead_wt":"wtl","worktrees":["wtl"],
 "members":[{"role":"lead","wt":"wtl"}],"units":[]}
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

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
sql() { "$bun" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
  for (const r of d.query(process.argv[2]).values()) console.log(r.map((v) => v ?? "").join("\t"))' "$S/loop.db" "$1"; }
run() { (cd "$TMP" && "$@"); }

run bin/commands/suspend-squad.sh fx t1 >/dev/null 2>"$TMP/err" || ck "suspend: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "suspend: no backend call" "$(cat "$FAKE_LOG")" ""
ck "suspend: suspended wish, no replay" "$(sql "SELECT want, want_by, json_extract(want_payload, '\$.argv') IS NULL FROM squads WHERE topic = 't1'")" "suspended	suspend-squad	1"
ck "suspend again: no-op" "$(run bin/commands/suspend-squad.sh fx t1 | jq -r .changed)" "false"
# The loop exports the suspended status back to the file; resume then writes running.
jq '.status = "suspended"' "$S/fx/squads/t1.json" > "$S/fx/squads/t1.json.tmp" && mv "$S/fx/squads/t1.json.tmp" "$S/fx/squads/t1.json"
run bin/commands/suspend-squad.sh fx t1 --resume >/dev/null 2>"$TMP/err" || ck "resume: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "resume: running wish" "$(sql "SELECT want, want_by FROM squads WHERE topic = 't1'")" "running	resume-squad"
ck "resume: no backend call" "$(cat "$FAKE_LOG")" ""
set +e; run bin/commands/suspend-squad.sh fx nosuch >/dev/null 2>&1; rc=$?; set -e
ck "unknown squad: exit 1" "$rc" "1"

echo "suspend-squad: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
