#!/usr/bin/env bash
# U244: inside a loop tick (DS_ORCA_TICK_DIR) the adapter shares a Run's run-show between steps and counts
# real CLI spawns (DS_ORCA_SPAWN_LOG); without the directory every call goes to Orca. Fake CLI, no live Orca.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/tick"
cat > "$TMP/bin/orca" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$CLI_LOG"
echo '{"ok":true,"result":{"run":{"coordinator_handle":"term_lead"}}}'
FAKE
chmod +x "$TMP/bin/orca"
export DS_ORCA_CLI_BIN_DIR="$TMP/bin" CLI_LOG="$TMP/log" DS_STATE_ROOT="$TMP/state"
B="$ROOT/bin/backend/orca.sh"
pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1: expected [$3], got [$2]" >&2; fi; }
calls() { if [ -f "$TMP/log" ]; then wc -l <"$TMP/log" | tr -d ' '; else echo 0; fi; }

: >"$TMP/log"
for _ in 1 2 3; do eq "no tick dir: handle" "$("$B" run-coordinator run_a)" term_lead; done
eq "no tick dir: every call goes to Orca" "$(calls)" 3

: >"$TMP/log"; export DS_ORCA_TICK_DIR="$TMP/tick" DS_ORCA_SPAWN_LOG="$TMP/spawns"; : >"$DS_ORCA_SPAWN_LOG"
for _ in 1 2 3; do eq "tick dir: handle" "$("$B" run-coordinator run_a)" term_lead; done
eq "tick dir: one run-show for three reads" "$(calls)" 1
eq "tick dir: the spawn is counted, with its caller and kind" "$(cat "$DS_ORCA_SPAWN_LOG")" "$(printf 'orchestration run-show\trun-coordinator\tkeyed')"
"$B" run-coordinator run_b >/dev/null
eq "tick dir: another Run is its own read" "$(calls)" 2

# parallel readers of one Run: one call
rm -rf "$TMP/tick"; mkdir "$TMP/tick"; : >"$TMP/log"
for _ in 1 2 3 4 5 6; do "$B" run-coordinator run_c >/dev/null & done; wait
eq "tick dir: parallel readers share one call" "$(calls)" 1

# a directory that is gone: back to direct calls
rm -rf "$TMP/tick"; : >"$TMP/log"
"$B" run-coordinator run_a >/dev/null; "$B" run-coordinator run_a >/dev/null
eq "missing tick dir: direct calls" "$(calls)" 2

echo "orca-tick-cache: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
