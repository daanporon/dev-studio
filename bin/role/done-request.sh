#!/usr/bin/env bash
# done-request.sh <request-file> — the ONE way for an agent to clear a handled restart/board
# request. Deletes the file (already gone is fine), then prints every request still waiting in
# that same folder — as watch.sh prints them — or `none left`, so the agent handles each line
# before it stops. Works for the Studio (requests/_studio/) and a Lead (requests/<topic>/).
# Refuses anything outside state/*/requests/ or not ending in .txt. (bin/commands/close-role.sh deletes
# requests itself when it retires a role — that path stays as it is; this is for an agent
# clearing a request it handled.)
set -euo pipefail
# U192: the work runs in TypeScript (bin/commands/done-request-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" DS_SCRIPT="$0" "$ROOT/bin/ds" done-request-ts "$@"
