#!/usr/bin/env bash
# suspend-squad.sh <project> <topic> [--resume] — SUSPEND a squad, or bring it back
# (U158: a wish writer). It writes the squad's suspended (or, with --resume, running)
# wish and returns at once; no backend call is made here on any path.
#
# Suspend: the loop checkpoints each live agent (5 minutes, then closes anyway and
# journals "checkpoint failed"), closes it, removes its worktree and clears its wt —
# state, branches, PRs and journals are kept, and a worktree that is dirty or unpushed
# is recorded as a leftover instead of blocking the suspend. Resume: the squad goes
# back to running and each member starts fresh from its journal in a new worktree.
set -euo pipefail
# U263: the work runs in TypeScript (bin/commands/suspend-squad-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" suspend-squad-ts "$@"
