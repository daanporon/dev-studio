#!/usr/bin/env bash
# arm-rewake.sh <worktree_id> -- <watch-args...> — install the UNIVERSAL rewake Stop hook
# into a standing agent's worktree, so it wakes on actionable work instead of only on its
# heartbeat. One mechanism for every standing agent; the <watch-args> (forwarded to
# bin/lib/watch.sh by the hook) say what that agent watches:
#   Lead:       arm-rewake.sh <lead_wt>    -- <project> <topic>
#   Thinker:    arm-rewake.sh <thinker_wt> -- --worktree
#   Dispatcher: arm-rewake.sh <disp_wt>    -- --run <run_id>
#
# Armed unconditionally by the spawner for every standing agent — this is the ONE wake
# mechanism (no heartbeat). It writes <worktree>/.claude/settings.local.json (MERGING into
# any existing settings, idempotent). Needs the worktree's local filesystem path (from ps);
# a remote-host worktree can't be armed from here (prints a notice, exits 0).
set -euo pipefail
# U193: the work runs in TypeScript (bin/commands/arm-rewake-ts.ts); this path stays because worktree settings name it.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" arm-rewake-ts "$@"
