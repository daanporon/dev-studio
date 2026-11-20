#!/usr/bin/env bash
# Codex skill wiring uses temporary destinations; never touches host skills.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export CODEX_SKILLS_DIR="$TMP/skills" CODEX_CE_SKILLS_DIR="$TMP/ce"
mkdir -p "$CODEX_CE_SKILLS_DIR/ce-work" "$CODEX_CE_SKILLS_DIR/ce-code-review"
printf 'work\n' > "$CODEX_CE_SKILLS_DIR/ce-work/SKILL.md"
printf 'review\n' > "$CODEX_CE_SKILLS_DIR/ce-code-review/SKILL.md"
"$ROOT/bin/host/codex-skills.sh"
[ "$(readlink "$CODEX_SKILLS_DIR/ds")" = "$ROOT/skills/ds" ]
[ "$(readlink "$CODEX_SKILLS_DIR/ce-work")" = "$CODEX_CE_SKILLS_DIR/ce-work" ]
"$ROOT/bin/host/codex-skills.sh" --check
before="$(stat -c %Y "$CODEX_SKILLS_DIR/ds")"
"$ROOT/bin/host/codex-skills.sh" --check
[ "$before" = "$(stat -c %Y "$CODEX_SKILLS_DIR/ds")" ]
"$ROOT/bin/host/codex-skills.sh"
# An operator-owned directory is preserved, including its contents.
rm "$CODEX_SKILLS_DIR/ce-work"
mkdir "$CODEX_SKILLS_DIR/ce-work"
printf 'operator skill\n' > "$CODEX_SKILLS_DIR/ce-work/SKILL.md"
"$ROOT/bin/host/codex-skills.sh"
[ "$(cat "$CODEX_SKILLS_DIR/ce-work/SKILL.md")" = 'operator skill' ]
rm "$CODEX_SKILLS_DIR/ds"
rc=0; "$ROOT/bin/host/codex-skills.sh" --check >/dev/null 2>&1 || rc=$?
[ "$rc" = 1 ]
[ ! -e "$CODEX_SKILLS_DIR/ds" ]
"$ROOT/bin/host/install-skills.sh" --codex-only
[ -f "$CODEX_SKILLS_DIR/ds/SKILL.md" ]
echo 'codex-skills: passed'
