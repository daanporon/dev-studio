#!/usr/bin/env bash
# finish-unit.sh — a Builder ends its unit with one call, so the finish can't be
# half-done (pushed but no PR recorded, PR opened but worker_done never sent).
#
#   finish-unit.sh <state> <unit> [--check | --no-pr]
#
# Run in the Builder's worktree. In order: look up the PR for the current branch
# (the same open-else-newest-merged lookup the loop uses), refuse with
# a clear error when there is none, refuse unless the PR is merge-ready (green
# checks, every check the base branch requires or the project expects reported, no open review threads,
# mergeable — `prHealthLine` in bin/lib/lib.ts), refuse in
# ce-pipeline mode unless review-unit.sh left a receipt for an ancestor of HEAD
# (a merged PR skips this — the review question is moot once the operator merged),
# record it with set-unit-pr, add a journal keep, and send worker_done saying the PR
# is merge-ready — the loop marks the unit done when the PR merges. --check prints
# the verdict and exits 0/1 without writing or sending anything (the babysit exit
# test). --no-pr (local-only mode or a no-code unit) skips the lookup, the gate and
# the recording, and says so in the note and body.
#
# Any refusal exits non-zero having written no state, added no journal entry and
# sent nothing. A journal write that fails warns on stderr but doesn't block the
# finish: state + worker_done are the load-bearing handoff, the note is best-effort.
# Re-running after a failed send is safe (set-unit-pr overwrites, the note is
# additive, the send retries); re-running after the dispatch settled (a stale fix
# after the loop poked) exits 0 with a note instead of failing on "no active dispatch".
set -euo pipefail
# U192: the work runs in TypeScript (bin/commands/finish-unit-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" DS_SCRIPT="$0" "$ROOT/bin/ds" finish-unit-ts "$@"
