#!/usr/bin/env bash
# state-root-trap.sh — a test that sources tests/lib/state-root.sh adds cleanup with state_root_on_exit,
# never a bare `trap … EXIT` (that replaces the state folder's own trap and leaks /tmp/dsstate.*).
# Usage: tests/state-root-trap.sh [dir]   (dir: where to look for tests/*.sh, default this checkout)
set -uo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
bad=0
for f in "$ROOT"/tests/*.sh; do
  # a real sourcing line: `. …/state-root.sh` or `source …`, at the start or after `||`/`&&`/`;`
  grep -qE '(^|\|\||&&|;)[[:space:]]*(\.|source)[[:space:]]+[^#]*lib/state-root\.sh' "$f" || continue
  [ "$(basename "$f")" = state-root-trap.sh ] && continue
  while IFS= read -r l; do
    echo "FAIL: $(basename "$f"): bare EXIT trap after sourcing state-root.sh: $l" >&2; bad=$((bad+1))
  done < <(grep -nE "^[^#]*\btrap\b[^#]*\bEXIT\b" "$f")
done
[ "$bad" -eq 0 ] && echo "state-root-trap: ok" || exit 1
