#!/usr/bin/env bash
# wrap-hooks.sh — undo the old settings.json gate of the lavish-axi, gh-axi and chrome-devtools-axi SessionStart hooks (U235).
set -euo pipefail
# U272: the work runs in TypeScript (bin/commands/wrap-hooks-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
DS_ROOT="$ROOT" exec "$ROOT/bin/ds" wrap-hooks-ts "$@"
