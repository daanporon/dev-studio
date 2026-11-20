#!/usr/bin/env bash
# install-skills-muse-ds.sh — the dev-studio ds-* wrapper skill on Muse, in a
# throwaway HOME (never the live one) with a stub `muse` on a stub PATH:
# validate passes, a symlinked skill DIR installs and lists active, a bare
# .md symlink is ignored (never installed), install is idempotent, --check
# changes nothing, and a removed source prunes a stale install.
#
# Regression pins of the live framing probes (`muse skills validate/install/
# list` on a scratch HOME: validate prints `valid\tds`; a symlinked DIR
# installs and lists `ds user on …`; a bare .md symlink fails with `skill
# package must be a directory`). The stub below replays exactly those
# verdicts, so this test fails if the wrapper source (skills/ds/SKILL.md) or
# the wiring (MUSE_DS_SKILL + install_muse_ds_skill + the --check verdict in
# bin/host/install-skills.sh) regresses.
#
# The skill name under test is derived from the MUSE_DS_SKILL line in
# bin/host/install-skills.sh — never hardcoded — so a rename changes the script
# alone and this test follows it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SCRIPT="$ROOT/bin/host/install-skills.sh"
TMP="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
good(){ pass=$((pass + 1)); }
bad(){ fail=$((fail + 1)); echo "  FAIL: $1" >&2; }

# The skill under test: exactly what the script wires, nothing hardcoded.
MUSE_DS_SKILL="$(sed -n 's/^export const MUSE_DS_SKILL = "\(.*\)";$/\1/p' "$ROOT/bin/lib/install.ts")"
[ -n "${MUSE_DS_SKILL:-}" ] || { echo "  FAIL: no MUSE_DS_SKILL line in bin/lib/install.ts" >&2; exit 1; }

# --- stub PATH: real coreutils + a fake `muse` replaying the live verdicts ---
STUB="$TMP/stub"; mkdir -p "$STUB"
for t in bash find ls sort tail basename dirname cat grep rm sed mkdir mv readlink head awk bun; do
  ln -s "$(command -v "$t")" "$STUB/$t"
done
export MUSE_LOG="$TMP/muse.log" MUSE_STATE="$TMP/muse-state"
mkdir -p "$MUSE_STATE"
cat > "$STUB/muse" <<'FAKE'
#!/usr/bin/env bash
# stub muse: `skills validate/install/list/uninstall` with the live framing
# verdicts (validate prints `valid\t<name>`; a non-directory package fails
# with `skill package must be a directory`). Installed skills persist in
# $MUSE_STATE/installed.tsv as name/scope/activation/description/path rows.
echo "muse $*" >> "$MUSE_LOG"
[ "${1:-}" = skills ] || exit 0
verb="${2:-}"; arg="${3:-}"
pkg_name() { # <path> -> frontmatter name, or fail like the live CLI
  local d="$1" f="$2" name
  [ -d "$d" ] || { echo "skill package must be a directory" >&2; return 1; }
  f="$d/SKILL.md"
  [ -f "$f" ] || { echo "skill package has no SKILL.md" >&2; return 1; }
  [ "$(sed -n '1p' "$f")" = "---" ] || { echo "skill package has no frontmatter" >&2; return 1; }
  name="$(grep -E '^name: ' "$f" | sed 's/^name: *//' | head -n 1)"
  [ -n "$name" ] || { echo "skill package has no name" >&2; return 1; }
  printf '%s' "$name"
}
pkg_desc() { grep -E '^description: ' "$1/SKILL.md" | sed 's/^description: *//' | head -n 1; }
case "$verb" in
  validate)
    name="$(pkg_name "$arg")" || exit 1
    printf 'valid\t%s\n' "$name"
    ;;
  install)
    name="$(pkg_name "$arg")" || exit 1
    [ "$name" = "${MUSE_FAIL_SKILL:-}" ] && { echo "boom: cannot install $name" >&2; exit 1; }
    mkdir -p "$MUSE_STATE"
    grep -v -F -e "$(printf '%s\t' "$name")" "$MUSE_STATE/installed.tsv" 2>/dev/null > "$MUSE_STATE/next.tsv" || true
    printf '%s\tuser\ton\t%s\t%s\n' "$name" "$(pkg_desc "$arg")" "$(readlink -f "$arg")" >> "$MUSE_STATE/next.tsv"
    mv "$MUSE_STATE/next.tsv" "$MUSE_STATE/installed.tsv"
    printf '%s\t%s\n' "$name" "$(readlink -f "$arg")"
    ;;
  list)
    printf 'NAME\tSCOPE\tACTIVATION\tDESCRIPTION\tPATH\n'
    cat "$MUSE_STATE/installed.tsv" 2>/dev/null || true
    ;;
  uninstall)
    mkdir -p "$MUSE_STATE"
    grep -v -F -e "$(printf '%s\t' "$arg")" "$MUSE_STATE/installed.tsv" 2>/dev/null > "$MUSE_STATE/next.tsv" || true
    mv "$MUSE_STATE/next.tsv" "$MUSE_STATE/installed.tsv"
    ;;
esac
exit 0
FAKE
chmod +x "$STUB/muse"

reset_state(){ rm -rf "$MUSE_STATE"; mkdir -p "$MUSE_STATE"; rm -f "$MUSE_LOG"; }
# An overlay checkout holding THIS script's wiring plus a chosen skill-source
# shape (real dir, symlinked dir, bare .md symlink, or absent).
# make_overlay <dir>: bin/host/install-skills.sh + conventions, no skill source.
make_overlay(){
  local o="$1"
  mkdir -p "$o/bin/host" "$o/bin/lib" "$o/conventions"
  cp "$SCRIPT" "$o/bin/host/install-skills.sh"
  cp "$ROOT/conventions/roles.conf" "$ROOT/conventions/models.conf" "$o/conventions/"
  install_ts_copy "$o"
}
# shellcheck source=tests/lib/install-ts.sh
. "$ROOT/tests/lib/install-ts.sh"

# 1. wrapper source matches the wired name: SKILL.md frontmatter `name:` is
# exactly MUSE_DS_SKILL (a rename on either side breaks install + --check).
SRC="$ROOT/skills/$MUSE_DS_SKILL"
[ -f "$SRC/SKILL.md" ] || { echo "  FAIL: wrapper source missing: $SRC/SKILL.md" >&2; exit 1; }
if [ "$(grep -E '^name: ' "$SRC/SKILL.md" | sed 's/^name: *//' | head -n 1)" = "$MUSE_DS_SKILL" ]; then good;
else bad "SKILL.md frontmatter name differs from MUSE_DS_SKILL=$MUSE_DS_SKILL"; fi

# 2. validate passes on the checkout source (the live `valid\tds` verdict).
reset_state
rc=0; out="$(PATH="$STUB" muse skills validate "$SRC" 2>&1)" || rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "validate exits $rc, want 0: $out"; fi
if [ "$out" = "$(printf 'valid\t%s' "$MUSE_DS_SKILL")" ]; then good;
else bad "validate should print 'valid\\t$MUSE_DS_SKILL', got: $out"; fi

# 3. symlinked skill DIR installs (resolving the link) and lists active.
O3="$TMP/o3"; make_overlay "$O3"
mkdir -p "$O3/skills"; ln -s "$SRC" "$O3/skills/$MUSE_DS_SKILL"
reset_state
rc=0; out="$(HOME="$TMP/h3" PATH="$STUB" "$O3/bin/host/install-skills.sh" --muse-only 2>&1)" || rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "symlinked-DIR install exits $rc, want 0: $out"; fi
if grep -F 'skills install' "$MUSE_LOG" | grep -q -F -- '--force'; then good;
else bad "symlinked-DIR install must pass --force: $(cat "$MUSE_LOG")"; fi
if grep -F 'skills install' "$MUSE_LOG" | grep -q -F "$O3/skills/$MUSE_DS_SKILL"; then good;
else bad "install must come from the checkout source: $(cat "$MUSE_LOG")"; fi
if PATH="$STUB" muse skills list 2>/dev/null | grep -q -E "^${MUSE_DS_SKILL}[[:space:]].*on"; then good;
else bad "symlinked DIR must list active after install"; fi

# 4. bare .md symlink is ignored: wiring skips it, never installs it.
O4="$TMP/o4"; make_overlay "$O4"
mkdir -p "$O4/skills" "$TMP/bare-md"
cp "$SRC/SKILL.md" "$TMP/bare-md/SKILL.md"
ln -s "$TMP/bare-md/SKILL.md" "$O4/skills/$MUSE_DS_SKILL"
reset_state
rc=0; out="$(HOME="$TMP/h4" PATH="$STUB" "$O4/bin/host/install-skills.sh" --muse-only 2>&1)" || rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "bare-md run exits $rc, want 0: $out"; fi
if grep -q -F 'skills install' "$MUSE_LOG" 2>/dev/null; then bad "bare .md symlink must never be installed: $(cat "$MUSE_LOG")";
else good; fi
if grep -q "skipping ds skill" <<<"$out"; then good;
else bad "bare .md run should say it skips the ds skill: $out"; fi

# 5. install is idempotent: a second run installs the same set.
reset_state
rc1=0; rc2=0
HOME="$TMP/h3" PATH="$STUB" "$O3/bin/host/install-skills.sh" --muse-only >/dev/null 2>&1 || rc1=$?
cp "$MUSE_LOG" "$TMP/first.log"
HOME="$TMP/h3" PATH="$STUB" "$O3/bin/host/install-skills.sh" --muse-only >/dev/null 2>&1 || rc2=$?
if [ "$rc1" -eq 0 ] && [ "$rc2" -eq 0 ]; then good;
else bad "idempotence runs exit $rc1/$rc2, want 0/0"; fi
first_n="$(grep -c -F 'skills install' "$TMP/first.log")"
second_only="$(grep -F 'skills install' "$MUSE_LOG" | tail -n "$first_n")"
if [ "$second_only" = "$(grep -F 'skills install' "$TMP/first.log")" ]; then good;
else bad "re-run installs differ from first run"; fi

# 6. --check changes nothing: ok verdict when listed, names it when missing,
# and installs/uninstalls nothing either way.
rm -f "$MUSE_LOG"
rc=0; out="$(HOME="$TMP/h3" PATH="$STUB" "$O3/bin/host/install-skills.sh" --check --muse-only 2>&1)" || rc=$?
if [ "$rc" -eq 0 ] && grep -qF 'muse: ds skill ok' <<<"$out"; then good;
else bad "--check with ds listed should say 'muse: ds skill ok': $out"; fi
reset_state
rm -f "$MUSE_LOG"
rc=0; out="$(HOME="$TMP/h3" PATH="$STUB" "$O3/bin/host/install-skills.sh" --check --muse-only 2>&1)" || rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "--check with ds missing exits $rc, want 0"; fi
if grep -qF "$MUSE_DS_SKILL" <<<"$out"; then good;
else bad "--check should name the missing ds skill: $out"; fi
if grep -qE 'skills (install|uninstall)' "$MUSE_LOG" 2>/dev/null; then bad "--check must not install or uninstall: $(cat "$MUSE_LOG")";
else good; fi

# 7. stale-skill prune: source removed + ds listed -> uninstall; source
# removed + not listed -> quiet skip, no uninstall.
O7="$TMP/o7"; make_overlay "$O7"; mkdir -p "$O7/skills"
printf '%s\tuser\ton\tstale\t/nowhere\n' "$MUSE_DS_SKILL" > "$MUSE_STATE/installed.tsv"
rm -f "$MUSE_LOG"
rc=0; out="$(HOME="$TMP/h7" PATH="$STUB" "$O7/bin/host/install-skills.sh" --muse-only 2>&1)" || rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "prune run exits $rc, want 0: $out"; fi
if grep -q -F "skills uninstall $MUSE_DS_SKILL" "$MUSE_LOG"; then good;
else bad "prune should uninstall the stale ds skill: $(cat "$MUSE_LOG")"; fi
if ! PATH="$STUB" muse skills list 2>/dev/null | grep -q -E "^$MUSE_DS_SKILL([[:space:]]|$)"; then good;
else bad "pruned skill must no longer list"; fi
reset_state
rm -f "$MUSE_LOG"
rc=0; out="$(HOME="$TMP/h7" PATH="$STUB" "$O7/bin/host/install-skills.sh" --muse-only 2>&1)" || rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "skip run exits $rc, want 0: $out"; fi
if grep -q -F "skills uninstall $MUSE_DS_SKILL" "$MUSE_LOG" 2>/dev/null; then bad "skip must not uninstall when ds is not listed";
else good; fi
if grep -q "skipping ds skill" <<<"$out"; then good;
else bad "skip should say it skips the ds skill: $out"; fi

# 8. a failing ds install warns (naming the skill), carries on, still reaches
# verify_agents and exits 0; the verify block says the ds skill is missing.
reset_state
rc=0; out="$(MUSE_FAIL_SKILL="$MUSE_DS_SKILL" HOME="$TMP/h8" PATH="$STUB" "$O3/bin/host/install-skills.sh" --muse-only 2>&1)" || rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "failing ds install exits $rc, want 0: $out"; fi
if grep -qF "failed for '$MUSE_DS_SKILL'" <<<"$out"; then good;
else bad "failing ds install should warn naming the skill: $out"; fi
if grep -qF '1 failed' <<<"$out"; then good; else bad "ds summary should say '1 failed': $out"; fi
if grep -qF "muse ds skill '$MUSE_DS_SKILL' missing" <<<"$out"; then good;
else bad "verify block should report the ds skill missing: $out"; fi
if grep -qF '== done ==' <<<"$out"; then good; else bad "failing ds install should reach '== done ==': $out"; fi

# 9. present-but-off ds skill counts as missing in --check.
reset_state
printf '%s\tuser\toff\tdisabled\t/x\n' "$MUSE_DS_SKILL" > "$MUSE_STATE/installed.tsv"
out="$(HOME="$TMP/h9" PATH="$STUB" "$O3/bin/host/install-skills.sh" --check --muse-only 2>&1)" || true
if grep -qF "muse ds skill '$MUSE_DS_SKILL' missing" <<<"$out"; then good;
else bad "ds 'off' must count as missing: $out"; fi
if grep -qF 'muse: ds skill ok' <<<"$out"; then bad "ds 'off' must not say ok: $out"; else good; fi

echo "install-skills-muse-ds: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
