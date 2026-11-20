#!/usr/bin/env bash
# CLI selection and failed inbox reads through the real adapter and watch, with no live CLI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
TMP="$(mktemp -d)"
LBL="zzoc_$$"
trap 'rm -rf "$TMP" "$DS_STATE_ROOT/$LBL"' EXIT
mkdir -p "$TMP/old" "$TMP/data/cli/bin" "$TMP/env"
export DS_ORCA_CLI_BIN_DIR="$TMP/old" DS_ORCA_DATA="$TMP/data" ORCA_CLI_BIN_DIR="$TMP/env"
export CLI_LOG="$TMP/log" DS_INSTR_SEEN="$TMP/seen"
cat > "$TMP/old/orca" <<'FAKE'
#!/usr/bin/env bash
echo "old $*" >> "$CLI_LOG"
echo '{"ok":false,"error":{"code":"invalid_argument","message":"Unknown flag --full for command: orchestration check"}}'
exit 1
FAKE
cat > "$TMP/data/cli/bin/orca" <<'FAKE'
#!/usr/bin/env bash
echo "new $*" >> "$CLI_LOG"
case "${CLI_MODE:-mail}" in
  rejected) echo '{"ok":false,"error":{"code":"consumer_fenced","message":"Inbox belongs to another terminal"}}' ;;
  malformed) echo 'not JSON' ;;
  missing) echo '{"ok":true}' ;;
  timeout) echo '{"ok":true,"result":{"messages":[],"timedOut":true}}' ;;
  *) echo '{"ok":true,"result":{"messages":[{"id":"m1","type":"question","subject":"pending question"}],"deliveryId":"d1"}}' ;;
esac
FAKE
chmod +x "$TMP/old/orca" "$TMP/data/cli/bin/orca"
sed 's/echo "new /echo "env /' "$TMP/data/cli/bin/orca" > "$TMP/env/orca"
chmod +x "$TMP/env/orca"
export PATH="$TMP/old:$PATH"
pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1: expected [$3], got [$2]" >&2; fi; }
has() { if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1: missing [$3] in [$2]" >&2; fi; }
absent() { if grep -qF -- "$3" <<<"$2"; then fail=$((fail+1)); echo "FAIL: $1: unexpected [$3]" >&2; else pass=$((pass+1)); fi; }
run() { rc=0; out="$("$@" 2>"$TMP/err")" || rc=$?; err="$(cat "$TMP/err")"; }
B="$ROOT/bin/backend/orca.sh"
W="$ROOT/bin/lib/watch.sh"
# DS override wins even with another override, data CLI, and old PATH CLI present.
DS_ORCA_CLI_BIN_DIR="$TMP/data/cli/bin" run "$B" inbox-peek-self
eq 'DS override succeeds' "$rc" 0
has 'DS override returns pending mail' "$out" 'pending question'
has 'DS override wins over Orca override' "$(tail -1 "$CLI_LOG")" 'new orchestration check'
# Unsetting the explicit pin is safe only here: every candidate is a fake in this temp tree.
unset DS_ORCA_CLI_BIN_DIR
run "$B" inbox-peek-self
eq 'Orca override succeeds' "$rc" 0
has 'Orca override wins over data CLI' "$(tail -1 "$CLI_LOG")" 'env orchestration check'
unset ORCA_CLI_BIN_DIR
run "$B" ask run_test question
eq 'data CLI ask succeeds past old PATH' "$rc" 0
run "$W" --worktree 1
eq 'watch uses data CLI' "$rc" 0
has 'watch shows pending mail' "$out" 'pending question'
absent 'old PATH was never called' "$(cat "$CLI_LOG")" 'old '
export DS_ORCA_DATA="$TMP/no-data"
for mode in '--worktree 1' '--worktree --poll' '--run run_test --all'; do
  # shellcheck disable=SC2086 # exercise the CLI argument shapes
  run "$W" $mode
  eq 'failed watch exits nonzero' "$rc" 1
  if [[ "$mode" == *--poll* ]]; then eq 'failed poll has no stdout' "$out" ''; has 'poll failure on stderr' "$err" 'INBOX READ FAILED: invalid_argument:'
  else has 'foreground failure is visible' "$out" 'INBOX READ FAILED: invalid_argument:'; fi
  absent 'failure never claims empty inbox' "$out" 'do a check-in and re-arm'
  absent 'failure yields no ACK-ID' "$out" 'ACK-ID:'
done
mkdir -p "$DS_STATE_ROOT/$LBL/requests/_studio"
echo 'restart lead after inbox failure' > "$DS_STATE_ROOT/$LBL/requests/_studio/restart.txt"
run "$W" --worktree --requests "$LBL" --poll
eq 'failed poll with request exits nonzero' "$rc" 1
has 'failed poll preserves pending request' "$out" $'↻ request\t'"restart lead after inbox failure"
absent 'failed poll with request prints no inbox header' "$out" '=== '
absent 'failed poll with request prints no empty inbox' "$out" 'do a check-in and re-arm'
has 'failed poll with request reports read error on stderr' "$err" 'INBOX READ FAILED: invalid_argument:'
absent 'failed reads send no ack' "$(cat "$CLI_LOG")" '--ack'
export DS_ORCA_CLI_BIN_DIR="$TMP/missing"
for op in inbox-peek-self ps worker-states status account-list; do
  run "$B" "$op"
  eq "missing DS override fails for $op" "$rc" 1
  has "missing DS override names directory for $op" "$err" "$TMP/missing"
done
run "$B" claude-config-dir system
eq 'an operation without Orca does not require the CLI' "$rc" 0
eq 'system account config stays empty' "$out" ''
mkdir -p "$TMP/empty-proc"
DS_PROC="$TMP/empty-proc" run "$B" agent-accounts
eq 'agent-accounts does not require the CLI' "$rc" 0
eq 'agent-accounts with no processes stays empty' "$out" ''
cat > "$TMP/fake-gh" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*"
FAKE
chmod +x "$TMP/fake-gh"
DS_GH="$TMP/fake-gh" run "$B" pr-close owner/repo 310
eq 'pr-close does not require the CLI' "$rc" 0
eq 'pr-close still calls gh' "$out" 'pr close 310 --repo owner/repo'
unset DS_ORCA_CLI_BIN_DIR
export ORCA_CLI_BIN_DIR="$TMP/missing-orca"
run "$B" inbox-peek-self
eq 'missing Orca override fails' "$rc" 1
has 'missing Orca override names directory' "$err" "$TMP/missing-orca"
unset ORCA_CLI_BIN_DIR
export DS_ORCA_CLI_BIN_DIR="$TMP/data/cli/bin"
for CLI_MODE in rejected malformed missing; do
  export CLI_MODE
  for op in inbox-peek-self inbox-all-self 'inbox-peek run_test' 'inbox-all run_test' 'inbox-wait-self 1' 'inbox-wait run_test 1' 'worker-done subject body'; do
    # shellcheck disable=SC2086 # adapter op and positional args
    ORCA_TERMINAL_HANDLE=term_fake run "$B" $op
    eq "$CLI_MODE $op fails" "$rc" 1
    eq "$CLI_MODE $op emits no stdout" "$out" ''
    absent 'failed dispatch lookup does not claim no dispatch' "$err" 'no active dispatch'
    if [ "$CLI_MODE" = rejected ]; then has 'real Orca error survives' "$err" 'consumer_fenced: Inbox belongs to another terminal'; fi
  done
done
CLI_MODE=timeout run "$W" --worktree 1
eq 'real timeout succeeds' "$rc" 0
has 'real timeout says empty inbox' "$out" 'do a check-in and re-arm'
absent 'all checks keep --full' "$(grep 'orchestration check' "$CLI_LOG" | grep -v -- '--full' || true)" 'orchestration check'
echo "orca-cli: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
