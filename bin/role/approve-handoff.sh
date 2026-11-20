#!/usr/bin/env bash
# approve-handoff.sh — a Thinker approves its plan and hands it to the Lead in one call.
#
#   approve-handoff.sh <state> <plan> <lead_wt>
#
# In order: dry-run `register-plan` against a scratch copy of the state (a refusal stops
# here, before anything in the real state changes), `approve-plan`, `resolve-question
# plan-<short-name> --answer approved`, then `orch.sh send-worker <lead_wt> handoff "report-path=<plan>
# …"`. The approval record is what lets a restarted Lead know the plan is cleared, so
# it is written before the handoff; the handoff's report-path is what the Lead builds
# from. Idempotent: re-running re-approves (no dup), re-resolves (nothing left to clear)
# and re-sends the handoff. No explicit `set-status running`: `resolve-question` already
# clears waiting-on-you once no open question remains, so other questions keep the squad
# waiting.
#
# <short-name> comes from the canonical plan filename (<topic>-<short>-plan.md, the
# <topic> read from the state filename), matching the plan-<short-name> id the Thinker
# asked approval under. A plan that doesn't follow that shape falls back to its basename.
# When no such question is open (a mismatched id, or lfg which never asks), the script
# warns — outside lfg — and says so instead of claiming it resolved anything.
set -euo pipefail
# U192: the work runs in TypeScript (bin/commands/approve-handoff-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" DS_SCRIPT="$0" "$ROOT/bin/ds" approve-handoff-ts "$@"
