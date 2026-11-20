#!/usr/bin/env bash
# update-host.sh — bring the host's dev-studio checkout to the head of its branch, reinstall, restart a running loop when the commit moved.
set -euo pipefail
# U191: the work runs in TypeScript (bin/commands/update-host-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" update-host-ts "$@"
