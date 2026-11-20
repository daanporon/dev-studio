#!/usr/bin/env bash
# set-orca-depth.sh [<n>=5] [--auto [--yes]] — set Orca's "Nested worker depth" to >= n safely.
set -euo pipefail
# U272: the work runs in TypeScript (bin/commands/set-orca-depth-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
DS_ROOT="$ROOT" exec "$ROOT/bin/ds" set-orca-depth-ts "$@"
