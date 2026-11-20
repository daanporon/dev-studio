---
description: Free leaked Orca long-poll slots (settled dispatches) that pile up across restarts
argument-hint: <project> [--topic <topic>]
allowed-tools: Read, Bash(~/.dev-studio/bin/commands/reclaim.sh:*)
---
Close the leaked `reclaimable` terminals that dev-studio restarts leave behind — the
coordinator-owned terminal of a settled worker that nothing released. (`retained` dispatches —
no-terminal or protected ones like your taken-over terminals — are left alone; they aren't the
leak.) Orca holds a stopped/succeeded worker's terminal until it's released, and each
restart/`/ds-update` cycle leaks one per worker — enough of them saturate the runtime so new
`worker-start`s fail with `runtime_busy: long-poll capacity reached`. Run from the Studio.

- **All live squads:** `~/.dev-studio/bin/commands/reclaim.sh <project>` — sweeps every live squad's run.
- **One squad:** `~/.dev-studio/bin/commands/reclaim.sh <project> --topic <topic>`.
- **Whole host:** `~/.dev-studio/bin/commands/reclaim.sh --all` — releases settled worker dispatches **and
  closes ORPHANED terminal tabs** across every run, **including closed/orphaned squads with no
  state file**. Orphaned-only, so it never touches a live/connected terminal (yours or another
  project's). Use this when a per-project sweep frees 0 but the runtime is still jammed with
  `runtime_busy` — the capacity is held by dead-run dispatches or stranded terminal tabs.

Capacity is held by two things: settled worker **dispatches** (freed by release) and live
terminal **tabs** (freed by close). `reclaim.sh --all` handles both. A connected tab that isn't
orphaned — a stale-but-still-attached dead-squad tab — is deliberately left alone; close those
from the Studio where you can tell which are truly dead.

Safe and idempotent: `worker-release` is settled-only (a live worker is never touched) and
re-running is a no-op. Output is archived, not deleted — `worker-read` still works after.

You mainly need this to clear a **backlog** that built up before the auto-release fix. Going
forward the loop releases each worker's dispatch when it stops it (a restart, a close, a
pause), and reclaims a squad's Run workers when it closes the squad. If a mass update ever
still reports `runtime_busy`, run this, then re-run the update.
