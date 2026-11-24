#!/usr/bin/env bash
# shadow-drill.sh — bin/host/shadow-drill.sh: crash signals only the agent inside the named worktree; report
# passes only on `exit: met`. A fake ds stands in for the report; a fake `claude` process is a sleep run under that name.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
T="$(cd "$(mktemp -d)" && pwd -P)"
pids=()
cleanup() { for p in "${pids[@]}"; do kill -KILL "$p" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT
pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1" >&2; fi; }
D="$ROOT/bin/host/shadow-drill.sh"
mkdir -p "$T/a" "$T/b"
mkfake() { mkdir -p "$T/fake"; cp "$(command -v sleep)" "$T/fake/claude"; }
mkfake
(cd "$T/a" && exec "$T/fake/claude" 300) & pids+=($!)
(cd "$T/b" && exec "$T/fake/claude" 300) & pids+=($!)
sleep 0.5
ok "dry-run lists the process and kills nothing" "$D crash $T/a --dry-run | grep -q 'would be killed' && kill -0 ${pids[0]}"
"$D" crash "$T/a" > /dev/null
sleep 0.3
ok "crash kills the agent in the named worktree" "! kill -0 ${pids[0]} 2>/dev/null"
ok "crash leaves another worktree's agent" "kill -0 ${pids[1]} 2>/dev/null"
ok "crash with no agent exits 1" "! $D crash $T/a > /dev/null 2>&1"
ok "crash refuses HOME" "! $D crash \$HOME > /dev/null 2>&1"
printf '#!/bin/sh\necho "shadow since x"\necho "exit: met"\n' > "$T/ds-met"; chmod +x "$T/ds-met"
printf '#!/bin/sh\necho "exit: not met — 0 of 5 crashes"\n' > "$T/ds-not"; chmod +x "$T/ds-not"
ok "report passes on exit: met" "DS_BIN=$T/ds-met $D report --since 2026-11-23 > /dev/null"
ok "report fails when the exit is not met" "! DS_BIN=$T/ds-not $D report --since 2026-11-23 > /dev/null 2>&1"
ok "report needs --since" "! $D report > /dev/null 2>&1"
echo "shadow-drill: $pass passed, $fail failed"
[ "$fail" = 0 ]
