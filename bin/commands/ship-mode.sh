#!/usr/bin/env bash
# ship-mode.sh <project> [<mode>] — view or set a project's ship mode (conventions/ship-modes.md).
#   no <mode>     -> print the project's current mode and where it comes from.
#   <mode>        -> set it. Writes the operator override, the project's ship-mode row in
#                    state/loop.db (U256), so it SURVIVES `git reset --hard` / a dev-studio update.
#   default | -   -> clear the override (fall back to conventions/projects.conf / the default).
# Applies to each squad's NEXT ship (the Builder reads the mode at ship time) — no restart
# needed, though a running squad should re-read via /ds-reload to pick up any brief changes.
set -euo pipefail
# U263: the work runs in TypeScript (bin/commands/ship-mode-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" ship-mode-ts "$@"
