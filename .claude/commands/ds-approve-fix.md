---
description: Approve a testing squad's proposed fix and spawn it as an independent squad
argument-hint: <project> <testing-topic> <proposal-id> [--autonomy checkpoints|lfg]
allowed-tools: Read, Bash(~/.dev-studio/bin/commands/approve-fix.sh:*)
---
A **testing squad** doesn't fix what it finds — its Thinker triages a confirmed bug into a
**proposed fix squad** (repo + topic + framing), which shows on `/ds-board` under the testing
squad as a pending approval. This is your one-click approval: it spawns that fix squad
**independently** (its own run), so the fix work runs apart from the ongoing testing squad.

Run it from the **Studio**:

```
~/.dev-studio/bin/commands/approve-fix.sh <project> <testing-topic> <proposal-id>
```

- `<testing-topic>` — the testing squad that proposed it (e.g. `manual-testing`).
- `<proposal-id>` — from the board's proposal line / the squad state's `proposed_squads[]`.
- It inherits the testing squad's repo/host and the proposal's framing, runs `spawn-squad.sh` for a
  `feature` squad (a wish: the loop starts it),
  marks the proposal `spawned`, and clears its approval question. Idempotent — re-approving an
  already-spawned proposal is a no-op.

The new fix squad then runs the normal flow (Thinker plans → you approve → Builder ships). The
testing squad keeps watching and can propose more fixes.
