#!/usr/bin/env bash
# spawn-squad.sh — spawn one topic Squad (U158: a wish writer). It checks its arguments,
# then writes the squad's running wish (`ds want squad <label>/<topic> running`, with the
# repo/type/autonomy/host/framing on the row) and returns at once. The loop creates the
# Run and the gates task, writes the squad doc, and wishes the Lead and the roster's
# always roles running (bin/loop/fulfil/squad.ts); their starts make the worktrees.
# No backend call is made here on any path.
set -euo pipefail
# U263: the work runs in TypeScript (bin/commands/spawn-squad-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" spawn-squad-ts "$@"
