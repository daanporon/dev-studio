#!/usr/bin/env bash
# skills/ds/SKILL.md stays in step with .claude/commands/ds-*.md.
# shellcheck disable=SC2016  # backticks in the patterns are literal markdown
set -euo pipefail
cd "$(dirname "$0")/.."
SKILL=${SKILL:-skills/ds/SKILL.md}
fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }

want=$(for f in .claude/commands/ds-*.md; do basename "$f" .md; done | sort)
desc_line=$(grep -m1 '^description:' "$SKILL")

got_desc=$(printf '%s' "$desc_line" | grep -oE 'ds-[a-z-]+' | sort -u)
[ "$got_desc" = "$want" ] || bad "description names differ from commands: $(diff <(echo "$want") <(echo "$got_desc") | tr '\n' ' ')"

got_body=$(grep -E '^- `ds-[a-z-]+` — ' "$SKILL" | grep -oE '^- `ds-[a-z-]+`' | grep -oE 'ds-[a-z-]+' | sort -u)
[ "$got_body" = "$want" ] || bad "body list differs from commands: $(diff <(echo "$want") <(echo "$got_body") | tr '\n' ' ')"

for n in $want; do
  d=$(grep -m1 '^description: ' ".claude/commands/$n.md" | sed 's/^description: //')
  grep -qF -- "- \`$n\` — $d" "$SKILL" || bad "$n one-liner does not match its description"
done

grep -qF '.claude/commands/ds-<cmd>.md' "$SKILL" || bad "routing path missing"
grep -qF 'allowed-tools' "$SKILL" || bad "allowed-tools caveat missing"
grep -qF 'Wherever the body says `$ARGUMENTS`, use the text the user gave after the command name (empty if none); ignore the `allowed-tools`/`argument-hint` frontmatter.' <(tr '\n' ' ' <"$SKILL" | sed 's/  */ /g') || bad '$ARGUMENTS sentence missing'
grep -qiE '\b[0-9]+ (below|commands)\b|which of the [0-9]+' "$SKILL" && bad "hardcoded command count"

[ "$fail" = 0 ] && echo "skill-ds: ok"
exit "$fail"
