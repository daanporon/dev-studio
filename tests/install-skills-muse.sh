#!/usr/bin/env bash
# install-skills-muse.sh — the Muse copy of the passing ce-* skills, in a
# throwaway HOME (never the live one): skip-without-muse, newest-version
# selection, --force idempotence, and pass-list only (derived from the
# MUSE_CE_SKILLS line in bin/lib/install.ts, so a U7 upgrade changes the
# script alone and this test follows it).
set -euo pipefail
unset CLAUDE_CONFIG_DIR   # the throwaway HOME's ~/.claude, not the caller's account

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SCRIPT="$ROOT/bin/host/install-skills.sh"
TMP="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
good(){ pass=$((pass + 1)); }
bad(){ fail=$((fail + 1)); echo "  FAIL: $1" >&2; }

# The pass-list under test: exactly what the script installs, nothing hardcoded.
MUSE_CE_SKILLS="$(sed -n 's/^export const MUSE_CE_SKILLS = "\(.*\)";$/\1/p' "$ROOT/bin/lib/install.ts")"
[ -n "${MUSE_CE_SKILLS:-}" ] || { echo "  FAIL: no MUSE_CE_SKILLS line in bin/lib/install.ts" >&2; exit 1; }
MUSE_DS_SKILL="$(sed -n 's/^export const MUSE_DS_SKILL = "\(.*\)";$/\1/p' "$ROOT/bin/lib/install.ts")"
[ -n "${MUSE_DS_SKILL:-}" ] || { echo "  FAIL: no MUSE_DS_SKILL line in bin/lib/install.ts" >&2; exit 1; }

# --- stub PATH: real coreutils + a fake `muse` that logs its argv --------------
STUB="$TMP/stub"; mkdir -p "$STUB"
for t in bash find ls sort tail basename dirname cat grep rm sed mkdir awk bun; do
  ln -s "$(command -v "$t")" "$STUB/$t"
done
export MUSE_LOG="$TMP/muse.log"
cat > "$STUB/muse" <<'FAKE'
#!/usr/bin/env bash
echo "muse $*" >> "$MUSE_LOG"
if [ "${1:-}" = "skills" ] && [ "${2:-}" = "list" ]; then
  echo "user skills: (stub)"
fi
exit 0
FAKE
chmod +x "$STUB/muse"
# A stub identical but WITHOUT muse, for the Claude-only-host case.
STUB_NOMUSE="$TMP/stub-nomuse"; mkdir -p "$STUB_NOMUSE"
for t in bash find ls sort tail basename dirname cat grep rm sed mkdir awk bun; do
  ln -s "$(command -v "$t")" "$STUB_NOMUSE/$t"
done

# --- fake HOME with a CE plugin cache holding several versions -----------------
# (3.9.0 sorts below 3.33.x under -V but above it lexically, so a plain
# `sort | tail` would pick wrongly; newest must be 3.33.2.)
fake_home() {
  local home="$1" newest="$2" skills="$3"
  local cache="$home/.claude/plugins/cache/compound-engineering-plugin/compound-engineering"
  for v in 3.9.0 3.33.1 "$newest"; do
    # shellcheck disable=SC2086
    for s in $skills; do
      mkdir -p "$cache/$v/skills/$s"
      printf '# stub\n' > "$cache/$v/skills/$s/SKILL.md"
    done
  done
}

# list_rows <state> <name>…: the real `muse skills list` shape — a header row,
# then name/scope/activation/description rows. <state> is on|off for all rows.
list_rows() {
  local state="$1"; shift
  printf 'NAME\tSCOPE\tACTIVATION\tDESCRIPTION\n'
  local n
  for n in "$@"; do printf '%s\tuser\t%s\tfixture skill\n' "$n" "$state"; done
}

# installed skill names, one per line, from the stub log's `skills install` rows.
installed_names() {
  grep -F 'skills install' "$MUSE_LOG" | sed 's/.*skills\///;s/ .*//'
}

# 1. skip-without-muse: exit 0, no muse invocations, says it skips.
H1="$TMP/h1"; mkdir -p "$H1"
fake_home "$H1" 3.33.2 "$MUSE_CE_SKILLS ce-babysit-pr"
rm -f "$MUSE_LOG"
out="$(HOME="$H1" PATH="$STUB_NOMUSE" "$SCRIPT" --muse-only 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "skip-without-muse exits $rc, want 0"; fi
if grep -q "skipping (Claude-only host)" <<<"$out"; then good; else bad "skip-without-muse should say it skips: $out"; fi
if [ ! -e "$MUSE_LOG" ]; then good; else bad "skip-without-muse must not invoke muse"; fi

# 2-4. full muse-only refresh against the fake HOME. The cache holds the whole
# list plus two decoys the list must NOT pick up: ce-babysit-pr (still partial
# per U1/U7 — U3 covers its tick loop) and ce-dogfood (never probed).
H2="$TMP/h2"; mkdir -p "$H2"
fake_home "$H2" 3.33.2 "$MUSE_CE_SKILLS ce-babysit-pr ce-dogfood"
rm -f "$MUSE_LOG"
out="$(HOME="$H2" PATH="$STUB" "$SCRIPT" --muse-only 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "muse-only refresh exits $rc, want 0: $out"; fi

# 2. newest-version selection: every install comes from 3.33.2, never 3.9.0/3.33.1.
if grep -F 'skills install' "$MUSE_LOG" | grep -q 'compound-engineering/3.33.2/skills/'; then good; else bad "installs should come from 3.33.2: $(cat "$MUSE_LOG")"; fi
if grep -F 'skills install' "$MUSE_LOG" | grep -E -q 'compound-engineering/3\.(9\.0|33\.1)/skills/'; then bad "installs must not come from older versions: $(cat "$MUSE_LOG")"; else good; fi

# 3. --force idempotence: a second run installs the same set, still exit 0.
cp "$MUSE_LOG" "$TMP/first.log"
out2="$(HOME="$H2" PATH="$STUB" "$SCRIPT" --muse-only 2>&1)"; rc2=$?
if [ "$rc2" -eq 0 ]; then good; else bad "second muse-only run exits $rc2, want 0: $out2"; fi
second_only="$(grep -F 'skills install' "$MUSE_LOG" | tail -n "$(grep -c -F 'skills install' "$TMP/first.log")")"
if [ "$second_only" = "$(grep -F 'skills install' "$TMP/first.log")" ]; then good; else bad "re-run installs differ from first run"; fi
if grep -F 'skills install' "$MUSE_LOG" | grep -q -F -- '--force'; then good; else bad "installs must pass --force: $(cat "$MUSE_LOG")"; fi

# --- ds wrapper skill wiring (U2): overlay checkout -----------------------------
# The ds source (skills/ds) lands via U1; this file's repo may not carry it
# yet, so ds assertions run against an overlay checkout holding THIS script +
# a skill source (the real one when present, else a minimal SKILL.md
# fixture — the wiring needs a valid dir, not U1's content).
O="$TMP/overlay"; mkdir -p "$O/bin/host" "$O/bin/lib" "$O/conventions"
cp "$SCRIPT" "$O/bin/host/install-skills.sh"
# shellcheck source=tests/lib/install-ts.sh
. "$ROOT/tests/lib/install-ts.sh"; install_ts_copy "$O"
cp "$ROOT/conventions/roles.conf" "$ROOT/conventions/models.conf" "$O/conventions/"
if [ -f "$ROOT/skills/ds/SKILL.md" ]; then
  mkdir -p "$O/skills"; cp -r "$ROOT/skills/ds" "$O/skills/ds"
else
  mkdir -p "$O/skills/ds"
  printf -- '---\nname: ds\ndescription: fixture ds wrapper (wiring test only)\n---\n# fixture\n' > "$O/skills/ds/SKILL.md"
fi
# Overlay stub: `skills list` prints $MUSE_LIST so the ds verdicts are
# controllable (real `NAME SCOPE ACTIVATION` rows, see list_rows); everything else logs its argv like the main stub. Each list
# call also prints a distinct LIST-CALL-n marker (sequenced per run via
# $MUSE_LIST_COUNT), so the quiet/verbose tests can pin the CE and ds dumps
# independently — suppressing either branch alone fails the test.
OSTUB="$TMP/ostub"; mkdir -p "$OSTUB"
for t in bash find ls sort tail basename dirname cat grep rm sed mkdir awk bun; do
  ln -s "$(command -v "$t")" "$OSTUB/$t"
done
export MUSE_LIST="$TMP/muse-list.txt"; : > "$MUSE_LIST"
export MUSE_LIST_COUNT="$TMP/muse-list-count"
cat > "$OSTUB/muse" <<'FAKE'
#!/usr/bin/env bash
echo "muse $*" >> "$MUSE_LOG"
if [ "${1:-}" = "skills" ] && [ "${2:-}" = "list" ]; then
  n=0; [ -f "$MUSE_LIST_COUNT" ] && n="$(cat "$MUSE_LIST_COUNT")"
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  n=$((n + 1)); printf '%s' "$n" > "$MUSE_LIST_COUNT"
  echo "LIST-CALL-$n-MARKER"
  cat "$MUSE_LIST" 2>/dev/null || true
fi
# MUSE_FAIL_SKILL: that skill's `skills install` fails like a broken package.
if [ "${1:-}" = "skills" ] && [ "${2:-}" = "install" ] && [ -n "${MUSE_FAIL_SKILL:-}" ]; then
  case "${3:-}" in */"$MUSE_FAIL_SKILL") echo "boom: cannot install $MUSE_FAIL_SKILL" >&2; exit 1 ;; esac
fi
exit 0
FAKE
chmod +x "$OSTUB/muse"
OHOME="$TMP/ohome"; mkdir -p "$OHOME"
fake_home "$OHOME" 3.33.2 "$MUSE_CE_SKILLS ce-babysit-pr ce-dogfood"
# shellcheck disable=SC2086
# shellcheck disable=SC2086
list_rows on $MUSE_CE_SKILLS "$MUSE_DS_SKILL" > "$MUSE_LIST"

# 4. pass-list only: installed set == MUSE_CE_SKILLS + MUSE_DS_SKILL, partials
# absent; the ds install comes from the overlay source with --force.
rm -f "$MUSE_LOG"
HOME="$OHOME" PATH="$OSTUB" "$O/bin/host/install-skills.sh" --muse-only >/dev/null 2>&1
# shellcheck disable=SC2086
if [ "$(installed_names | sort)" = "$(printf '%s\n' $MUSE_CE_SKILLS "$MUSE_DS_SKILL" | sort)" ]; then good; else bad "installed set differs from CE list + ds: $(installed_names | tr '\n' ' ') vs $MUSE_CE_SKILLS $MUSE_DS_SKILL"; fi
for decoy in ce-babysit-pr ce-dogfood; do
  if installed_names | grep -q -F -x "$decoy"; then bad "decoy '$decoy' must not be installed"; else good; fi
done
if grep -F 'skills install' "$MUSE_LOG" | grep -F "$O/skills/$MUSE_DS_SKILL" | grep -q -F -- '--force'; then good; else bad "ds install must come from the checkout source with --force: $(cat "$MUSE_LOG")"; fi
if grep -q -F 'muse skills list' "$MUSE_LOG"; then good; else bad "refresh must end with 'muse skills list'"; fi

# 4b. second run installs the same set including ds (idempotent).
cp "$MUSE_LOG" "$TMP/first-o.log"
HOME="$OHOME" PATH="$OSTUB" "$O/bin/host/install-skills.sh" --muse-only >/dev/null 2>&1
second_only="$(grep -F 'skills install' "$MUSE_LOG" | tail -n "$(grep -c -F 'skills install' "$TMP/first-o.log")")"
if [ "$second_only" = "$(grep -F 'skills install' "$TMP/first-o.log")" ]; then good; else bad "overlay re-run installs differ from first run"; fi

# 4c. --check verdicts for the ds skill (read-only, no installs).
rm -f "$MUSE_LOG"
out="$(HOME="$OHOME" PATH="$OSTUB" "$O/bin/host/install-skills.sh" --check --muse-only 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -qF 'muse: ds skill ok' <<<"$out"; then good; else bad "--check with ds listed should say 'muse: ds skill ok': $out"; fi
# shellcheck disable=SC2086
list_rows on $MUSE_CE_SKILLS > "$MUSE_LIST"
rm -f "$MUSE_LOG"
out="$(HOME="$OHOME" PATH="$OSTUB" "$O/bin/host/install-skills.sh" --check --muse-only 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "--check with ds missing exits $rc, want 0"; fi
if grep -qF "$MUSE_DS_SKILL" <<<"$out"; then good; else bad "--check should name the missing ds skill: $out"; fi
if grep -qE '^(muse skills install|claude plugin (install|marketplace))' "$MUSE_LOG" 2>/dev/null; then bad "--check must not install anything"; else good; fi
# 4c-ii. a ds lookalike (longer id, ds-* mention in a description) is not ds.
printf 'old-ds\tuser\ton\tmentions ds-board\n' >> "$MUSE_LIST"
rm -f "$MUSE_LOG"
out="$(HOME="$OHOME" PATH="$OSTUB" "$O/bin/host/install-skills.sh" --check --muse-only 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "--check with only a ds lookalike exits $rc, want 0"; fi
if grep -qF "missing from 'muse skills list'" <<<"$out"; then good; else bad "--check must still report ds missing despite the lookalike: $out"; fi

# 4c-iii. quiet-by-default (U8): the default run prints one line per
# installed skill plus compact counts, never the full `muse skills list`
# dump; --verbose restores it. Call 1 is the CE dump, call 2 the ds dump, so
# asserting each marker independently pins both branches.
# shellcheck disable=SC2086
# shellcheck disable=SC2086
list_rows on $MUSE_CE_SKILLS "$MUSE_DS_SKILL" > "$MUSE_LIST"
rm -f "$MUSE_LOG" "$MUSE_LIST_COUNT"
out="$(HOME="$OHOME" PATH="$OSTUB" "$O/bin/host/install-skills.sh" --muse-only 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "quiet default run exits $rc, want 0: $out"; fi
for marker in LIST-CALL-1-MARKER LIST-CALL-2-MARKER; do
  if grep -qF "$marker" <<<"$out"; then bad "default run must not print the full 'muse skills list' dump ($marker)"; else good; fi
done
# shellcheck disable=SC2086
for skill in $MUSE_CE_SKILLS "$MUSE_DS_SKILL"; do
  if grep -qF "installed $skill" <<<"$out"; then good; else bad "default run should print one line per installed skill, missing '$skill'"; fi
done
if grep -qF 'installed, 0 skipped' <<<"$out"; then good; else bad "default run should print compact installed/skipped counts: $out"; fi
rm -f "$MUSE_LOG" "$MUSE_LIST_COUNT"
out="$(HOME="$OHOME" PATH="$OSTUB" "$O/bin/host/install-skills.sh" --muse-only --verbose 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "--verbose run exits $rc, want 0: $out"; fi
for marker in LIST-CALL-1-MARKER LIST-CALL-2-MARKER; do
  if grep -qF "$marker" <<<"$out"; then good; else bad "--verbose should restore the full 'muse skills list' dump ($marker): $out"; fi
done

# 4c-iv. skipped-skill dump (U8): with one CE skill missing from the
# plugin-cache source, the default run still prints the CE dump (call 1)
# while the ds dump (call 2) stays suppressed, and the count names the skip.
H3="$TMP/h3"; mkdir -p "$H3"
first="${MUSE_CE_SKILLS%% *}"; rest="${MUSE_CE_SKILLS#* }"
fake_home "$H3" 3.33.2 "$rest ce-babysit-pr ce-dogfood"
# shellcheck disable=SC2086
# shellcheck disable=SC2086
list_rows on $MUSE_CE_SKILLS "$MUSE_DS_SKILL" > "$MUSE_LIST"
rm -f "$MUSE_LOG" "$MUSE_LIST_COUNT"
out="$(HOME="$H3" PATH="$OSTUB" "$O/bin/host/install-skills.sh" --muse-only 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "skipped-skill run exits $rc, want 0: $out"; fi
if grep -qF 'LIST-CALL-1-MARKER' <<<"$out"; then good; else bad "default run with a skipped skill should print the CE dump: $out"; fi
if grep -qF 'LIST-CALL-2-MARKER' <<<"$out"; then bad "ds dump must stay suppressed in a default run"; else good; fi
expect_installed="$(printf '%s' "$rest" | wc -w | tr -d ' ')"
if grep -qF "muse ce-skills: $expect_installed installed, 1 skipped" <<<"$out"; then good; else bad "count should name the one skip: $out"; fi
if grep -qF "installed $first " <<<"$out"; then bad "missing '$first' must not print an installed line"; else good; fi
if grep -qF "'$first' not in" <<<"$out"; then good; else bad "missing '$first' should warn it was skipped: $out"; fi

# 4c-v. failing `muse skills list` (U8): installs succeed but every list
# call fails — default and --verbose must agree on exit 0, both warn
# distinctly, and both still reach the counts, verification, and done.
FSTUB="$TMP/fstub"; mkdir -p "$FSTUB"
for t in bash find ls sort tail basename dirname cat grep rm sed mkdir awk bun; do
  ln -s "$(command -v "$t")" "$FSTUB/$t"
done
cat > "$FSTUB/muse" <<'FAKE'
#!/usr/bin/env bash
echo "muse $*" >> "$MUSE_LOG"
if [ "${1:-}" = "skills" ] && [ "${2:-}" = "list" ]; then
  exit 1
fi
exit 0
FAKE
chmod +x "$FSTUB/muse"
expect_all="$(printf '%s' "$MUSE_CE_SKILLS" | wc -w | tr -d ' ')"
for mode in default verbose; do
  rm -f "$MUSE_LOG"
  if [ "$mode" = verbose ]; then
    out="$(HOME="$OHOME" PATH="$FSTUB" "$O/bin/host/install-skills.sh" --muse-only --verbose 2>&1)"; rc=$?
  else
    out="$(HOME="$OHOME" PATH="$FSTUB" "$O/bin/host/install-skills.sh" --muse-only 2>&1)"; rc=$?
  fi
  if [ "$rc" -eq 0 ]; then good; else bad "$mode run with failing list exits $rc, want 0: $out"; fi
  # Both install functions hit the failing list call, so the distinct
  # warning appears twice (CE + ds) — and never the dump itself.
  nwarn="$(printf '%s' "$out" | grep -cF "'muse skills list' failed" || true)"
  if [ "$nwarn" = 2 ]; then good; else bad "$mode run should warn twice (CE + ds), got $nwarn: $out"; fi
  if grep -qF '== done ==' <<<"$out"; then good; else bad "$mode run with failing list should still reach '== done ==': $out"; fi
  if grep -qF "muse ce-skills: $expect_all installed, 0 skipped" <<<"$out"; then good; else bad "$mode run should still print install counts: $out"; fi
done

# 4d. prune: source removed + ds still listed -> uninstall; source removed +
# not listed -> quiet skip, no uninstall.
rm -rf "$O/skills/ds"
list_rows on "$MUSE_DS_SKILL" > "$MUSE_LIST"
rm -f "$MUSE_LOG"
out="$(HOME="$OHOME" PATH="$OSTUB" "$O/bin/host/install-skills.sh" --muse-only 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "prune run exits $rc, want 0: $out"; fi
if grep -q -F "skills uninstall $MUSE_DS_SKILL" "$MUSE_LOG"; then good; else bad "prune should uninstall the stale ds skill: $(cat "$MUSE_LOG")"; fi
: > "$MUSE_LIST"
rm -f "$MUSE_LOG"
out="$(HOME="$OHOME" PATH="$OSTUB" "$O/bin/host/install-skills.sh" --muse-only 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "skip run exits $rc, want 0: $out"; fi
if grep -q -F "skills uninstall $MUSE_DS_SKILL" "$MUSE_LOG" 2>/dev/null; then bad "skip must not uninstall when ds is not listed"; else good; fi
if grep -q "skipping ds skill" <<<"$out"; then good; else bad "skip should say it skips the ds skill: $out"; fi

# 5. default path still exits 1 when claude is missing (behaviour unchanged).
H5="$TMP/h5"; mkdir -p "$H5"
rc=0; HOME="$H5" PATH="$STUB_NOMUSE" "$SCRIPT" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 1 ]; then good; else bad "default path without claude exits $rc, want 1"; fi

# 6. --muse-only never touches claude: with both CLIs present, claude stays unused.
STUB_BOTH="$TMP/stub-both"; mkdir -p "$STUB_BOTH"
for t in bash find ls sort tail basename dirname cat grep rm sed mkdir awk bun; do
  ln -s "$(command -v "$t")" "$STUB_BOTH/$t"
done
ln -s "$STUB/muse" "$STUB_BOTH/muse"
export CLAUDE_LOG="$TMP/claude.log"
cat > "$STUB_BOTH/claude" <<'FAKE'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_LOG"
exit 0
FAKE
chmod +x "$STUB_BOTH/claude"
rm -f "$MUSE_LOG" "$CLAUDE_LOG"
rc=0; HOME="$H2" PATH="$STUB_BOTH" "$SCRIPT" --muse-only >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 0 ] && [ -e "$MUSE_LOG" ]; then good; else bad "--muse-only with both CLIs should still install (rc=$rc)"; fi
if [ ! -e "$CLAUDE_LOG" ]; then good; else bad "--muse-only must not invoke claude"; fi

# (4d removed the overlay's ds source; put it back for the failure cases.)
mkdir -p "$O/skills/$MUSE_DS_SKILL"
printf -- '---\nname: %s\ndescription: fixture ds wrapper (wiring test only)\n---\n# fixture\n' "$MUSE_DS_SKILL" > "$O/skills/$MUSE_DS_SKILL/SKILL.md"

# 7. a failing `muse skills install` for one ce skill warns (naming it),
# carries on, and --muse-only still reaches verify and exits 0 (U6).
# shellcheck disable=SC2086
list_rows on $MUSE_CE_SKILLS "$MUSE_DS_SKILL" > "$MUSE_LIST"
bad_skill="${MUSE_CE_SKILLS%% *}"
rm -f "$MUSE_LOG"
out="$(MUSE_FAIL_SKILL="$bad_skill" HOME="$OHOME" PATH="$OSTUB" "$O/bin/host/install-skills.sh" --muse-only 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "failing ce install exits $rc, want 0: $out"; fi
if grep -qF "failed for '$bad_skill'" <<<"$out"; then good; else bad "failing ce install should warn naming '$bad_skill': $out"; fi
if grep -qF "1 failed" <<<"$out"; then good; else bad "ce summary should say '1 failed': $out"; fi
if grep -qF 'muse: CLI ok' <<<"$out"; then good; else bad "failing ce install should still print the verify block: $out"; fi
if [ "$(installed_names | wc -l | tr -d ' ')" -gt "$(( $(printf '%s' "$MUSE_CE_SKILLS" | wc -w) ))" ]; then good; else bad "the loop must carry on past the failure (ds still attempted): $(installed_names | tr '\n' ' ')"; fi

# 8. same for the ds skill.
rm -f "$MUSE_LOG"
out="$(MUSE_FAIL_SKILL="$MUSE_DS_SKILL" HOME="$OHOME" PATH="$OSTUB" "$O/bin/host/install-skills.sh" --muse-only 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "failing ds install exits $rc, want 0: $out"; fi
if grep -qF "failed for '$MUSE_DS_SKILL'" <<<"$out"; then good; else bad "failing ds install should warn naming the skill: $out"; fi
if grep -qF 'muse: CLI ok' <<<"$out"; then good; else bad "failing ds install should still print the verify block: $out"; fi

# 9. full install with stub claude/curl/npx: the ds skill goes to muse with --force,
# and a failing muse install still lets the full install finish (exit 0).
STUB_FULL="$TMP/stub-full"; mkdir -p "$STUB_FULL"
for t in bash find ls sort tail basename dirname cat grep rm sed mkdir awk bun sh jq readlink; do
  ln -s "$(command -v "$t")" "$STUB_FULL/$t"
done
ln -s "$OSTUB/muse" "$STUB_FULL/muse"
for t in curl npx; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB_FULL/$t"; chmod +x "$STUB_FULL/$t"
done
# claude: like the real CLI, `plugin install` lays down the plugin and records a user entry
# (install-skills re-reads the registry after an install and fails a run that recorded nothing).
ROLE_CE_SKILLS="$("$ROOT/bin/ds" account-skills role-skills ce)"
cat > "$STUB_FULL/claude" <<STUB
#!/usr/bin/env bash
[ "\$1 \$2" = "plugin install" ] || exit 0
ip="\$HOME/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/9.9.9"
for s in $ROLE_CE_SKILLS; do mkdir -p "\$ip/skills/\$s"; : > "\$ip/skills/\$s/SKILL.md"; done
printf '{"version":2,"plugins":{"%s":[{"scope":"user","installPath":"%s"}]}}' "\$3" "\$ip" \
  > "\$HOME/.claude/plugins/installed_plugins.json"
STUB
chmod +x "$STUB_FULL/claude"
rm -f "$MUSE_LOG"
out="$(MUSE_FAIL_SKILL="$bad_skill" HOME="$OHOME" PATH="$STUB_FULL" "$O/bin/host/install-skills.sh" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "full install with a failing muse skill exits $rc, want 0: $out"; fi
if grep -F 'skills install' "$MUSE_LOG" | grep -F "skills/$MUSE_DS_SKILL" | grep -q -F -- '--force'; then good; else bad "full install must install the ds skill with --force: $(cat "$MUSE_LOG")"; fi
if grep -qF '== done ==' <<<"$out"; then good; else bad "full install should reach '== done ==': $out"; fi

# 10. verify reads the name + activation columns (U6).
verify_with() { # <rows…> -> --check --muse-only output
  : > "$MUSE_LIST"; cat > "$MUSE_LIST"
  HOME="$OHOME" PATH="$OSTUB" "$O/bin/host/install-skills.sh" --check --muse-only 2>&1
}
out="$(list_rows on ce-worktree | verify_with)"
if grep -qF 'missing from' <<<"$out" && grep -qF 'ce-work' <<<"$out" && ! grep -qF 'ce-* skills ok' <<<"$out"; then good; else bad "only ce-worktree on: ce-work must be missing (substring is not installed): $out"; fi
# shellcheck disable=SC2086
out="$({ list_rows on $MUSE_CE_SKILLS "$MUSE_DS_SKILL" | grep -v '^ce-work'"$(printf '\t')"; printf 'ce-work\tuser\toff\tfixture\n'; } | verify_with)"
if grep -qE "missing from 'muse skills list': .*ce-work" <<<"$out" && ! grep -qF 'ce-* skills ok' <<<"$out"; then good; else bad "ce-work off must count as missing: $out"; fi
# shellcheck disable=SC2086
out="$({ list_rows on $MUSE_CE_SKILLS; printf '%s\tuser\toff\tfixture\n' "$MUSE_DS_SKILL"; } | verify_with)"
if grep -qF "muse ds skill '$MUSE_DS_SKILL' missing" <<<"$out" && ! grep -qF 'ds skill ok' <<<"$out"; then good; else bad "ds off must count as missing: $out"; fi
# shellcheck disable=SC2086
out="$(list_rows on $MUSE_CE_SKILLS "$MUSE_DS_SKILL" | verify_with)"
if grep -qF 'ce-* skills ok' <<<"$out" && grep -qF 'muse: ds skill ok' <<<"$out" && ! grep -qF 'missing' <<<"$out"; then good; else bad "all seven on: expected ok: $out"; fi

echo "install-skills-muse: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
