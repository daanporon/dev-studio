#!/usr/bin/env bash
# lane-rules.sh — a project's shared lane rules (light-lane plan U5), one per line in state/<label>/lanes.md:
#   - <id>: light|normal — <when it applies> — <evidence>
#
#   lane-rules.sh <project> [print]
#   lane-rules.sh <project> add <id> light|normal "<when it applies>" "<evidence>"
#   lane-rules.sh <project> drop <id>
#   lane-rules.sh <project> path
#
# A Thinker names a rule on a plan line (`Lane: light (rule: <id>)`); `ds lanes <project>` shows each
# rule's units, misses and median CPU-hours. The file is host-local, created on the first add.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" lane-rules-ts "$@"
