#!/usr/bin/env bash
# add-role.sh — ask the loop to add one role worker to a RUNNING squad (U157: a wish writer).
#
# The loop dispatches Builders itself now (bin/loop/reconcilers/ready.ts), so the Lead never
# calls this for a Builder. Manual/operator use for one extra worker:
#
#   add-role.sh <project> <topic> builder <unit-slug> [--spec <text>]
#   add-role.sh <project> <topic> <role> <suffix> [--spec <text>]
#
# It checks its arguments as before, then writes the same member wish `ds request` would
# (running, payload request:true) and returns: the loop picks the agent, model and account
# through the ladder, starts it under add-role.sh's worktree name and prompt, records the
# member and (for a Builder) the unit dispatched, and tells the squad's Lead once it started.
# Placement flags from the backend era (--agent/--model/--effort/--account/--host) and the
# routing/legacy flags (--for/--unit/--owns) are accepted and ignored: only the loop places now.
set -euo pipefail
# U263: the work runs in TypeScript (bin/commands/add-role-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" add-role-ts "$@"
