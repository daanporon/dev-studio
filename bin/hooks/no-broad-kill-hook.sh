#!/usr/bin/env bash
# no-broad-kill-hook.sh — Claude PreToolUse guard (matcher Bash): block host-wide
# process kills from a role terminal. Every squad's Builders share the host, so a
# `pkill -f <name>` from one Builder kills other squads' work (U195). Blocked:
# `pkill`, `killall`, and `kill` fed by `pgrep`/`pidof` (including `kill $(…)` and
# `pgrep … | xargs kill`). Allowed: `kill <pid>`, `kill %job`, `kill -l`, plain
# `ps`/`grep`/`echo` (even mentioning pkill), and anything where pkill only appears
# inside a quoted string. The reason names the safe replacement: `ds stop-mine`.
#
# Reads the Claude hook JSON from stdin, exits 2 with the reason on stderr to block,
# exits 0 (silent) to allow — and always exits 0 when the input is not a Bash
# command it understands, so a hook failure never blocks legitimate work.
# Installed per role worktree by bin/hooks/arm-picker.sh; see conventions/wake.md.
set -euo pipefail
# U193: the work runs in TypeScript (bin/commands/no-broad-kill-hook-ts.ts); this path stays because worktree settings name it.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" no-broad-kill-hook-ts "$@"
