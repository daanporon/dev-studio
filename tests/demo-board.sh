#!/usr/bin/env bash
# demo-board.sh — scripts/demo-board.sh still builds today's board from fake data: every section the
# live board shows has rows, and the run leaves the live state and a running board alone.
#   DEMO_DROP=<seed key> tests/demo-board.sh   the demo script drops that key from its seed (shows the check failing)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib.sh"
. "$ROOT/tests/lib/state-root.sh"        # a temp DS_STATE_ROOT the demo must not touch
TMP="$(mktemp -d -p "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}")"
state_root_on_exit 'rm -rf "$TMP" "$DS_STATE_PARENT"; stop_own "${SPID:-}"'
pass=0; fail=0
ok() { if jq -e "$2" "$TMP/board.json" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2]" >&2; fi; }

# A sentinel standing in for a live board and its state: both must be the same after the run.
mkdir -p "$DS_STATE_ROOT/live-sentinel"; echo before > "$DS_STATE_ROOT/live-sentinel/x"
sleep 300 & SPID=$!
before="$(find "$DS_STATE_ROOT" -type f | sort | xargs cksum)"

SCRIPT="$ROOT/scripts/demo-board.sh"
"$SCRIPT" --json > "$TMP/board.json" 2> "$TMP/err" || { cat "$TMP/err" >&2; echo "FAIL: demo-board --json exited non-zero"; exit 1; }
"$SCRIPT" --events > "$TMP/events.json" 2>> "$TMP/err" || true
# The loop must not read as down once its threshold has passed (3 s at this tick): the demo's refresher keeps it live.
DS_LOOP_TICK_S=0.25 DEMO_REFRESH_S=1 DEMO_WAIT_S=5 "$SCRIPT" --json > "$TMP/waited.json" 2>> "$TMP/err" || true

ok "header tiles"        '.header.needs >= 1 and .header.squads_active >= 1 and .header.prs_open >= 1'
ok "needs you: a blocking question" '.header.blocking >= 1 and (.needs_you | length) >= 1'
ok "needs you: a done squad"        '[.squads[] | select(.status == "done")] | length >= 1'
ok "squads: three, one with a pipeline" '(.squads | length) >= 3 and ([.squads[] | select((.units | length) >= 10)] | length >= 1)'
ok "flow: cards, merges, stage times" '(.flow.cards | length) > 0 and (.flow.merged | length) > 0 and (.flow.typical_s | length) > 0 and ([.flow.per_day[].merged] | add) > 0'
ok "accounts"            '(.accounts | length) >= 2'
ok "machine"             '(.machine.cores // 0) > 0 and (.machine.mem | length) > 0'
ok "briefs"              '(.briefings | length) >= 1'
ok "briefs: the schedule is on, so the section shows" '.briefing_schedule.on == true'
if jq -e 'length >= 5' "$TMP/events.json" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: event log has fewer than 5 rows" >&2; fi

# The event log: rows in loop.db are in time order (the log reads newest first by id), each with real text.
if jq -e '[.[].id] == ([.[].id] | sort) and ([.[].at] == ([.[].at] | sort))' "$TMP/events.json" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: event rows are not in time order" >&2; fi
if jq -e 'all(.[]; (.payload.n // "") != .kind)' "$TMP/events.json" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: an event's text is a bare placeholder (n <kind>)" >&2; fi
if jq -e '.loop.down == false' "$TMP/waited.json" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: the board reads the loop as down after its threshold" >&2; fi

# Nothing real in the output (the picture's data comes from the same seed).
real="da""an|po""ron|gm""ail|da""lp|tail""3fdd95|100\\.84\\."   # split so this file holds none of them
if grep -qiE "$real" "$TMP/board.json" "$TMP/events.json"; then fail=$((fail+1)); echo "  FAIL: a real name or address in the demo output" >&2; else pass=$((pass+1)); fi
# The live state and the running board are as they were.
after="$(find "$DS_STATE_ROOT" -type f | sort | xargs cksum)"
if [ "$before" = "$after" ] && kill -0 "$SPID" 2>/dev/null; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: the live state or the running board changed" >&2; fi
echo "demo-board: $pass passed, $fail failed"
[ "$fail" = 0 ]
