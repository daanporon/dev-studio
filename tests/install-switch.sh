#!/usr/bin/env bash
# install-switch.sh — the switch on fixture state, crash recovery and the cron line for any PATH (U18, U164).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
# shellcheck source=tests/lib/install-setup.sh
. "$ROOT/tests/lib/install-setup.sh"
install_prelude
# --- U18: the switch, on fixture state of two projects ---------------------------------------------
cat > "$TMP/q.ts" <<'Q'
// q.ts <state root> <sql>: tab-separated rows of the loop's database.
import { Database } from "bun:sqlite";
const db = new Database(`${process.argv[2]}/loop.db`);
db.run("PRAGMA busy_timeout = 5000");
for (const r of db.query(process.argv[3]).values()) console.log(r.join("\t"));
Q
q(){ "$BUN_REAL" "$TMP/q.ts" "$1" "$2"; }
eq(){ if [ "$2" = "$3" ]; then good; else bad "$1: got [$2], want [$3]"; fi; }
# fixture_host <checkout> <port a> <port b>: a host as the sweep leaves it, live squads with terminals.
fixture_host() {
  local s="$1/state" p
  for p in alpha beta; do
    mkdir -p "$s/$p/squads" "$s/$p/sweep"
    jq -n --arg t "topic-$p" --arg wt "wt-$p" '{topic: $t, status: "running", type: "feature", lead_wt: $wt,
      members: [{role: "lead", suffix: "", wt: $wt, terminal: ("term-" + $wt), conversation: ("conv-" + $wt), since: "2026-11-01"}],
      units: [{slug: "u1", status: "dispatched", builder_wt: $wt, deps: [], hold: false}]}' > "$s/$p/squads/topic-$p.json"
    printf '1700000000 ep-1 2\n' > "$s/$p/sweep/wt-$p.poke"
  done
  printf 'alpha\t\t%s\n' "$2" > "$s/alpha/board-serve.want"
  printf 'beta\t\t%s\n' "$3" > "$s/beta/board-serve.want"
}
PORT_A=$((20000 + RANDOM % 20000)); PORT_B=$((PORT_A + 1))
S="$REPO/state"

rm -rf "$S"; fixture_host "$REPO" "$PORT_A" "$PORT_B"; : > "$CRONTAB"; : > "$SYSTEMCTL_LOG"; rm -f "$UNIT"
files_before="$(cat "$S"/*/squads/*.json)"
rc=0; out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1)" || rc=$?
eq "the switch exits 0 ($out)" "$rc" 0
eq "squad rows of both projects" "$(q "$S" "SELECT project, topic, status FROM squads ORDER BY project" | tr '\t\n' ' ;')" "alpha topic-alpha running;beta topic-beta running;"
eq "live squads keep their workers" "$(q "$S" "SELECT wt, json_extract(doc, '$.terminal'), json_extract(doc, '$.conversation') FROM members WHERE project = 'beta'")" "wt-beta	term-wt-beta	conv-wt-beta"
eq "unit rows" "$(q "$S" "SELECT count(*) FROM units")" 2
eq "markers became episodes" "$(q "$S" "SELECT count(*) FROM episodes WHERE source = 'sweep'")" 2
eq "the board wish of each project" "$(q "$S" "SELECT name, project, port, want, want_by FROM services ORDER BY project" | tr '\t\n' ' ;')" "board alpha $PORT_A running install;board beta $PORT_B running install;"
eq "the import leaves the files as they were" "$(cat "$S"/*/squads/*.json)" "$files_before"
eq "the mark is one line" "$(wc -l < "$S/.loop-migrated" | tr -d ' ')" 1
if grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$S/.loop-migrated"; then good; else bad "the mark holds the import time: $(cat "$S/.loop-migrated")"; fi
if [ ! -e "$S/.sweep.lock" ] && [ ! -e "$S/.loop-migrated.tmp" ]; then good; else bad "the migration should leave no lock and no temp file"; fi
eq "no sweep cron line" "$(grep -c 'sweep[.]sh' "$CRONTAB" || true)" 0
eq "one watchdog line" "$(grep -c 'bin/loop/loop.sh --ensure' "$CRONTAB")" 1
if grep -qxF -- '--user start ds-loop.service' "$SYSTEMCTL_LOG" && [ -f "$UNIT" ]; then good; else bad "the loop unit should be installed and started"; fi
# A second install imports nothing.
mark_before="$(cat "$S/.loop-migrated")"; events_before="$(q "$S" "SELECT count(*) FROM events")"; want_before="$(q "$S" "SELECT want_at FROM services ORDER BY id")"
out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1)"
if grep -qF 'nothing to import' <<<"$out"; then good; else bad "a second install should say it imports nothing: $out"; fi
eq "a second install writes no event" "$(q "$S" "SELECT count(*) FROM events")" "$events_before"
eq "a second install keeps the mark" "$(cat "$S/.loop-migrated")" "$mark_before"
eq "a second install keeps the wishes" "$(q "$S" "SELECT want_at FROM services ORDER BY id")" "$want_before"
# A wish stopped on the loop stays stopped, though the want file is still there.
out="$(cd "$REPO" && PATH="$STUB" ./bin/ds --state "$S" want board --project beta --stop 2>&1)" || bad "ds want board --stop: $out"
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
eq "an install never undoes a stopped board" "$(q "$S" "SELECT want FROM services WHERE project = 'beta'")" stopped

# A crash after each migration step leaves no mark; a rerun completes. Inside the transaction nothing lands at all.
for step in json markers config boards import mark-tmp; do
  rm -rf "$S"; fixture_host "$REPO" "$PORT_A" "$PORT_B"; : > "$CRONTAB"
  rc=0; out="$(cd "$REPO" && DS_SWITCH_CRASH="$step" PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] && [ ! -e "$S/.loop-migrated" ]; then good; else bad "crash after $step: no mark, non-zero: rc=$rc $out"; fi
  eq "crash after $step keeps the sweep line" "$(grep -c 'sweep[.]sh' "$CRONTAB" || true)" 0
  if [ ! -e "$S/.sweep.lock" ]; then good; else bad "crash after $step left the sweep's lock"; fi
  case "$step" in import|mark-tmp) want=2 ;; *) want=0 ;; esac
  eq "crash after $step: rows" "$(q "$S" "SELECT count(*) FROM squads")" "$want"
  rc=0; out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1)" || rc=$?
  eq "rerun after $step exits 0 ($out)" "$rc" 0
  if [ -s "$S/.loop-migrated" ]; then good; else bad "rerun after $step should write the mark"; fi
  eq "rerun after $step: rows" "$(q "$S" "SELECT count(*) FROM squads")" 2
  eq "rerun after $step: wishes" "$(q "$S" "SELECT count(*) FROM services WHERE want = 'running'")" 2
  eq "rerun after $step: no sweep line" "$(grep -c 'sweep[.]sh' "$CRONTAB" || true)" 0
done
# After the mark, installing the unit and watchdog remains safe to rerun.
for step in migrated unit watchdog; do
  rm -rf "$S"; fixture_host "$REPO" "$PORT_A" "$PORT_B"; : > "$CRONTAB"; : > "$SYSTEMCTL_LOG"; rm -f "$UNIT"
  rc=0; out="$(cd "$REPO" && DS_SWITCH_CRASH="$step" PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1)" || rc=$?
  if [ "$rc" -eq 9 ] && [ -e "$S/.loop-migrated" ]; then good; else bad "crash after $step: rc=$rc $out"; fi
  if grep -qxF -- '--user start ds-loop.service' "$SYSTEMCTL_LOG"; then bad "crash after $step started the loop"; else good; fi
  # One driver or the other at every step: the crontab write swaps them, so the host is never without.
  case "$step" in
    migrated|unit) wd=0 ;;
    *) wd=1 ;;
  esac
  eq "crash after $step: sweep line" "$(grep -c 'sweep[.]sh' "$CRONTAB" || true)" 0
  eq "crash after $step: watchdog line" "$(grep -c 'bin/loop/loop.sh --ensure' "$CRONTAB" || true)" "$wd"
  if [ "$step" = watchdog ]; then
    if [ -e "$S/.loop-reconcile" ]; then good; else bad "crash after $step: the loop it starts should look at the files first"; fi
  fi
  rc=0; out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1)" || rc=$?
  eq "rerun after $step exits 0 ($out)" "$rc" 0
  if grep -qF 'nothing to import' <<<"$out"; then good; else bad "rerun after $step imports nothing: $out"; fi
  eq "rerun after $step: no sweep line" "$(grep -c 'sweep[.]sh' "$CRONTAB" || true)" 0
  eq "rerun after $step: one watchdog line" "$(grep -c 'bin/loop/loop.sh --ensure' "$CRONTAB")" 1
  if grep -qxF -- '--user start ds-loop.service' "$SYSTEMCTL_LOG"; then good; else bad "rerun after $step should start the loop"; fi
done

# --- U164: the install writes a crontab line cron accepts, whatever PATH it runs with ---
# A PATH with repeats, missing folders and empty entries gives a cron line with each folder
# once, the Orca CLI folder first and no missing folders; the unit matches; a rerun changes nothing.
U164_CLI="$TMP/u164-cli"; U164_B="$TMP/u164-b"; U164_C="$TMP/u164-c"
mkdir -p "$U164_CLI" "$U164_B" "$U164_C"; ln -s "$STUB/orca" "$U164_CLI/orca"
U164_MISSING="$TMP/u164-missing"
rm -rf "$U164_MISSING"
fresh_host; rm -f "$UNIT"
rc=0; out="$(cd "$REPO" && ORCA_USER_DATA_PATH="$HOME/.config/orca" ORCA_CLI_BIN_DIR="$U164_CLI" PATH="$U164_CLI:$STUB:$U164_B:$STUB:$U164_MISSING:$U164_B:$U164_C:" ./bin/host/install.sh "$DEST" 2>&1)" || rc=$?
eq "U164 dirty PATH exits 0 ($out)" "$rc" 0
u164_line="$(grep -F 'bin/loop/loop.sh' "$CRONTAB")"
u164_path="${u164_line#*" PATH='"}"; u164_path="${u164_path%%"' "*}"
eq "U164 the Orca CLI folder leads" "${u164_path%%:*}" "$U164_CLI"
if grep -qF "$U164_MISSING" <<<"$u164_path"; then bad "U164 a missing folder must not reach the line: $u164_path"; else good; fi
case "$u164_path" in *::* ) bad "U164 an empty entry must not reach the line: $u164_path" ;; *) good ;; esac
for d in "$U164_CLI" "$STUB" "$U164_B" "$U164_C"; do
  _occ="$(printf '%s' ":$u164_path:" | grep -oF ":$d:" | wc -l)"; _occ="$(printf '%s' "$_occ" | tr -d '[:space:]')"
  if [ "$_occ" = 1 ]; then good; else bad "U164 $d should occur once, got $_occ: $u164_path"; fi
done
if PATH="$u164_path" command -v git >/dev/null 2>&1 && PATH="$u164_path" command -v jq >/dev/null 2>&1 \
  && PATH="$u164_path" command -v claude >/dev/null 2>&1 && PATH="$u164_path" command -v orca >/dev/null 2>&1 \
  && PATH="$u164_path" command -v bun >/dev/null 2>&1; then good; else bad "U164 the install's tools must resolve on the cleaned PATH: $u164_path"; fi
if [ "$(unit_path)" = "$u164_path" ]; then good; else bad "U164 the unit and the line share the cleaned PATH: $(unit_path) vs $u164_path"; fi
was164="$u164_line"
( cd "$REPO" && ORCA_USER_DATA_PATH="$HOME/.config/orca" ORCA_CLI_BIN_DIR="$U164_CLI" PATH="$U164_CLI:$STUB:$U164_B:$STUB:$U164_MISSING:$U164_B:$U164_C:" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ "$(grep -F 'bin/loop/loop.sh' "$CRONTAB")" = "$was164" ]; then good; else bad "U164 a second install with the same PATH leaves the line as it is"; fi
# A PATH that is still too long after cleaning exits non-zero with one line, and the crontab is untouched.
U164_LONG=""; i=0
while [ "$i" -lt 25 ]; do d="$TMP/u164-long-$(printf '%03d' "$i")-abcdefghijklmnopqrstuvwxyz0123456789"; mkdir -p "$d"; U164_LONG="$U164_LONG:$d"; i=$((i + 1)); done
U164_LONG="$STUB$U164_LONG"
cp "$CRONTAB" "$TMP/u164-cron-before"
rc=0; out="$(cd "$REPO" && ORCA_USER_DATA_PATH="$HOME/.config/orca" ORCA_CLI_BIN_DIR="$U164_CLI" PATH="$U164_CLI:$U164_LONG" ./bin/host/install.sh "$DEST" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then good; else bad "U164 a too-long line must fail the install"; fi
if grep -qF "install: the loop's cron line is " <<<"$out" && grep -qF "cron accepts about 1000. Run the install from a shell with a shorter PATH." <<<"$out"; then good; else bad "U164 the failure names the byte count and the fix: $out"; fi
if cmp -s "$CRONTAB" "$TMP/u164-cron-before"; then good; else bad "U164 a too-long line must leave the crontab untouched"; fi


echo "install-switch: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
