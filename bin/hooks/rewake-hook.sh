#!/usr/bin/env bash
# rewake-hook.sh <watch-args...> — the body of the asyncRewake Stop hook (armed by
# bin/hooks/arm-rewake.sh with asyncRewake:true + a long timeout). It runs AFTER the turn ends
# (async, so it never holds the turn open), blocks on this agent's own inbox via Orca's
# inbox-wait (bin/lib/watch.sh), and:
#   - exits 2 with a stderr banner the moment a real inbox MESSAGE is waiting -> that WAKES
#     the idle session to handle it (asyncRewake turns exit 2 into an idle wake —
#     host-confirmed);
#   - exits 0 (silent) when the window elapses with nothing -> lets the agent stay stopped.
#
# It wakes on a MESSAGE; a Lead also wakes once per window to reconcile (a silently-dead
# Builder). The woken agent MUST ack a handled message (lead.md) or it re-wakes — on an
# unacked message the hook backs off (sleep) then re-arms, so it retries on a bounded
# interval rather than spinning or going dormant.
#   Lead: rewake-hook.sh <project> <topic>   Thinker/Studio: --worktree
#
# Diagnostics: it appends a line per fire to state/rewake-hook.log (FIRE, the first watch
# result, and the decision) so we can see whether it even has a sender terminal. Silence it
# with DS_REWAKE_LOG=none.
set -euo pipefail
# U193: the work runs in TypeScript (bin/commands/rewake-hook-ts.ts); this path stays because worktree settings name it.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" rewake-hook-ts "$@"
