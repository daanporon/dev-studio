#!/usr/bin/env bash
# loop.sh — start, watch and stop the loop daemon (bin/loop/main.ts) of a state root.
#   loop.sh --ensure   start it unless it runs (cron calls this every minute); a stalled loop is restarted
#   loop.sh --status   whether it runs, and its health row; exits 3 when it does not run
#   loop.sh --stop     stop it
set -euo pipefail
# U273: the work runs in TypeScript (bin/commands/loop-ts.ts); this path stays for the cron watchdog line.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" loop-ts "$@"
