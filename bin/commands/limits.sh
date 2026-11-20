#!/usr/bin/env bash
# limits.sh — view and configure the limits (thresholds) in conventions/limits.conf.
#
#   limits.sh show [--json] [<project>]            every key, its value, and where it comes from
#   limits.sh set  <project> <key> <value>         override a key for the project
#   limits.sh rm   <project> <key>                 drop the override (back to the default)
#
# The repo default is conventions/limits.conf. A per-project override is the project's
# limits.conf row in state/loop.db (U256, written by bin/loop/settings/settings.ts). An env var
# (DS_LIMIT_<KEY>, or the historical name) beats both; `show` marks it `env`.
set -euo pipefail
# U263: the work runs in TypeScript (bin/commands/limits-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" limits-ts "$@"
