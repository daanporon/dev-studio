#!/usr/bin/env bash
# send-peer.sh — cross-squad delivery resolves through directory.sh (the phone book):
# a Thinker goes by worktree-in-run (send-run-worker), a Lead by its Run inbox
# (send); anything else is exit 2 without a send. Every send logs one line to
# cross-squad.md; --ruling also journals both Leads. A blind phone book is attempted
# anyway (the receipt judges). Stub $BACKEND, temp label; never touches ~/.dev-studio.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
LBL="zzpeer_$$"; SD="$DS_STATE_ROOT/$LBL"
TMP="$(mktemp -d)"
state_root_on_exit 'rm -rf "$SD" "$TMP"'
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3" >&2; fi; }
loglines() { if [ -f "$SD/cross-squad.md" ]; then wc -l < "$SD/cross-squad.md" | tr -d ' '; else echo 0; fi; }

mkdir -p "$SD/squads"
printf '{"run_id":"run_a","status":"running","members":[{"role":"lead","suffix":"","wt":"wtAL"},{"role":"thinker","suffix":"","wt":"wtAT"}]}' > "$SD/squads/a.json"
printf '{"run_id":"run_b","status":"running","members":[{"role":"lead","suffix":"","wt":"wtBL"},{"role":"thinker","suffix":"","wt":"wtBT"},{"role":"builder","suffix":"u1","wt":"wtBU"}]}' > "$SD/squads/b.json"
printf '{"run_id":"run_c","status":"closed","members":[{"role":"thinker","suffix":"","wt":"wtCT"}]}' > "$SD/squads/c.json"

cat > "$TMP/fakeb" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_LOG"
case "$1" in
  current) echo "${FAKE_CURRENT:-}" ;;
  run-workers)
    # Every dispatch completed (the F1 bug shape) — delivery must not consult this op.
    printf 'wtX\tno\t-\n' ;;
  wt-terminals)
    [ "${FAKE_BLIND:-0}" = 1 ] && exit 2
    for w in wtAL wtAT wtBT; do [ "$w" = "${FAKE_NO_TERM:-}" ] || printf '%s\n' "$w"; done ;;
  send) : ;;   # the real op prints no receipt
  send-run-worker)
    if [ "${FAKE_SEND_RC:-0}" != 0 ]; then echo "fake backend: NOT delivered — filed under 'run:run_b' instead of its terminal" >&2; exit "$FAKE_SEND_RC"; fi
    echo "send-run-worker: delivered to term_bt (msg_42)" ;;
  *) exit 2 ;;
esac
FAKE
chmod +x "$TMP/fakeb"
export STUB_LOG="$TMP/stub.log"; : > "$STUB_LOG"
SP() { BACKEND="$TMP/fakeb" "$ROOT/bin/role/send-peer.sh" "$@"; }

# 1. a Thinker target goes by worktree in run, the subject prefixed with the sender —
# even though every dispatch shows completed (run-workers all-no is never consulted).
: > "$STUB_LOG"
out="$(SP b thinker "need api" "what field?" --project "$LBL" --from a/thinker 2>"$TMP/err")"; rc=$?
check "thinker send exits 0" "0" "$rc"
check "thinker target -> one send-run-worker run_b wtBT" "1" "$(grep -c '^send-run-worker run_b wtBT ' "$STUB_LOG")"
check "run-workers never consulted (completed-only dispatches still reachable)" "0" "$(grep -c '^run-workers' "$STUB_LOG")"
check "subject prefixed peer:from" "1" "$(grep -cF 'peer:a/thinker need api' "$STUB_LOG")"
check "one line in cross-squad.md" "1" "$(loglines)"
check "log line names from, to, subject, msg" "1" "$(grep -c -- 'a/thinker → b/thinker \[need api\] msg_42' "$SD/cross-squad.md")"
check "receipt" "1" "$(printf '%s' "$out" | grep -cF 'send-peer: a/thinker → b/thinker delivered (send-run-worker: delivered to term_bt (msg_42)) — logged in cross-squad.md')"
check "a plain send journals nothing" "no" "$([ -d "$SD/journals" ] && echo yes || echo no)"

# 2. a Lead target goes to its Run inbox (send prints no receipt of its own).
: > "$STUB_LOG"
out="$(SP b lead "order?" "who merges first" --project "$LBL" --from a/thinker 2>/dev/null)"; rc=$?
check "lead send exits 0" "0" "$rc"
check "lead target -> one send run_b" "1" "$(grep -c '^send run_b ' "$STUB_LOG")"
check "lead send uses no send-run-worker" "0" "$(grep -c '^send-run-worker' "$STUB_LOG")"
check "run-kind receipt falls back to the run id" "1" "$(printf '%s' "$out" | grep -cF 'delivered (run:run_b)')"
check "run-kind log line carries - for the msg id" "1" "$(tail -n1 "$SD/cross-squad.md" | grep -c -- '\[order?\] -$')"

# 3. unknown squad -> exit 2, no send, no log line.
n_before="$(loglines)"
: > "$STUB_LOG"
SP nope thinker s b --project "$LBL" --from a/thinker >/dev/null 2>&1; rc=$?
check "unknown squad -> exit 2" "2" "$rc"
check "unknown squad -> no send call" "0" "$(grep -c '^send' "$STUB_LOG")"
check "unknown squad -> no log line" "$n_before" "$(loglines)"

# 4. the backend rejecting a misfiled receipt (run:* to_handle -> exit 3) passes through,
# logs nothing, names the Studio route.
: > "$STUB_LOG"
out="$(FAKE_SEND_RC=3 SP b thinker s b --project "$LBL" --from a/thinker 2>&1)"; rc=$?
check "backend 3 -> exit 3" "3" "$rc"
check "backend 3 -> no log line" "$n_before" "$(loglines)"
check "exit 3 surfaces the run:* misfile" "1" "$(printf '%s' "$out" | grep -c "filed under 'run:run_b'")"
check "exit 3 names the Studio route" "1" "$(printf '%s' "$out" | grep -c 'raises it to the Studio')"

# 4b. a peer worktree with no live terminal is exit 3 with no send and no log line.
n_before="$(loglines)"
: > "$STUB_LOG"
out="$(FAKE_NO_TERM=wtBT SP b thinker s b --project "$LBL" --from a/thinker 2>&1)"; rc=$?
check "no-terminal peer -> exit 3" "3" "$rc"
check "no-terminal peer says no live terminal" "1" "$(printf '%s' "$out" | grep -c 'no live terminal')"
check "no-terminal peer -> no send call" "0" "$(grep -c '^send-run-worker' "$STUB_LOG")"
check "no-terminal peer -> no log line" "$n_before" "$(loglines)"

# 4c. a blind phone book (exit 4) is attempted anyway — the receipt judges.
n_before="$(loglines)"
: > "$STUB_LOG"
out="$(FAKE_BLIND=1 SP b thinker s b --project "$LBL" --from a/thinker 2>&1)"; rc=$?
check "blind phone book -> still exits 0" "0" "$rc"
check "blind phone book says trying anyway" "1" "$(printf '%s' "$out" | grep -c 'trying anyway; the receipt judges')"
check "blind phone book -> one send-run-worker" "1" "$(grep -c '^send-run-worker run_b wtBT ' "$STUB_LOG")"
check "blind send logs its line" "$((n_before + 1))" "$(loglines)"

# 5. --ruling puts the body on the log line and into both Leads' journals.
: > "$STUB_LOG"
SP b thinker "api shape" "use field X" --project "$LBL" --from a/thinker --ruling >/dev/null 2>&1; rc=$?
check "ruling exits 0" "0" "$rc"
check "ruling still sends once" "1" "$(grep -c '^send-run-worker run_b wtBT ' "$STUB_LOG")"
check "ruling log line carries the body" "1" "$(tail -n1 "$SD/cross-squad.md" | grep -cF 'RULING: use field X')"
check "ruling journaled in the from-Lead journal" "1" "$(grep -cF '[decision] use field X — peer ruling with b — cross-squad.md' "$SD/journals/a-lead.md")"
check "ruling journaled in the to-Lead journal" "1" "$(grep -cF '[decision] use field X — peer ruling with a — cross-squad.md' "$SD/journals/b-lead.md")"

# 6. a closed squad, an unknown role, and a non-Thinker/Lead target are all exit 2.
SP c thinker s b --project "$LBL" --from a/thinker >/dev/null 2>&1
check "closed squad -> exit 2" "2" "$?"
SP b reviewer s b --project "$LBL" --from a/thinker >/dev/null 2>&1
check "unknown role -> exit 2" "2" "$?"
: > "$STUB_LOG"
out="$(SP b builder-u1 s b --project "$LBL" --from a/thinker 2>&1)"; rc=$?
check "builder target -> exit 2" "2" "$rc"
check "builder target says ask your Lead" "1" "$(printf '%s' "$out" | grep -c 'ask your Lead')"
check "builder target -> no send call" "0" "$(grep -c '^send' "$STUB_LOG")"

# 7. your own squad's worker is in-squad mail, not a peer send.
: > "$STUB_LOG"
out="$(SP a thinker s b --project "$LBL" --from a/thinker 2>&1)"; rc=$?
check "same-squad worker -> exit 2" "2" "$rc"
check "same-squad hint names send-worker" "1" "$(printf '%s' "$out" | grep -c 'send-worker')"
check "same-squad -> no send call" "0" "$(grep -c '^send' "$STUB_LOG")"

# 8. --from defaults to this worktree: its roster row, else its worktree name.
: > "$STUB_LOG"
out="$(FAKE_CURRENT=wtAT SP b thinker s b --project "$LBL" 2>/dev/null)"; rc=$?
check "from derived from roster exits 0" "0" "$rc"
check "roster-derived from names a/thinker" "1" "$(printf '%s' "$out" | grep -cF 'send-peer: a/thinker →')"
out="$(FAKE_CURRENT="x::/w/ds-$LBL-thinker-a" SP b thinker s b --project "$LBL" 2>/dev/null)"; rc=$?
check "from derived from worktree name exits 0" "0" "$rc"
check "name-derived from names a/thinker" "1" "$(printf '%s' "$out" | grep -cF 'send-peer: a/thinker →')"
FAKE_CURRENT=wtZZ SP b thinker s b --project "$LBL" >/dev/null 2>&1; rc=$?
check "an unknown caller worktree needs --from" "2" "$rc"

# 9. the project is found from the current worktree when --project is absent.
out="$(FAKE_CURRENT=wtBT SP b thinker s b --from a/thinker 2>/dev/null)"; rc=$?
check "project found from current worktree" "0" "$rc"
check "found project logs to its own cross-squad.md" "1" "$(tail -n1 "$SD/cross-squad.md" | grep -c 'a/thinker → b/thinker')"

# 10. the backend seam holds: no direct orca call.
check "no direct orca call" "0" "$(grep -vE '^[[:space:]]*#' "$ROOT/bin/role/send-peer.sh" | grep -cE 'orca[[:space:]]')"

echo "send-peer: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
