#!/usr/bin/env bash
# close-squad.sh — U158: a wish writer. It writes the squad's archived wish (gone) and
# returns; the loop closes its agents, removes its worktrees (dirty/unpushed ones as
# recorded leftovers), reclaims its workers and archives its state off the live board.
# No backend call on any path; --force/--keep-state/--purge are accepted and ignored.
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
has() { if grep -qF -- "$3" <<<"$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
sql() { "$bun" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
  for (const r of d.query(process.argv[2]).values()) console.log(r.map((v) => v ?? "").join("\t"))' "$S/loop.db" "$1"; }
run() { (cd "$TMP" && "$@"); }

run bin/commands/close-squad.sh fx t1 >/dev/null 2>"$TMP/err" || ck "close: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "close: no backend call" "$(cat "$FAKE_LOG")" ""
ck "close: archived wish, no replay" "$(sql "SELECT want, want_by, json_extract(want_payload, '\$.argv') IS NULL FROM squads WHERE topic = 't1'")" "gone	close-squad	1"
ck "close again: no-op" "$(run bin/commands/close-squad.sh fx t1 | jq -r .changed)" "false"
ck "close --force: still just the wish" "$(run bin/commands/close-squad.sh fx t1 --force | jq -r .changed) $(cat "$FAKE_LOG")" "false "
# The state file stays until the loop archives it.
[ -f "$S/fx/squads/t1.json" ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "  FAIL: state file stays for the loop" >&2; }
set +e; run bin/commands/close-squad.sh fx nosuch >/dev/null 2>&1; rc=$?; set -e
ck "unknown squad: exit 1" "$rc" "1"
set +e; out="$(run bin/commands/close-squad.sh fx 2>&1)"; rc=$?; set -e
ck "no topic: exit 2" "$rc" "2"
has "no topic: lists the squad" "$out" "t1"

echo "close-squad: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
