#!/usr/bin/env bash
# reassert-roles.sh <project> — (re)write the CLAUDE.local.md role brief into EVERY standing
# worktree for a project: the Studio and each squad's recorded members
# (Lead, Thinker, Builders, …). Each role worktree lives inside the project repo, so a
# session that turned over reverts to the repo's own CLAUDE.md and forgets it is a dev-studio
# agent; this pins the role so any session (fresh, resumed, woken) reads the right files.
#
# Run it after a dev-studio update, or to RECOVER a system whose agents "lost their roles".
# It only writes files — the running agents pick it up on their next read, so also poke /
# restart each one (or it takes effect when its session next starts).
set -euo pipefail
# U193: the work runs in TypeScript (bin/commands/reassert-roles-ts.ts); this path stays because worktree settings name it.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" reassert-roles-ts "$@"
