# Trial: treehouse worktrees (orca-backend-alternatives U16e)

**Status: not run.** This page is the runbook and the empty record for the live trial. The live run waits for
four things:

- the shadow exit (`docs/backends/shadow.md`, earliest 2026-11-30);
- the operator's go for the trial project and the loop restart (the board question `trial-live-go`);
- a host update;
- treehouse installed on the host. This unit installed nothing on the host.

Nothing under "Record" is filled in yet.

The trial runs a squad on the `tmux` backend with `worktree_provider treehouse`. Each member then sits in a
leased slot of treehouse's warm pool instead of a fresh `git worktree add`. A returned slot keeps its
ignored files (`node_modules`, build caches) for the next lease. The question the trial answers is whether
that makes a Builder reach its first test sooner, and whether every lease goes back to the pool when the
loop is done with it.

What this unit shipped so the trial can run:

- `tests/loop/contract-treehouse.test.ts` runs a tmux squad (the fake contract) on real treehouse slots
  (the pinned release, or skipped with the reason printed). It covers every path that ends or restarts a
  member's worktree. The results are under "What the tests show".
- A fix in `bin/loop/squad/cancel.ts`, found by that test. A cancelled Builder's tree counted as present
  while its folder existed, and a returned slot keeps its folder. So the member never read `gone` and its
  cancel wish never finished. Now, when the tree has a provider's `worktrees` row, the row decides: present
  while it is not gone, even when the contract observer's row still reads the folder. Orca's own trees and
  trees with no row still go by the folder. A returned slot can be leased to another member at the same
  path; when the row names that member's worktree, the cancel stops and removes nothing there
  (`tests/loop/cancel-provider.test.ts`).
- A spawn check in `bin/backend/registry.ts`. `worktree_provider treehouse` is refused at spawn when there
  is no treehouse binary (`DS_TREEHOUSE_BIN`, else on PATH). Before, the squad's first member start was
  the one to fail.
- `ds treehouse-drill` (`bin/commands/treehouse-drill.ts`, tested in `tests/loop/treehouse-drill.test.ts`):
  - `time` measures worktree start to first test, pooled against fresh. See "Start-to-first-test drill".
  - `leases <project>` is the read-only lease check each step below asks for. It puts the project's
    treehouse `worktrees` rows beside `treehouse status` and names three kinds of mismatch:
    - a live row whose slot is on another lease or none;
    - a gone row whose slot is still on its lease (a return that never ran);
    - a slot leased to the project's holder (`ds:<project>:…`) that no row names (a create that died
      before its row).

    It exits 1 when it finds any.

## What the tests show

`tests/loop/contract-treehouse.test.ts` ran six cases. The squad is wanted with `backend tmux` and
`worktree_provider treehouse`, and the actuator starts the Lead and a Builder through the contract.

| Path | What happens to the slot |
|---|---|
| Start | The Lead and the Builder each lease a slot. The holder is `ds:<project>:<worktree name>`, the row records the lease id, and the Builder's `parent_path` is the Lead's path. |
| Close (unit done) | The terminal closes and the lease is returned. The folder stays in the pool, the branch is kept, and the row reads gone with one `worktree_removed` event. No Orca call is made. |
| Cancel of a dirty tree | The lease is returned forced, the member reads `gone` with `done: cancelled Builder removed` (this needed the fix above). |
| Crash restart | The agent dies and the walk sees none, so the loop starts the member again. The new terminal is on the same path and lease: the create adopts its own lease, with no second slot and no second `worktree_created` event. |
| Leftover pass | A queued `worktree.remove` returns the lease the same way a close does. |
| Host tidy scan | The cleanup observer lists no slot: no row under the pool folder. |

Why the tidy scan leaves the pool alone: class `d` (`bin/loop/observers/cleanup.ts`) lists only git
worktrees and folders whose name starts with `ds-<label>-`, and a slot's folder is named after the repo
(`…/<repo>-<hash>/<n>/<repo>`). The one exception is a repo whose own folder name starts with
`ds-<label>-`. Its slots would be listed like any other untracked worktree. No project here is named that
way. Pick a trial project whose folder is not.

## Start-to-first-test drill

```
bin/ds treehouse-drill time --repo <a local clone> --test "<install + one test>" --n 3 [--fetch]
```

The drill runs these steps:

1. It clones the repo into a temp folder, with its own pool root, worktree root, loop.db and HOME.
2. It leases one untimed slot to warm the pool. It reports that run as `cold`.
3. It makes `--n` pooled worktrees, each through the loop's own provider. Each one reuses the returned slot
   with its ignored files.
4. It makes `--n` fresh git worktrees.

In each worktree it runs the test command with `sh -c` and times the create and the test. It removes the
temp folder at the end. The repo and the host's pools are never touched. `--fetch` downloads the pinned
treehouse into the temp folder when none is installed. `--json` prints every run.

The comparison only means something with a real repo and a test command that installs first, for example
`--test "bun install --frozen-lockfile && bun test tests/loop/kinds.test.ts"`. On a one-commit repo with
`--test true` a fresh git worktree is quicker (about 50 ms against 500 ms on this host), because there is
nothing to keep warm and treehouse's own bookkeeping is the whole cost.

## Runbook (the live trial)

The same trial as tmux (`docs/backends/trial-tmux.md`), with treehouse worktrees and a git squad beside it to
measure against.

1. **Before the run.**
   - Get the operator's go on `trial-live-go`.
   - Update the host (`/ds-update`).
   - Install treehouse v3.1.8 (github.com/kunchenguid/treehouse) on PATH, or set `DS_TREEHOUSE_BIN` in the
     loop's environment.
   - Pick a throwaway trial project whose repo folder does not start with `ds-` (see the tidy note above).
     Set its backend: `bin/ds config set <trial> limits.conf default_backend tmux`.
   - Give the trial project a Claude-only roster, as in the tmux runbook:
     `bin/commands/roles.sh <trial> set builder claude opus ondemand - claude:sonnet`.
   - Run the drill on the trial repo and keep its output:
     `bin/ds treehouse-drill time --repo <trial checkout> --test "<install + one test>" --n 3 --json > drill.json`.
2. **Spawn the git squad first.**
   - Leave `worktree_provider` at `auto`, which is git.
   - Start one small feature squad with at least three units, so that three Builders start.
   - `ds squads` shows `backend tmux`, `worktree_provider git`.
3. **Spawn the treehouse squad.**
   - Run `bin/ds config set <trial> limits.conf worktree_provider treehouse`. The provider is written on a
     squad's row once at spawn, so the git squad keeps git.
   - Start a second squad with a similar plan, at least three units.
   - `ds squads` shows `worktree_provider treehouse`, and the board chip reads `tmux/treehouse`.
   - Run `ds treehouse-drill leases <trial>`: the Lead's slot, with no problem.
4. **Measure start to first test**, for at least three Builders on each squad. For each one, record:
   - the start: its `member_started` event (`ds events --kind member_started`);
   - the first test: the first test command in its conversation (`ds observed chat`, the first `Bash` turn
     running the project's tests).

   The first Builder on the treehouse squad leases a cold slot. A Builder after a returned one gets a warm
   slot. Note which is which.
5. **Crash.**
   - While a treehouse Builder works, run `bin/host/shadow-drill.sh crash <builder worktree>` and note the time.
   - The loop starts it again on the same slot: `ds treehouse-drill leases <trial>` shows the same lease id,
     and `ds events --kind worktree_created` has no second event for its path.
6. **Loop restart.**
   - Run `ds treehouse-drill leases <trial> --json` before and after `systemctl --user restart ds-loop`.
   - Every lease must be the same in both.
7. **Finish.**
   - Each unit's PR merges, and its Builder is retired after the merge. Its lease is returned:
     `ds treehouse-drill leases <trial>` shows the row gone and the slot `available`.
   - Close both squads.
   - Run `ds treehouse-drill leases <trial>`, which must report 0 problems, and `treehouse status` in the
     trial repo, which must show no slot leased to `ds:<trial>:…`.
   - The next host tidy pass (`ds observed cleanup`) lists no pool slot.

## Record (fill in when run)

- Trial project and the two squads (git, treehouse): _
- Merged PR(s): _
- Lease ids per member (from `ds treehouse-drill leases <trial> --json`): _
- Drill on the trial repo (`drill.json`): pooled and fresh medians: _
- Live start to first test, at least 3 Builders each (member, start, first test, seconds, cold or warm slot):
  - git: _
  - treehouse: _
- Forced crash: time, member, restart event id (`member_started`), lease id before and after: _
- Leases before and after the loop restart: _
- `treehouse status` after close: _
- `ds treehouse-drill leases <trial>` after close (problems: 0?): _
- Host tidy pass after close: any pool slot listed? _
- Failures (contract calls, cards, leases left over) and the fix or follow-up unit for each: _
