#!/usr/bin/env bash
# alerts.sh — a project's Studio alerts: state/<label>/alerts.json, {"alerts":[…]}, each entry the
# shape of a squad's waiting_on_you entry. They belong to the project, not to any squad; the board
# shows them at the top of the project's Needs-you list and answering one dismisses it.
#   alerts.sh <file> add <id> <title> <text> <option> <why> [<fields JSON object>]
#   alerts.sh <file> resolve <id>
#   alerts.sh <file> resolve-prefix <id-prefix>
#   alerts.sh <file> list
# A card shows its options as answers only when the answer acts: 2+ options, or the field
# "acts_on_answer": true (the studio_move "move it" card). A lone option that does nothing is the
# board's "When done: <option>" line (field "when"), and the card shows only Dismiss.
set -euo pipefail
# U222: the work runs in TypeScript (bin/commands/alerts-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" alerts-ts "$@"
