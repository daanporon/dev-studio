# shellcheck shell=bash
# install-setup.sh — the throwaway checkout, HOME, stub PATH and fakes every tests/install*.sh file builds (sourced, not run).
# The caller sets ROOT and `set -euo pipefail`; this runs tests/lib.sh and leaves TMP, REPO, HOME, STUB*, BACKEND, CRONTAB and good/bad/eq.
# shellcheck source=tests/lib.sh
. "$ROOT/tests/lib.sh"
BUN_REAL="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
# Fully physical TMP so `pwd -P` results compare equal to the paths we build (macOS /tmp is a
# symlink to /private/tmp).
TMP="$(cd "$(mktemp -d)" && pwd -P)"
# Every process this test starts is stopped by pid (never a pattern, tests/lib.sh).
OWN_PIDS=""
cleanup() {
  local p
  # shellcheck disable=SC2086  # a list of pids
  for p in $OWN_PIDS; do stop_own "$p"; done
  rm -rf "$TMP"
}
trap cleanup EXIT
# install.sh prefers it over $HOME/.config, so a set one would put the unit outside this test's HOME.
unset XDG_CONFIG_HOME
# An Orca terminal sets it, and the install would write it into every unit below.
unset ORCA_USER_DATA_PATH
# Orca's CLI dir (U54): an Orca terminal sets it, and the install would lead every unit's PATH with it.
unset ORCA_CLI_BIN_DIR
unset DS_ORCA_CLI_BIN_DIR

# A fake checkout with the real bin/ (the install runs the real migration) and one ds-*.md command.
REPO="$TMP/real/dev-studio"; mkdir -p "$REPO/.claude/commands"
cp -r "$ROOT/bin" "$REPO/bin"
mkdir -p "$REPO/systemd"; cp "$ROOT/systemd/ds-loop.service" "$REPO/systemd/ds-loop.service"
printf -- '---\ndescription: x\n---\nhi\n' > "$REPO/.claude/commands/ds-fake.md"

unset CLAUDE_CONFIG_DIR   # the check reads the caller's account otherwise
export HOME="$TMP/home"; mkdir -p "$HOME"
DEST="$HOME/.claude/commands"
# A complete Claude home (every role skill on disk): --check exits non-zero for an account without
# them (accountSkillsCheck), so every --check run below that expects exit 0 uses this one.
# The role skills every account must carry (bin/lib/account-skills.ts, U274).
DS_ROLE_CE_SKILLS="$("$ROOT/bin/ds" account-skills role-skills ce)"
DS_ROLE_USER_SKILLS="$("$ROOT/bin/ds" account-skills role-skills user)"
DS_ROLE_OPTIONAL_USER_SKILLS="$("$ROOT/bin/ds" account-skills role-skills optional)"
mk_skills_home() { # <home>
  local h="$1" ip="$1/.claude/plugins/cache/p/compound-engineering/1" s
  for s in $DS_ROLE_CE_SKILLS; do mkdir -p "$ip/skills/$s"; : > "$ip/skills/$s/SKILL.md"; done
  for s in $DS_ROLE_USER_SKILLS $DS_ROLE_OPTIONAL_USER_SKILLS; do mkdir -p "$h/.claude/skills/$s"; : > "$h/.claude/skills/$s/SKILL.md"; done
  printf '{"version":2,"plugins":{"compound-engineering@compound-engineering-plugin":[{"scope":"user","installPath":"%s"}]}}' "$ip" > "$h/.claude/plugins/installed_plugins.json"
  printf '{"enabledPlugins":{"compound-engineering@compound-engineering-plugin":true}}' > "$h/.claude/settings.json"
}

pass=0; fail=0
good(){ pass=$((pass + 1)); }
bad(){ fail=$((fail + 1)); echo "  FAIL: $1" >&2; }

# --- stub PATH: fake orca/claude/git + real coreutils, nothing else ----------------
# Every install run below uses ONLY this PATH, so preflight never depends on the host —
# a missing tool is simulated by omitting it from the stub, not by hoping the host lacks it.
STUB="$TMP/stub"; mkdir -p "$STUB"
for t in bash dirname mkdir ln grep sed basename readlink rm head cat awk sleep ps; do
  ln -s "$(command -v "$t")" "$STUB/$t"
done
ln -s "$(command -v jq)" "$STUB/jq"
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB/claude"; chmod +x "$STUB/claude"
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB/git"; chmod +x "$STUB/git"
ln -s "$BUN_REAL" "$STUB/bun"   # real: the migration and the loop run on it
# Fake systemctl: records each call in $SYSTEMCTL_LOG; FAKE_NOSYSTEMD=1 is a host without a
# systemd user session (show-environment fails); FAKE_NOENABLE=1 fails the enable.
cat > "$STUB/systemctl" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
[ "${FAKE_NOSYSTEMD:-0}" = 1 ] && [ "${2:-}" = show-environment ] && exit 1
[ "${FAKE_NOENABLE:-0}" = 1 ] && [ "${2:-}" = enable ] && exit 1
exit 0
FAKE
chmod +x "$STUB/systemctl"
export SYSTEMCTL_LOG="$TMP/systemctl.log"
cat > "$STUB/orca" <<'FAKE'
#!/usr/bin/env bash
# Fake orca: canned reachable runtime + one managed account. FAKE_ORCA_DOWN=1 makes the
# runtime unreachable; FAKE_ORCA_NOACCT=1 empties the account list (no login at all);
# FAKE_ORCA_SYSLOGIN=1 leaves only a system login with an email (a real login, no managed rows).
if [ "${1:-}" = "status" ]; then
  if [ "${FAKE_ORCA_DOWN:-0}" = 1 ]; then echo '{"ok":true,"result":{"runtime":{"reachable":false}}}'; exit 0; fi
  echo '{"ok":true,"result":{"runtime":{"reachable":true,"state":"ready"}}}'
elif [ "${1:-}" = "account" ]; then
  if [ "${FAKE_ORCA_NOACCT:-0}" = 1 ]; then echo '{"ok":true,"result":{"claude":{"accounts":[]}}}'; exit 0; fi
  if [ "${FAKE_ORCA_SYSLOGIN:-0}" = 1 ]; then echo '{"ok":true,"result":{"claude":{"accounts":[],"systemDefaultEmail":"s@e.com"}}}'; exit 0; fi
  echo '{"ok":true,"result":{"claude":{"accounts":[{"id":"a1","email":"t@e.com","managedAuthRuntime":"host"}],"systemDefaultEmail":"s@e.com"}}}'
else echo "fake orca: unexpected: $*" >&2; exit 2; fi
FAKE
chmod +x "$STUB/orca"
# Pin native adapter calls separately from the installer inputs under test.
export BACKEND="$TMP/test-backend.sh"
cat > "$BACKEND" <<FAKE
#!/usr/bin/env bash
DS_ORCA_CLI_BIN_DIR="$STUB" exec "$REPO/bin/backend/orca.sh" "\$@"
FAKE
chmod +x "$BACKEND"
# Fake crontab IN the stub PATH: the default install writes a cron line, so every install
# run below must see this fake ($CRONTAB), never the host's real crontab.
cat > "$STUB/crontab" <<'FAKE'
#!/usr/bin/env bash
if [ "$1" = "-l" ]; then cat "$CRONTAB" 2>/dev/null || { echo "no crontab for you" >&2; exit 1; }
else cat > "$CRONTAB"; [ -z "${CRONTAB_WRITE_HOOK:-}" ] || "$CRONTAB_WRITE_HOOK"; fi
FAKE
chmod +x "$STUB/crontab"
export CRONTAB="$TMP/crontab"
# A stub identical but WITHOUT jq, for the missing-prerequisite case.
STUB_NOJQ="$TMP/stub-nojq"; mkdir -p "$STUB_NOJQ"
for t in bash dirname mkdir ln grep sed basename readlink rm head cat claude git orca crontab bun systemctl; do
  ln -s "$STUB/$t" "$STUB_NOJQ/$t"
done
# A stub identical but WITHOUT crontab, for the no-cron-daemon install path.
STUB_NOCRON="$TMP/stub-nocron"; mkdir -p "$STUB_NOCRON"
for t in bash dirname mkdir ln grep sed basename readlink rm head cat awk sleep ps jq claude git orca bun systemctl; do
  ln -s "$STUB/$t" "$STUB_NOCRON/$t"
done
# A stub identical but WITHOUT bun, for the bun-required case.
STUB_NOBUN="$TMP/stub-nobun"; mkdir -p "$STUB_NOBUN"
for t in bash dirname mkdir ln grep sed basename readlink rm head cat awk sleep ps jq claude git orca crontab systemctl; do
  ln -s "$STUB/$t" "$STUB_NOBUN/$t"
done

eq(){ if [ "$2" = "$3" ]; then good; else bad "$1: got [$2], want [$3]"; fi; }
# install_prelude: the pointer link and a first install, which every file after the first starts from.
install_prelude() {
  ln -s "$REPO" "$HOME/.dev-studio"
  ( cd "$HOME/.dev-studio" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
}
# --- helpers the parts below share (from the one-file install test) ---
fresh_host(){ rm -rf "$REPO/state"; : > "$CRONTAB"; }
UNIT="$HOME/.config/systemd/user/ds-loop.service"
orca_line() { grep -F 'ORCA_USER_DATA_PATH' "$UNIT" || true; }
no_orca_line() { # <what>
  if [ -z "$(orca_line)" ] && grep -A1 -F 'Environment="PATH=' "$UNIT" | grep -qxF 'Restart=on-failure'; then good; else bad "$1 should leave the unit without a data path or a gap: $(cat "$UNIT")"; fi
}
unit_path() { sed -n 's/^Environment="PATH=\(.*\)"$/\1/p' "$UNIT"; }
LOOP_LOG="$TMP/loop-stub.log"
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
