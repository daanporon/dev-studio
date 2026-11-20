#!/usr/bin/env bash
# restart-squads.sh — restart the roles of one or all squads in a project, IN PLACE.
set -euo pipefail
# U191: the work runs in TypeScript (bin/commands/restart-squads-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" restart-squads-ts "$@"
