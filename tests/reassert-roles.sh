#!/usr/bin/env bash
# reassert-roles.sh — writes the CLAUDE.local.md role brief into each standing worktree so a
# turned-over session keeps its dev-studio role. Asserts the Studio points at studio.md, the
# Lead at roles/lead.md with its adopt line, and the file is git-excluded. Uses a fake
# $BACKEND ps and real git worktrees so the exclude path resolves.
set -euo pipefail
# shellcheck source=tests/lib/hook-tree.sh
. "$(dirname "$0")/lib/hook-tree.sh"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
LABEL="zzrole_$$"
SD="$DS_STATE_ROOT/$LABEL"
TMP="$(mktemp -d)"
state_root_on_exit 'rm -rf "$SD" "$TMP"'

mkdir -p "$SD/squads" "$TMP/wtStudio" "$TMP/wtLead"
for w in wtStudio wtLead; do ( cd "$TMP/$w" && git init -q && git config user.email t@t && git config user.name t ); done
printf '{"studio_wt":"wtS","label":"%s"}' "$LABEL" > "$SD/dispatcher.json"
printf '{"run_id":"run_9","members":[{"role":"lead","suffix":"","wt":"wtL"},{"role":"thinker","suffix":"","wt":"wtT"}]}' > "$SD/squads/mt.json"
cat > "$TMP/fakeps" <<FAKE
#!/usr/bin/env bash
[ "\$1" = "ps" ] && printf '{"result":{"worktrees":[{"worktreeId":"wtS","path":"$TMP/wtStudio"},{"worktreeId":"wtL","path":"$TMP/wtLead"}]}}'
FAKE
chmod +x "$TMP/fakeps"

# U185: a worktree armed with the old hook paths moves to bin/hooks/ on reassert.
mkdir -p "$TMP/wtLead/.claude"
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"%s/bin/rewake-hook.sh mt"}]}]}}' "$ROOT" > "$TMP/wtLead/.claude/settings.local.json"

# U186: the Studio's hooks move too.
mkdir -p "$TMP/wtStudio/.claude"
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"%s/bin/rewake-hook.sh studio"}]}]}}' "$ROOT" > "$TMP/wtStudio/.claude/settings.local.json"

BACKEND="$TMP/fakeps" "$ROOT/bin/hooks/reassert-roles.sh" "$LABEL" >/dev/null

pass=0; fail=0
ok(){ if eval "$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1" >&2; fi; }

ok "studio brief exists"            "[ -f '$TMP/wtStudio/CLAUDE.local.md' ]"
ok "studio points at studio.md"     "grep -q 'studio/studio.md' '$TMP/wtStudio/CLAUDE.local.md'"
ok "studio NOT roles/studio.md"     "! grep -q 'roles/studio.md' '$TMP/wtStudio/CLAUDE.local.md'"
ok "lead points at roles/lead.md"   "grep -q 'roles/lead.md' '$TMP/wtLead/CLAUDE.local.md'"
ok "lead carries its adopt line"    "grep -q 'backend/orca.sh adopt run_9' '$TMP/wtLead/CLAUDE.local.md'"
# Where the loop runs, it holds the Run's seat: the Lead's brief says not to adopt (U59).
mkdir -p "$TMP/loop"; : > "$TMP/loop/.loop-migrated"
DS_STATE_ROOT="$TMP/loop" bun "$ROOT/tests/lib/twins.ts" ds_role_brief lead "$LABEL" mt run_9 > "$TMP/loop/brief"   # roleBrief (bin/lib/lib.ts)
ok "a loop's Lead brief says not to adopt"  "grep -q 'do not adopt it' '$TMP/loop/brief'"
ok "a loop's Lead brief has no adopt line"  "! grep -q 'orch.sh adopt' '$TMP/loop/brief'"
ok "lead names its topic"           "grep -q 'mt' '$TMP/wtLead/CLAUDE.local.md'"
ok "role file is git-excluded"      "grep -qxF 'CLAUDE.local.md' '$TMP/wtLead/.git/info/exclude'"
ok "worktree git status stays clean (except ours: .claude/)" "[ -z \"\$(cd '$TMP/wtLead' && git status --porcelain | grep -v '^?? \\.claude/')\" ]"

ok "lead gets the picker pre hook"   "grep -q 'picker-hook.sh pre $SD/squads/mt.json lead wtL' '$TMP/wtLead/.claude/settings.local.json'"
ok "lead gets the picker post hook"  "grep -q 'picker-hook.sh post $SD/squads/mt.json lead wtL' '$TMP/wtLead/.claude/settings.local.json'"
ok "studio is never picker-armed"     "! grep -q 'picker-hook' '$TMP/wtStudio/.claude/settings.local.json'"
ok "studio's old rewake hook moved"   "grep -q 'bin/hooks/rewake-hook.sh' '$TMP/wtStudio/.claude/settings.local.json' && ! grep -q 'bin/rewake-hook.sh' '$TMP/wtStudio/.claude/settings.local.json'"
ok "old rewake hook moved to hooks/"  "grep -q 'bin/hooks/rewake-hook.sh' '$TMP/wtLead/.claude/settings.local.json'"
ok "no old rewake hook path left"     "! grep -q 'bin/rewake-hook.sh' '$TMP/wtLead/.claude/settings.local.json'"

echo "reassert-roles: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
