#!/usr/bin/env bash
# codex-skills.sh — wire installed CE skills and the ds skill into Codex's shared user skill directory.
set -euo pipefail
# U191: the work runs in TypeScript (bin/commands/codex-skills-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" codex-skills-ts "$@"
