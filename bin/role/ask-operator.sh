#!/usr/bin/env bash
# ask-operator.sh — the ONE way a squad role raises a question to the operator.
#
#   ask-operator.sh <state-file> <id> <asker> <blocking:true|false> --title "<~8 words>" --question "<2-3 sentences>" \
#     --option "<label>" "<what happens>" --option … --recommend <n|label> --why "<one line>"
#
# The title is the board's one-line row; the board's overlay shows the question, each option with
# what happens, and the recommended one pre-selected (plus a free-text answer).
# Old form, still accepted (agents on older prompts): … "<question>" "<suggestion>" "<why>" ["A|B|C"].
# Every question carries the asker's suggested answer and why — required, so the operator can
# accept in one step (/ds-q) instead of working it out from scratch.
# Does the whole raise in one call: marks the squad waiting-on-you, queues the question
# (re-asking an id replaces it), pings the caller's own worktree card (cleared again when the
# question is answered — squad-state resolve-question), then READS IT BACK
# from the state file and prints a receipt. Refuses a state file it can't find — an agent
# that writes to a wrong path must hear about it, not report "on the board" from memory.
# --pr <n>: the question is about PR #n (a human review, a sign-off, a waiver) — one PR per question.
# The loop asks PR questions: a Builder or Lead is refused for --pr and for a question naming one
# of its squad's unit PRs. The refusal starts "the loop asks PR questions" and names who posts it:
# the loop (a question is already on the board, or it posts once only human gates remain), or, when
# the PR is not ready, its Builder fixes it first; a Lead asks about the unit with --unit <slug> and
# no PR number. A --unit that is not a unit slug exits 2 with one line listing the squad's slugs.
# With no --pr, PR references in --title and --question (`#<n>` or `.../pull/<n>`) count the same:
# one distinct PR acts as --pr <n>; two or more are refused like a second --pr (U86). A plan path,
# an issue key such as PRD-18424 or a U<n> is not a PR reference.
# --doc <path>: link one .md directly in state/<label>/squads/ or archive/ (stored as doc_path, relative to the state root);
# a plan-* question links its plan by the id rule (plan-<short> -> <topic>-<short>-plan.md) and is refused unless the plan
# carries `## In plain words` with its five labels (bin/lib/plan-plain.ts); a passing plan ask prints the five lines.
# --unit <slug>: this question blocks that unit when blocking=true. This is routing
# metadata, not a PR review question, so it can be raised while the PR needs repairs.
# Before it enqueues, the PR's observed row (else one `gh` read) must show only human gates left; a
# conflict or a red/missing non-human check refuses: send its Builder to fix it first (U70).
# Exit 0 = on the board AND pinged; 1 = not on the board; 2 = bad arguments (nothing written);
# 3 = on the board but NOT pinged.
set -euo pipefail
# U260: the work runs in TypeScript (bin/commands/ask-operator-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" DS_SCRIPT="$0" "$ROOT/bin/ds" ask-operator-ts "$@"
