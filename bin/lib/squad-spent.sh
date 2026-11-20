#!/usr/bin/env bash
# squad-spent.sh <label> [--dir <claude-projects-dir>] — each squad's spend SINCE IT STARTED, for the board.
#
# Writes state/<label>/loop/squad-spent.tsv (tokens.tsv only keeps 7 days):
#   topic  since  total  lead  thinker  builders  other  frozen
# Values are price-weighted tokens, the board's "spent": cache write x2 on the 1-hour TTL and x1.25 on
# the 5-minute one (cw_1h / cw_5m), cache read x0.05 on Opus and x0.1 on other models, output x5, input x1.
# A `:review` worker (role review) counts under `other`. `since` is the squad's first member start (unix seconds; the state file's age
# when it has none). A closed squad (state/<label>/archive/*.json) is computed once and frozen —
# its row is kept as is. One log scan covers all the others, from the oldest `since` among them.
# The sweep runs this in the background; it prints nothing.
set -euo pipefail
# U222: the work runs in TypeScript (bin/commands/squad-spent-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" squad-spent-ts "$@"
