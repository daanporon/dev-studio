# Autonomy and checkpoints

A squad runs at one of two autonomy levels, chosen at spawn with
`bin/commands/spawn-squad.sh --autonomy checkpoints|lfg` (default `checkpoints`), recorded
in the squad state file, and shown on the board.

## Default: autonomous to checkpoints (R16)

The squad runs on its own and stops at natural checkpoints for the operator's
nod. A checkpoint is an `orchestration gate-create` against the **squad's task**
(the `task_id` recorded in the squad state file at spawn, KTD5):

```
~/.dev-studio/bin/role/orch.sh gate-create <task_id> "<checkpoint>"   # prints the gate id
```

**A gate that needs the operator must also show on the board** — the board is where
they live, not the Lead's terminal. So whenever the Lead opens a checkpoint gate, it
also, in the same breath:

- raises the decision at the operator's level so the board prints the actual question,
  not just a gate count: `~/.dev-studio/bin/role/ask-operator.sh <state> <gate_id> lead true --title "<the decision>" --question "<how to resolve it>" --option … --recommend <n> --why "<why>"`
  (sets `waiting-on-you`, queues it, pings, and prints an `ON BOARD` receipt).

The Lead then waits; the operator sees it in `/ds-board`'s WAITING ON YOU, answers
from the Studio with `~/.dev-studio/bin/role/orch.sh gate-resolve <gate_id> "<text>"`,
and the Lead runs `resolve-question <gate_id> --answer "<text>"` and moves the status back
to `running`. Never leave a decision only in the Lead's terminal — if the operator
has to read a worktree to find it, the board has failed its one job.

Default checkpoints:

1. **plan drafted** — **the Thinker** owns this one: after it saves the plan it asks the
   operator for approval and **waits**, and only hands the plan to the Lead once approved
   (`roles/thinker.md`). So the Lead always receives an already-approved plan; it does not
   re-gate it. Under `lfg` the Thinker skips the nod and hands straight over.
2. **tests green** — the Builder's work passes.
3. **PR ready** — fired **after** the project's ship mode runs
   (`conventions/ship-modes.md`), so under `no-mistakes` the pipeline is already
   green when the operator is asked.

## `lfg`: fire-and-forget (R17)

`lfg` mode creates **no** gates. When the squad hits a would-be-blocking
question it does not wait: it decides, logs the assumption
(`bin/role/squad-state.sh state/<label>/squads/<topic>.json log-assumption "<decision>" "<rationale>"`),
and continues. The logged assumption shows on the board for after-the-fact review.
The Thinker's start triage (`roles/thinker.md`, step 0) follows it: its `direction` question becomes
an assumption (its own recommendation) instead of a wait.

`lfg` does **not** cover the "Never decide alone" list in `conventions/escalation.md`
(closing the squad, merging or closing a PR, force-push, deleting outside the retire flow,
parking or scope changes, cost/secrets/access, anything not reversible). Those still go to
the operator with `ask-operator.sh` — non-blocking where the rest of the work can go on.

## The one rule both modes share

Either way, the Lead keeps the squad state file current (R7) — including an `lfg`
squad — so the board never goes dark on a squad, which is the whole point.
