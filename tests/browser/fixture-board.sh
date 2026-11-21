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
# Events for the event-log view: the seed is JSON, so add a few rows (one long sentence) before the db is made.
python3 - "$SEED" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["events"] = [{"ago": 60 * i, "squad": "manual-testing", "kind": k} for i, k in enumerate(["unit_dispatched", "pr_opened", "merge_waiting_on_a_long_named_reconciler_check", "member_started"])]
json.dump(d, open(sys.argv[1], "w"))
PY
mkdb "$LBL"
DS_STATE_ROOT="$DBR" DS_BIND=127.0.0.1 BACKEND="$TMP/fakeb" "$ROOT/bin/board/board.sh" "$LBL" --serve-fg "$1" &
pid=$!
trap 'kill "$pid" 2>/dev/null; rm -rf "$DS_STATE_ROOT/$LBL" "$TMP" "${DS_STATE_PARENT:-}"' EXIT TERM INT
wait "$pid"
