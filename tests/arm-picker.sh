#!/usr/bin/env bash
# arm-picker.sh — install the picker-mirror PreToolUse/PostToolUse pair (matcher
# AskUserQuestion) into a role worktree's settings.local.json, merging with whatever is
# there: the rewake Stop hook and foreign hooks survive, re-arming replaces the pair in
# place, and a worktree with no local path is a no-op notice (exit 0).
set -uo pipefail
# shellcheck source=tests/lib/hook-tree.sh
. "$(dirname "$0")/lib/hook-tree.sh"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARM="$ROOT/bin/hooks/arm-picker.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/wt"
cat > "$TMP/fakeps" <<FAKE
#!/usr/bin/env bash
[ "\$1" = "ps" ] && printf '{"result":{"worktrees":[{"worktreeId":"wt1","path":"$TMP/wt"}]}}'
FAKE
chmod +x "$TMP/fakeps"
export BACKEND="$TMP/fakeps"

pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 (want [$3], got [$2])" >&2; fi; }
SET="$TMP/wt/.claude/settings.local.json"

# Pre-existing settings: a rewake Stop hook plus a foreign AskUserQuestion hook of our own.
mkdir -p "$TMP/wt/.claude"
cat > "$SET" <<'JSON'
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/r/bin/hooks/rewake-hook.sh x","asyncRewake":true,"timeout":28800}]}],
"PreToolUse":[{"matcher":"AskUserQuestion","hooks":[{"type":"command","command":"/other/lint.sh","timeout":5}]}]}}
JSON
"$ARM" wt1 /tmp/st/squads/t.json thinker-auth >/dev/null 2>&1; eq "arm exits 0" "$?" "0"
eq "keeps the rewake Stop hook" "$(jq -r '.hooks.Stop[0].hooks[0].command' "$SET")" "/r/bin/hooks/rewake-hook.sh x"
eq "keeps a foreign AskUserQuestion hook" "$(jq -r '[.hooks.PreToolUse[].hooks[].command] | join(",") | contains("/other/lint.sh")' "$SET")" "true"
eq "adds the pre command with state+role+wt" \
  "$(jq -r '.hooks.PreToolUse[] | select(.matcher=="AskUserQuestion") | .hooks[].command | select(contains("picker-hook.sh pre "))' "$SET")" \
  "$ROOT/bin/hooks/picker-hook.sh pre /tmp/st/squads/t.json thinker-auth wt1"
eq "adds the post command" \
  "$(jq -r '[.hooks.PostToolUse[] | select(.matcher=="AskUserQuestion") | .hooks[].command] | length' "$SET")" "1"
eq "pre carries timeout 15" \
  "$(jq -r '.hooks.PreToolUse[] | select(.matcher=="AskUserQuestion") | .hooks[] | select(.command | contains("picker-hook.sh")) | .timeout' "$SET")" "15"
eq "post carries timeout 15" \
  "$(jq -r '.hooks.PostToolUse[] | select(.matcher=="AskUserQuestion") | .hooks[] | select(.command | contains("picker-hook.sh")) | .timeout' "$SET")" "15"

# Re-arming replaces the pair in place (new state path), never duplicates.
"$ARM" wt1 /tmp/st2/squads/t.json thinker-auth >/dev/null 2>&1
eq "re-arm keeps foreign + own entries" "$(jq -r '[.hooks.PreToolUse[] | select(.matcher=="AskUserQuestion")] | length' "$SET")" "2"
eq "re-arm keeps one own pre hook" \
  "$(jq -r '[.hooks.PreToolUse[] | select(.matcher=="AskUserQuestion") | .hooks[].command | select(contains("picker-hook.sh"))] | length' "$SET")" "1"
eq "re-arm drops the stale command" "$(grep -c '/tmp/st/squads' "$SET")" "0"
eq "re-arm keeps one guard entry" \
  "$(jq -r '[.hooks.PreToolUse[] | select(.matcher=="Bash") | .hooks[].command | select(contains("no-broad-kill-hook.sh"))] | length' "$SET")" "1"
eq "re-arm keeps the AskUserQuestion pair" \
  "$(jq -r '[.hooks.PostToolUse[] | select(.matcher=="AskUserQuestion") | .hooks[].command | select(contains("picker-hook.sh"))] | length' "$SET")" "1"

# A flat (non-git) worktree with no settings at all still arms.
mkdir -p "$TMP/bare"
cat > "$TMP/fakeps2" <<FAKE
#!/usr/bin/env bash
[ "\$1" = "ps" ] && printf '{"result":{"worktrees":[{"worktreeId":"wt9","path":"$TMP/bare"}]}}'
FAKE
chmod +x "$TMP/fakeps2"
BACKEND="$TMP/fakeps2" "$ARM" wt9 /s/t.json builder-u1 >/dev/null 2>&1; eq "bare worktree arms" "$?" "0"
eq "bare worktree has both hooks" "$(jq -r '[(.hooks.PreToolUse // [] | length), (.hooks.PostToolUse // [] | length)] | join(",")' "$TMP/bare/.claude/settings.local.json")" "2,1"
eq "bare worktree has the broad-kill Bash guard" \
  "$(jq -r '[.hooks.PreToolUse[] | select(.matcher=="Bash") | .hooks[].command] | length' "$TMP/bare/.claude/settings.local.json")" "1"
eq "guard points at no-broad-kill-hook.sh" \
  "$(jq -r '[.hooks.PreToolUse[] | select(.matcher=="Bash") | .hooks[].command | contains("no-broad-kill-hook.sh")] | all' "$TMP/bare/.claude/settings.local.json")" "true"
eq "guard carries timeout 5" \
  "$(jq -r '.hooks.PreToolUse[] | select(.matcher=="Bash") | .hooks[].timeout' "$TMP/bare/.claude/settings.local.json")" "5"

# No local path (remote host): a notice, exit 0, nothing written.
out="$(BACKEND="$TMP/fakeps" "$ARM" wt-gone /s/t.json lead 2>&1)"; eq "remote worktree exits 0" "$?" "0"
eq "remote worktree says so" "$(printf '%s' "$out" | grep -c 'remote host')" "1"
"$ARM" 2>/dev/null; eq "bad args exit 2" "$?" "2"

echo "arm-picker: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
