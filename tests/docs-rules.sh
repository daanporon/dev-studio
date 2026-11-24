#!/usr/bin/env bash
# Greps the instruction text for the rule sentences that must stay in it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
need() { # <file> <fixed string>
  if grep -qF -- "$2" "$ROOT/$1"; then echo "ok   $1: $2"; else echo "FAIL $1 lacks: $2"; fail=1; fi
}
need AGENTS.md "A Builder runs targeted tests before it opens its PR, not the full suite"
need .github/workflows/tests.yml "types: [opened, synchronize, reopened]"
if grep -v '^[[:space:]]*#' "$ROOT/.github/workflows/tests.yml" | grep -q edited; then echo "FAIL .github/workflows/tests.yml has edited outside a comment"; fail=1; else echo "ok   .github/workflows/tests.yml has no edited trigger"; fi
need .github/workflows/pr-title.yml "types: [opened, edited, reopened, synchronize]"
need conventions/plan-shape.md "A unit that touches the board needs a board Check."
need conventions/plan-shape.md "render"
need conventions/plan-shape.md "the board on real squad state and look at the affected rows"
need roles/lead.md "Odd board row? Explain it or file it before \`done\`."
need roles/lead.md "\`I did not track it down\` is not an"
need roles/lead.md "\`state unknown\` is not a state."
need roles/lead.md "never treat it as open, merge-ready, or"
need roles/lead.md "merged. Run \`gh pr view\` on the PR"
need conventions/learnings.md "with one exception: notes"
need conventions/learnings.md "## Where a lesson goes: the three places"
need conventions/learnings.md "would the next role on a *different* topic need this?"
need conventions/learnings.md "a note loses to the operator, the plan, the role file and the repo's docs"
need AGENTS.md "bin/role/notes.sh"
need AGENTS.md "### Your project notes (every role)"
need roles/builder.md "A unit that looks too big for one PR is not refused."
need roles/builder.md "When \`orch.sh ask\` says it fell back"
need AGENTS.md "read a large file in parts"
need conventions/plan-shape.md "is
two units (example"
need roles/thinker.md "is two units; if you keep one, the plan says why."
need roles/lead.md "never \"build it all as one PR\"."
need roles/builder.md "Add a note (\`~/.dev-studio/bin/role/notes.sh <project> builder add"
need roles/thinker.md "notes.sh <project> thinker print"
need conventions/thinker-routing.md "the text of the Thinker's notes for this project"
# These compatibility names remain live loop settings. Listing them only under
# historical variables tells operators their configured thresholds are ignored.
active_settings="$(awk '/^## Environment variables: host behaviour$/ {active=1; next} /^### Historical sweep variables$/ {active=0} active {print}' "$ROOT/docs/settings.md")"
historical_settings="$(awk '/^### Historical sweep variables$/ {historical=1; next} historical {print}' "$ROOT/docs/settings.md")"
for key in DS_SWEEP_SPAWN_GRACE_MIN DS_SWEEP_SILENT_MIN DS_SWEEP_HUNG_MIN DS_SWEEP_RECHECK_MIN DS_SWEEP_REBREAK_MIN DS_SWEEP_POKES DS_SWEEP_TOKENS_MIN; do
  row="| \`$key\` |"
  if grep -qF "$row" <<<"$active_settings" && ! grep -qF "$row" <<<"$historical_settings"; then
    echo "ok   docs/settings.md: $key is an active loop setting"
  else
    echo "FAIL docs/settings.md: $key must be active, not historical"; fail=1
  fi
done
# U154 moved the usage-limit pokes into the decider and dropped their two knobs; nothing under
# bin/ reads them, so they belong in the historical table.
for key in DS_SWEEP_LIMIT_POKE_MIN DS_SWEEP_LIMIT_POKES; do
  row="| \`$key\` |"
  if grep -qF "$row" <<<"$historical_settings" && ! grep -qF "$row" <<<"$active_settings"; then
    echo "ok   docs/settings.md: $key is historical"
  else
    echo "FAIL docs/settings.md: $key is read by nothing since U154; list it as historical"; fail=1
  fi
done
forbid() { # <file> <fixed string>
  if grep -qF -- "$2" "$ROOT/$1"; then echo "FAIL $1 still has: $2"; fail=1; else echo "ok   $1 lacks: $2"; fi
}
forbid bin/lib/watch.sh "skip it for docs-only"
forbid roles/lead.md "skip it for docs-only"
need AGENTS.md "A unit documents its scripts, tables and events in \`docs/scripts.md\`."
agents_bytes="$(wc -c < "$ROOT/AGENTS.md")"
if [ "$agents_bytes" -gt 40000 ]; then echo "FAIL AGENTS.md is $agents_bytes bytes (limit 40000): move the detail to docs/scripts.md and keep one index line"; fail=1; else echo "ok   AGENTS.md is $agents_bytes bytes (limit 40000)"; fi
exit "$fail"
