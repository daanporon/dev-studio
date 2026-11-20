#!/usr/bin/env bash
# squad-state.sh — read/write a single squad's state: the Bun port in bin/loop/squad/squad-state.ts (U13a).
# Usage and every subcommand: `squad-state.sh` with no args, or conventions/state.md.
# ~/.bun/bin is where bun's installer puts it; a hook's or cron's PATH misses it.
bun="$(command -v bun 2>/dev/null || true)"
[ -n "$bun" ] || [ ! -x "$HOME/.bun/bin/bun" ] || bun="$HOME/.bun/bin/bun"
exec "${bun:-bun}" "$(dirname "$0")/../loop/squad/squad-state.ts" "$@"
