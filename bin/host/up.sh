#!/usr/bin/env bash
# up.sh — bring up (or reconcile) a per-project Studio instance.
set -euo pipefail
# U191: the work runs in TypeScript (bin/commands/up-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" up-ts "$@"
