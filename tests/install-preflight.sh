#!/usr/bin/env bash
# install-preflight.sh — preflight, --check, prune, --skills and the closing line.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
# shellcheck source=tests/lib/install-setup.sh
. "$ROOT/tests/lib/install-setup.sh"
install_prelude
# Each check runs the rendered line the way cron does, with a stub bin/loop/loop.sh recording what it receives.
LOOP_REAL="$TMP/loop.sh.real"; cp "$REPO/bin/loop/loop.sh" "$LOOP_REAL"
LOOP_LOG="$TMP/loop-stub.log"
cat > "$REPO/bin/loop/loop.sh" <<FAKE
#!/usr/bin/env bash
printf '%s|%s\n' "\$1" "\${ORCA_USER_DATA_PATH-UNSET}" >> "$LOOP_LOG"
printf '%s\n' "\${DS_ORCA_CLI_BIN_DIR-UNSET}" > "$TMP/loop-cli.log"
FAKE
# A working unit: both carry the path, by the same rules, since cron can reach the line without a session.
( cd "$REPO" && ORCA_USER_DATA_PATH="$HOME/.config/orca" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
line_gives "the default path on a working unit" UNSET
if loop_line | grep -qF ORCA_USER_DATA_PATH; then bad "the default should clear the line on a working unit too: $(loop_line)"; else good; fi
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
line_gives "no path on a working unit" UNSET
: > "$LOOP_LOG"
( cd "$REPO" && ORCA_USER_DATA_PATH="$TMP/it's 100%" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ ! -s "$LOOP_LOG" ]; then good; else bad "a working unit restarts through systemd, not --stop: $(cat "$LOOP_LOG")"; fi
line_gives "a custom path on a working unit" "$TMP/it's 100%"
if [ "$(orca_line)" = "Environment=\"ORCA_USER_DATA_PATH=$TMP/it's 100%%\"" ]; then good; else bad "the unit should carry the path too: $(cat "$UNIT")"; fi
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
line_gives "a working unit without the variable" "$TMP/it's 100%"
( cd "$REPO" && ORCA_USER_DATA_PATH="$TMP/newer" PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
line_gives "a working unit with another path" "$TMP/newer"
if [ "$(grep -c 'bin/loop/loop.sh' "$CRONTAB")" = 1 ]; then good; else bad "a working unit's reruns should leave one line: $(cat "$CRONTAB")"; fi
# No systemd user session: no unit, and the cron line (which then starts the loop) still goes in.
fresh_host; rm -f "$UNIT"
out="$(cd "$REPO" && FAKE_NOSYSTEMD=1 PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1)"
if [ ! -e "$UNIT" ] && [ "$(grep -c 'bin/loop/loop.sh' "$CRONTAB")" = 1 ]; then good; else bad "without systemd: no unit, one cron line: $out"; fi
if grep -qF 'the cron line starts it' <<<"$out" && [ ! -e "$REPO/state/loop.pid" ]; then good; else bad "without systemd the cron line starts the loop, not this terminal: $out"; fi
# Preflight runs BEFORE any link: an unreachable runtime fails the install and writes nothing.
mkdir -p "$TMP/home2"
rc=0; out="$(cd "$REPO" && HOME="$TMP/home2" FAKE_ORCA_DOWN=1 PATH="$STUB" ./bin/host/install.sh 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then good; else bad "an unreachable runtime should fail the install"; fi
if grep -qF 'not reachable' <<<"$out"; then good; else bad "unreachable runtime should say so: $out"; fi
if [ -e "$TMP/home2/.dev-studio" ] || [ -e "$TMP/home2/.claude" ]; then bad "a failed preflight must write nothing"; else good; fi

# A missing hard prerequisite (jq) fails with a one-line fix.
rc=0; out="$(cd "$REPO" && PATH="$STUB_NOJQ" ./bin/host/install.sh "$DEST" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then good; else bad "a missing jq should fail the install"; fi
if grep -qF "install: 'jq' not found" <<<"$out"; then good; else bad "missing jq should name the fix: $out"; fi

# Soft: no Claude login warns but still installs (exit 0).
rc=0; out="$(cd "$REPO" && FAKE_ORCA_NOACCT=1 PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1)" || rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "no login is soft — the install should continue"; fi
if grep -qF 'no Claude login found' <<<"$out"; then good; else bad "no login should warn: $out"; fi
# Soft: the system login's credentials file is a real login — no warning.
mkdir -p "$HOME/.claude"; had=0; [ ! -e "$HOME/.claude/.credentials.json" ] || had=1; : > "$HOME/.claude/.credentials.json"
out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1)"
if grep -qF 'no Claude login found' <<<"$out"; then bad "a system login should not warn: $out"; else good; fi
[ "$had" = 1 ] || rm -f "$HOME/.claude/.credentials.json"
# Soft: a login in the accounts table beside the system one counts too — no warning.
# shellcheck source=tests/lib/seed-accounts.sh
. "$ROOT/tests/lib/seed-accounts.sh"
mkdir -p "$TMP/zzds"; seed_claude_accounts "$REPO/state" "zzds:$TMP/zzds"
out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1)"
if grep -qF 'no Claude login found' <<<"$out"; then bad "a listed account should not warn: $out"; else good; fi
seed_claude_accounts "$REPO/state"

# Prune: a dangling checkout link goes; a foreign link, a foreign file, and a live link stay.
ln -s "$REPO/.claude/commands/ds-old.md" "$DEST/ds-old.md"
mkdir -p "$TMP/elsewhere"; ln -s "$TMP/elsewhere/x.md" "$DEST/ds-foreign.md"
printf 'mine\n' > "$DEST/ds-plain.md"
out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1)"
if [ ! -e "$DEST/ds-old.md" ] && [ ! -L "$DEST/ds-old.md" ]; then good; else bad "a dangling checkout link should be pruned"; fi
if grep -qF 'pruned stale ds-old.md' <<<"$out"; then good; else bad "pruning should say what went: $out"; fi
if [ -L "$DEST/ds-foreign.md" ]; then good; else bad "a foreign link must survive pruning"; fi
if [ -f "$DEST/ds-plain.md" ] && [ ! -L "$DEST/ds-plain.md" ]; then good; else bad "a foreign file must survive pruning"; fi
if [ -e "$DEST/ds-fake.md" ]; then good; else bad "a live checkout link must survive pruning"; fi

# --check verifies and changes nothing, even on a fresh HOME. A fresh HOME has no role skills, so
# the run fails (exit 1, naming the system account and the repair) after printing its verdict.
mkdir -p "$TMP/home3"
rc=0; out="$(cd "$REPO" && HOME="$TMP/home3" PATH="$STUB" ./bin/host/install.sh --check 2>&1)" || rc=$?
if [ "$rc" -eq 1 ] && grep -qF 'preflight: ok' <<<"$out"; then good; else bad "--check on a HOME without role skills should print its verdict and exit 1: rc=$rc out=$out"; fi
if grep -qF '⚠ claude[system]: compound-engineering is not installed' <<<"$out" && grep -qF 'bin/host/install-skills.sh' <<<"$out"; then good; else bad "--check should name the broken account + repair: $out"; fi
# ... and the same run on a complete HOME exits 0.
mkdir -p "$TMP/home5/.claude/plugins"; mk_skills_home "$TMP/home5"
rc=0; out="$(cd "$REPO" && HOME="$TMP/home5" PATH="$STUB" ./bin/host/install.sh --check 2>&1)" || rc=$?
if [ "$rc" -eq 0 ] && grep -qF 'claude[system]: skills ok' <<<"$out"; then good; else bad "--check on a complete HOME should exit 0: rc=$rc out=$out"; fi
if [ -z "$(ls -A "$TMP/home3")" ]; then good; else bad "--check must change nothing"; fi
# --check with a missing hard requirement fails, still writing nothing.
mkdir -p "$TMP/home4"
rc=0; out="$(cd "$REPO" && HOME="$TMP/home4" PATH="$STUB_NOJQ" ./bin/host/install.sh --check 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && grep -qF "install: 'jq' not found" <<<"$out"; then good; else bad "--check should fail on a missing jq: rc=$rc out=$out"; fi
if [ -z "$(ls -A "$TMP/home4")" ]; then good; else bad "--check must change nothing even on failure"; fi
# U262: install.sh is a bash bootstrap for `ds install-ts`. With no bun on PATH or in ~/.bun/bin it stops
# before any install step: one message naming the install line, exit 1, nothing written (HOME, the
# commands dir, the checkout's state), with or without --check.
for args in "$DEST" --check; do
  mkdir -p "$TMP/home-nobun"; fresh_host
  rc=0; out="$(cd "$REPO" && HOME="$TMP/home-nobun" PATH="$STUB_NOBUN" ./bin/host/install.sh "$args" 2>&1)" || rc=$?
  eq "no bun ($args): exit 1" "$rc" 1
  if [ "$(grep -c "install: 'bun' not found" <<<"$out")" -eq 1 ] && grep -qF 'curl -fsSL https://bun.sh/install | bash' <<<"$out" \
    && ! grep -qF 'preflight' <<<"$out"; then good; else bad "no bun ($args): one message naming the install line, no other step: $out"; fi
  if [ -z "$(ls -A "$TMP/home-nobun")" ] && [ ! -e "$REPO/state/.loop-migrated" ] && [ ! -e "$TMP/home-nobun/.dev-studio" ]; then good
  else bad "no bun ($args): nothing may be written"; fi
done

mkdir -p "$HOME/.claude/plugins"; mk_skills_home "$HOME"
# --check requires migrated state and the watchdog, and never repairs either.
fresh_host
rc=0; out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh --check 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && grep -qF 'loop is not installed' <<<"$out"; then good; else bad "uninstalled loop: rc=$rc $out"; fi
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
rc=0; out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh --check 2>&1)" || rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "installed loop must pass --check: rc=$rc $out"; fi
cp "$CRONTAB" "$TMP/installed-cron"
: > "$CRONTAB"
rc=0; out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh --check 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && grep -qF 'nothing starts the loop' <<<"$out"; then good; else bad "a unit alone lacks the watchdog: rc=$rc $out"; fi
printf '# * * * * * %s/bin/loop/loop.sh --ensure\n' "$REPO" > "$CRONTAB"
rc=0; out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh --check 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then good; else bad "a commented watchdog must not pass --check"; fi
cp "$TMP/installed-cron" "$CRONTAB"
cp "$REPO/state/.loop-migrated" "$TMP/migrated-mark"
rm "$REPO/state/.loop-migrated"
rc=0; out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh --check 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && [ ! -e "$REPO/state/.loop-migrated" ]; then good; else bad "a watchdog alone must fail --check without migrating"; fi
cp "$TMP/migrated-mark" "$REPO/state/.loop-migrated"

# --skills runs bin/host/install-skills.sh; without the flag (or under --check) it never runs.
cat > "$REPO/bin/host/install-skills.sh" <<'SKILLS'
#!/usr/bin/env bash
echo "skills ran" >> "$SKILLS_MARKER"
SKILLS
chmod +x "$REPO/bin/host/install-skills.sh"
export SKILLS_MARKER="$TMP/skills.log"; rm -f "$SKILLS_MARKER"
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh --skills "$DEST" >/dev/null 2>&1 )
if [ -f "$SKILLS_MARKER" ]; then good; else bad "--skills should run bin/host/install-skills.sh"; fi
rm -f "$SKILLS_MARKER"
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh --check --skills >/dev/null 2>&1 )
if [ ! -e "$SKILLS_MARKER" ]; then good; else bad "--check must not run the skills installer"; fi
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )
if [ ! -e "$SKILLS_MARKER" ]; then good; else bad "without --skills the installer must not run"; fi

# Closing line: the exact next step.
out="$(cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" 2>&1)"
if grep -qF 'Next: ~/.dev-studio/bin/ds up <git-url>  (in this shell)' <<<"$out"; then good; else bad "missing the closing next-step line: $out"; fi


# U246: a repeat install starts few processes. A counting bun on the stub PATH logs every start: at most 4 (the
# version line, one backend read for the preflight and every account's config dir, the migration, the skills
# refresh), and wrap-hooks.sh adds none because install.sh hands it the rows.
STUB_COUNT="$TMP/stub-count"; mkdir -p "$STUB_COUNT"
for t in "$STUB"/*; do ln -s "$t" "$STUB_COUNT/${t##*/}"; done
rm "$STUB_COUNT/bun"
printf '#!/usr/bin/env bash\necho "$*" >> "$BUN_COUNT_LOG"\nexec "%s" "$@"\n' "$BUN_REAL" > "$STUB_COUNT/bun"; chmod +x "$STUB_COUNT/bun"
export BUN_COUNT_LOG="$TMP/bun-count.log"
( cd "$REPO" && PATH="$STUB" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 )   # the state a repeat starts from
: > "$BUN_COUNT_LOG"
rc=0; ( cd "$REPO" && PATH="$STUB_COUNT" ./bin/host/install.sh "$DEST" >/dev/null 2>&1 ) || rc=$?
eq "a repeat install succeeds" "$rc" 0
n="$(wc -l < "$BUN_COUNT_LOG")"; echo "install-preflight: a repeat install started $n bun process(es)"
if [ "$n" -le 4 ]; then good; else bad "a repeat install should start at most 4 bun processes, started $n: $(cat "$BUN_COUNT_LOG")"; fi
if grep -q 'backend\|claude-config-dir' <<<"$(grep -c . "$BUN_COUNT_LOG" >/dev/null; awk '{print $2}' "$BUN_COUNT_LOG" | sort | uniq -c | awk '$1>1')"; then bad "no backend verb runs twice in an install: $(cat "$BUN_COUNT_LOG")"; else good; fi

echo "install-preflight: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
