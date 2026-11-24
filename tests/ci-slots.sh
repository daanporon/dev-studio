#!/usr/bin/env bash
# ci-slots.sh — tests/ci.sh takes one of CI_SLOTS host-wide slots before it starts (a flock per slot file in
# CI_SLOT_DIR): with 2 slots held a third run waits and names the holders, a killed holder frees its slot at
# once, GITHUB_ACTIONS or CI_SLOTS=0 skip the slot, and the tests a run starts run at nice 10. Runs the real
# ci.sh in a temp root whose tests/ holds stubs, with its own CI_SLOT_DIR (never the suite's slot).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
pids=()
# shellcheck disable=SC2317 # called by the trap
cleanup() { for p in "${pids[@]}"; do kill "$p" 2> /dev/null || true; done; rm -rf "$TMP"; }
trap cleanup EXIT

# a killed ci.sh leaves its temp dirs: keep them under $TMP, which goes with the test
mkdir -p "$TMP/tmp"
export TMPDIR="$TMP/tmp" XDG_RUNTIME_DIR="$TMP/tmp"
mkdir -p "$TMP/root/tests/lib" "$TMP/root/bin/role" "$TMP/path" "$TMP/slots"
cp "$ROOT/tests/ci.sh" "$TMP/root/tests/ci.sh"
cp "$ROOT/tests/lib/live-state-guard.sh" "$TMP/root/tests/lib/"
touch "$TMP/root/bin/ds" "$TMP/root/bin/role/x.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/path/shellcheck"
chmod +x "$TMP/path/shellcheck"
# the stub test: records its nice value and its start, then waits for a go file when asked
cat > "$TMP/root/tests/a.sh" <<EOF2
#!/usr/bin/env bash
echo "\$\$ \$(ps -o ni= -p \$\$ | tr -d ' ')" >> "$TMP/ran"
[ -n "\${HOLD:-}" ] && while [ ! -e "$TMP/go" ]; do sleep 0.1; done
exit 0
EOF2

fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; printf '%s\n' "${2:-}"; fail=1; }
run_ci() { # <log> [env...]: starts ci.sh in the background, pid in $!
  local log="$1"
  shift
  env -u GITHUB_ACTIONS -u DS_CI_SLOT_HELD -u CI_SLOTS CI_SLOT_DIR="$TMP/slots" PATH="$TMP/path:$PATH" "$@" \
    bash "$TMP/root/tests/ci.sh" > "$log" 2>&1 &
}
wait_for() { for _ in $(seq 100); do eval "$1" && return 0; sleep 0.1; done; return 1; }

# two holders take both slots, the third waits and names them
run_ci "$TMP/h1.log" HOLD=1; pids+=("$!")
wait_for "[ \"\$(wc -l < '$TMP/ran' 2> /dev/null || echo 0)\" = 1 ]" || bad "first holder never started"
run_ci "$TMP/h2.log" HOLD=1; h2=$!; pids+=("$h2")
wait_for "[ \"\$(wc -l < '$TMP/ran' 2> /dev/null || echo 0)\" = 2 ]" || bad "second holder never started"
run_ci "$TMP/w.log"; w=$!; pids+=("$w")
wait_for "grep -q 'slots are taken' '$TMP/w.log'" && ok "a third run waits" || bad "no wait line" "$(cat "$TMP/w.log")"
grep -q "pid .*$TMP/root" "$TMP/w.log" && ok "the wait line names the holders" || bad "no holder named" "$(cat "$TMP/w.log")"
[ "$(wc -l < "$TMP/ran")" = 2 ] && ok "the waiter has not started" || bad "waiter started early"

# killing a holder frees its slot at once
kill -9 "$h2"
wait_for "[ \"\$(wc -l < '$TMP/ran')\" = 3 ]" && ok "kill -9 of a holder lets the waiter in" || bad "waiter never started" "$(cat "$TMP/w.log")"
wait "$w" 2> /dev/null || true
touch "$TMP/go"
grep -q '^ci: ' "$TMP/w.log" && ok "the waiter finished" || bad "waiter did not finish" "$(cat "$TMP/w.log")"

# the tests a run starts run at nice 10
awk 'NR==3 {print $2}' "$TMP/ran" | grep -qx 10 && ok "a test process shows nice 10" || bad "nice value:" "$(cat "$TMP/ran")"

# nothing waits on GitHub or with CI_SLOTS=0, even with every slot held
for p in "${pids[@]}"; do kill "$p" 2> /dev/null || true; done
rm -f "$TMP/ran"
exec 8> "$TMP/slots/slot-1.lock"; wait_for "flock -n 8" || bad "slot 1 stayed held"
exec 7> "$TMP/slots/slot-2.lock"; wait_for "flock -n 7" || bad "slot 2 stayed held"
for e in GITHUB_ACTIONS=1 CI_SLOTS=0; do
  rc=0
  env -u DS_CI_SLOT_HELD CI_SLOT_DIR="$TMP/slots" PATH="$TMP/path:$PATH" "$e" timeout 30 bash "$TMP/root/tests/ci.sh" > "$TMP/s.log" 2>&1 < /dev/null || rc=$?
  { [ "$rc" = 0 ] && ! grep -q 'slots are taken' "$TMP/s.log"; } && ok "$e: no slot" || bad "$e: rc=$rc" "$(cat "$TMP/s.log")"
done
exit "$fail"
