#!/usr/bin/env bash
# Contract backend adapter — the role-side verbs of a squad off Orca (orca-backend-alternatives U11b;
# conventions/backend.md, "Role scripts off Orca"). backendPath() (bin/lib/shared.ts) picks it for a
# process that runs in such a squad (DS_BACKEND, else DS_MEMBER's squad row in loop.db), so a role's
# `$BACKEND <verb>` reaches the squad's own backend through the contract and loop.db, never Orca.
#
# Every verb lives in bin/commands/contract-backend.ts; a verb with no meaning off Orca prints
# `contract adapter: no '<verb>' off Orca` and exits 2.
set -euo pipefail
op="${1:-}"
[ "$#" -gt 0 ] && shift
DS_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export DS_ROOT="$DS_HOME" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
exec "$DS_HOME/bin/ds" contract-backend "$op" "$@"
