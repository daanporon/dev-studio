#!/usr/bin/env bash
# The agent calls this only after all its local commands finish. Journal first, acknowledge second.
set -euo pipefail
# U192: the work runs in TypeScript (bin/commands/pause-checkpoint-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" DS_SCRIPT="$0" "$ROOT/bin/ds" pause-checkpoint-ts "$@"
