#!/usr/bin/env bash
# remove-project.sh — remove-project U2: `ds remove-project <label> --dry-run` on a temp state root:
# blockers with the command that clears them, the plan when clear, refusals, and no write at all.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=tests/lib/state-root.sh
. "$ROOT/tests/lib/state-root.sh"
S="$DS_STATE_ROOT"
export DS_NOW=1800000000
unset ORCA_TERMINAL_HANDLE DS_LOOP_CHILD DS_WHO
mkdir -p "$S/fx/squads"
echo '{"home_repo":"fx"}' > "$S/fx/dispatcher.json"
cat > "$S/fx/squads/t1.json" <<'EOF'
{"topic":"t1","repo":"fx","type":"feature","status":"running","run_id":"run1","lead_wt":"wtl","worktrees":["wtl"],
 "members":[{"role":"lead","wt":"wtl"}],"units":[]}
EOF
"$ROOT/bin/ds" import >/dev/null

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
has() { if grep -qF -- "$3" <<<"$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
bun="$(command -v bun 2>/dev/null || true)"; [ -n "$bun" ] || bun="$HOME/.bun/bin/bun"
# Every row of every table, hashed, and every file but SQLite's own side files.
snapshot() {
  "$bun" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
    const out = d.query("SELECT name FROM sqlite_master WHERE type = \"table\" ORDER BY name").values()
      .map(([t]) => t + JSON.stringify(d.query("SELECT * FROM " + t).values()));
    console.log(Bun.hash(out.join("\n")).toString())' "$S/loop.db"
  find "$S" ! -name 'loop.db-*' | sort
}
dry() { rc=0; out="$("$ROOT/bin/ds" remove-project "$@" 2>&1)" || rc=$?; }

before="$(snapshot)"
dry fx --dry-run
ck "blocked: exit 1" "$rc" "1"
has "blocked: names the squad" "$out" "squad 't1' is not closed (status: running)"
has "blocked: the clearing command" "$out" "clear: ds close-squad fx t1"
has "blocked: says nothing changed" "$out" "Dry run: nothing changed."
ck "blocked: wrote nothing" "$(snapshot)" "$before"

for bad in .. a/b nobody; do
  dry "$bad" --dry-run
  ck "refused $bad: exit 2" "$rc" "2"
  has "refused $bad: nothing changed" "$out" "Nothing changed."
done
dry fx
ck "no --dry-run: exit 1" "$rc" "1"
has "no --dry-run: not available yet" "$out" "removal itself is not available yet"
dry --dry-run
ck "no label: exit 2" "$rc" "2"
ck "refusals: wrote nothing" "$(snapshot)" "$before"

"$bun" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1]);
  d.run("UPDATE squads SET status = \"closed\" WHERE project = \"fx\"");
  d.run("UPDATE members SET status = \"gone\", want = \"gone\" WHERE project = \"fx\"")' "$S/loop.db"
rm "$S/fx/squads/t1.json"
before="$(snapshot)"
dry fx --dry-run
ck "clear: exit 0" "$rc" "0"
has "clear: says so" "$out" "Nothing blocks removing 'fx'."
has "clear: what stops" "$out" "A removal would stop:"
has "clear: what moves" "$out" "$S/.removed/fx-<YYYY-MM-DD>/"
has "clear: what stays" "$out" "the repo clone repos/fx"
ck "clear: wrote nothing" "$(snapshot)" "$before"

echo "remove-project: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
