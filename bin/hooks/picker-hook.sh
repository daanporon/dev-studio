#!/usr/bin/env bash
# picker-hook.sh <pre|post|permission> <state> <role> <wt> — mirror a picker or safety prompt
# onto the board: an AskUserQuestion picker (cleared when answered there) or a Claude safety-check prompt.
#
# Armed per role worktree by bin/hooks/arm-picker.sh (like the rewake Stop hook): PreToolUse with
# matcher AskUserQuestion runs `pre`, PostToolUse runs `post`. Reads the hook JSON from stdin.
# Always exits 0 and prints nothing to the agent — a hook failure must never block the picker.
#
# pre: queue a `picker-<tool_use_id suffix>` entry through ask-operator.sh — but DETACHED
# (stdin is copied to a temp file, the queueing runs in the background, the hook exits at
# once), so backend latency never delays the picker. Skips when the question is already on
# the board: (1) a BLOCKING non-picker entry with card_wt = this worktree (the role ran
# ask-operator.sh, then opened a picker — a non-blocking follow-up does NOT suppress a new
# picker), or (2) a picker question's text contains the title (or id) of any queued non-picker
# entry (/ds-q and the Lead's engage flow start each picker question with the entry's title).
# Before queueing it resolves any earlier picker-… entry for the same worktree — a role has
# at most one live picker.
# post: resolve `picker-<suffix>` — but only when that entry exists AND has source:"picker",
# so a picker the pre hook skipped through dedup never clears someone else's entry.
# post also drops a tombstone for its id first: the enqueue runs detached and can land AFTER
# the answer, so pre checks the tombstone before and after enqueueing and stands down when
# the picker already closed (a dismissed picker or a dead agent never runs post — the sweep
# reaps those).
# permission (PermissionRequest, matcher *): detached like pre; returns no decision. Queues a
# blocking picker-… entry with picker_kind "permission" and the command or change the prompt is
# about, not answerable from the board, and writes one permission_asked event. AskUserQuestion and
# ExitPlanMode are ignored, and pre's two dedup rules don't apply. The sweep clears the entry once
# the transcript shows the call's result, or the role stops waiting.
set -euo pipefail
# U193: the work runs in TypeScript (bin/commands/picker-hook-ts.ts); this path stays because worktree settings name it.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" picker-hook-ts "$@"
