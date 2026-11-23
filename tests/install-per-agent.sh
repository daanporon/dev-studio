#!/usr/bin/env bash
# install-per-agent.sh — per-agent install verification (U4) in a throwaway
# HOME (never the live one): bin/host/install-skills.sh --check and bin/host/install.sh
# --check verify per agent in use (from conventions/roles.conf rows incl.
# fallbacks) that the CLI is on PATH and the ce-* skills it needs are listed;
# stubbed claude/muse/codex in PATH, scratch HOME for experiments.
#
# Covers: all-present ok, muse-missing warning (names the fallback roles, still
# exit 0), claude-missing hard error, --muse-only never requiring claude,
# missing muse/claude skills warn, codex gets a not-used line and no skill
# check, --check changes nothing (no installs, only list reads).
set -euo pipefail
unset CLAUDE_CONFIG_DIR   # the account check reads the caller's config dir otherwise

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SKILLS_SCRIPT="$ROOT/bin/host/install-skills.sh"
TMP="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
good(){ pass=$((pass + 1)); }
bad(){ fail=$((fail + 1)); echo "  FAIL: $1" >&2; }

# The pass-list under test: exactly what the scripts verify, nothing hardcoded.
MUSE_CE_SKILLS="$(sed -n 's/^export const MUSE_CE_SKILLS = "\(.*\)";$/\1/p' "$ROOT/bin/lib/install.ts")"
[ -n "${MUSE_CE_SKILLS:-}" ] || { echo "  FAIL: no MUSE_CE_SKILLS line in bin/lib/install.ts" >&2; exit 1; }
MUSE_DS_SKILL="$(sed -n 's/^export const MUSE_DS_SKILL = "\(.*\)";$/\1/p' "$ROOT/bin/lib/install.ts")"
[ -n "${MUSE_DS_SKILL:-}" ] || { echo "  FAIL: no MUSE_DS_SKILL line in bin/lib/install.ts" >&2; exit 1; }
# --- stub-CLI factory ---------------------------------------------------------
# make_stubs <dir> <claude:yes|no> <muse:yes|no> <codex:yes|no>
# Fake claude/muse/codex log every argv to $CALL_LOG. List outputs come from
# $FAKE_CLAUDE_PLUGINS / $FAKE_MUSE_SKILLS (newline-separated); default fakes
# installed below report everything present.
COREUTILS="bash dirname mkdir ln grep sed basename readlink rm head cat awk jq bun"   # bun: install-skills.sh runs on it (U262)
make_stubs() {
  local dir="$1" want_claude="$2" want_muse="$3" want_codex="$4"
  mkdir -p "$dir"
  local t
  # shellcheck disable=SC2086
  for t in $COREUTILS; do ln -sf "$(command -v "$t")" "$dir/$t"; done
  if [ "$want_claude" = yes ]; then
    cat > "$dir/claude" <<'FAKE'
#!/usr/bin/env bash
echo "claude $*" >> "$CALL_LOG"
if [ "${1:-}" = "plugin" ] && [ "${2:-}" = "list" ] && [ "${3:-}" = "--json" ]; then
  printf '%s\n' "$FAKE_CLAUDE_PLUGINS_JSON"
elif [ "${1:-}" = "plugin" ] && [ "${2:-}" = "list" ]; then
  printf '%s\n' "$FAKE_CLAUDE_PLUGINS"
fi
exit 0
FAKE
    chmod +x "$dir/claude"
  fi
  if [ "$want_muse" = yes ]; then
    cat > "$dir/muse" <<'FAKE'
#!/usr/bin/env bash
echo "muse $*" >> "$CALL_LOG"
if [ "${1:-}" = "skills" ] && [ "${2:-}" = "list" ]; then
  printf '%s\n' "$FAKE_MUSE_SKILLS"
fi
exit 0
FAKE
    chmod +x "$dir/muse"
  fi
  if [ "$want_codex" = yes ]; then
    cat > "$dir/codex" <<'FAKE'
#!/usr/bin/env bash
echo "codex $*" >> "$CALL_LOG"
exit 0
FAKE
    chmod +x "$dir/codex"
  fi
}

export CALL_LOG="$TMP/calls.log"
# Defaults: everything installed. `plugin list --json` reports a user-scope
# compound-engineering whose installPath holds the review skill (the per-account
# probe checks it on disk; tests/install-ce-accounts.sh covers the broken cases).
export FAKE_CLAUDE_PLUGINS="compound-engineering@compound-engineering-plugin (1.2.3)"
CE_PATH="$TMP/ce-cache/1.2.3"; mkdir -p "$CE_PATH/skills/ce-code-review"; : > "$CE_PATH/skills/ce-code-review/SKILL.md"
ce_json(){ printf '[{"id":"compound-engineering@compound-engineering-plugin","scope":"user","enabled":true,"installPath":"%s"}]' "$CE_PATH"; }
export FAKE_CLAUDE_PLUGINS_JSON; FAKE_CLAUDE_PLUGINS_JSON="$(ce_json)"
# The per-account check reads each config dir's registry + skills/ from disk (no claude call), and
# --check exits 1 for an account without the role skills: give every config dir a complete tree.
# The role skills every account must carry (bin/lib/account-skills.ts, U274).
DS_ROLE_CE_SKILLS="$("$ROOT/bin/ds" account-skills role-skills ce)"
DS_ROLE_USER_SKILLS="$("$ROOT/bin/ds" account-skills role-skills user)"
DS_ROLE_OPTIONAL_USER_SKILLS="$("$ROOT/bin/ds" account-skills role-skills optional)"
mk_skills_home() { # <config dir>
  local cfg="$1" ip="$1/plugins/cache/p/compound-engineering/1" s
  for s in $DS_ROLE_CE_SKILLS; do mkdir -p "$ip/skills/$s"; : > "$ip/skills/$s/SKILL.md"; done
  for s in $DS_ROLE_USER_SKILLS $DS_ROLE_OPTIONAL_USER_SKILLS; do mkdir -p "$cfg/skills/$s"; : > "$cfg/skills/$s/SKILL.md"; done
  printf '{"version":2,"plugins":{"compound-engineering@compound-engineering-plugin":[{"scope":"user","installPath":"%s"}]}}' "$ip" > "$cfg/plugins/installed_plugins.json"
  printf '{"enabledPlugins":{"compound-engineering@compound-engineering-plugin":true}}' > "$cfg/settings.json"
}
muse_skills_all(){ # the real `muse skills list` shape: header, then name/scope/activation rows (ce-* + ds wrapper)
  local n
  printf 'NAME\tSCOPE\tACTIVATION\tDESCRIPTION\n'
  # shellcheck disable=SC2086
  for n in $MUSE_CE_SKILLS $MUSE_DS_SKILL; do printf '%s\tuser\ton\tfixture\n' "$n"; done
}
without_skill(){ grep -v "^$1"$'\t'; } # drop one skill's row from stdin
export FAKE_MUSE_SKILLS
FAKE_MUSE_SKILLS="$(muse_skills_all)"

rm_log(){ rm -f "$CALL_LOG"; }

# --- Part A: install-skills.sh --check ---------------------------------------
S1="$TMP/s1"; make_stubs "$S1" yes yes no
H1="$TMP/h1"; mkdir -p "$H1/.claude/plugins"; mk_skills_home "$H1/.claude"

# A1. all present: exit 0, ok lines for both agents, codex not-used line.
rm_log
out="$(HOME="$H1" PATH="$S1" "$SKILLS_SCRIPT" --check 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "--check all-present exits $rc, want 0: $out"; fi
for want in "claude: CLI ok" "claude: skills ok" "muse: CLI ok" "ce-* skills ok" "muse: ds skill ok" "codex: not installed, not used"; do
  if grep -qF "$want" <<<"$out"; then good; else bad "--check all-present should say '$want': $out"; fi
done

# A2. muse missing: warning naming the fallback role, still exit 0.
S2="$TMP/s2"; make_stubs "$S2" yes no no
rm_log
out="$(HOME="$H1" PATH="$S2" "$SKILLS_SCRIPT" --check 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "--check without muse exits $rc, want 0 (warning, not failure)"; fi
if grep -qF 'muse' <<<"$out" && grep -qiF 'builder' <<<"$out"; then good; else bad "--check without muse should name the role using it: $out"; fi
if grep -qiF 'fallback' <<<"$out"; then good; else bad "--check without muse should say fallback: $out"; fi
if [ ! -e "$CALL_LOG" ] || ! grep -q '^muse ' "$CALL_LOG"; then good; else bad "--check without muse must not invoke muse"; fi

# A3. claude missing (default path): hard error, exit 1.
S3="$TMP/s3"; make_stubs "$S3" no yes no
rm_log
rc=0; out="$(HOME="$H1" PATH="$S3" "$SKILLS_SCRIPT" --check 2>&1)" || rc=$?
if [ "$rc" -eq 1 ]; then good; else bad "--check without claude exits $rc, want 1 (hard error)"; fi

# A4. --muse-only --check without claude: exit 0, claude skipped, muse checked.
rm_log
out="$(HOME="$H1" PATH="$S3" "$SKILLS_SCRIPT" --check --muse-only 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "--check --muse-only without claude exits $rc, want 0: $out"; fi
if grep -qF 'claude: not checked (--muse-only)' <<<"$out"; then good; else bad "--muse-only check should skip claude: $out"; fi
if grep -qF 'muse: CLI ok' <<<"$out"; then good; else bad "--muse-only check should verify muse: $out"; fi

# A5. one muse skill missing from the list: warning naming it, still exit 0.
S5="$TMP/s5"; make_stubs "$S5" yes yes no
first_skill="${MUSE_CE_SKILLS%% *}"
FAKE_MUSE_SKILLS="$(muse_skills_all | without_skill "$first_skill")"
rm_log
out="$(HOME="$H1" PATH="$S5" "$SKILLS_SCRIPT" --check 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "--check with a missing muse skill exits $rc, want 0"; fi
if grep -qF "$first_skill" <<<"$out"; then good; else bad "--check should name the missing muse skill '$first_skill': $out"; fi
FAKE_MUSE_SKILLS="$(muse_skills_all)"

# A5b. ds skill missing from the list: warning naming it, still exit 0.
FAKE_MUSE_SKILLS="$(muse_skills_all | without_skill "$MUSE_DS_SKILL")"
rm_log
out="$(HOME="$H1" PATH="$S5" "$SKILLS_SCRIPT" --check 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "--check with a missing ds skill exits $rc, want 0"; fi
if grep -qF "$MUSE_DS_SKILL" <<<"$out"; then good; else bad "--check should name the missing ds skill '$MUSE_DS_SKILL': $out"; fi
FAKE_MUSE_SKILLS="$(muse_skills_all)"

# A6. claude plugin missing: the account is broken -> named, and --check exits 1.
mv "$H1/.claude/plugins/installed_plugins.json" "$TMP/reg.bak"
rm_log
rc=0; out="$(HOME="$H1" PATH="$S1" "$SKILLS_SCRIPT" --check 2>&1)" || rc=$?
if [ "$rc" -eq 1 ]; then good; else bad "--check with a missing claude plugin exits $rc, want 1"; fi
if grep -qF '⚠ claude: compound-engineering is not installed' <<<"$out"; then good; else bad "--check should name the missing compound-engineering plugin: $out"; fi
mv "$TMP/reg.bak" "$H1/.claude/plugins/installed_plugins.json"

# A7. codex present: still not used, and never skill-checked.
S7="$TMP/s7"; make_stubs "$S7" yes yes yes
rm_log
out="$(HOME="$H1" PATH="$S7" "$SKILLS_SCRIPT" --check 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "--check with codex present exits $rc, want 0"; fi
if grep -qF 'codex:' <<<"$out" && grep -qiF 'not used' <<<"$out"; then good; else bad "--check should report codex as not used: $out"; fi
if grep -q '^codex \(plugin\|skills\)' "$CALL_LOG" 2>/dev/null; then bad "--check must never skill-check codex"; else good; fi

# A8. --check changes nothing: only list reads, no installs.
rm_log
HOME="$H1" PATH="$S7" "$SKILLS_SCRIPT" --check >/dev/null 2>&1
if grep -qE '^(muse skills install|claude plugin (install|marketplace))' "$CALL_LOG"; then bad "--check must not install anything: $(cat "$CALL_LOG")"; else good; fi
if grep -q '^muse skills list' "$CALL_LOG" && ! grep -q '^claude plugin' "$CALL_LOG"; then good; else bad "--check should verify muse via list commands and read the claude registry from disk: $(cat "$CALL_LOG" 2>/dev/null || echo none)"; fi

# A9. unknown flag: usage error.
rc=0; HOME="$H1" PATH="$S1" "$SKILLS_SCRIPT" --bogus >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 2 ]; then good; else bad "unknown flag exits $rc, want 2"; fi

# --- Part B: install.sh --check ------------------------------------------------
# Fake checkout with the REAL install.sh + install-skills.sh + backend adapter
# and one ds-*.md command, mirroring tests/install.sh.
REPO="$TMP/real/dev-studio"; mkdir -p "$REPO/bin/host" "$REPO/bin/lib" "$REPO/.claude/commands"
cp "$ROOT/bin/host/install.sh" "$REPO/bin/host/install.sh"; chmod +x "$REPO/bin/host/install.sh"
cp "$ROOT/bin/host/install-skills.sh" "$REPO/bin/host/install-skills.sh"; chmod +x "$REPO/bin/host/install-skills.sh"
# orca.sh runs its ported verbs (status, account-list, claude-config-dir) through `ds backend` (U223).
mkdir -p "$REPO/bin/backend" "$REPO/bin/commands"; cp "$ROOT/bin/backend/orca.sh" "$ROOT/bin/backend/orca.ts" "$ROOT/bin/backend/orca-cache.ts" "$ROOT/bin/backend/orca-client.ts" "$REPO/bin/backend/"
cp "$ROOT/bin/ds" "$ROOT/bin/ds.ts" "$REPO/bin/"; cp "$ROOT/bin/commands/backend.ts" "$REPO/bin/commands/"
# orca.ts builds its Claude launch lines from drivers/claude-launch.ts (U11), which imports nothing local.
mkdir -p "$REPO/bin/loop/drivers"; cp "$ROOT/bin/loop/drivers/claude-launch.ts" "$REPO/bin/loop/drivers/"
# shellcheck source=tests/lib/install-ts.sh
. "$ROOT/tests/lib/install-ts.sh"; install_ts_copy "$REPO"
mkdir -p "$REPO/conventions"
cp "$ROOT/conventions/roles.conf" "$ROOT/conventions/models.conf" "$REPO/conventions/"
printf -- '---\ndescription: x\n---\nhi\n' > "$REPO/.claude/commands/ds-fake.md"
# The skill verdicts are checked on a host whose required loop is installed.
mkdir -p "$REPO/state"
: > "$REPO/state/.loop-migrated"
: > "$REPO/state/loop.db"

B_STUB="$TMP/bstub"; mkdir -p "$B_STUB"
for t in bash dirname mkdir ln grep sed basename readlink rm head cat awk; do
  ln -sf "$(command -v "$t")" "$B_STUB/$t"
done
ln -sf "$(command -v jq)" "$B_STUB/jq"
printf '#!/usr/bin/env bash\nexit 0\n' > "$B_STUB/git"; chmod +x "$B_STUB/git"
# A pinned --version for the preflight line; anything else is the real bun (the backend verbs run on it).
printf '#!/usr/bin/env bash\n[ "${1:-}" = --version ] && { echo 1.0.0; exit 0; }\nexec %s "$@"\n' "$(command -v bun)" > "$B_STUB/bun"; chmod +x "$B_STUB/bun"
cat > "$B_STUB/orca" <<'FAKE'
#!/usr/bin/env bash
if [ "${1:-}" = "status" ]; then
  echo '{"ok":true,"result":{"runtime":{"reachable":true,"state":"ready"}}}'
elif [ "${1:-}" = "account" ]; then
  echo '{"ok":true,"result":{"claude":{"accounts":[{"id":"a1","email":"t@e.com","managedAuthRuntime":"host"}],"systemDefaultEmail":"s@e.com"}}}'
else echo "fake orca: unexpected: $*" >&2; exit 2; fi
FAKE
chmod +x "$B_STUB/orca"
export DS_ORCA_CLI_BIN_DIR="$B_STUB"
cat > "$B_STUB/crontab" <<'FAKE'
#!/usr/bin/env bash
if [ "$1" = "-l" ]; then cat "$CRONTAB" 2>/dev/null || { echo "no crontab for you" >&2; exit 1; }
else cat > "$CRONTAB"; fi
FAKE
chmod +x "$B_STUB/crontab"
export CRONTAB="$TMP/crontab"
printf '* * * * * %s/bin/loop/loop.sh --ensure\n' "$REPO" > "$CRONTAB"
ln -sf "$S1/claude" "$B_STUB/claude"
ln -sf "$S1/muse" "$B_STUB/muse"
export HOME_BAK="$HOME"
export HOME="$TMP/bhome"; mkdir -p "$HOME"
# The fake Orca's managed account a1 has a profile home, so the per-account plugin check probes it.
# Named outright: an Orca terminal's ORCA_USER_DATA_PATH or a runner's XDG_CONFIG_HOME would point the
# adapter at the real profiles instead of this fake HOME.
export DS_ORCA_DATA="$HOME/.config/orca"
mkdir -p "$DS_ORCA_DATA/claude-profiles/a1/home/plugins" "$HOME/.claude/plugins"
mk_skills_home "$DS_ORCA_DATA/claude-profiles/a1/home"; mk_skills_home "$HOME/.claude"

# B1. all present: exit 0, preflight ok, per-agent ok lines, codex line.
rm_log
out="$(cd "$REPO" && PATH="$B_STUB" ./bin/host/install.sh --check 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "install.sh --check all-present exits $rc, want 0: $out"; fi
for want in "preflight: ok" "per-agent verification" "claude: CLI ok" "claude[system]: skills ok" "claude[a1]: skills ok" "muse: CLI ok" "muse: ds skill ok" "codex: not installed, not used"; do
  if grep -qF "$want" <<<"$out"; then good; else bad "install.sh --check should say '$want': $out"; fi
done

# B2. muse missing: warning naming builder (fallback), still exit 0.
B_NOMUSE="$TMP/bnomuse"; mkdir -p "$B_NOMUSE"
for t in bash dirname mkdir ln grep sed basename readlink rm head cat jq git bun orca crontab claude; do
  ln -sf "$B_STUB/$t" "$B_NOMUSE/$t"
done
rm_log
out="$(cd "$REPO" && PATH="$B_NOMUSE" ./bin/host/install.sh --check 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "install.sh --check without muse exits $rc, want 0"; fi
if grep -qiF 'builder' <<<"$out" && grep -qiF 'fallback' <<<"$out"; then good; else bad "install.sh --check without muse should name the fallback role: $out"; fi

# B3. claude missing: hard preflight error (unchanged behaviour).
B_NOCLAUDE="$TMP/bnoclaude"; mkdir -p "$B_NOCLAUDE"
for t in bash dirname mkdir ln grep sed basename readlink rm head cat jq git bun orca crontab; do
  ln -sf "$B_STUB/$t" "$B_NOCLAUDE/$t"
done
rc=0; out="$(cd "$REPO" && PATH="$B_NOCLAUDE" ./bin/host/install.sh --check 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && grep -qF "'claude' not found" <<<"$out"; then good; else bad "install.sh --check without claude should hard-fail: rc=$rc out=$out"; fi

# B4. a muse skill missing: warning naming it, still exit 0.
FAKE_MUSE_SKILLS="$(muse_skills_all | without_skill "$first_skill")"
rm_log
out="$(cd "$REPO" && PATH="$B_STUB" ./bin/host/install.sh --check 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "install.sh --check with a missing muse skill exits $rc, want 0"; fi
if grep -qF "$first_skill" <<<"$out"; then good; else bad "install.sh --check should name the missing muse skill: $out"; fi
FAKE_MUSE_SKILLS="$(muse_skills_all)"

# B4b. ds skill missing: warning naming it on its own line, still exit 0.
FAKE_MUSE_SKILLS="$(muse_skills_all | without_skill "$MUSE_DS_SKILL")"
rm_log
out="$(cd "$REPO" && PATH="$B_STUB" ./bin/host/install.sh --check 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "install.sh --check with a missing ds skill exits $rc, want 0"; fi
if grep -qF "muse ds skill '$MUSE_DS_SKILL'" <<<"$out"; then good; else bad "install.sh --check should name the missing ds skill: $out"; fi
FAKE_MUSE_SKILLS="$(muse_skills_all)"

# B5. --check changes nothing on a fresh HOME (no links, no cron writes).
mkdir -p "$TMP/bhome3"
: > "$CRONTAB"
rm_log
rc=0; out="$(cd "$REPO" && HOME="$TMP/bhome3" PATH="$B_STUB" ./bin/host/install.sh --check 2>&1)" || rc=$?
if [ "$rc" -eq 1 ]; then good; else bad "install.sh --check on a fresh HOME (no role skills) exits $rc, want 1: $out"; fi
if [ -z "$(ls -A "$TMP/bhome3")" ]; then good; else bad "--check must change nothing on a fresh HOME"; fi
if [ ! -s "$CRONTAB" ] && ! grep -qE '^(muse skills install|claude plugin (install|marketplace))' "$CALL_LOG" 2>/dev/null; then good; else bad "--check must not write cron or install skills"; fi

export HOME="$HOME_BAK"

# C. verify matches the name column and needs activation `on` (U6), in both
# install-skills.sh --check and install.sh --check.
check_both() { # <label> <expect-missing-regex> ; FAKE_MUSE_SKILLS already set
  local label="$1" want="$2" o1 o2
  o1="$(HOME="$H1" PATH="$S5" "$SKILLS_SCRIPT" --check 2>&1 || true)"
  o2="$(cd "$REPO" && { PATH="$B_STUB" ./bin/host/install.sh --check 2>&1 || true; })"
  if grep -qE "$want" <<<"$o1"; then good; else bad "install-skills --check, $label: want /$want/: $o1"; fi
  if grep -qE "$want" <<<"$o2"; then good; else bad "install.sh --check, $label: want /$want/: $o2"; fi
}
first_off="$MUSE_CE_SKILLS"; first_off="${first_off%% *}"
# a skill present but off is missing
FAKE_MUSE_SKILLS="$(muse_skills_all | sed "s/^\($first_off\t[^\t]*\t\)on/\1off/")"
check_both "ce skill off" "missing from 'muse skills list':.*$first_off"
# ds present but off is missing
FAKE_MUSE_SKILLS="$(muse_skills_all | sed "s/^\($MUSE_DS_SKILL\t[^\t]*\t\)on/\1off/")"
check_both "ds off" "muse ds skill '$MUSE_DS_SKILL' missing"
# only a longer lookalike name listed: ce-work must not match ce-worktree
FAKE_MUSE_SKILLS="$(printf 'NAME\tSCOPE\tACTIVATION\tDESCRIPTION\nce-worktree\tuser\ton\tx\n')"
check_both "substring name" "missing from 'muse skills list':.* ce-work( |$)"
FAKE_MUSE_SKILLS="$(muse_skills_all)"

echo "install-per-agent: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
