#!/usr/bin/env bash
# Codex's bundled model catalog as one picker entry per line (a list of choices, not an access check).
set -euo pipefail
# U272: the work runs in TypeScript (bin/commands/codex-models-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DS_ROOT="$ROOT" exec "$ROOT/bin/ds" codex-models-ts "$@"
