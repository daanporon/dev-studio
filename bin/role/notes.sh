#!/usr/bin/env bash
# notes.sh — per-project, per-role notes: tips a later role on the same project should know.
#
#   notes.sh <project> <role> [print]            print the notes (or "no notes yet")
#   notes.sh <project> <role> add "<note>" "<why>"
#   notes.sh <project> <role> drop "<fragment>"  remove the ONE note containing the fixed string
#   notes.sh <project> <role> path
#
# File: state/<label>/notes/<role>.md (host-local, gitignored by state/*/). <role> must have a
# roles/<role>.md, so `builder-u3` (the journal's per-unit naming) is refused.
# One entry per line: `- YYYY-MM-DD <note> — <why>`. Max `notes_cap` notes per role per project (limits
# setting, default 20, 1-100; a higher cap costs context at every start), and
# note+why at most 300 characters. Notes are tips, not orders (conventions/learnings.md).
set -euo pipefail
# U222: the work runs in TypeScript (bin/commands/notes-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" notes-ts "$@"
