#!/usr/bin/env bash
# directory.sh — the phone book: the ONE place dev-studio resolves who a squad member is and
# how to reach it. Look here first; never hand-build an address from a state file.
#
#   directory.sh list  [--project <label>] [--from <squad>] [--json]
#   directory.sh reach <squad> <role[-suffix]> [--project <label>] [--from <squad>]
#   directory.sh check <squad> <role[-suffix]> [--project <label>]
#
# list   one row per member of every squad in the label: squad, role[-suffix], worktree id,
#        live yes/no, and the exact command that reaches it (send-peer.sh across squads,
#        orch.sh send/send-worker inside one). A closed/suspended/failed squad's members show
#        `not running (<reason>)`. --json also carries `terminals` (the member's live terminal
#        handles, newest first; [] when the backend has none) for team.sh and the board.
# reach  "<kind>\t<address>\t<run_id>\t<worktree_id>" — the first two fields are the answer;
#        run and worktree ride along so a sender needs no lookup of its own:
#          run          the member is the squad's Lead -> its Run inbox (address = run id). The
#                       inbox is durable, so a Lead is reachable whenever its squad is open.
#          worktree     same squad as the caller -> the worker's own inbox (address = worktree id,
#                       for `send-worker`).
#          worktree-run another squad -> the worker's worktree in its Run (address = worktree id,
#                       the run rides in field 3, for `send-run-worker`).
#        exit 2 = unknown squad or role, or the squad is closed/suspended/failed;
#        exit 3 = the member is not running (no live terminal);
#        exit 4 = the backend's wt-terminals failed, so liveness is unknown. The address row is
#        still printed (delivery is judged by the send receipt, not the phone book), so a caller
#        may attempt the send anyway — send-peer.sh does.
#
# check  reach's answer to "is there such a member?" from the state files alone: exit 0 and no output
#        when the squad is open and has the role, else reach's exit 2 and message. No backend call when
#        --project is given. The senders (send-role.sh, send-peer.sh) ask it before queueing a message
#        for the loop, so a typo fails in their own terminal (U75).
#
# --from <squad> names the caller's squad; without it, it is the squad whose roster holds this
# terminal's worktree ($BACKEND current), else the squad named at the end of the worktree's
# name (`<prefix><label>-<role>[-<suffix>]-<topic>`). No caller squad (the Studio) = everything
# is "another squad".
#
# Not a stored file: liveness changes on every restart, so each call joins the squad state files
# (who belongs where: run_id, members[]) with the backend's live `wt-terminals` (one worktree
# id per line for every worktree with a live terminal) and, in list mode, `worker-detail`
# ("<worktree_id>\t<live-terminal handle>") for the --json `terminals`. Only $BACKEND ops.
# A dispatch id is deliberately NOT consulted: an idle standing role shows as `completed` in
# worker-list, so dispatch status can't tell whether it is alive (docs/orca-notes.md).
set -euo pipefail
# U222: the work runs in TypeScript (bin/commands/directory-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" directory-ts "$@"
