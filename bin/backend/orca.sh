#!/usr/bin/env bash
# Orca backend adapter — the ONLY file that invokes `orca` directly (KTD9).
# Implements the backend interface (conventions/backend.md). Callers use $BACKEND
# and never call `orca` themselves, so another backend is a sibling adapter.
#
# Every verb lives in bin/backend/orca.ts (U223-U226); this file only hands it the call:
# `ds backend <verb>` prints what the shell arms printed, with the same exit codes. An unknown verb
# prints `orca adapter: unknown op '<verb>'` and exits 2.
#
# Entities always live under `.result`; the envelope's top-level `.id` is a
# *request* UUID, never the entity id.
set -euo pipefail
op="${1:-}"
[ "$#" -gt 0 ] && shift
DS_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# export, not `env`: install.sh's preflight runs on a PATH of only the tools it needs. No transpiler
# cache: a backend verb must not write into HOME (install.sh --check changes nothing).
export DS_ROOT="$DS_HOME" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
exec "$DS_HOME/bin/ds" backend "$op" "$@"
