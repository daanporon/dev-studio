#!/usr/bin/env bash
# set-orca-depth.sh (core) — idempotent no-op when already set; safe export->edit->verify when below;
# refuses (and leaves the value untouched) when the rollback reports Orca is still running. Uses a
# fake `orca` on PATH and a sandboxed XDG_CONFIG_HOME so nothing real is touched.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

export XDG_CONFIG_HOME="$TMP/cfg"
PROFILE="$XDG_CONFIG_HOME/orca/profiles/local-default/orca-data.json"
mkdir -p "$(dirname "$PROFILE")"

# Fake orca: `profile state rollback --latest-json` echoes `restored: <FAKE_RESTORED>` (or refuses
# when FAKE_ORCA_RUNNING=1, mirroring requireStoppedRuntime). Everything else is a quiet success.
cat > "$TMP/orca" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  "profile state rollback --latest-json")
    if [ "${FAKE_ORCA_RUNNING:-0}" = 1 ]; then echo "Stop Orca before profile-state rollback" >&2; exit 1; fi
    printf 'profileId: local-default\nrevision: 1\nstorage: json\nrestored: %s\nremovedDatabaseFiles: 3\n' "${FAKE_RESTORED:-/nonexistent}"
    ;;
  status) echo "appRunning: true" ;;
  *) : ;;
esac
FAKE
chmod +x "$TMP/orca"
export DS_ORCA_CLI_BIN_DIR="$TMP"
export PATH="$TMP:$PATH"
export FAKE_RESTORED="$PROFILE"

pass=0; fail=0
has(){ if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
eqd(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — got [$2] want [$3]" >&2; fi; }
valof(){ grep -o '"nestedWorkerMaxDepth"[: ]*[0-9]*' "$1" | grep -oE '[0-9]+' | head -1; }

# 1. idempotent: already >= n -> no-op, exit 0, rollback never run (value stays 5)
printf '{"settings":{"nestedWorkerMaxDepth":5}}' > "$PROFILE"
rc=0; out="$("$ROOT/bin/host/set-orca-depth.sh" 5 2>&1)" || rc=$?
eqd "idempotent exit 0"              "$rc" "0"
has "idempotent reports already set" "$out" "already 5"

# 2. below target + Orca stopped -> rollback, edit restored file to 5, verify
printf '{"settings":{"nestedWorkerMaxDepth":1}}' > "$PROFILE"
rc=0; out="$(FAKE_ORCA_RUNNING=0 "$ROOT/bin/host/set-orca-depth.sh" 5 2>&1)" || rc=$?
eqd "edits the restored file to 5"   "$(valof "$PROFILE")" "5"
has "reports the value it set"       "$out" "nestedWorkerMaxDepth=5"

# 3. rollback refuses (Orca running) -> non-zero, tells you to stop Orca, value untouched
printf '{"settings":{"nestedWorkerMaxDepth":1}}' > "$PROFILE"
rc=0; out="$(FAKE_ORCA_RUNNING=1 "$ROOT/bin/host/set-orca-depth.sh" 5 2>&1)" || rc=$?
eqd "non-zero when rollback refuses" "$([ "$rc" -ne 0 ] && echo nonzero || echo zero)" "nonzero"
has "tells you to stop Orca"         "$out" "STOP Orca first"
eqd "value untouched on refusal"     "$(valof "$PROFILE")" "1"

# 4. --auto with already-set depth -> no-op exit 0 before any stop (hermetic: never reaches
# systemctl detection, so no Orca service on this host can make it stop anything).
printf '{"settings":{"nestedWorkerMaxDepth":5}}' > "$PROFILE"
rc=0; out="$("$ROOT/bin/host/set-orca-depth.sh" 5 --auto 2>&1)" || rc=$?
eqd "--auto idempotent exit 0"       "$rc" "0"
has "--auto reports already set"     "$out" "already 5"
eqd "--auto leaves value alone"      "$(valof "$PROFILE")" "5"

# 5. --auto usage: an unknown flag exits 2 without touching anything.
rc=0; out="$("$ROOT/bin/host/set-orca-depth.sh" --bogus 2>&1)" || rc=$?
eqd "--bogus exits 2"                "$rc" "2"
has "--bogus prints usage"           "$out" "usage: set-orca-depth.sh"

# 6. --auto stop/set/start path, with a fake systemctl logging every call.
cat > "$TMP/systemctl" <<'FAKECTL'
#!/usr/bin/env bash
printf '%s\n' "systemctl $*" >> "$TMP/syslog"
case "$*" in
  *list-units*) printf '%s\n' "${FAKE_UNIT:-}" ;;
  *" start "*) [ "${FAKE_START_FAIL:-0}" = 1 ] && exit 1; : ;;
  *) : ;;
esac
FAKECTL
chmod +x "$TMP/systemctl"
export TMP PATH="$TMP:$PATH"

# 6a. no Orca unit detected -> exit 1, names the manual steps, stops nothing.
: > "$TMP/syslog"
printf '{"settings":{"nestedWorkerMaxDepth":1}}' > "$PROFILE"
rc=0; out="$(FAKE_UNIT="" "$ROOT/bin/host/set-orca-depth.sh" 5 --auto --yes 2>&1)" || rc=$?
eqd "--auto without a unit exits 1"  "$rc" "1"
has "--auto without a unit is explicit" "$out" "can't auto-detect"
no() { if grep -qF -- "$3" <<<"$2"; then fail=$((fail+1)); echo "  FAIL: $1 — unexpected [$3]" >&2; else pass=$((pass+1)); fi; }
no  "--auto without a unit stops nothing" "$(cat "$TMP/syslog")" " stop "
eqd "--auto without a unit leaves depth" "$(valof "$PROFILE")" "1"

# 6b. unit found but operator declines -> aborts before stopping.
: > "$TMP/syslog"
rc=0; out="$(printf 'n\n' | FAKE_UNIT="orca-serve.service" "$ROOT/bin/host/set-orca-depth.sh" 5 --auto 2>&1)" || rc=$?
eqd "--auto decline exits 1"         "$rc" "1"
has "--auto decline says aborted"    "$out" "aborted"
no  "--auto decline stops nothing"   "$(cat "$TMP/syslog")" " stop "
eqd "--auto decline leaves depth"    "$(valof "$PROFILE")" "1"

# 6c. unit found + --yes -> stop, set to 5, restart, in that order.
: > "$TMP/syslog"
rc=0; out="$(FAKE_UNIT="orca-serve.service" FAKE_ORCA_RUNNING=0 "$ROOT/bin/host/set-orca-depth.sh" 5 --auto --yes 2>&1)" || rc=$?
eqd "--auto --yes exits 0"           "$rc" "0"
has "--auto --yes restarts the unit" "$out" "orca-serve.service restarted"
eqd "--auto --yes sets depth"        "$(valof "$PROFILE")" "5"
log="$(cat "$TMP/syslog")"
stop_line="$(printf '%s' "$log" | grep -n " stop " | head -1 | cut -d: -f1)"
start_line="$(printf '%s' "$log" | grep -n " start " | head -1 | cut -d: -f1)"
if [ -n "$stop_line" ] && [ -n "$start_line" ] && [ "$stop_line" -lt "$start_line" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: stop must precede start in: $log" >&2; fi

# 6d. the set fails (the setter refuses: Orca still running) -> stop, failed set, start; non-zero + message.
: > "$TMP/syslog"
printf '{"settings":{"nestedWorkerMaxDepth":1}}' > "$PROFILE"
rc=0; out="$(FAKE_UNIT="orca-serve.service" FAKE_ORCA_RUNNING=1 "$ROOT/bin/host/set-orca-depth.sh" 5 --auto --yes 2>&1)" || rc=$?
eqd "failed set exits non-zero"      "$([ "$rc" -ne 0 ] && echo nonzero || echo zero)" "nonzero"
has "failed set says Orca restarted" "$out" "setting the depth failed ($rc); Orca was started again with its old depth"
log="$(cat "$TMP/syslog")"
eqd "failed set: stop then start"    "$(printf '%s' "$log" | grep -E ' (stop|start) ' | sed 's/.* \(stop\|start\) .*/\1/' | tr '\n' ' ')" "stop start "
eqd "failed set leaves depth"        "$(valof "$PROFILE")" "1"

# 6e. the set fails AND the start fails -> the hand command is printed.
: > "$TMP/syslog"
rc=0; out="$(FAKE_UNIT="orca-serve.service" FAKE_ORCA_RUNNING=1 FAKE_START_FAIL=1 "$ROOT/bin/host/set-orca-depth.sh" 5 --auto --yes 2>&1)" || rc=$?
eqd "failed set+start exits non-zero" "$([ "$rc" -ne 0 ] && echo nonzero || echo zero)" "nonzero"
has "failed start names the hand command" "$out" "systemctl --user start orca-serve.service"

echo "set-orca-depth: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
