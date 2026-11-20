#!/usr/bin/env bash
# reclaim.sh — sweep each squad's run and sum the freed (settled) dispatches. --topic scopes it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
LBL="zzrcl_$$"; SD="$DS_STATE_ROOT/$LBL/squads"
TMP="$(mktemp -d)"
trap 'rm -rf "$DS_STATE_ROOT/$LBL" "$TMP"' EXIT
mkdir -p "$SD"
printf '{"run_id":"run_A","members":[]}' > "$SD/alpha.json"
printf '{"run_id":"run_B","members":[]}' > "$SD/beta.json"

# Fake backend: worker-reclaim prints a per-run freed count (run_A=2, run_B=3); no run = host-wide.
cat > "$TMP/fakeb" <<'FAKE'
#!/usr/bin/env bash
if [ "$1" = "worker-reclaim" ]; then
  case "${2:-}" in run_A) echo 2 ;; run_B) echo 3 ;; "") echo 42 ;; *) echo 0 ;; esac
  exit 0
fi
if [ "$1" = "terminal-reap-orphaned" ]; then echo 9; exit 0; fi
if [ "$1" = "worker-resolve-unknown" ]; then echo 4; exit 0; fi
echo '{}'
FAKE
chmod +x "$TMP/fakeb"

pass=0; fail=0
has(){ if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }

out="$(BACKEND="$TMP/fakeb" "$ROOT/bin/commands/reclaim.sh" "$LBL" 2>&1)"
has "sweeps all squads: totals the freed count" "$out" "freed 5 leaked dispatch(es) across 2 squad(s)"
has "reports the per-squad count"               "$out" "alpha (run_A) — freed 2"

out="$(BACKEND="$TMP/fakeb" "$ROOT/bin/commands/reclaim.sh" "$LBL" --topic beta 2>&1)"
has "--topic scopes to one squad"               "$out" "freed 3 leaked dispatch(es) across 1 squad(s)"
has "--topic skips the other squad"             "$out" "beta (run_B) — freed 3"
if grep -qF "alpha" <<<"$out"; then fail=$((fail+1)); echo "  FAIL: --topic should skip alpha" >&2; else pass=$((pass+1)); fi

# --all: host-wide sweep (no --run), reaches closed/orphaned runs; no project needed.
out="$(BACKEND="$TMP/fakeb" "$ROOT/bin/commands/reclaim.sh" --all 2>&1)"
has "--all releases worker dispatches host-wide" "$out" "released 42 worker dispatch(es)"
has "--all also closes orphaned terminal tabs"   "$out" "closed 9 orphaned terminal tab(s)"
has "--all clears release_unknown dispatches"    "$out" "cleared 4 release_unknown"
has "--all notes it covers closed/orphaned runs" "$out" "incl. closed/orphaned"

echo "reclaim: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
