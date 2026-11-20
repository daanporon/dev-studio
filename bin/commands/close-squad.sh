#!/usr/bin/env bash
# close-squad.sh — tear down one squad (U158: a wish writer).
#
#   close-squad.sh <project> <topic> [--force] [--keep-state] [--purge]
#
# It writes the squad's archived wish (`ds want squad … gone`) and returns at once; no
# backend call is made here on any path. The loop closes every member's agent, removes
# its worktrees (a dirty or unpushed one is recorded as a leftover, never force-deleted),
# reclaims the Run's workers, and moves the squad JSON and its plans to the archive, so
# it leaves the live board but stays viewable in the board's Archived section. Branches
# and PRs are kept. --force, --keep-state and --purge are accepted for compatibility and
# ignored: the loop never force-deletes and always archives.
set -euo pipefail
# U263: the work runs in TypeScript (bin/commands/close-squad-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" close-squad-ts "$@"
