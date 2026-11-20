#!/usr/bin/env bash
# send-peer.sh — message a peer squad's Thinker or Lead (cross-squad clarification).
#
#   send-peer.sh <squad> <role[-suffix]> <subject> <body> [--project <label>] [--ruling] [--from <squad>/<role>]
#
# The ONE allowed cross-squad path (conventions/escalation.md "Peer clarification"):
# technical clarification only — scope, priority, ownership still go Lead → operator.
# Resolves the target through directory.sh (the phone book); no lookup of its own.
# A Lead is reached at its Run inbox (`send`); a Thinker at its worktree in its Run
# (`send-run-worker`). The sent subject is prefixed `peer:<from squad>/<role>`.
#
# Every send appends one line to state/<label>/cross-squad.md:
#   - <ISO> <from squad>/<role> → <to squad>/<role> [<subject>] <msg_id>
# (the Lead tick shows it). With --ruling the line also carries the body and both
# squads' Lead journals get the ruling as a decision. --from overrides the sender,
# else it is this worktree's roster row (falling back to its worktree name).
#
# exit 2 = bad args, unknown squad/role, a closed/suspended/failed squad, a target
#   that isn't a Thinker/Lead ("ask your Lead"), or your own squad's worker (use
#   orch.sh send-worker); exit 3 = the peer isn't live — the Studio route still
#   exists, so ask your Lead, who raises it to the Studio. The backend's exit code
#   is passed through otherwise. Only $BACKEND ops — never `orca`.
set -euo pipefail
# U192: the work runs in TypeScript (bin/commands/send-peer-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" DS_SCRIPT="$0" "$ROOT/bin/ds" send-peer-ts "$@"
