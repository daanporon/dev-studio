#!/usr/bin/env bash
# ds-feedback.sh "<note>" — jot a dev-studio (orchestrator) snag or improvement idea.
#
# For when the ORCHESTRATOR itself got in a role's way: an awkward escalation, a role
# instruction that misfires, a "the Lead should really do X". NOT for project code (that is
# `ce-compound` into the project's own docs/solutions/), and NOT a fix — roles must never edit
# dev-studio on the host: the host's copy is a `reset --hard` mirror of its branch, so any edit is
# wiped on the next sync. This only APPENDS the note to a gitignored, host-local log that
# survives `git reset --hard`; the operator reviews it in a dev session and promotes what is
# worth keeping into the dev-studio repo (edit -> test -> PR -> merge).
#
#   bin/role/ds-feedback.sh "thinker on acme: fix-loop round count is in-context, lost on restart"
#
# Review/clear it with:  cat state/dev-studio-feedback   (act on it, then empty the file)
#
# This reaches NO ONE until the operator's next dev-studio session: it only appends to
# a host-local log. Never use it for something that blocks you or needs the operator —
# tell your Lead instead (a Lead raises it with bin/role/ask-operator.sh --unit <slug>).
set -euo pipefail
# U192: the work runs in TypeScript (bin/commands/ds-feedback-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" DS_SCRIPT="$0" "$ROOT/bin/ds" ds-feedback-ts "$@"
