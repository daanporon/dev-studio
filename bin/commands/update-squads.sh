#!/usr/bin/env bash
# update-squads.sh <project> [--auto] — bring every squad of a project to the LATEST dev-studio: rewrite the role briefs and write a restart-once-idle wish on every member (--auto: only the wishes the new commits need).
set -euo pipefail
# U191: the work runs in TypeScript (bin/commands/update-squads-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" update-squads-ts "$@"
