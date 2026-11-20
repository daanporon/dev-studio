#!/usr/bin/env bash
# watch.sh — one coordination tick, backend-agnostic. Three shapes:
#
#   watch.sh <project> <topic> [timeout_ms] [--ack <id>]   Lead: squad Run + team + work items
#   watch.sh --worktree [ms] [--ack <id>]                  a worker's OWN inbox only (no team,
#                                                           no <project> <topic> — it uses the
#                                                           caller's own worktree inbox)
#   watch.sh --run <run_id> [ms] [--ack <id>]              any specific Run (no team)
#   watch.sh --worktree --requests <label> …               the Studio: also its restart requests
#   add --all to any shape to re-read the whole inbox (already-consumed messages too; no ACK-ID).
#   add --full (Lead) to list every worker and unit; in a squad the loop runs the TEAM and WORK
#   ITEMS block otherwise lists only what changed since the last tick, plus one count line.
#
# Blocks until a message arrives on the watched inbox OR the timeout elapses, then
# prints (a) any messages + an ACK-ID to pass back next tick, and — in Lead mode —
# (b) a team check-in (each recorded worker's state, GONE if its worktree vanished)
# and (c) WORK ITEMS derived from the squad's units[] (planned-not-dispatched and
# dispatched-but-GONE are the dropped-handoff failures surfaced). The Lead tick also
# touches a beat file so the board can tell a live Lead from a silent one.
#
# All backend access is through $BACKEND, so the roles never call `orca` directly.
set -euo pipefail
# U260: the work runs in TypeScript (bin/commands/watch-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" DS_SCRIPT="$0" "$ROOT/bin/ds" watch-ts "$@"
