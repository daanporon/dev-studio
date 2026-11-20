#!/usr/bin/env bash
# orch.sh — the agent-facing entry point to the backend: roles call it instead of `orca` (worker-protocol ops only).
set -euo pipefail
# U272: the work runs in TypeScript (bin/commands/orch-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DS_ROOT="$ROOT" exec "$ROOT/bin/ds" orch-ts "$@"
