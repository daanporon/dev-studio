#!/usr/bin/env bash
# hook-tree.sh — sourced at the top of a hook test: the hooks are one-line execs into their TypeScript
# port (bin/ds <name>-ts, U193), so a test that copies a hook into its own tree <dir> links the port's
# entry (bin/ds, bin/ds.ts) into it; the port reads <dir> as its root (DS_ROOT).
# The test's `mktemp -d` under $XDG_RUNTIME_DIR (as tests/lib/review-unit-prelude.sh): bun lists its
# working directory's parents at start, a second under a crowded /tmp — slower than the hook's own
# timing checks (one hook replacing the previous within a second) allow.
if [ -d "${XDG_RUNTIME_DIR:-}" ] && [ -w "$XDG_RUNTIME_DIR" ]; then export TMPDIR="$XDG_RUNTIME_DIR"; fi

# hook_tree <dir> — give <dir>/bin the port's entry (bin/ds, bin/ds.ts, which find bin/commands/ in
# this checkout).
hook_tree() {
  local src
  src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  mkdir -p "$1/bin/hooks"
  ln -sf "$src/bin/ds" "$1/bin/ds"
  ln -sf "$src/bin/ds.ts" "$1/bin/ds.ts"
}
