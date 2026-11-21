#!/usr/bin/env bash
# fixture-board.sh <port> — serves the tests/lib/board-setup.sh fixture board on 127.0.0.1:<port> until it is killed.
# Used by board-phone.ts; never touches the live state (temp DS_STATE_ROOT).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASH_ARGV0="$ROOT/tests/fixture-board.sh"   # board-setup.sh finds ROOT from $0 (it expects a script in tests/)
# shellcheck source=tests/lib/state-root.sh
. "$ROOT/tests/lib/state-root.sh"
# shellcheck source=tests/lib/board-setup.sh
. "$ROOT/tests/lib/board-setup.sh"
mkdb "$LBL"
DS_STATE_ROOT="$DBR" DS_BIND=127.0.0.1 BACKEND="$TMP/fakeb" "$ROOT/bin/board/board.sh" "$LBL" --serve-fg "$1" &
pid=$!
trap 'kill "$pid" 2>/dev/null; rm -rf "$DS_STATE_ROOT/$LBL" "$TMP" "${DS_STATE_PARENT:-}"' EXIT TERM INT
wait "$pid"
