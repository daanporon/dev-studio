#!/usr/bin/env bash
# reclaim.sh <project> [--topic <topic>] | --all — free leaked long-poll slots.
set -euo pipefail
# U191: the work runs in TypeScript (bin/commands/reclaim-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" reclaim-ts "$@"
