#!/usr/bin/env bash
# arm-picker.sh <worktree_id> <state> <role> — install the picker-mirror hooks into a squad
# role's worktree, so a terminal AskUserQuestion picker also lands on the board (and clears
# when answered there). Writes <worktree>/.claude/settings.local.json (MERGING into any
# existing settings, idempotent): a PreToolUse + PostToolUse pair with matcher AskUserQuestion
# each (timeout 15), and a PermissionRequest entry (matcher *, timeout 15) for safety-check
# prompts. Only its own entries are replaced — the rewake Stop hook and any
# other hooks stay untouched. Needs the worktree's local filesystem path (from ps); a
# remote-host worktree can't be armed from here (prints a notice, exits 0); a side host arms its own
# members' worktrees when it makes their terminals (bin/link/channels/contract.ts sideArm).
#
# <role> is the member's role[-suffix] label (the asker on the mirrored entry, so a mirrored
# picker clears watch.sh's "unasked" flag). Armed by the spawner (spawn-squad, add-role,
# suspend-squad --resume, reassert-roles) — never by the agent itself. Never for the Studio.
set -euo pipefail
# U193: the work runs in TypeScript (bin/commands/arm-picker-ts.ts); this path stays because worktree settings name it.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" arm-picker-ts "$@"
