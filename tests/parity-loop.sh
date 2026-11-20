#!/usr/bin/env bash
# parity-loop.sh — the ported loop launcher (U273: bin/loop/loop.sh -> ds loop-ts) starts, watches and stops the
# loop as the shell version did: same output, exit code and loop starts for --status when stopped (exit 3), the
# usage (exit 2), --ensure (starts once; a second --ensure starts no second loop), --status when running (with the
# skipped-project, tick_slow, orca-spawns and bg_deferred lines), the stale-tick restart, and --stop. The shell
# side is the tree at PARITY_BASE (default 3c71af0d, the last commit with the shell launcher), unpacked with git
# archive. Both run with DS_LOOP_SYSTEMD=0 and a stub bin/loop/main.ts (writes its pid, logs its start) and a stub
# watchdog.ts (prints the verdict the case sets), so no real loop ticks. Only the PIDs started here are stopped.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091 source=tests/lib.sh
. "$ROOT/tests/lib.sh"
BASE="${PARITY_BASE:-3c71af0d}"
TMP="$(mktemp -d)"
PIDS=()
cleanup() {
  local p
  for p in "${PIDS[@]}"; do stop_own "$p"; done
  rm -rf "$TMP"
}
trap cleanup EXIT

if ! git -C "$ROOT" cat-file -e "$BASE^{commit}" 2>/dev/null; then
  echo "parity-loop: $BASE is not in this clone — skipped"; echo "parity-loop: 0 passed, 0 failed"; exit 0
fi
mkdir "$TMP/old" "$TMP/new" "$TMP/home"
git -C "$ROOT" archive "$BASE" bin conventions | tar -x -C "$TMP/old"
cp -r "$ROOT/bin" "$ROOT/conventions" "$TMP/new/"
# The PARITY_BASE tree has bin/loop/ flat; this one keeps those files in bin/loop/core/ (docs-after-the-loop U1).
loopfile() { if [ -d "$TMP/$1/bin/loop/core" ]; then echo "$TMP/$1/bin/loop/core/$2"; else echo "$TMP/$1/bin/loop/$2"; fi; }
for t in old new; do
  cat > "$TMP/$t/bin/loop/main.ts" <<'TS'
// stub loop: log the start (with the env the launcher passed), take the pidfile, wait for TERM.
import { appendFileSync, writeFileSync } from "node:fs";
const root = process.env.DS_STATE_ROOT!;
appendFileSync(`${root}/starts`, `pid ${process.pid} DS_NOW=${process.env.DS_NOW ?? "-"} DS_ROOT=${process.env.DS_ROOT ?? "-"}\n`);
writeFileSync(`${root}/loop.pid`, `${process.pid}\n`);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
TS
  cat > "$(loopfile "$t" watchdog.ts)" <<'TS'
// stub watchdog: the verdict the case wrote.
import { readFileSync } from "node:fs";
console.log(readFileSync(`${process.env.DS_STATE_ROOT}/verdict.json`, "utf8").trim());
TS
done

# A fake systemctl: logs each call; `start` runs the side's stub loop detached, `stop` stops it.
mkdir "$TMP/fakebin"
cat > "$TMP/fakebin/systemctl" <<'SH'
#!/usr/bin/env bash
echo "systemctl $*" >> "$DS_STATE_ROOT/systemctl.log"
case "$*" in
  "--user show-environment") [ -z "${SYSTEMCTL_NO_BUS:-}" ] || exit 1 ;;
  "--user start ds-loop.service") [ -z "${SYSTEMCTL_FAIL:-}" ] || exit 4
    setsid bun "$SYSTEMD_TREE/bin/loop/main.ts" </dev/null >/dev/null 2>&1 & ;;
  "--user stop ds-loop.service") p="$(cat "$DS_STATE_ROOT/loop.pid" 2>/dev/null || true)"; [ -z "$p" ] || kill "$p" 2>/dev/null || true ;;
esac
SH
chmod +x "$TMP/fakebin/systemctl"

pass=0; fail=0
good() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }

# One launcher run on one side: stdout + stderr + exit code, with pids and the side's paths made generic.
launch() { # <side> <args…>
  local side="$1" rc=0 out; shift
  out="$(env HOME="$TMP/home" XDG_CONFIG_HOME="$TMP/home/.config" DS_LOOP_SYSTEMD="${LAUNCH_SYSTEMD:-0}" DS_NOW=1700000000 \
    PATH="$TMP/fakebin:$PATH" SYSTEMD_TREE="$TMP/$side" DS_STATE_ROOT="$TMP/state-$side" "$TMP/$side/bin/loop/loop.sh" "$@" 2>&1)" || rc=$?
  local pid
  pid="$(cat "$TMP/state-$side/loop.pid" 2>/dev/null || true)"
  [ -z "$pid" ] || PIDS+=("$pid")
  printf '%s\nrc=%s\n' "$out" "$rc" | sed -E "s|$TMP/state-$side|STATE|g; s|$TMP/$side|TREE|g; s/pid [0-9]+/pid PID/g; s/\"pid\": [0-9]+/\"pid\": PID/g"
}
starts() { sed -E 's/pid [0-9]+/pid PID/' "$TMP/state-$1/starts" 2>/dev/null || true; sed "s|$TMP/state-$1|STATE|g" "$TMP/state-$1/systemctl.log" 2>/dev/null || true; }
same() { # <name> <args…>: run both sides, compare output, exit code and the loop starts so far
  local name="$1"; shift
  local o n
  o="$(launch old "$@")"; o+=$'\n'"$(starts old)"
  # The usage names the watchdog, which docs-after-the-loop U1 moved to bin/loop/core/.
  n="$(launch new "$@" | sed -E 's|bin/loop/core/(watchdog\.ts)|bin/loop/\1|g')"; n+=$'\n'"$(starts new)"
  if [ "$o" = "$n" ]; then good; else bad "$name"; diff <(echo "$o") <(echo "$n") | head -20; fi
  [ -z "${SHOW:-}" ] || printf '== %s\n%s\n' "$name" "$n"
}
alive_pid() { local p; p="$(cat "$TMP/state-$1/loop.pid" 2>/dev/null)" && kill -0 "$p" 2>/dev/null && echo "$p"; }
each() { local s; for s in old new; do "$@" "$s"; done; }
verdict() { echo "$1" > "$TMP/state-$2/verdict.json"; } # <json> <side>

for s in old new; do mkdir -p "$TMP/state-$s"; verdict '{"state":"fresh","age":3}' "$s"; done

same "status when stopped exits 3"     --status
same "no argument prints the usage"
same "unknown argument prints the usage" --bogus
same "ensure starts the loop"          --ensure
for s in old new; do
  if [ -n "$(alive_pid "$s")" ]; then good; else bad "$s: ensure left no live loop"; fi
done
same "a second ensure starts no second loop" --ensure
for s in old new; do
  if [ "$(wc -l < "$TMP/state-$s/starts")" = 1 ]; then good; else bad "$s: two ensures started $(wc -l < "$TMP/state-$s/starts") loops"; fi
done

# --status when running: plain, then with every extra line, then with the edge shapes jq leaves out or fills.
same "status when running, nothing extra" --status
for s in old new; do
  mkdir -p "$TMP/state-$s/loop"
  for p in zz-a zz-b zz-c zz-d zz-e zz-f _x real; do mkdir -p "$TMP/state-$s/$p/squads"; done
  cat > "$TMP/state-$s/loop/orca-spawns.json" <<'J'
{"tick":42,"total":17,"top":[{"verb":"terminal list","n":5},{"verb":"worker-list","n":3}],"bun":2,"runs":{"reread":1,"kept":4,"why":{"mail":1,"terminals":2}},"dropped_by":{"send":3},"by_caller":[{"caller":"observe","verb":"terminal","kind":"keyed","n":4},{"caller":"a","verb":"b","kind":"past","n":1},{"caller":"c","verb":"d","kind":"write","n":1},{"caller":"e","verb":"f","kind":"keyed","n":1},{"caller":"g","verb":"h","kind":"keyed","n":1},{"caller":"i","verb":"j","kind":"keyed","n":1}]}
J
  echo '{"tick":42,"last":{"merge":2,"review":1},"total":{"merge":9}}' > "$TMP/state-$s/loop/bg-deferred.json"
  DS_NOW=1700000000 DS_STATE_ROOT="$TMP/state-$s" bun -e "import { open } from '$(loopfile "$s" store.ts)'; const st = open();
    st.event('tick_slow', { payload: { slow: 3, ticks: 120, tick_s: 5, avg_ms: 812.5, max_ms: 9001, slowest: { step: 'observe:orca', avg_ms: 400 }, top: [{ step: 'observe:orca', avg_ms: 400 }, { step: 'decide', avg_ms: 90 }, { step: 'act', avg_ms: 50 }, { step: 'x', avg_ms: 1 }] } });
    st.close();" >/dev/null
done
same "status when running, every line" --status
for s in old new; do
  echo '{"tick":43,"total":0,"top":[],"runs":{"reread":0,"kept":0,"why":{}},"dropped_by":null}' > "$TMP/state-$s/loop/orca-spawns.json"
  echo '{"tick":43,"last":{}}' > "$TMP/state-$s/loop/bg-deferred.json"
  rm -rf "$TMP/state-$s/zz-b" "$TMP/state-$s/zz-c"
  DS_NOW=1700000000 DS_STATE_ROOT="$TMP/state-$s" bun -e "import { open } from '$(loopfile "$s" store.ts)'; const st = open();
    st.event('tick_slow', { payload: { slow: 1, ticks: 10, tick_s: 5, avg_ms: 6000, max_ms: 6000, slowest: null } });
    st.close();" >/dev/null
done
same "status when running, edge shapes" --status

# The stale-tick restart: the old loop is stopped and a new one started.
each verdict '{"state":"stale","ref":100,"stall":100,"age":99,"pid":1}'
declare -A before
for s in old new; do before[$s]="$(alive_pid "$s")"; done
same "a stale loop is restarted" --ensure
for s in old new; do
  now="$(alive_pid "$s" || true)"
  if [ -n "$now" ] && [ "$now" != "${before[$s]}" ] && ! kill -0 "${before[$s]}" 2>/dev/null; then good
  else bad "$s: stale restart left pid '${now}' (was ${before[$s]})"; fi
done
each verdict '{"state":"fresh","age":1}'

same "stop stops it"            --stop
for s in old new; do if [ -z "$(alive_pid "$s" || true)" ]; then good; else bad "$s: --stop left the loop running"; fi; done
same "status after stop exits 3" --status
same "stop when stopped"        --stop

# Under systemd: the unit for this state root is installed and `systemctl --user` answers.
unit() { mkdir -p "$TMP/home/.config/systemd/user"; printf '[Service]\nEnvironment="DS_STATE_ROOT=%s"\n' "$@" > "$TMP/home/.config/systemd/user/ds-loop.service"; }
unit "$TMP/state-elsewhere"
LAUNCH_SYSTEMD=1 same "a unit for another state root: detached start" --ensure
LAUNCH_SYSTEMD=1 same "a unit for another state root: no unit in status" --status
LAUNCH_SYSTEMD=1 same "a unit for another state root: stop" --stop
for s in old new; do
  unit "$TMP/state-$s"
  o="$(LAUNCH_SYSTEMD=1 launch "$s" --ensure)"
  if [ "$o" = $'loop: started (pid PID)\nrc=0' ] && grep -q 'start ds-loop.service' "$TMP/state-$s/systemctl.log"; then good; else bad "$s: systemd ensure: $o"; fi
  o="$(LAUNCH_SYSTEMD=1 launch "$s" --status | head -1)"
  if [ "$o" = "loop: running (pid PID, ds-loop.service)" ]; then good; else bad "$s: systemd status: $o"; fi
  o="$(LAUNCH_SYSTEMD=0 launch "$s" --status | head -1)"
  if [ "$o" = "loop: running (pid PID)" ]; then good; else bad "$s: DS_LOOP_SYSTEMD=0 status: $o"; fi
  o="$(LAUNCH_SYSTEMD=1 SYSTEMCTL_NO_BUS=1 launch "$s" --status | head -1)"
  if [ "$o" = "loop: running (pid PID)" ]; then good; else bad "$s: no bus status: $o"; fi
  o="$(LAUNCH_SYSTEMD=1 launch "$s" --stop)"
  if [ "$o" = $'loop: stopped\nrc=0' ] && [ -z "$(alive_pid "$s" || true)" ]; then good; else bad "$s: systemd stop: $o"; fi
  o="$(LAUNCH_SYSTEMD=1 SYSTEMCTL_FAIL=1 launch "$s" --ensure)"
  if [ "$o" = "rc=4" ] || [ "$o" = $'\nrc=4' ]; then good; else bad "$s: a failed systemctl start: $o"; fi
done
same "the systemctl calls match" --status

echo "parity-loop: $pass passed, $fail failed"
[ "$fail" = 0 ]
