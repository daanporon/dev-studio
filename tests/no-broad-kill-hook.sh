#!/usr/bin/env bash
# no-broad-kill-hook.sh — the Bash guard blocks host-wide kills and allows the rest.
# (The broad-kill names below are assembled, never literal: tests/no-broad-kill.sh
# forbids literal pkill/killall in tests.)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/bin/hooks/no-broad-kill-hook.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 (want [$3], got [$2])" >&2; fi }

# run <command> — feed the Claude PreToolUse JSON; prints "<rc> <stderr>".
run() {
  local err rc
  err="$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' "$1" | jq -Rs .)" \
    | bash "$HOOK" 2>&1 >/dev/null)"; rc=$?
  printf '%s %s' "$rc" "$err"
}

PK="pki"; PK+="ll"
KA="killa"; KA+="ll"

# Blocked: the three shapes from the plan, naming ds stop-mine in the reason.
r="$(run "$PK -f \"bun run ship\"")"; eq "broad-pattern kill blocked" "${r%% *}" "2"
eq "broad-pattern reason names ds stop-mine" "$(printf '%s' "$r" | grep -c 'ds stop-mine')" "1"
r="$(run "$KA node")"; eq "all-process kill blocked" "${r%% *}" "2"
eq "all-process reason names ds stop-mine" "$(printf '%s' "$r" | grep -c 'ds stop-mine')" "1"
r="$(run 'kill $(pgrep -f ship.ts)')"; eq "kill fed by pgrep blocked" "${r%% *}" "2"
eq "kill-pgrep reason names ds stop-mine" "$(printf '%s' "$r" | grep -c 'ds stop-mine')" "1"

# Allowed: the four shapes from the plan.
eq "kill <pid> allowed" "$(run 'kill 12345')" "0 "
eq "kill %job allowed" "$(run 'kill %1')" "0 "
eq "ps | grep allowed" "$(run 'ps -ef | grep ship')" "0 "
eq "quoted name allowed" "$(run 'echo "'"$PK"' server"')" "0 "

# The hook is a one-line exec into its port (bin/ds no-broad-kill-hook-ts, U193): every case above and
# below runs the port. The project comes from the role worktree's name.
mkdir -p "$TMP/state/zzkill" "$TMP/ds-zzkill-builder-x"
cmdjson() { printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' "$1" | jq -Rs .)"; }
both() { # <name> <payload> — the exit code the hook gives for a project worktree; RC is it
  local out
  out="$(printf '%s' "$2" | DS_STATE_ROOT="$TMP/state" CLAUDE_PROJECT_DIR="$TMP/ds-zzkill-builder-x" bash "$HOOK" 2>&1 >/dev/null; echo "rc=$?")"
  RC="${out##*rc=}"
}
for c in "$PK -f ship" "$KA node" 'kill $(pgrep -f ship.ts)' 'kill `pgrep ship`' 'pgrep -f ship | xargs kill' \
  "sudo $PK x" "/usr/bin/$PK x" "FOO=1 $PK x" "ls; $PK x" 'kill -9 $(pidof node)' 'pidof node | xargs -r kill -9' \
  "echo hi && $KA x" "$(printf 'cd /x\n%s y' "$PK")"; do
  both "$c" "$(cmdjson "$c")"; eq "project worktree blocks: $c" "$RC" "2"
done
for c in 'kill 12345' 'kill %1' 'kill -l' "echo '$PK x'" "echo \"$PK server\"" 'ps -ef | grep ship' \
  "grep $PK notes.txt" 'kill $(cat pid.txt)' 'pgrep -f ship' "$(printf 'echo a\necho b')" '   '; do
  both "$c" "$(cmdjson "$c")"; eq "project worktree allows: $c" "$RC" "0"
done
for p in 'not json' '' '[1,2]' '{"tool_name":"Read","tool_input":{"command":"x"}}' '{"tool_name":"Bash","tool_input":"x"}' \
  '{"tool_name":"Bash","tool_input":{"command":5}}' '{"tool_name":"Bash"}' '{"tool_name":"Bash","tool_input":{"command":null}}'; do
  both "$p" "$p"; eq "fails open on junk: $p" "$RC" "0"
done

# The wrapper: it execs bin/ds no-broad-kill-hook-ts with DS_ROOT and passes stdin and the exit code on.
mkdir -p "$TMP/co/bin/hooks"
cp "$HOOK" "$TMP/co/bin/hooks/"
printf '#!/usr/bin/env bash\necho "port $*" >&2; exit 7\n' > "$TMP/co/bin/ds"; chmod +x "$TMP/co/bin/ds"
eq "the hook runs its port" "$(cmdjson 'kill 1' | CLAUDE_PROJECT_DIR="$TMP/ds-zzkill-builder-x" bash "$TMP/co/bin/hooks/no-broad-kill-hook.sh" 2>&1; echo "rc=$?")" "$(printf 'port no-broad-kill-hook-ts\nrc=7')"

echo "no-broad-kill-hook: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
