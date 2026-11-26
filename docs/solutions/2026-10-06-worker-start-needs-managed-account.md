# Squad spawn fails at `worker-start` → the host has no usable agent login

**Symptom.** `/ds-start-squad` (or `bin/commands/spawn-squad.sh`) fails at the Lead's
`worker-start` with `worker-start failed for lead …`. Two identical attempts; a
retry never helps.

**Root cause, when this was written.** Every role was launched with
`worker-start --agent claude`, where Orca types the launch line. Orca could only start
that agent if its account was registered with the Orca runtime on the host that runs
the worker, and "No managed Claude accounts" was the real blocker.

**What changed (issue #125).** dev-studio keeps its own host-wide account list, for
every agent. A Claude start on this host opens a tab that runs `claude` with the picked
account's folder and then binds it with `worker-start --terminal`, so dev-studio, not
Orca, says which login runs. Orca still types the launch line itself for Codex and
Muse on their own login, and for a Claude start on another host (`--on`).

**Why a login on your laptop is not enough.** Squad workers run on the host (for
example a remote `runtime:` server), and use the logins on that host.

**Fix.** On the host, log `claude` in (dev-studio lists it as `system`), or add a login
with `bin/ds account add <name>` ([USAGE, Accounts](../USAGE.md#accounts)). Do not
remove accounts in Orca as part of a fix: see the warning there.

**Check first.** Before spawning on a fresh host, run `bin/ds account`.

**Related behavior now in the code.** The adapter no longer swallows orca's stderr,
so this surfaces as the real error instead of "returned no id"; and a spawn that
fails past the dep-gate removes its seeded state file, so no phantom "running"
squad is left on the board.
