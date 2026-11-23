#!/usr/bin/env bash
# update-host.sh — bin/host/update-host.sh on a hermetic git repo with a fake install and a fake bin/loop/loop.sh:
# it lands on origin/<the branch it is on>, never on origin/main from loop-v1; the loop restarts once
# when the commit moved and not at all when it did not, or when it is not running; a detached HEAD or
# a branch gone from origin exits non-zero and changes nothing; a failed install goes back to the old
# commit so the next run sees the move again; a failed restart is not reported as a plain advance.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@e.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@e.com
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

pass=0; fail=0
good(){ pass=$((pass + 1)); }
bad(){ fail=$((fail + 1)); echo "  FAIL: $1" >&2; }
# check <what> <want> <got>
check(){ if [ "$2" = "$3" ]; then good; else bad "$1: want [$2], got [$3]"; fi; }
has(){ if grep -qF -- "$2" <<<"$3"; then good; else bad "$1: no [$2] in [$3]"; fi; }

CLI_PATH="$TMP/cli"; mkdir -p "$CLI_PATH"
for t in bash dirname readlink git env grep cat; do ln -s "$(command -v "$t")" "$CLI_PATH/$t"; done
printf '#!/usr/bin/env bash\nexit 0\n' > "$CLI_PATH/codex"; chmod +x "$CLI_PATH/codex"
CODEX_CALL="skills --codex-only,"
export CALLS="$TMP/calls"   # every fake appends the call it got
fake(){ # fake <path>: the fake script committed into the origin repo, so it survives the reset
  mkdir -p "$(dirname "$1")"
  cat > "$1"; chmod +x "$1"
}

# Origin with main and loop-v1 that have different code; the scripts under test live in both.
ORIGIN="$TMP/origin.git"; SEED="$TMP/seed"
git init -q --bare -b main "$ORIGIN"
git init -q -b main "$SEED"
mkdir -p "$SEED/bin/host"; cp "$ROOT/bin/host/update-host.sh" "$SEED/bin/host/update-host.sh"
# U191: the port runs in TypeScript behind the one-line wrapper: the fixture carries ds and the files the command loads.
mkdir -p "$SEED/bin/lib" "$SEED/bin/commands" "$SEED/bin/loop/settings" "$SEED/bin/loop/core"; cp "$ROOT/bin/loop/settings/projects.ts" "$SEED/bin/loop/settings/"; cp "$ROOT/bin/loop/core/whoami.ts" "$SEED/bin/loop/core/"; cp "$ROOT/bin/ds" "$ROOT/bin/ds.ts" "$SEED/bin/"; cp "$ROOT/bin/lib/shared.ts" "$ROOT/bin/lib/upkeep.ts" "$SEED/bin/lib/"; cp "$ROOT/bin/commands/update-host-ts.ts" "$SEED/bin/commands/"
fake "$SEED/bin/host/install.sh" <<'F'
#!/usr/bin/env bash
echo "install${*:+ $*}" >> "$CALLS"
if [ "$1" = --check ]; then [ "${FAKE_CHECK_FAIL:-0}" = 0 ]; exit; fi
[ "${FAKE_INSTALL_FAIL:-0}" = 0 ]
F
fake "$SEED/bin/host/install-skills.sh" <<'F'
#!/usr/bin/env bash
echo "skills $*" >> "$CALLS"
if [ "$1" = --codex-only ] && [ "${FAKE_CODEX_INSTALL_FAIL:-0}" = 1 ]; then
  echo 'codex: install failed' >&2; exit 1
fi
if [ "${FAKE_CODEX_MISSING:-0}" = 1 ]; then
  case "$1" in
    --codex-only) : > "$FAKE_CODEX_READY" ;;
    --muse-only) [ -e "$FAKE_CODEX_READY" ] || { echo 'codex: missing ds' >&2; exit 1; } ;;
  esac
fi
if [ "$1" = --check ] && [ "${FAKE_SKILLS_BROKEN:-0}" = 1 ]; then
  echo "claude[system]: skills ok (/x)"
  echo "⚠ claude[p1]: compound-engineering not installed" >&2; exit 1
fi
F
fake "$SEED/bin/loop/loop.sh" <<'F'
#!/usr/bin/env bash
case "$1" in
  --status) [ "${FAKE_LOOP_RUNNING:-1}" = 1 ] || { echo "loop: not running"; exit 3; }; echo "loop: running (pid 1)" ;;
  --stop) echo stop >> "$CALLS" ;;
  --ensure) echo ensure >> "$CALLS"; env | grep -E '^(ORCA_|CLAUDE)' >> "$CALLS.env" || true; [ "${FAKE_ENSURE_FAIL:-0}" = 0 ] ;;
esac
F
git -C "$SEED" add -A; git -C "$SEED" commit -qm base
git -C "$SEED" remote add origin "$ORIGIN"; git -C "$SEED" push -q origin main
git -C "$SEED" checkout -q -b loop-v1; git -C "$SEED" push -q origin loop-v1
git -C "$SEED" checkout -q main

# On the loop unless a case says otherwise.
export DS_STATE_ROOT="$TMP/state"; mkdir -p "$DS_STATE_ROOT"; : > "$DS_STATE_ROOT/.loop-migrated"

# push_to <branch>: one new commit on origin's <branch>; prints its sha.
push_to(){
  git -C "$SEED" checkout -q "$1"
  git -C "$SEED" commit -q --allow-empty -m "change on $1 after $(git -C "$SEED" rev-parse HEAD)"
  git -C "$SEED" push -q origin "$1"
  git -C "$SEED" rev-parse HEAD
}
# host <dir> <branch>: a clean host checkout on <branch> at origin's current head.
host(){ git clone -q -b "$2" "$ORIGIN" "$1"; }
# update <dir>: run the script through a ~/.dev-studio-style symlink; sets OUT and RC, resets CALLS.
update(){
  : > "$CALLS"
  ln -sfn "$1" "$TMP/link"
  RC=0; OUT="$(PATH="${UPDATE_PATH:-$CLI_PATH}" "$TMP/link/bin/host/update-host.sh" 2>&1)" || RC=$?
}
head_of(){ git -C "$1" rev-parse HEAD; }
calls(){ tr '\n' ',' < "$CALLS"; }

echo "1. on loop-v1 it lands on origin/loop-v1, never origin/main, and restarts the loop once"
H="$TMP/h1"; host "$H" loop-v1; B="$(head_of "$H")"
M="$(push_to main)"; L="$(push_to loop-v1)"
update "$H"
check "rc" 0 "$RC"
check "HEAD" "$L" "$(head_of "$H")"
if [ "$(head_of "$H")" = "$M" ]; then bad "landed on main"; else good; fi
check "still on the branch" loop-v1 "$(git -C "$H" symbolic-ref --short HEAD)"
has "advanced line" "DS-UPDATE: advanced $B -> $L" "$OUT"
check "install, then one stop and one ensure" "install,${CODEX_CALL}skills --muse-only,skills --check,stop,ensure," "$(calls)"

echo "2. nothing new and install --check passes: the install is skipped, the skills refresh runs, the loop is left alone"
update "$H"
check "rc" 0 "$RC"
has "current line" "DS-UPDATE: already current ($L)" "$OUT"
check "check only, no install, no restart" "install --check,${CODEX_CALL}skills --muse-only,skills --check," "$(calls)"
has "skip line" "update: install skipped — checkout unchanged and install --check passed" "$OUT"

echo "2a. nothing new but install --check fails: the install repairs it"
export FAKE_CHECK_FAIL=1
update "$H"
unset FAKE_CHECK_FAIL
check "rc" 0 "$RC"
has "current line" "DS-UPDATE: already current ($L)" "$OUT"
check "check, then install" "install --check,install,${CODEX_CALL}skills --muse-only,skills --check," "$(calls)"

echo "2b. an uninitialized host installs the required loop"
rm "$DS_STATE_ROOT/.loop-migrated"
export FAKE_CHECK_FAIL=1
update "$H"
unset FAKE_CHECK_FAIL
check "rc" 0 "$RC"
check "install requires the loop" "install --check,install,${CODEX_CALL}skills --muse-only,skills --check," "$(calls)"
: > "$DS_STATE_ROOT/.loop-migrated"

echo "3. on main it lands on origin/main"
H="$TMP/h3"; host "$H" main; M2="$(push_to main)"
update "$H"
check "rc" 0 "$RC"
check "HEAD" "$M2" "$(head_of "$H")"
check "restart once" "install,${CODEX_CALL}skills --muse-only,skills --check,stop,ensure," "$(calls)"

echo "4. a stopped loop is not started by the update (its cron line does that)"
H="$TMP/h4"; host "$H" main; M3="$(push_to main)"
export FAKE_LOOP_RUNNING=0
update "$H"
unset FAKE_LOOP_RUNNING
check "rc" 0 "$RC"
check "HEAD" "$M3" "$(head_of "$H")"
check "no restart" "install,${CODEX_CALL}skills --muse-only,skills --check," "$(calls)"

echo "5. a detached HEAD exits non-zero and changes nothing"
H="$TMP/h5"; host "$H" main; D="$(head_of "$H")"
git -C "$H" checkout -q --detach; push_to main >/dev/null
R="$(git -C "$H" rev-parse origin/main)"
update "$H"
check "rc" 1 "$RC"
has "refused line" "DS-UPDATE: refused" "$OUT"
check "HEAD" "$D" "$(head_of "$H")"
check "still detached" "HEAD" "$(git -C "$H" rev-parse --abbrev-ref HEAD)"
check "not even a fetch" "$R" "$(git -C "$H" rev-parse origin/main)"
check "no install, no restart" "" "$(calls)"

echo "6. a branch gone from origin is refused, whatever stale origin/<branch> the checkout holds"
git -C "$SEED" checkout -q -b gone; git -C "$SEED" push -q origin gone
H="$TMP/h6"; host "$H" gone; G="$(head_of "$H")"
git -C "$SEED" checkout -q main; git -C "$SEED" push -q origin --delete gone
update "$H"
check "rc" 1 "$RC"
has "refused line" "DS-UPDATE: refused" "$OUT"
check "HEAD" "$G" "$(head_of "$H")"
check "no install, no restart" "" "$(calls)"

echo "7. a failed install goes back to the old commit, and the next run sees the move again"
H="$TMP/h7"; host "$H" main; O="$(head_of "$H")"; M4="$(push_to main)"
export FAKE_INSTALL_FAIL=1
update "$H"
unset FAKE_INSTALL_FAIL
check "rc" 1 "$RC"
has "failed line" "DS-UPDATE: failed" "$OUT"
check "HEAD back" "$O" "$(head_of "$H")"
check "no restart" "install," "$(calls)"
update "$H"
check "rerun rc" 0 "$RC"
has "rerun advanced" "DS-UPDATE: advanced $O -> $M4" "$OUT"
check "rerun restarts" "install,${CODEX_CALL}skills --muse-only,skills --check,stop,ensure," "$(calls)"

echo "8. a loop that does not come back is a failure, not a plain advance"
H="$TMP/h8"; host "$H" main; M5="$(push_to main)"
export FAKE_ENSURE_FAIL=1
update "$H"
unset FAKE_ENSURE_FAIL
check "rc" 1 "$RC"
has "failed line" "DS-UPDATE: failed" "$OUT"
check "stays on the new code" "$M5" "$(head_of "$H")"

echo "9. the restarted loop gets none of this terminal's ORCA_* or CLAUDE*"
H="$TMP/h9"; host "$H" main; push_to main >/dev/null
: > "$CALLS.env"
export ORCA_TERMINAL_HANDLE=term_x CLAUDE_CONFIG_DIR=/x
update "$H"
unset ORCA_TERMINAL_HANDLE CLAUDE_CONFIG_DIR
check "rc" 0 "$RC"
check "restart once" "install,${CODEX_CALL}skills --muse-only,skills --check,stop,ensure," "$(calls)"
check "clean env" "" "$(cat "$CALLS.env")"

echo "9b. a cron line with a data path does the start itself: this shell does not have the path"
H="$TMP/h9b"; host "$H" main; push_to main >/dev/null
CRON_BIN="$TMP/cron-bin"; fake "$CRON_BIN/crontab" <<'F'
#!/usr/bin/env bash
cat "$FAKE_CRONTAB"
F
export FAKE_CRONTAB="$TMP/crontab"
HP="$(cd "$H" && pwd -P)"
printf "* * * * * [ -x %s/bin/loop/loop.sh ] && PATH='x' ORCA_USER_DATA_PATH='/o' %s/bin/loop/loop.sh --ensure >> /l 2>&1\n" "$HP" "$HP" > "$FAKE_CRONTAB"
UPDATE_PATH="$CRON_BIN:$CLI_PATH" update "$H"
check "rc" 0 "$RC"
check "stop only" "install,${CODEX_CALL}skills --muse-only,skills --check,stop," "$(calls)"
echo "9c. a plain line, or another checkout's line with a path, still restarts here"
H="$TMP/h9c"; host "$H" main; push_to main >/dev/null
HP="$(cd "$H" && pwd -P)"
printf "* * * * * PATH='x' %s/bin/loop/loop.sh --ensure >> /l 2>&1\n* * * * * PATH='x' ORCA_USER_DATA_PATH='/o' /other/bin/loop/loop.sh --ensure >> /l 2>&1\n" "$HP" > "$FAKE_CRONTAB"
UPDATE_PATH="$CRON_BIN:$CLI_PATH" update "$H"
check "rc" 0 "$RC"
check "stop and ensure" "install,${CODEX_CALL}skills --muse-only,skills --check,stop,ensure," "$(calls)"

echo "10. a reset that fails prints its DS-UPDATE line and runs nothing"
H="$TMP/h10"; host "$H" main; O="$(head_of "$H")"; push_to main >/dev/null
touch "$H/.git/index.lock"
update "$H"
rm -f "$H/.git/index.lock"
check "rc" 1 "$RC"
has "failed line" "DS-UPDATE: failed" "$OUT"
check "HEAD" "$O" "$(head_of "$H")"
check "no install, no restart" "" "$(calls)"

echo "11. a broken Claude account is printed with its repair; the exit code and the DS-UPDATE line stay"
H="$TMP/h11"; host "$H" main; B="$(head_of "$H")"; A="$(push_to main)"
FAKE_LOOP_RUNNING=0 FAKE_SKILLS_BROKEN=1 update "$H"
check "rc" 0 "$RC"
has "advanced line" "DS-UPDATE: advanced $B -> $A" "$OUT"
has "warning" "update: WARNING — an agent cannot load the role skills" "$OUT"
has "the broken account" "⚠ claude[p1]: compound-engineering not installed" "$OUT"
has "the repair" "bin/host/install-skills.sh (the update carries on)" "$OUT"
check "the check runs after the install" "install,${CODEX_CALL}skills --muse-only,skills --check," "$(calls)"
FAKE_LOOP_RUNNING=0 FAKE_SKILLS_BROKEN=1 update "$H"
check "already current: rc" 0 "$RC"
has "already current: still warns" "update: WARNING" "$OUT"
has "already current line" "DS-UPDATE: already current" "$OUT"
FAKE_LOOP_RUNNING=0 update "$H"
if grep -q "WARNING" <<<"$OUT"; then bad "a healthy check prints no warning: $OUT"; else good; fi

echo "12. missing Codex skills are installed before the Muse-only step checks configured Codex roles"
H="$TMP/h12"; host "$H" loop-v1; B="$(head_of "$H")"; A="$(push_to loop-v1)"
export FAKE_CODEX_READY="$TMP/codex-ready"
FAKE_CODEX_MISSING=1 update "$H"
check "missing Codex skills: rc" 0 "$RC"
check "missing Codex skills: HEAD advanced" "$A" "$(head_of "$H")"
has "missing Codex skills: advanced line" "DS-UPDATE: advanced $B -> $A" "$OUT"
check "missing Codex skills: install before verification and restart" "install,${CODEX_CALL}skills --muse-only,skills --check,stop,ensure," "$(calls)"

echo "13. an optional Codex refresh failure still warns and carries on when verification passes"
FAKE_CODEX_INSTALL_FAIL=1 update "$H"
check "optional Codex failure: rc" 0 "$RC"
has "optional Codex failure: warning" "update: WARNING — Codex skills could not be refreshed" "$OUT"
has "optional Codex failure: already current" "DS-UPDATE: already current ($A)" "$OUT"

echo "14. missing required Codex skills still roll back when their install fails"
rm "$FAKE_CODEX_READY"
B="$(head_of "$H")"; push_to loop-v1 >/dev/null
FAKE_CODEX_INSTALL_FAIL=1 FAKE_CODEX_MISSING=1 update "$H"
check "required Codex install failure: rc" 1 "$RC"
check "required Codex install failure: HEAD back" "$B" "$(head_of "$H")"
has "required Codex install failure: failed line" "DS-UPDATE: failed — install did not finish" "$OUT"
check "required Codex install failure: no restart" "install,${CODEX_CALL}skills --muse-only," "$(calls)"

rm "$CLI_PATH/codex"
FAKE_LOOP_RUNNING=0 update "$H"
check "Codex absent: rc" 0 "$RC"
check "Codex absent: refresh skipped" "install,skills --muse-only,skills --check," "$(calls)"

echo "15. the outcome file records every exit; markers are seeded only where missing, before the loop restarts"
H="$TMP/h15"; host "$H" main; B="$(head_of "$H")"; A="$(push_to main)"
OF="$DS_STATE_ROOT/loop/host-update.json"
mkdir -p "$DS_STATE_ROOT/pa/squads" "$DS_STATE_ROOT/pb/squads" "$DS_STATE_ROOT/zzt/squads"
echo '{"rev":"keepme"}' > "$DS_STATE_ROOT/pb/squads-rev.json"
update "$H"
check "advanced: rc" 0 "$RC"
j(){ bun -e "const d=JSON.parse(require('fs').readFileSync('$1','utf8'));console.log(d$2)"; }
check "advanced: outcome" advanced "$(j "$OF" .outcome)"
check "advanced: before" "$B" "$(j "$OF" .before)"
check "advanced: after" "$A" "$(j "$OF" .after)"
check "advanced: branch" main "$(j "$OF" .branch)"
has "advanced: line" "DS-UPDATE: advanced $B -> $A" "$(j "$OF" .line)"
check "marker seeded with before" "$B" "$(j "$DS_STATE_ROOT/pa/squads-rev.json" .rev)"
check "marker not overwritten" keepme "$(j "$DS_STATE_ROOT/pb/squads-rev.json" .rev)"
[ ! -e "$DS_STATE_ROOT/zzt/squads-rev.json" ] && good || bad "test project got a marker"
update "$H"
check "already: outcome" already "$(j "$OF" .outcome)"
check "already: no new marker rewrite" "$B" "$(j "$DS_STATE_ROOT/pa/squads-rev.json" .rev)"
H="$TMP/h15b"; host "$H" main; git -C "$H" checkout -q --detach
update "$H"
check "refused: outcome" refused "$(j "$OF" .outcome)"
check "refused: branch null" null "$(j "$OF" .branch)"
H="$TMP/h15c"; host "$H" main; push_to main >/dev/null
FAKE_INSTALL_FAIL=1 update "$H"
check "failed: outcome" failed "$(j "$OF" .outcome)"
[ -z "$(find "$DS_STATE_ROOT/loop" -name "*.tmp")" ] && good || bad "tmp file left"

echo "update-host: $pass passed, $fail failed"
[ "$fail" = 0 ]
