#!/usr/bin/env bash
# loop.sh — the loop's Bun tests: `bun test tests/loop/` (store, import/export, ds CLI). Each test
# copies its fixture to a temp state root; nothing touches state/ or a live loop.
#
# `loop.sh --shard K/N [bun test args]` runs the K-th of N slices (K from 1) of the test files: files
# sorted largest first and dealt out round-robin, so a file's slice is the same on every run and the big
# files land in different slices. ci.sh runs one shard per CI job. No --shard runs the whole suite.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# ~/.bun/bin is where bun's installer puts it; a shell that didn't load the profile misses it.
bun="$(command -v bun 2>/dev/null || true)"
[ -n "$bun" ] || [ ! -x "$HOME/.bun/bin/bun" ] || bun="$HOME/.bun/bin/bun"
[ -n "$bun" ] || { echo "loop.sh needs bun — install it once: curl -fsSL https://bun.sh/install | bash" >&2; exit 1; }
cd "$ROOT"
# DS_LOOP_JUNIT=<file>: also write a JUnit report there (ci.sh reads each test's time from it).
args=()
[ -z "${DS_LOOP_JUNIT:-}" ] || args=(--reporter=junit "--reporter-outfile=$DS_LOOP_JUNIT")
if [ "${1:-}" = --shard ]; then
  case "${2:-}" in
    [1-9]*/[1-9]*) k="${2%/*}" n="${2#*/}" ;;
    *) echo "loop.sh: --shard wants K/N, like 2/4" >&2; exit 2 ;;
  esac
  case "$k$n" in *[!0-9]*) echo "loop.sh: --shard wants K/N, like 2/4" >&2; exit 2 ;; esac
  [ "$k" -le "$n" ] || { echo "loop.sh: --shard $2: K is past N" >&2; exit 2; }
  shift 2
  files=()
  i=0
  # Size order, ties by name: `ls -S` is not stable across locales, so sort the byte counts ourselves.
  while IFS= read -r f; do
    i=$((i + 1))
    [ $(((i - 1) % n + 1)) = "$k" ] && files+=("$f")
  done < <(for f in tests/loop/*.test.ts; do printf '%s %s\n' "$(wc -c < "$f")" "$f"; done | LC_ALL=C sort -k1,1nr -k2,2 | cut -d' ' -f2)
  [ "${#files[@]}" -gt 0 ] || { echo "loop.sh: shard $k/$n has no files" >&2; exit 0; }
  exec "$bun" test "${files[@]}" "${args[@]}" "$@"
fi
exec "$bun" test tests/loop/ "${args[@]}" "$@"
