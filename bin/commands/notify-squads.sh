#!/usr/bin/env bash
# notify-squads.sh — write a reload wish on every roster member of a project (U156).
#
# The Studio runs this after a dev-studio update so squads reload their
# instructions promptly (instead of waiting for their next self-refresh). The loop types
# the reload into each idle member's terminal (carrying the `ds reload ack` command) and
# the member confirms from that terminal; a fresh session after the wish satisfies it
# without an ack. Reload wishes never expire; the board shows their age.
#
#   notify-squads.sh <project>
#
# Skips squads with no run yet (not started yet: a fresh start reads current instructions
# anyway). A paused member's wish waits until it resumes. No backend call is made here on
# any path.
set -euo pipefail
# U263: the work runs in TypeScript (bin/commands/notify-squads-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" notify-squads-ts "$@"
