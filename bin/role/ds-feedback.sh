#!/usr/bin/env bash
# ds-feedback.sh "<note>" — jot a dev-studio (orchestrator) snag or improvement idea.
#
# For when the ORCHESTRATOR itself got in a role's way: an awkward escalation, a role
# instruction that misfires, a "the Lead should really do X". NOT for project code (that is
# `ce-compound` into the project's own docs/solutions/), and NOT a fix — roles must never edit
# dev-studio on the host: the host's copy is a `reset --hard` mirror of its branch, so any edit is
# wiped on the next sync. This only WRITES the note as one `feedback_notes` row in the host's
# loop.db (ds-feedback-github-issues U1), with the writer's project, squad and role taken from its
# member (DS_MEMBER, else this worktree), project `-` outside one; when loop.db can't be opened it
# appends to the old host-local file `state/dev-studio-feedback` instead and says so. The operator
# reviews the notes in a dev session and promotes what is worth keeping into the dev-studio repo.
#
#   bin/role/ds-feedback.sh "fix-loop round count is in-context, lost on restart"
#
# Review them with:  bin/ds feedback list   (bin/ds feedback import reads the old file in once)
#
# This reaches NO ONE until the operator's next dev-studio session: it only writes a host-local
# row. Never use it for something that blocks you or needs the operator —
# tell your Lead instead (a Lead raises it with bin/role/ask-operator.sh --unit <slug>).
set -euo pipefail
# U192: the work runs in TypeScript (bin/commands/ds-feedback-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" DS_SCRIPT="$0" "$ROOT/bin/ds" ds-feedback-ts "$@"
