#!/usr/bin/env bash
# journal.sh — a standing agent's journal: what it decided and what it must never forget.
#
#   journal.sh <project> <topic|studio> <role[-suffix]> add <decision|keep> "<text>" "<why>"
#   journal.sh <project> <topic|studio> <role[-suffix]> briefing   every keep + the latest 30 decisions
#   journal.sh <project> <topic|studio> <role[-suffix]> path
#
# File: state/<label>/journals/<topic>-<role>[-<suffix>].md (the Studio: journals/studio.md).
# A Builder passes builder-<unit-slug>, so its journal is per UNIT and outlives its worktree.
# One entry per line: `- <ISO time> [decision|keep] <text> — <why>`.
set -euo pipefail
# U222: the work runs in TypeScript (bin/commands/journal-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" journal-ts "$@"
