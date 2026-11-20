# Squad spawn fails at `worker-start` → the host has no managed agent account

**Symptom.** `/ds-start-squad` (or `bin/commands/spawn-squad.sh`) fails at the Lead's
`worker-start` with `worker-start failed for lead …`. Two identical attempts; a
retry never helps.

**Root cause.** The roster launches every role as a **supervised worker**
(`worker-start --agent claude`). Orca can only start a supervised agent
non-interactively if that agent's account is **registered with the Orca runtime on
the host that runs the worker**. `orca account list` showing "No managed Claude
accounts" is the real blocker — not a CLI-flag problem.

**Why it's not your local login.** Squad workers run on the Orca *host* (e.g. a
remote `runtime:` server), not your laptop, and Orca's supervisor doesn't see your
interactive `~/.claude` session. firstmate avoids this only because it runs plain
`claude` terminals instead of supervised workers; dev-studio uses supervised
workers on purpose — that's what powers the board and `worker-show`/`worker-stop`.

**Fix (operator, one-time per host).** `orca account add` on the host — it runs
`claude login` and registers *your same account* with the runtime. Then
`orca account list` shows it and spawns work.

**Check first.** Before spawning on a fresh host, run `orca account list`. If it's
empty, `orca account add` before `/ds-start-squad`.

**Related behavior now in the code.** The adapter no longer swallows orca's stderr,
so this surfaces as the real error instead of "returned no id"; and a spawn that
fails past the dep-gate removes its seeded state file, so no phantom "running"
squad is left on the board.

**Promote when settled:** this is already in `docs/USAGE.md` Prerequisites. Keep
the reasoning here.
