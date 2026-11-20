#!/usr/bin/env bash
# restart-role.sh — recycle one worker IN PLACE (stop + start the same worktree) without removing its worktree or branch.
set -euo pipefail
# U191: the work runs in TypeScript (bin/commands/restart-role-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" restart-role-ts "$@"
