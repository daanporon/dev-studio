#!/usr/bin/env bash
# install.sh — pointer link, loop unit and watchdog, Orca data path (first part of the split install tests).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
# shellcheck source=tests/lib/install-setup.sh
. "$ROOT/tests/lib/install-setup.sh"
# A complete skill installation still fails --check without the required loop.
rc=0; out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh --check 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && grep -qF 'loop is not installed' <<<"$out"; then good; else bad "--check must require the loop: rc=$rc $out"; fi

# Pre-make the pointer as a symlink to the repo, then run install FROM INSIDE that symlink — the
# exact scenario that produced the self-link on the host.
ln -s "$REPO" "$HOME/.dev-studio"
( cd "$HOME/.dev-studio" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )

# The pointer must resolve to the REAL repo, not loop back on itself.
resolved="$(cd "$HOME/.dev-studio" 2>/dev/null && pwd -P || echo LOOP)"
if [ "$resolved" = "$REPO" ]; then good; else bad "pointer should resolve to [$REPO], got [$resolved]"; fi
if [ -f "$HOME/.dev-studio/bin/host/install.sh" ]; then good; else bad "pointer not reachable (symlink loop)"; fi
if [ -f "$DEST/ds-fake.md" ]; then good; else bad "command ds-fake.md not linked"; fi

# Running it AGAIN (idempotent) must not break the now-correct link.
( cd "$HOME/.dev-studio" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
resolved2="$(cd "$HOME/.dev-studio" 2>/dev/null && pwd -P || echo LOOP)"
if [ "$resolved2" = "$REPO" ]; then good; else bad "re-run should keep target [$REPO], got [$resolved2]"; fi

# Orca nested-worker-depth preflight (read-only). Must handle the SPACE after the colon that
# Python's json.dump writes ("nestedWorkerMaxDepth": 5) — the regression that read empty + errored.
printf '{"settings": {"nestedWorkerMaxDepth": 5}}' > "$TMP/od5.json"
out5="$(cd "$HOME/.dev-studio" && DS_ORCA_DATA="$TMP/od5.json" PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1)"
if grep -qF 'this host: 5 (ok)' <<<"$out5"; then good; else bad "spaced depth 5 should read 'ok 5', got: $(printf '%s' "$out5" | grep -i 'nested\|integer' | head -1)"; fi
if grep -qF 'integer expression' <<<"$out5"; then bad "preflight errored on a spaced value"; else good; fi
printf '{"settings": {"nestedWorkerMaxDepth": 1}}' > "$TMP/od1.json"
out1="$(cd "$HOME/.dev-studio" && DS_ORCA_DATA="$TMP/od1.json" PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1)"
if grep -qF 'needs >= 2' <<<"$out1"; then good; else bad "spaced depth 1 should warn"; fi

# The loop is the only driver; retired install options cannot disable it.
fresh_host(){ rm -rf "$REPO/state"; : > "$CRONTAB"; }
for option in --no-loop --no-sweep --sweep; do
  rc=0; out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$option" "$DEST" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] && grep -qF 'the loop is required' <<<"$out"; then good; else bad "retired option $option: rc=$rc $out"; fi
done
fresh_host
rc=0; out="$(cd "$REPO" && FAKE_NOSYSTEMD=1 PATH="$STUB_NOCRON" ./bin/host/install.sh "$DEST" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && [ ! -e "$REPO/state/.loop-migrated" ]; then good; else bad "no loop driver must fail installation: rc=$rc $out"; fi
rc=0; out="$(cd "$REPO" && PATH="$STUB_NOCRON" ./bin/host/install.sh "$DEST" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && [ ! -e "$REPO/state/.loop-migrated" ] && grep -qF 'required loop watchdog' <<<"$out"; then good; else bad "systemd without cron must fail before migration: rc=$rc $out"; fi

# Bun (the loop, the board) is required and checked, never installed: neither on PATH nor in
# ~/.bun/bin (where its installer puts it) fails the install naming ~/.bun/bin and writes nothing;
# in ~/.bun/bin alone it is found.
mkdir -p "$TMP/home-nobun"
rc=0; out="$( cd "$REPO" && HOME="$TMP/home-nobun" PATH="$STUB_NOBUN" ./bin/host/install.sh 2>&1 )" || rc=$?
if [ "$rc" -ne 0 ]; then good; else bad "no bun should fail the install"; fi
# shellcheck disable=SC2088  # the message names ~/.bun/bin literally
if grep -qF "install: 'bun' not found" <<<"$out" && grep -qF '~/.bun/bin' <<<"$out" && grep -qF 'https://bun.sh/install' <<<"$out"; then good; else bad "no bun should name ~/.bun/bin and the install line: $out"; fi
if [ -z "$(ls -A "$TMP/home-nobun")" ]; then good; else bad "a failed bun preflight must write nothing"; fi
# The bootstrap execs the install on the bun it found: a wrapper in ~/.bun/bin that marks its use.
mkdir -p "$HOME/.bun/bin"; printf '#!/bin/bash\n: > "%s"\nexec "%s" "$@"\n' "$TMP/home-bun-used" "$BUN_REAL" > "$HOME/.bun/bin/bun"; chmod +x "$HOME/.bun/bin/bun"
rm -f "$TMP/home-bun-used"
out="$( cd "$REPO" && PATH="$STUB_NOBUN" ./bin/host/install.sh "$DEST" 2>&1 )" || true
if [ -e "$TMP/home-bun-used" ] && grep -qF "bun: $("$BUN_REAL" --version) (ok)" <<<"$out"; then good; else bad "bun in ~/.bun/bin should be found: $out"; fi
rm -rf "$HOME/.bun"

# The loop installs by default: the systemd user unit rendered for this checkout, enabled and
# started, and one `loop.sh --ensure` cron line however often install runs, other lines kept, and the
# sweep's line gone.
UNIT="$HOME/.config/systemd/user/ds-loop.service"
fresh_host; : > "$SYSTEMCTL_LOG"; rm -f "$UNIT"
printf '0 3 * * * /usr/bin/true\n* * * * * [ -x %s/bin/%s.sh ] && %s/bin/%s.sh\n' "$REPO" sweep "$REPO" sweep > "$CRONTAB"
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ "$(grep -c 'bin/loop/loop.sh' "$CRONTAB" 2>/dev/null || true)" = 1 ]; then good; else bad "default install should add one loop cron line: $(cat "$CRONTAB")"; fi
if grep -qF "* * * * * [ -x $REPO/bin/loop/loop.sh ] && PATH=" "$CRONTAB" && grep -qF "$REPO/bin/loop/loop.sh --ensure >> $REPO/state/loop-cron.log 2>&1" "$CRONTAB"; then good; else bad "loop line shape: $(cat "$CRONTAB")"; fi
if [ "$(grep -c 'sweep[.]sh' "$CRONTAB" || true)" = 0 ]; then good; else bad "the switch must take the sweep line out: $(cat "$CRONTAB")"; fi
if grep -qF '/usr/bin/true' "$CRONTAB"; then good; else bad "the switch dropped another crontab line"; fi
if [ -f "$UNIT" ] && grep -qxF "ExecStart=$STUB/bun $REPO/bin/loop/main.ts" "$UNIT" && grep -qxF "Environment=\"DS_STATE_ROOT=$REPO/state\"" "$UNIT"; then good; else bad "unit file should be rendered for this checkout: $(cat "$UNIT" 2>/dev/null || echo missing)"; fi
if grep -qxF "ConditionPathExists=$REPO/bin/loop/main.ts" "$UNIT"; then good; else bad "the unit needs bin/loop/main.ts in its checkout (the rollback): $(cat "$UNIT")"; fi
if grep -v '^#' "$UNIT" | grep -qF '@'; then bad "unit file keeps a template field: $(grep -v '^#' "$UNIT" | grep -F '@')"; else good; fi
if grep -qxF -- '--user daemon-reload' "$SYSTEMCTL_LOG" && grep -qxF -- '--user enable ds-loop.service' "$SYSTEMCTL_LOG" && grep -qxF -- '--user start ds-loop.service' "$SYSTEMCTL_LOG"; then good; else bad "install should reload, enable and start the unit: $(cat "$SYSTEMCTL_LOG")"; fi
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ "$(grep -c 'bin/loop/loop.sh' "$CRONTAB")" = 1 ]; then good; else bad "install twice should keep exactly one loop line"; fi
# U185: a pre-move watchdog line (bin/loop.sh, now a shim) is replaced, not doubled, and its CLI pin carries.
# The crontab and unit are put back after, so the pin does not leak into the cases below.
cp "$CRONTAB" "$TMP/crontab.u185"; cp "$UNIT" "$TMP/unit.u185"; rm -f "$UNIT"
printf "0 3 * * * /usr/bin/true\n* * * * * [ -x %s/bin/loop.sh ] && PATH='/pin/cli:/usr/bin' DS_ORCA_CLI_BIN_DIR=/pin/cli %s/bin/loop.sh --ensure >> %s/state/loop-cron.log 2>&1\n" "$REPO" "$REPO" "$REPO" > "$CRONTAB"
( cd "$REPO" && env -u DS_ORCA_CLI_BIN_DIR -u ORCA_CLI_BIN_DIR PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ "$(grep -c 'loop.sh --ensure' "$CRONTAB")" = 1 ] && ! grep -qF "$REPO/bin/loop.sh" "$CRONTAB"; then good; else bad "a pre-U185 loop line should be replaced by the new one: $(cat "$CRONTAB")"; fi
if grep -F "$REPO/bin/loop/loop.sh --ensure" "$CRONTAB" | grep -qF "DS_ORCA_CLI_BIN_DIR='/pin/cli' "; then good; else bad "the old line's CLI pin should carry over: $(cat "$CRONTAB")"; fi
cp "$TMP/crontab.u185" "$CRONTAB"; cp "$TMP/unit.u185" "$UNIT"
# A path containing this checkout path is still a foreign checkout. Both shell-word
# edges must match; quoting a managed path must not prevent its retirement.
retired_path="$(printf '%s/bin/%s.sh' "$REPO" sweep)"
foreign_suffix="* * * * * /mnt/backup$retired_path"
foreign_quoted="* * * * * '/mnt/backup$retired_path'"
foreign_child="* * * * * $retired_path/backup"
foreign_extension="* * * * * $retired_path.old"
foreign_nested="* * * * * $retired_path$retired_path"
managed_quoted="* * * * * '$retired_path'"
managed_double_quoted="* * * * * \"$retired_path\""
managed_after_foreign="* * * * * /mnt/backup$retired_path; $retired_path"
printf '%s\n' "$foreign_suffix" "$foreign_quoted" "$foreign_child" "$foreign_extension" "$foreign_nested" "$managed_quoted" "$managed_double_quoted" "$managed_after_foreign" >> "$CRONTAB"
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
for foreign in "$foreign_suffix" "$foreign_quoted" "$foreign_child" "$foreign_extension" "$foreign_nested"; do
  if grep -qxF "$foreign" "$CRONTAB"; then good; else bad "install pruned a foreign cron path: $foreign"; fi
done
for managed in "$managed_quoted" "$managed_double_quoted" "$managed_after_foreign"; do
  if grep -qxF "$managed" "$CRONTAB"; then bad "install retained a managed legacy cron path: $managed"; else good; fi
done
# Remove only the synthetic foreign entries from this fake crontab before the
# remaining install/recovery fixtures assert the absence of legacy jobs.
grep -vF "$retired_path" "$CRONTAB" > "$CRONTAB.tmp"; mv "$CRONTAB.tmp" "$CRONTAB"
# Orca's data path (U50): no path and the default write no line, so the unit reads as the template does;
# a custom path is written, escaped for systemd; a later install without the variable keeps it, the
# default clears it.
orca_line() { grep -F 'ORCA_USER_DATA_PATH' "$UNIT" || true; }
no_orca_line() { # <what>
  if [ -z "$(orca_line)" ] && grep -A1 -F 'Environment="PATH=' "$UNIT" | grep -qxF 'Restart=on-failure'; then good; else bad "$1 should leave the unit without a data path or a gap: $(cat "$UNIT")"; fi
}
rm -f "$UNIT"
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
no_orca_line "no path"
( cd "$REPO" && ORCA_USER_DATA_PATH="$HOME/.config/orca" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
no_orca_line "the default path"
( cd "$REPO" && ORCA_USER_DATA_PATH="$HOME/.config/orca/" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
no_orca_line "the default path with a trailing slash"
XDG_UNIT="$TMP/xdg/systemd/user/ds-loop.service"
( cd "$REPO" && XDG_CONFIG_HOME="$TMP/xdg" ORCA_USER_DATA_PATH="$TMP/xdg/orca" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ -f "$XDG_UNIT" ] && ! grep -qF ORCA_USER_DATA_PATH "$XDG_UNIT"; then good; else bad "the default under XDG_CONFIG_HOME should write no line: $(cat "$XDG_UNIT" 2>/dev/null || echo missing)"; fi
( cd "$REPO" && ORCA_USER_DATA_PATH="$TMP/custom orca" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ "$(orca_line)" = "Environment=\"ORCA_USER_DATA_PATH=$TMP/custom orca\"" ]; then good; else bad "a custom path should be in the unit: $(cat "$UNIT")"; fi
if grep -A1 -F 'Environment="PATH=' "$UNIT" | grep -qF ORCA_USER_DATA_PATH; then good; else bad "the data path line belongs after PATH: $(cat "$UNIT")"; fi
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ "$(orca_line)" = "Environment=\"ORCA_USER_DATA_PATH=$TMP/custom orca\"" ]; then good; else bad "an install without the variable should keep the unit's path: $(cat "$UNIT")"; fi
( cd "$REPO" && ORCA_USER_DATA_PATH="$HOME/.config/orca" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
no_orca_line "going back to the default path"
( cd "$REPO" && ORCA_USER_DATA_PATH='/o/100%"\x' PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ "$(orca_line)" = 'Environment="ORCA_USER_DATA_PATH=/o/100%%\"\\x"' ]; then good; else bad "a custom path should be escaped for systemd: $(orca_line)"; fi
if [ "$(grep -c 'ORCA_DATA_ENV' "$UNIT" || true)" = 0 ]; then good; else bad "the unit keeps the template's data path field: $(cat "$UNIT")"; fi
# A running loop keeps its environment, so a changed path restarts it; an unchanged one does not.
: > "$SYSTEMCTL_LOG"
( cd "$REPO" && ORCA_USER_DATA_PATH="$TMP/other" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if grep -qxF -- '--user try-restart ds-loop.service' "$SYSTEMCTL_LOG"; then good; else bad "a changed path should restart a running loop: $(cat "$SYSTEMCTL_LOG")"; fi
: > "$SYSTEMCTL_LOG"
( cd "$REPO" && ORCA_USER_DATA_PATH="$TMP/other" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if grep -qF try-restart "$SYSTEMCTL_LOG"; then bad "an unchanged path should not restart the loop: $(cat "$SYSTEMCTL_LOG")"; else good; fi
: > "$SYSTEMCTL_LOG"
( cd "$REPO" && ORCA_USER_DATA_PATH="$HOME/.config/orca" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if grep -qxF -- '--user try-restart ds-loop.service' "$SYSTEMCTL_LOG"; then good; else bad "clearing the path should restart a running loop: $(cat "$SYSTEMCTL_LOG")"; fi

# --- leak hooks (public-readiness U11): the repo turns its own hooks on, so the install never touches a clone ---
# A stub with real git, the checkout made a clone of a dev-studio origin (its main carries tests/leak-guard.sh) and
# a home_repo clone of it: the install and --check change no clone's git config and say nothing about leak hooks.
STUB_GIT="$TMP/stub-git"; mkdir -p "$STUB_GIT"
for t in "$STUB"/*; do ln -s "$t" "$STUB_GIT/${t##*/}"; done
rm "$STUB_GIT/git"; ln -s "$(command -v git)" "$STUB_GIT/git"
lg() { env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE GIT_CONFIG_NOSYSTEM=1 git -c user.name=t -c user.email=t@example.com "$@"; }
w="$TMP/seed-ds"; lg init -q -b main "$w"; echo r > "$w/README.md"; mkdir -p "$w/tests"; echo g > "$w/tests/leak-guard.sh"
lg -C "$w" add -A && lg -C "$w" commit -qm root && lg init -q --bare -b main "$TMP/ds-origin.git" && lg -C "$w" push -q "$TMP/ds-origin.git" main
lg -C "$REPO" init -q -b main && lg -C "$REPO" remote add origin "$TMP/ds-origin.git" && lg -C "$REPO" fetch -q origin \
  && lg -C "$REPO" remote set-head origin main
lg clone -q "$TMP/ds-origin.git" "$TMP/home-ds"
mkdir -p "$REPO/state/pa"
printf '{"home_repo":"path:%s"}\n' "$TMP/home-ds" > "$REPO/state/pa/dispatcher.json"
hooks_cfg() { lg -C "$1" config --get-regexp '^core\.hookspath$' || true; }
out="$(cd "$REPO" && PATH="$STUB_GIT" ./bin/host/install.sh --check 2>&1)" || true
if grep -qi 'leak' <<<"$out"; then bad "--check should say nothing about leak hooks: $out"; else good; fi
( cd "$REPO" && PATH="$STUB_GIT" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
eq "the install leaves the host checkout's git config alone" "$(hooks_cfg "$REPO")" ""
eq "the install leaves a dev-studio home_repo's git config alone" "$(hooks_cfg "$TMP/home-ds")" ""
rm -rf "$REPO/.git" "$REPO/state/pa"

echo "install: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
