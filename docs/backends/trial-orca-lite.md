# Trial: orca-lite (orca-backend-alternatives U16a)

**Status: run 2026-11-24 (steps 1-4 and 6 run, step 5 not run: the Orca upgrade moved to U24a).** The live trial ran with
the operator's go (board question `u24-host-window`, answered "Now"). The crash, loop-restart and retirement checks
passed and the squad's PR merged. One gap: the Thinker's worktree is not nested under the Lead's. See "Record" below.

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

## Record (run 2026-11-24)

- Trial project and squad: dev-studio-public, squad `reload-ack-off-orca` (task: ds-feedback #4/#5, `ds reload ack` refused off Orca), spawned 17:17:30Z on orca-lite (`default_backend` went to `orca-lite` and back to `orca` in the same second; the only other squad off Orca was `backend-pick-guide` on tmux). The builder roster row was already claude-only from U20.
- Host checkout (commit) and Orca version before / after the upgrade: checkout `c6e01e76` when spawned, Orca 1.4.246; no upgrade was done (moved to U24a), so there is no "after".
- The squad's merged PR: #161 `fix(loop): confirm a reload ack from an off-Orca terminal`, merged 18:12:03Z as `a4e7104`.
- Forced crash (time, Builder, the `member_started` event id of the restart): `shadow-drill.sh crash` at 17:55:46Z on `builder-u1-reload-ack-session` (it was running tests); the loop started it again at 17:56:09Z, `member_started` #616868, with `shadow_crash` #616870.
- Retirement after the merge (the `unit_done` event id, then the `member_closed` event id): `unit_done` #617060 (18:12:35Z), then `member_closed` #617064 (18:12:37Z). Right order.
- Agent pids before / after the loop restart (from the two snapshots): `systemctl --user restart ds-loop` at 17:57:31Z (loop pid 2455279 to 115456). Lead 3540825, Thinker 3540823 and Builder 96201 were the same in both snapshots, and no `member_started` came after it.
- `orca worktree show` with the Lead's `childWorktreeIds` (snapshot `builder-up`): the Builder's worktree has the Lead's as its `parentWorktreeId`, and the Lead lists the Builder in `childWorktreeIds`. The Lead and the Thinker both had `parentWorktreeId none`, and the Thinker is not a child of the Lead, so Orca's window shows the Thinker beside the Lead, not under it.
- Worktree rows before / after the Orca upgrade (the two snapshots): not run.
- Upgrade outcome (what still worked, what had to be redone): not run (U24a).
- Memory (loop RSS, agents' RSS) at start, after the restart, after the upgrade: loop 181.9 MB with the squad up, 199.8 MB just before the restart, 160.5 MB just after, 144.9 MB at the end (no upgrade). Agents: Lead 312 to 327 MB, Thinker 358 to 363 MB, Builder 393 to 409 MB.
- Backend calls per tick (Orca CLI spawns, ledgered calls by op): 7 to 14 Orca CLI spawns per tick (`terminal read`, `worker-list`, `terminal list`, `worktree ps`, inbox); the squad's ledger ended at `terminal.create` x5 and `terminal.close` x3, none failed.
- Failures seen and what was done about each: `ds events --kind action_failed` listed none for the squad. The Thinker is not nested under the Lead (above); no fix made, the squad is otherwise unaffected. The squad is still `waiting-on-you` for the Lead's or the operator's close.
