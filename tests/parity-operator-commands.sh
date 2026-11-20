#!/usr/bin/env bash
# parity-operator-commands.sh — the ported operator commands (U263: roles, limits, close-role, spawn-squad,
# add-role, close-squad, notify-squads, approve-fix, suspend-squad, ship-mode) do what the shell versions did on
# the same input: same output, exit code, `ds` calls and resulting files (conf bytes included). The shell side is
# the tree at PARITY_BASE (default 8b0818e, the last commit with the shell versions), unpacked with git archive.
# One normal run and one refusal per command, on a hermetic state root.
set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${PARITY_BASE:-8b0818e}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! git -C "$ROOT" cat-file -e "$BASE^{commit}" 2>/dev/null; then
  echo "parity-operator-commands: $BASE is not in this clone — skipped"; echo "parity-operator-commands: 0 passed, 0 failed"; exit 0
fi
mkdir "$TMP/old" "$TMP/new"
git -C "$ROOT" archive "$BASE" bin roles studio skills | tar -x -C "$TMP/old"
# Only bin/ is under test: both sides read today's conventions, so a later edit there (U264's
# studio_move comment) is no parity break.
cp -r "$ROOT/conventions" "$TMP/old/"
cp -r "$ROOT/bin" "$ROOT/conventions" "$ROOT/roles" "$ROOT/studio" "$ROOT/skills" "$TMP/new/"
mkdir "$TMP/home"; export HOME="$TMP/home" MUSE_MODEL_CATALOG_DIR="$TMP/nomuse"
export CALLS="$TMP/calls"
for t in old new; do
  # Stubs that only log: the loop's wish writer, the spawn script approve-fix calls, and the live model catalog.
  for s in bin/ds bin/commands/spawn-squad-stub.sh bin/lib/codex-models.sh; do
    { echo '#!/usr/bin/env bash'
      case "$s" in
        bin/lib/codex-models.sh) echo 'echo "{\"agent\":\"codex\",\"model\":\"gpt\",\"label\":\"GPT\",\"efforts\":[\"low\"],\"custom\":false}"' ;;
        *) echo 'echo "$(basename "$0") $*" >> "$CALLS"; case "$*" in *"--topic failspawn"*) exit 1 ;; esac' ;;
      esac; } > "$TMP/$t/$s"
    chmod +x "$TMP/$t/$s"
  done
done
# The new tree's wrappers reach the real bin/ds through a copy rooted at the new tree; its own wish calls go to the stub.
cp "$ROOT/bin/ds" "$TMP/realds"; sed -i "s|ROOT=.*|ROOT=\"$TMP/new\"|" "$TMP/realds"
for w in roles limits close-role spawn-squad add-role close-squad notify-squads approve-fix suspend-squad ship-mode; do
  sed -i "s|\"\$ROOT/bin/ds\" $w-ts|\"$TMP/realds\" $w-ts|" "$TMP/new/bin/commands/$w.sh"
done

fresh_state() {
  rm -rf "$TMP/state"; mkdir -p "$TMP/state/proj/squads" "$TMP/state/proj/x"
  echo '{"run_id":"run_a","status":"running","type":"feature","members":[{"role":"lead","wt":"wt-l"},{"role":"builder","suffix":"x","wt":"wt-b"},{"role":"builder","suffix":"y","wt":"wt-y"},{"role":"thinker","wt":"wt-t"}],"units":[{"slug":"x","builder_wt":"wt-b","status":"done"},{"slug":"y","builder_wt":"wt-y","status":"dispatched"}],"proposed_squads":[{"id":"p1","topic":"fix1","repo":"r","status":"proposed","framing":"do it"},{"id":"p2","topic":"failspawn","repo":"r","status":"proposed","framing":"f"},{"id":"p3","topic":"t3","repo":"r","status":"spawned","framing":"f"}]}' > "$TMP/state/proj/squads/a.json"
  echo '{"run_id":"run_b","status":"suspended","type":"testing","members":[{"role":"lead","wt":"w"}]}' > "$TMP/state/proj/squads/b.json"
  echo '{"status":"running","members":[{"role":"lead","wt":"w"}]}' > "$TMP/state/proj/squads/norun.json"
  printf 'lead claude opus always\nbuilder claude sonnet always high codex:gpt-5:low\n' > "$TMP/state/proj/roles.conf"
  printf 'max_builders 3\nauto_merge off\n' > "$TMP/state/proj/limits.conf"
  : > "$CALLS"
}
export DS_STATE_ROOT="$TMP/state" DS_SPAWN="$TMP/DS_SPAWN"
pass=0; fail=0
norm() { sed -E "s# \[--start plan\|brainstorm\|ask\|investigate\]##; s#$TMP/(old|new)#<tree>#g; s#$TMP/realds#<tree>/bin/ds#g; s#$TMP/state#<state>#g; s#[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z#<ts>#g"; }
same() { # <name> <script path relative to a tree> [args…]
  local name="$1" rel="$2"; shift 2
  local res=() t
  for t in old new; do
    fresh_state
    printf '#!/usr/bin/env bash\necho "spawn $*" >> "$CALLS"; case "$*" in *"--topic failspawn"*) exit 1 ;; esac\n' > "$TMP/DS_SPAWN"; chmod +x "$TMP/DS_SPAWN"
    local out rc=0
    out="$(cd "$TMP/$t" && DS_ROOT="" "$TMP/$t/$rel" "$@" 2>&1)" || rc=$?
    res+=("$(printf 'rc=%s\n%s\n-- calls\n%s\n-- files\n%s\n' "$rc" "$out" "$(cat "$CALLS")" \
      "$(cd "$TMP/state" && find . -type f | sort | while read -r f; do echo "== $f"; cat "$f"; done)" | norm)")
  done
  if [ "${res[0]}" = "${res[1]}" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $name" >&2; diff <(printf '%s\n' "${res[0]}") <(printf '%s\n' "${res[1]}") | cut -c1-200 | head -12 >&2 || true; fi
}
C=bin/commands
same "ship-mode view"                 $C/ship-mode.sh proj
same "ship-mode usage"                $C/ship-mode.sh
same "suspend-squad"                  $C/suspend-squad.sh proj a --wait 3
same "suspend-squad resume"           $C/suspend-squad.sh proj b --resume
same "suspend-squad not suspended"    $C/suspend-squad.sh proj a --resume
same "suspend-squad no squad"         $C/suspend-squad.sh proj zz
same "suspend-squad usage"            $C/suspend-squad.sh proj
same "close-squad"                    $C/close-squad.sh proj a --force
same "close-squad list"               $C/close-squad.sh proj
same "close-squad no squad"           $C/close-squad.sh proj zz
same "close-squad usage"              $C/close-squad.sh
same "add-role builder"               $C/add-role.sh proj a builder u9 --spec "do x"
same "add-role tester"                $C/add-role.sh proj a tester t1
same "add-role lead"                  $C/add-role.sh proj a lead x
same "add-role bad role"              $C/add-role.sh proj a boss x
same "add-role no squad"              $C/add-role.sh proj zz builder x
same "add-role usage"                 $C/add-role.sh proj a
same "notify-squads"                  $C/notify-squads.sh proj
same "notify-squads none"             $C/notify-squads.sh nope
same "notify-squads usage"            $C/notify-squads.sh
same "spawn-squad"                    $C/spawn-squad.sh --repo proj --topic new1 --type testing --autonomy lfg --framing "hi there" --host h1
same "spawn-squad minimal"            $C/spawn-squad.sh --repo proj --topic new2 --wait 2
same "spawn-squad bad topic"          $C/spawn-squad.sh --repo proj --topic .bad
same "spawn-squad bad type"           $C/spawn-squad.sh --repo proj --topic t --type x
same "spawn-squad usage"              $C/spawn-squad.sh --repo proj
same "approve-fix"                    $C/approve-fix.sh proj a p1 --autonomy lfg
same "approve-fix spawned"            $C/approve-fix.sh proj a p3
same "approve-fix failing spawn"      $C/approve-fix.sh proj a p2
same "approve-fix no proposal"        $C/approve-fix.sh proj a p9
same "approve-fix usage"              $C/approve-fix.sh proj a
same "close-role"                     $C/close-role.sh proj a builder-x
same "close-role cancel"              $C/close-role.sh proj a builder-y --cancel --why gone
same "close-role dispatched"          $C/close-role.sh proj a builder-y
same "close-role lead"                $C/close-role.sh proj a lead
same "close-role unknown"             $C/close-role.sh proj a nobody
same "close-role usage"               $C/close-role.sh proj a
same "limits show"                    $C/limits.sh show proj
same "limits show json"               $C/limits.sh show --json proj
same "limits usage"                   $C/limits.sh bogus
# U267 changed these on purpose, so they are left out: `list <project>` (and --json) shows the
# project's rows over the default's, per role, and `reset <project> <role>` drops the project's row.
# tests/roles.sh and tests/start-pick.sh cover the new behavior.
# U256 changed every write of roles, limits and ship-mode on purpose, so those are left out too: a
# write cuts the state root over (the project's conf files become loop.db rows and are renamed
# `.imported-<date>`) and changes a row, not a file; a refusal says why through bin/loop/settings/settings.ts.
# tests/limits.sh, tests/roles.sh, tests/ship-mode.sh and tests/loop/settings-migrate.test.ts cover it.
same "roles list default"             $C/roles.sh list
same "roles usage"                    $C/roles.sh set proj
echo "parity-operator-commands: $pass passed, $fail failed"
[ "$fail" = 0 ]
