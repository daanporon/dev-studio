#!/usr/bin/env bash
# typecheck.sh — `tsc --noEmit` over bin/loop, bin/commands and bin/board (U43), as a ratchet: the errors
# the tree already had are listed in tests/typecheck-baseline.txt (file + message, line numbers dropped);
# a new error fails, and so does a fixed one still listed (shrink the baseline: `typecheck.sh --update`).
# A fixture with a deliberate wrong payload (tests/typecheck-fixture/) must fail the same check.
# Needs node_modules (typescript, @types/bun): `bun install` makes them from package.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
bun="$(command -v bun 2>/dev/null || true)"
[ -n "$bun" ] || [ ! -x "$HOME/.bun/bin/bun" ] || bun="$HOME/.bun/bin/bun"
[ -n "$bun" ] || { echo "typecheck.sh needs bun" >&2; exit 1; }
[ -x node_modules/.bin/tsc ] || "$bun" install --frozen-lockfile >/dev/null 2>&1 || "$bun" install >/dev/null
tsc=node_modules/.bin/tsc
norm() { grep 'error TS' | sed -E 's/\([0-9,]+\)//' | cut -c1-160 | LC_ALL=C sort; }
now="$("$tsc" -p . 2>&1 | norm || true)"
if [ "${1:-}" = --update ]; then printf '%s\n' "$now" | grep . > tests/typecheck-baseline.txt || : > tests/typecheck-baseline.txt; echo "typecheck: baseline updated"; exit 0; fi
base="$(cat tests/typecheck-baseline.txt)"
rc=0
new="$(LC_ALL=C comm -13 <(printf '%s\n' "$base") <(printf '%s\n' "$now") | grep . || true)"
gone="$(LC_ALL=C comm -23 <(printf '%s\n' "$base") <(printf '%s\n' "$now") | grep . || true)"
[ -z "$new" ] || { echo "FAIL typecheck: new type errors:"; echo "$new"; rc=1; }
[ -z "$gone" ] || { echo "FAIL typecheck: fixed errors still in the baseline (typecheck.sh --update):"; echo "$gone"; rc=1; }
# the fixture: tsc must reject a wrong payload and an unknown kind
cfg="$ROOT/tsconfig.fixture.$$.json"; trap 'rm -f "$cfg"' EXIT
printf '{"extends":"./tsconfig.json","include":[],"files":["tests/typecheck-fixture/bad-payload.ts"]}\n' > "$cfg"
fx="$("$tsc" -p "$cfg" 2>&1 | grep -E '^tests/typecheck-fixture/bad-payload.ts' || true)"
[ "$(printf '%s\n' "$fx" | grep -c 'error TS')" -ge 2 ] || { echo "FAIL typecheck: the deliberate wrong payload in tests/typecheck-fixture was not rejected:"; echo "$fx"; rc=1; }
[ "$rc" = 0 ] && echo "typecheck: ok ($(printf '%s\n' "$base" | grep -c .) known errors, fixture rejected)"
exit "$rc"
