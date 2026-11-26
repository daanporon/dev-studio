#!/usr/bin/env bash
# install-skills.sh [--muse-only|--codex-only] [--check] [--verbose] — install or check the role skills the
# squad agents invoke, on THIS host, for every Claude account in the accounts table (bin/commands/install-skills-ts.ts).
# shellcheck disable=SC2097,SC2098 # DS_INSTALL_TCACHE reads the caller's value on purpose
DS_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)" DS_INSTALL_TCACHE="${BUN_RUNTIME_TRANSPILER_CACHE_PATH-@unset}" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 exec "$(dirname "$0")/../../bin/ds" install-skills-ts "$@"
