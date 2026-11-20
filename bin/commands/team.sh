#!/usr/bin/env bash
# team.sh — print one squad's roster (or every squad's) so you can see WHO owns each role
# and WHICH live worktree is which, and ACT on a role's live terminal (switch / reap).
# For the Lead (its own squad) or the Studio (all squads).
#
#   team.sh <project> [--topic <slug>]                 # print the roster
#   team.sh <project> --topic <slug> --switch <label>  # jump to that role's live terminal
#   team.sh <project> [--topic <slug>] --reap          # close each worktree's stale terminals, keep the owner
#
#     <label>  a roster row's name: role or role-suffix (e.g. "thinker-structures").
#
# Joins the roster (members[] in the state file) with the backend's generic worker-states
# (<wt>\t<state>\t<displayName>) and the phone book's live terminal tokens per member
# (directory.sh list --json). Stays backend-agnostic: the token is opaque — on Orca it's
# the live terminal handle, which the backend's terminal-switch/terminal-close act on; a
# backend without the concept shows no column and offers no switch/reap. A member whose
# worktree is absent shows GONE.
set -euo pipefail
# U222: the work runs in TypeScript (bin/commands/team-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" team-ts "$@"
