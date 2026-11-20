#!/usr/bin/env bash
# parity-upkeep.sh — the ported upkeep scripts (U191: restart-role, restart-squads, update-squads, reclaim,
# codex-skills; up until U262 changed it) do what the shell versions did on the same input: same output, exit code, backend and
# ds calls, and files. The shell side is the tree at PARITY_BASE (default e153edd, the last commit with the
# shell versions), unpacked with git archive. update-host.sh has no case here: tests/update-host.sh drives
# it on a hermetic git repo and passes unchanged against the port.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${PARITY_BASE:-e153edd}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! git -C "$ROOT" cat-file -e "$BASE^{commit}" 2>/dev/null; then
  echo "parity-upkeep: $BASE is not in this clone — skipped"; echo "parity-upkeep: 0 passed, 0 failed"; exit 0
fi
mkdir "$TMP/old" "$TMP/new"
git -C "$ROOT" archive "$BASE" bin conventions roles studio skills | tar -x -C "$TMP/old"
cp -r "$ROOT/bin" "$ROOT/conventions" "$ROOT/roles" "$ROOT/studio" "$ROOT/skills" "$TMP/new/"
mkdir "$TMP/home"; export HOME="$TMP/home"
export CALLS="$TMP/calls"
for t in old new; do
  # Stubs that only log: the loop's wish writer, the hooks and the skills check are not what is compared here.
  for s in bin/ds bin/hooks/arm-rewake.sh bin/hooks/reassert-roles.sh bin/host/install-skills.sh; do
    [ "$s" = bin/ds ] || [ -f "$TMP/$t/$s" ] || continue
    { echo '#!/usr/bin/env bash'; echo 'echo "$(basename "$0") $*" >> "$CALLS"; case "$*" in "want member"*) echo "{\"stub\":true}" ;; esac'
      echo 'case "$*" in *"want member proj/a/builder/x"*) [ -z "${STUB_FAIL:-}" ] || exit 1 ;; esac'
      echo 'case "$0" in *install-skills.sh) [ -z "${SKILLS_BAD:-}" ] || { echo "account x: broken" >&2; exit 1; } ;; esac'; } > "$TMP/$t/$s"
    chmod +x "$TMP/$t/$s"
  done
done
# The ported command files need the real bin/ds to be reachable as `ds up-ts` etc.: the new tree runs the
# stub as bin/ds for its own wish calls, so the wrappers call the real one through REAL_DS.
cp "$ROOT/bin/ds" "$TMP/realds"; sed -i "s|ROOT=.*|ROOT=\"$TMP/new\"|" "$TMP/realds"
for w in restart-role restart-squads update-squads reclaim; do sed -i "s|\"\$ROOT/bin/ds\" $w-ts|\"$TMP/realds\" $w-ts|" "$TMP/new/bin/commands/$w.sh"; done
sed -i "s|\"\$ROOT/bin/ds\" up-ts|\"$TMP/realds\" up-ts|" "$TMP/new/bin/host/up.sh"
sed -i "s|\"\$ROOT/bin/ds\" codex-skills-ts|\"$TMP/realds\" codex-skills-ts|" "$TMP/new/bin/host/codex-skills.sh"

# A backend that answers the same fixed way for both trees.
mkdir "$TMP/wt"
cat > "$TMP/fakeb" <<'EOS'
#!/usr/bin/env bash
echo "backend $*" | sed "s|$TMP_ROOT|<tree>|g" >> "$CALLS"
case "$1" in
  current) echo "${FAKE_CURRENT:-}" ;;
  worker-reclaim) if [ -n "${2:-}" ]; then echo 3; else echo 5; fi ;;
  terminal-reap-orphaned) echo 2 ;;
  worker-resolve-unknown) echo abc ;;
  worktree-ensure) echo wt-1 ;;
  ps) printf '{"result":{"worktrees":[{"worktreeId":"wt-1","path":"%s"}]}}\n' "$WTDIR" ;;
  *) exit 0 ;;
esac
EOS
chmod +x "$TMP/fakeb"; export BACKEND="$TMP/fakeb" WTDIR="$TMP/wt"

fresh_state() {
  rm -rf "$TMP/state" "$TMP/wt" "$TMP/codex"; mkdir -p "$TMP/state/proj/squads" "$TMP/wt" "$TMP/home/ce/ce-code-review" "$TMP/home/ce/ce-work" "$TMP/home/ce/notaskill"
  : > "$TMP/home/ce/ce-code-review/SKILL.md"; : > "$TMP/home/ce/ce-work/SKILL.md"
  git init -q "$TMP/wt"
  echo '{"run_id":"run_a","status":"running","members":[{"role":"lead"},{"role":"builder","suffix":"x"},{"role":"thinker"}]}' > "$TMP/state/proj/squads/a.json"
  echo '{"run_id":"run_b","status":"suspended","members":[{"role":"lead"}]}' > "$TMP/state/proj/squads/b.json"
  echo 'not json' > "$TMP/state/proj/squads/c.json"
  echo '{"run_id":"run_d","members":[{"role":"tester","suffix":""}]}' > "$TMP/state/proj/squads/d.json"
  : > "$CALLS"
}
export DS_STATE_ROOT="$TMP/state"
pass=0; fail=0
norm() { sed -E "s#$TMP/(old|new)#<tree>#g; s#$TMP/realds#<tree>/bin/ds#g; s#(update-squads.sh <project>) \[--auto\]#\1#"; }
same() { # <name> <script path relative to a tree> [args…]  (env set by the caller)
  local name="$1" rel="$2"; shift 2
  local res=() t
  for t in old new; do
    fresh_state
    local out rc=0
    out="$(cd "$TMP/$t" && TMP_ROOT="$TMP/$t" DS_ROOT="" "$TMP/$t/$rel" "$@" 2>&1)" || rc=$?
    res+=("$(printf 'rc=%s\n%s\n-- calls\n%s\n-- state\n%s\n-- files\n%s\n' "$rc" "$out" "$(cat "$CALLS")" \
      "$(cat "$TMP/state/proj/dispatcher.json" "$TMP/state/studio-proj/dispatcher.json" 2>/dev/null || true)" \
      "$(cat "$TMP/wt/CLAUDE.local.md" 2>/dev/null | head -3; ls -l "$TMP/codex" 2>/dev/null | tail -n +2 | awk '{print $1, $9, $10, $11}')" | norm)")
  done
  if [ "${res[0]}" = "${res[1]}" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $name" >&2; diff <(printf '%s\n' "${res[0]}") <(printf '%s\n' "${res[1]}") | cut -c1-200 | head -12 >&2 || true; fi
}
# [ -f ] guards on a tree-less script path: both trees have all of these.
C=bin/commands; H=bin/host
same "restart-role"                   $C/restart-role.sh proj a builder x
same "restart-role no suffix"         $C/restart-role.sh proj/a.git b lead --resume --wait 5
same "restart-role usage"             $C/restart-role.sh proj a
same "restart-role gone flag"         $C/restart-role.sh proj a lead --model opus
same "restart-role unexpected arg"    $C/restart-role.sh proj a lead x y
FAKE_CURRENT=wt-9 ORCA_TERMINAL_HANDLE=t same "restart-role self guard" $C/restart-role.sh proj a lead --wt wt-9
FAKE_CURRENT=wt-8 ORCA_TERMINAL_HANDLE=t same "restart-role other wt"   $C/restart-role.sh proj a lead --wt wt-9
same "restart-squads all"             $C/restart-squads.sh proj
same "restart-squads topic+role"      $C/restart-squads.sh proj --topic a --role builder
same "restart-squads suspended"       $C/restart-squads.sh proj --topic b
same "restart-squads none"            $C/restart-squads.sh nope
same "restart-squads usage"           $C/restart-squads.sh
STUB_FAIL=1 same "restart-squads failing wish" $C/restart-squads.sh proj
same "update-squads"                  $C/update-squads.sh proj
STUB_FAIL=1 same "update-squads failing wish" $C/update-squads.sh proj
same "update-squads no state"         $C/update-squads.sh nope
same "update-squads usage"            $C/update-squads.sh
same "reclaim project"                $C/reclaim.sh proj
same "reclaim topic"                  $C/reclaim.sh proj --topic a
same "reclaim all"                    $C/reclaim.sh --all
same "reclaim none"                   $C/reclaim.sh nope
same "reclaim usage"                  $C/reclaim.sh
# No up case: U262 changed /ds-up on purpose (the worktree comes with no agent, studio-start opens the
# Studio, its model is the studio row's); tests/backend-seam.sh covers it.
CODEX_CE_SKILLS_DIR="$TMP/home/ce" CODEX_SKILLS_DIR="$TMP/codex" same "codex-skills wire" $H/codex-skills.sh
CODEX_CE_SKILLS_DIR="$TMP/home/ce" CODEX_SKILLS_DIR="$TMP/codex" same "codex-skills check missing" $H/codex-skills.sh --check
CODEX_CE_SKILLS_DIR="$TMP/nothere" CODEX_SKILLS_DIR="$TMP/codex" same "codex-skills no source" $H/codex-skills.sh
same "codex-skills usage"             $H/codex-skills.sh --bogus
echo "parity-upkeep: $pass passed, $fail failed"
[ "$fail" = 0 ]
