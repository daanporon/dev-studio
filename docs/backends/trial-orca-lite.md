# Trial: orca-lite (orca-backend-alternatives U16a)

**Status: not run.** This page is the runbook and the empty record. Part 1 (this PR) wires orca-lite into
squad starts behind a trial gate and adds the record helper `ds trial`. Part 2, the live run, is a follow-up
after:

- the shadow exit is met (`docs/backends/shadow.md`; the earliest date is 2026-11-30);
- the host is updated to a checkout that holds part 1;
- the operator has picked the trial project (a throwaway repo is recommended);
- the operator has agreed to the host-wide steps: the loop restart and the Orca upgrade.

Nothing below the "Record" heading is filled in yet.

## What part 1 changed

- `bin/backend/registry.ts`: orca-lite has its adapter (`bin/backend/orca-lite.ts`), so spawn-squad can start a
  squad on it. Every backend other than `orca` is on `trial`: it starts squads only on a project whose
  `default_backend` names it. A `--backend orca-lite` on any other project is refused with
  `backend orca-lite (--backend) is on trial: …`, so the trial cannot spread past the trial project.
- `bin/lib/contract-roles.ts` `makeBackend`: the role scripts read an orca-lite squad's terminals through the same
  adapter and facts file as the loop (`<state root>/<project>/loop/orca-lite-terminals.json`), read-only
  (`readOnly`: only the loop writes the file; their create and close refuse). A list never drops the facts of a
  terminal made at or after its own pane read, so a list cannot lose a tab a create made meanwhile.
- `bin/backend/orca.ts` `wt-show` keeps Orca's `childWorktreeIds`, which shows the nesting Orca's window draws.
- `ds trial snapshot|events` (`bin/commands/trial.ts`): the record below, read-only.
- `tests/loop/orca-lite-squad.test.ts`: a squad on orca-lite runs on the fake Orca through the real adapter and the
  real `orca` worktree provider. The Lead and the Builder get Orca-made worktrees, the Builder's nested under the
  Lead's. Each gets one tab with `DS_BACKEND`, `DS_MEMBER` and `DS_GEN` exported and the launch line typed once.
  The squad gets no Run, task or worker start.

## Runbook

`<trial>` is the trial project's label and `<squad>` the squad's topic. Take a `ds trial snapshot` before and after
each drill step (`--step <name>`, output appended to a file) and keep the events list for the record.

1. Set the trial project up:
   - `ds config set <trial> limits.conf default_backend orca-lite`.
   - `ds config set <trial> roles.conf builder claude opus ondemand - claude:sonnet`. The default builder row
     falls back to Muse, which has no launch line off Orca, and spawn-squad refuses a roster that names it.
2. Start one small feature squad there (`/ds-start-squad`, or `spawn-squad.sh --repo <trial> --topic <squad>`).
   The board shows the `orca-lite` chip on it. Take `ds trial snapshot <trial> <squad> --step start`. Check in
   Orca's window that the Lead's worktree holds the Builder's and that both tabs are visible. The snapshot's
   `childWorktreeIds` line is the record of it.
3. **Crash.** While the Builder works, run `bin/host/shadow-drill.sh crash <builder worktree>` (it kills only the
   agent processes in that folder; `--dry-run` lists them). Note the time. The loop starts the Builder again.
   Find the `member_started` event after the crash with `ds trial events <trial> <squad> --since <time>`.
4. **Loop restart.** Take `--step before-loop-restart`, run `systemctl --user restart ds-loop`, then take
   `--step after-loop-restart`. The agent pids of every member must be the same in both snapshots, and no new
   `member_started` event may come for them.
5. **Orca upgrade.** Take `--step before-orca-upgrade`, upgrade Orca, then take `--step after-orca-upgrade`. Every
   worktree row must keep its path, and Orca's `worktree show` must still answer for each path, with the same
   nesting. Write down what changed: new Orca ids, or terminals that had to be reopened.
6. Let the unit reach a merged PR. The Builder must be retired only after the merge: the `unit_done` event comes
   before its `member_closed`. Close the squad when it is done.
7. Fill in the record. Memory: the loop's and the agents' RSS in the snapshots. Calls per tick: the Orca CLI
   spawns line, and `loop.sh --status`. Failures: the ledger's `failed` counts, `ds events --kind action_failed`
   for the squad, and anything the operator saw. Fixes of about 40 files or fewer go in the part 2 PR. Anything
   bigger becomes a follow-up unit that the Lead adds.

## Record (fill in when run)

- Trial project and squad: _
- Host checkout (commit) and Orca version before / after the upgrade: _
- The squad's merged PR: _
- Forced crash (time, Builder, the `member_started` event id of the restart): _
- Retirement after the merge (the `unit_done` event id, then the `member_closed` event id): _
- Agent pids before / after the loop restart (from the two snapshots): _
- `orca worktree show` with the Lead's `childWorktreeIds` (snapshot `start`): _
- Worktree rows before / after the Orca upgrade (the two snapshots): _
- Upgrade outcome (what still worked, what had to be redone): _
- Memory (loop RSS, agents' RSS) at start, after the restart, after the upgrade: _
- Backend calls per tick (Orca CLI spawns, ledgered calls by op): _
- Failures seen and what was done about each: _
