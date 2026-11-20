#!/usr/bin/env bash
# install.sh — make the /ds-* slash commands available in EVERY worktree, and keep them in sync
# with this checkout: preflight (git, jq, claude, bun, a reachable Orca runtime), point
# ~/.dev-studio at this checkout, symlink the ds-*.md commands (pruning deleted links), import
# state once and install the loop plus its watchdog, optionally install the role skills.
# Idempotent: re-run after a pull that adds or removes a command, or after moving the checkout.
#
#   bin/host/install.sh                  # into ~/.claude/commands/
#   bin/host/install.sh <dir>            # into <dir>
#   bin/host/install.sh --check          # preflight only: verify everything, change nothing
#   bin/host/install.sh --unwrap-hooks   # unwrap any settings.json an older install gated
#   bin/host/install.sh --skills         # also install the role skills
#
# This file only finds bun; the install itself is `ds install-ts` (bin/commands/install-ts.ts).
set -euo pipefail

# `pwd -P`: the PHYSICAL checkout. Run via the ~/.dev-studio symlink, a logical `pwd` is the link
# itself, and pointing ~/.dev-studio at it would make it point at itself.
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"

bun="$(command -v bun 2>/dev/null || true)"
[ -n "$bun" ] || [ ! -x "$HOME/.bun/bin/bun" ] || bun="$HOME/.bun/bin/bun"
if [ -z "$bun" ]; then
  echo "install: 'bun' not found on PATH or in ~/.bun/bin — the loop and the board run on it. Install it once" >&2
  echo "  (curl -fsSL https://bun.sh/install | bash, which puts it in ~/.bun/bin), then re-run" >&2
  exit 1
fi
# No `env`: a bare assignment before exec passes the variables and needs no other binary. Bun's
# transpiler cache stays off so --check writes nothing under $HOME; the caller's value is restored for
# every child (bin/lib/install.ts, restoreBunEnv).
# shellcheck disable=SC2097,SC2098 # DS_INSTALL_TCACHE reads the caller's value on purpose
DS_ROOT="$ROOT" DS_INSTALL_BUN="$bun" DS_INSTALL_TCACHE="${BUN_RUNTIME_TRANSPILER_CACHE_PATH-@unset}" \
  BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 exec "$bun" "$ROOT/bin/ds.ts" install-ts "$@"
