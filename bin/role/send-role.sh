#!/usr/bin/env bash
# send-role.sh — message a squad member by squad + role name, in-squad or across squads.
#
#   send-role.sh <squad> <role[-suffix]> <subject> <body> [--project <label>] [--from <squad>]
#
# The address comes from the phone book (`directory.sh reach`), never from a hand-built lookup:
# a Lead is messaged at its Run inbox (at its worktree in its Run when no pane holds the Run), a
# same-squad member at its own inbox, another squad's member at its worktree in its Run. Exit 2 = unknown squad/role (or the squad is
# closed/suspended/failed); 3 = the member is not running; 4 = the backend couldn't list live
# terminals — reach's codes pass straight through, as does the backend send's (unlike
# send-peer.sh, a blind address is not attempted here).
set -euo pipefail
# U192: the work runs in TypeScript (bin/commands/send-role-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" DS_SCRIPT="$0" "$ROOT/bin/ds" send-role-ts "$@"
