#!/usr/bin/env bash
# Guard: tests must never pkill/killall (a pattern kill hits the live boards), and every `kill`
# must name a PID/group variable. Stop processes with stop_own (tests/lib.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/tests"
bad="$(grep -nE '(^|[^[:alnum:]_-])(pkill|killall)([^[:alnum:]_-]|$)' *.sh | grep -v '^no-broad-kill.sh:' | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)"
# a `kill` whose next non-option word is not a $variable / "$(…)" / "-$pid"
bad2="$(grep -nE '(^|[;&|(]|then|do)[[:space:]]*kill( |$)' *.sh | grep -v '^no-broad-kill.sh:' | grep -vE 'kill( +-[A-Za-z0-9]+)*( +--)? +"?-?(\$|`)' || true)"
if [ -n "$bad$bad2" ]; then
  echo "FAIL: broad kill in tests (use stop_own <pid> from tests/lib.sh):"; printf '%s\n%s\n' "$bad" "$bad2" | sed '/^$/d'; exit 1
fi
echo "ok: no pkill/killall/bare kill in tests"
