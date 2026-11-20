#!/usr/bin/env bash
# install-cli-path.sh — Orca CLI dir on the loop PATH, the cron line and its PATH (U54, U53).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
# shellcheck source=tests/lib/install-setup.sh
. "$ROOT/tests/lib/install-setup.sh"
install_prelude
# Orca's own CLI leads the loop's PATH (U54): an older `orca` earlier on the shell's PATH failed every
# run-switch. None: PATH as it is. <Orca data path>/cli/bin when it exists, or $ORCA_CLI_BIN_DIR, first
# (once), in the unit and the cron line; --check warns while the unit's orca is another one.
unit_path() { sed -n 's/^Environment="PATH=\(.*\)"$/\1/p' "$UNIT"; }
ORCA_DEFAULT="$HOME/.config/orca"
rm -rf "$ORCA_DEFAULT/cli"
( cd "$REPO" && ORCA_USER_DATA_PATH="$ORCA_DEFAULT" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ "$(unit_path)" = "$STUB" ]; then good; else bad "no Orca CLI dir should leave the unit's PATH as it is: $(unit_path)"; fi
if grep -F 'bin/loop/loop.sh' "$CRONTAB" | grep -qF "PATH='$STUB' "; then good; else bad "no Orca CLI dir should leave the loop line's PATH as it is: $(grep -F bin/loop/loop.sh "$CRONTAB")"; fi
mkdir -p "$ORCA_DEFAULT/cli/bin"; cp "$STUB/orca" "$ORCA_DEFAULT/cli/bin/orca"
rc=0; out="$(cd "$REPO" && ORCA_USER_DATA_PATH="$ORCA_DEFAULT" PATH="$STUB" ./bin/host/install.sh --check 2>&1)" || rc=$?
if grep -qF "⚠ the loop's unit resolves 'orca' to $STUB/orca, not Orca's CLI in $ORCA_DEFAULT/cli/bin" <<<"$out"; then good; else bad "--check should warn while the unit's orca is not Orca's CLI: $out"; fi
: > "$SYSTEMCTL_LOG"
( cd "$REPO" && ORCA_USER_DATA_PATH="$ORCA_DEFAULT" PATH="$ORCA_DEFAULT/cli/bin:$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ "$(unit_path)" = "$ORCA_DEFAULT/cli/bin:$STUB" ]; then good; else bad "the unit's PATH should lead with Orca's CLI dir, once: $(unit_path)"; fi
if grep -F 'bin/loop/loop.sh' "$CRONTAB" | grep -qF "PATH='$ORCA_DEFAULT/cli/bin:$STUB' "; then good; else bad "the loop line's PATH should lead with Orca's CLI dir: $(grep -F bin/loop/loop.sh "$CRONTAB")"; fi
if grep -qxF -- '--user try-restart ds-loop.service' "$SYSTEMCTL_LOG"; then good; else bad "a changed PATH should restart a running loop: $(cat "$SYSTEMCTL_LOG")"; fi
rc=0; out="$(cd "$REPO" && ORCA_USER_DATA_PATH="$ORCA_DEFAULT" PATH="$STUB" ./bin/host/install.sh --check 2>&1)" || rc=$?
if grep -qF "⚠ the loop's unit runs orca" <<<"$out"; then bad "--check should not warn once the unit runs Orca's CLI: $out"; else good; fi
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ "$(unit_path)" = "$ORCA_DEFAULT/cli/bin:$STUB" ]; then good; else bad "the default data path's CLI dir should be found without the variable: $(unit_path)"; fi
mkdir -p "$TMP/clibin"; cp "$STUB/orca" "$TMP/clibin/orca"
( cd "$REPO" && ORCA_CLI_BIN_DIR="$TMP/clibin/" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ "$(unit_path)" = "$TMP/clibin:$STUB" ]; then good; else bad "ORCA_CLI_BIN_DIR should lead the unit's PATH: $(unit_path)"; fi
if grep -qxF "Environment=\"DS_ORCA_CLI_BIN_DIR=$TMP/clibin\"" "$UNIT"; then good; else bad "the unit should preserve the explicit CLI directory"; fi
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if grep -qxF "Environment=\"DS_ORCA_CLI_BIN_DIR=$TMP/clibin\"" "$UNIT" && [ "$(unit_path)" = "$TMP/clibin:$STUB" ]; then good; else bad "reinstall should retain the CLI pin and PATH"; fi
if grep -F 'bin/loop/loop.sh' "$CRONTAB" | grep -qF "DS_ORCA_CLI_BIN_DIR='$TMP/clibin' "; then good; else bad "cron should carry the explicit CLI pin"; fi
mkdir -p "$TMP/other-cli"; cp "$STUB/orca" "$TMP/other-cli/orca"
( cd "$REPO" && DS_ORCA_CLI_BIN_DIR="$TMP/clibin" ORCA_CLI_BIN_DIR="$TMP/other-cli" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ "$(unit_path)" = "$TMP/clibin:$STUB" ]; then good; else bad "the DS CLI override should win in the installer too"; fi
# Independent data-path scenarios begin without a saved CLI override in either driver.
sed -i '/^Environment="DS_ORCA_CLI_BIN_DIR=/d' "$UNIT"
: > "$CRONTAB"
# A custom data path: its CLI dir, kept by an install from a shell without the variable as the path is.
mkdir -p "$TMP/odata 1/cli/bin"
( cd "$REPO" && ORCA_USER_DATA_PATH="$TMP/odata 1" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ "$(unit_path)" = "$TMP/odata 1/cli/bin:$STUB" ]; then good; else bad "a custom data path's CLI dir should lead the unit's PATH: $(unit_path)"; fi
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ "$(unit_path)" = "$TMP/odata 1/cli/bin:$STUB" ]; then good; else bad "an install without the variable should keep the custom data path's CLI dir: $(unit_path)"; fi
( cd "$REPO" && ORCA_USER_DATA_PATH="$ORCA_DEFAULT" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
rm -rf "$ORCA_DEFAULT/cli"
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
# The cron line carries the data path by the same rules, with and without systemd (U53).
# Each check runs the rendered line the way cron does, with a stub bin/loop/loop.sh recording what it receives.
LOOP_REAL="$TMP/loop.sh.real"; cp "$REPO/bin/loop/loop.sh" "$LOOP_REAL"
LOOP_LOG="$TMP/loop-stub.log"
cat > "$REPO/bin/loop/loop.sh" <<FAKE
#!/usr/bin/env bash
printf '%s|%s\n' "\$1" "\${ORCA_USER_DATA_PATH-UNSET}" >> "$LOOP_LOG"
printf '%s\n' "\${DS_ORCA_CLI_BIN_DIR-UNSET}" > "$TMP/loop-cli.log"
FAKE
loop_line() { grep -F 'bin/loop/loop.sh' "$CRONTAB"; }
# The command cron hands to sh: an unescaped % ends it and \% is %. Crons differ on \\: "collapse" reads it
# as one backslash, "keep" leaves both.
cron_cmd() { # <line> <collapse|keep>
  local in="${1#"* * * * * "}" out="" i c esc=0
  for ((i = 0; i < ${#in}; i++)); do
    c="${in:i:1}"
    if [ "$esc" = 1 ]; then
      esc=0
      if [ "$c" = % ] || { [ "$c" = "\\" ] && [ "$2" = collapse ]; }; then out+="$c"; else out+="\\$c"; fi
    elif [ "$c" = "\\" ]; then esc=1
    elif [ "$c" = % ]; then break
    else out+="$c"; fi
  done
  printf '%s' "$out"
}
# The path a loop started by the line receives, under both readings, from cron's bare environment.
line_gives() { # <what> <expected value, or UNSET>
  local how got
  for how in collapse keep; do
    : > "$LOOP_LOG"
    env -i HOME="$HOME" /bin/sh -c "$(cron_cmd "$(loop_line)" "$how")" 2>/dev/null || true
    got="$(cat "$LOOP_LOG")"
    if [ "$got" = "--ensure|$2" ]; then good; else bad "$1: cron ($how) should start the loop with [$2], got [$got]; line: $(loop_line)"; fi
  done
}
install_nosd() { ( cd "$REPO" && FAKE_NOSYSTEMD=1 PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1 ); }
fresh_host; rm -f "$UNIT"
out="$(install_nosd)"
line_gives "no path" UNSET
if loop_line | grep -qF ORCA_USER_DATA_PATH; then bad "no path should leave the line without one: $(loop_line)"; else good; fi
out="$(ORCA_USER_DATA_PATH="$TMP/other" install_nosd)"
line_gives "a custom path" "$TMP/other"
if [ ! -e "$UNIT" ]; then good; else bad "no systemd should write no unit"; fi
if grep -qF 'carried only by' <<<"$out"; then bad "the line carries the path now, so no warning: $out"; else good; fi
was="$(loop_line)"; : > "$LOOP_LOG"
out="$(install_nosd)"
if [ "$(loop_line)" = "$was" ]; then good; else bad "an install without the variable should keep the line: $(loop_line)"; fi
if [ -s "$LOOP_LOG" ]; then bad "an unchanged path should not stop the loop: $(cat "$LOOP_LOG")"; else good; fi
out="$(ORCA_USER_DATA_PATH="$TMP/other" install_nosd)"
if [ "$(loop_line)" = "$was" ] && [ ! -s "$LOOP_LOG" ]; then good; else bad "the same path again should change nothing: $(loop_line); $(cat "$LOOP_LOG")"; fi
# shellcheck disable=SC1003  # a backslash at the end of a value is the case
for odd in "$TMP/custom orca" "$TMP/it's 100%" '/o/a\%b' '/o/a\\b\' "/o/\$HOME/\`x\`/\"q\"/'" '/o/%%'; do
  : > "$LOOP_LOG"
  out="$(ORCA_USER_DATA_PATH="$odd" install_nosd)"
  if grep -q '^--stop|' "$LOOP_LOG"; then good; else bad "a changed path should stop the running loop ($odd): $(cat "$LOOP_LOG")"; fi
  if grep -qF 'the cron line starts it' <<<"$out"; then good; else bad "the line starts the loop after a change: $out"; fi
  line_gives "the path $odd" "$odd"
  was="$(loop_line)"
  out="$(install_nosd)"
  if [ "$(loop_line)" = "$was" ]; then good; else bad "keeping $odd should not change the line: $was -> $(loop_line)"; fi
  line_gives "the kept path $odd" "$odd"
done
if [ "$(grep -c 'bin/loop/loop.sh' "$CRONTAB")" = 1 ]; then good; else bad "reruns should leave one line: $(cat "$CRONTAB")"; fi
: > "$LOOP_LOG"
out="$(ORCA_USER_DATA_PATH="$HOME/.config/orca/" install_nosd)"
if grep -q '^--stop|' "$LOOP_LOG"; then good; else bad "clearing the path should stop the running loop: $(cat "$LOOP_LOG")"; fi
line_gives "the default path" UNSET
# The line's PATH picks the loop's orca (U54): a changed one stops the running loop too, an unchanged one not.
: > "$LOOP_LOG"
( cd "$REPO" && FAKE_NOSYSTEMD=1 ORCA_CLI_BIN_DIR="$TMP/clibin" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if grep -q '^--stop|' "$LOOP_LOG" && loop_line | grep -qF "PATH='$TMP/clibin:$STUB' "; then good; else bad "a changed PATH should stop the running loop: $(cat "$LOOP_LOG"); $(loop_line)"; fi
: > "$LOOP_LOG"
( cd "$REPO" && FAKE_NOSYSTEMD=1 ORCA_CLI_BIN_DIR="$TMP/clibin" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ -s "$LOOP_LOG" ]; then bad "an unchanged PATH should not stop the loop: $(cat "$LOOP_LOG")"; else good; fi
( cd "$REPO" && FAKE_NOSYSTEMD=1 PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if loop_line | grep -qF "DS_ORCA_CLI_BIN_DIR='$TMP/clibin' "; then good; else bad "reinstall without systemd should retain the CLI pin"; fi
# A stale unit without a pin does not outrank the live cron pin when systemd is unavailable.
printf '[Service]\nEnvironment="PATH=%s"\n' "$STUB" > "$UNIT"
( cd "$REPO" && FAKE_NOSYSTEMD=1 PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if loop_line | grep -qF "DS_ORCA_CLI_BIN_DIR='$TMP/clibin' "; then good; else bad "an unpinned stale unit must not make reinstall drop the cron CLI pin"; fi
rm -f "$UNIT"
env -i HOME="$HOME" PATH=/usr/bin:/bin sh -c "$(cron_cmd "$(loop_line)" keep)"
if [ "$(cat "$TMP/loop-cli.log")" = "$TMP/clibin" ]; then good; else bad "a clean cron shell should pass the CLI pin to the loop"; fi
( cd "$REPO" && FAKE_NOSYSTEMD=1 PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if loop_line | grep -qF ORCA_USER_DATA_PATH; then bad "the default should clear the line: $(loop_line)"; else good; fi
# A unit that could not be enabled is no working unit either: the line carries the path too.
rm -f "$UNIT"
( cd "$REPO" && FAKE_NOENABLE=1 ORCA_USER_DATA_PATH="$TMP/other" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
line_gives "a unit that could not be enabled" "$TMP/other"
# The stop goes with the line's write: a crash in the wait after it must not lose it, since a rerun sees no
# change. It reaches a loop on a host whose enable failed too.
: > "$LOOP_LOG"
( cd "$REPO" && FAKE_NOENABLE=1 ORCA_USER_DATA_PATH="$TMP/newer" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if grep -q '^--stop|' "$LOOP_LOG"; then good; else bad "a failed enable should stop the loop on a changed path: $(cat "$LOOP_LOG")"; fi
: > "$LOOP_LOG"
rc=0; ( cd "$REPO" && DS_SWITCH_CRASH=watchdog FAKE_NOSYSTEMD=1 ORCA_USER_DATA_PATH="$TMP/other" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 ) || rc=$?
if [ "$rc" = 9 ] && grep -q '^--stop|' "$LOOP_LOG"; then good; else bad "the stop should come before the crash point: rc=$rc $(cat "$LOOP_LOG")"; fi
# Neither a unit nor a crontab can drive the required loop.
rc=0; out="$(cd "$REPO" && FAKE_NOSYSTEMD=1 ORCA_USER_DATA_PATH="$TMP/other" PATH="$STUB_NOCRON" ./bin/host/install.sh "$DEST" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && grep -qF 'required loop watchdog' <<<"$out"; then good; else bad "no driver must fail: rc=$rc $out"; fi

# U5: folders under /nix/store come from the nix/devenv shell the install ran in: out of the loop's PATH,
# the unit and the cron line; a stable profile folder stays.
NIXPROF="$TMP/nixprof/bin"; mkdir -p "$NIXPROF"
NIXPATH="/nix/store/aaa-git-2.4/bin:/nix/store/bbb-jq-1.7/bin:$NIXPROF:$STUB"
( cd "$REPO" && ORCA_USER_DATA_PATH="$TMP/nixdata" PATH="$NIXPATH" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [[ "$(unit_path)" == *"$NIXPROF:$STUB" && "$(unit_path)" != */nix/store/* ]]; then good; else bad "the unit's PATH should drop /nix/store and keep the profile folder: $(unit_path)"; fi
if grep -F 'bin/loop/loop.sh' "$CRONTAB" | grep -qF "$NIXPROF:$STUB' " && ! grep -F 'bin/loop/loop.sh' "$CRONTAB" | grep -qF /nix/store/; then good; else bad "the cron line should carry no /nix/store: $(grep -F bin/loop/loop.sh "$CRONTAB")"; fi
# A PATH too long for cron is refused, naming its biggest contributors.
LONGP=""; for i in $(seq 1 40); do mkdir -p "$TMP/longpath/folder-with-a-long-name-$i"; LONGP="$LONGP:$TMP/longpath/folder-with-a-long-name-$i"; done
rc=0; out="$(cd "$REPO" && ORCA_USER_DATA_PATH="$TMP/nixdata" PATH="$STUB$LONGP" ./bin/host/install.sh "$DEST" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && grep -qF "40 folders under $TMP/longpath" <<<"$out"; then good; else bad "the guard should name the biggest PATH contributors: rc=$rc $out"; fi

echo "install-cli-path: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
