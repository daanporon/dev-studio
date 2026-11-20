#!/usr/bin/env bash
# approve-fix.sh <project> <testing-topic> <proposal-id> [--autonomy checkpoints|lfg]
#
# The operator's one-click approval of a fix squad a TESTING squad's Thinker proposed. A testing
# squad never fixes what it finds — it triages a confirmed bug into a proposed fix squad (repo +
# topic + framing, recorded in its state's proposed_squads[] and surfaced on the board). This
# reads that proposal and SPAWNS the fix squad independently (its own run), so the fix work runs
# apart from the ongoing testing squad. Run it from the Studio; spawn-squad writes the wish and the loop starts it.
set -euo pipefail
# U263: the work runs in TypeScript (bin/commands/approve-fix-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" approve-fix-ts "$@"
