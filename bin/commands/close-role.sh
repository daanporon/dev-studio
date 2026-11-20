#!/usr/bin/env bash
# close-role.sh <project> <topic> <label> [--cancel [--into X] [--why T]] [--force] — retire
# ONE member of a squad (U155: a wish writer). A plain retirement writes the member's
# archived wish (`ds want member … archived`, stored `gone`); the loop closes its agent
# and removes its worktree in Bun (bin/loop/fulfil/close.ts), recording a leftover when
# the tree is dirty or unpushed. Its branch and PR are never touched. --force is accepted
# and ignored: the loop never force-removes. A cancellation keeps writing the cancel wish
# (squad-state cancel-unit): the loop stops the Builder, removes its worktree and closes
# its PR. No backend call is made here on any path.
# <label> is a roster row's name: role or role-suffix (e.g. builder-structures-console).
set -euo pipefail
# U263: the work runs in TypeScript (bin/commands/close-role-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" close-role-ts "$@"
