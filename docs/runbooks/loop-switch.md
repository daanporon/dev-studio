# Switching the host from the cron sweep to the loop

> Historical: the switch was done in #317 on 2026-11-08; `main` is the loop's branch and merge target.

> Historical switch runbook. The loop now runs on `main` only. The checkout-to-main
> rollback and quiet-week prerequisite below describe the 2026-11-03 switch; the operator
> waived the quiet-week gate on 2026-11-07. Restore a pinned pre-loop revision and its state
> backup for any rollback to the removed driver. Current installation uses `bin/host/install.sh`.


One checkout and one install move the whole host, every project together, and the same two commands
move it back. `tests/install.sh` runs all of this on a hermetic root; this page is the live run.

## Before the switch

1. `loop-v1` carries everything the switch needs. U39 and U40 are merged into it.
2. `main` is merged into `loop-v1`, so no main-only commit remains (KTD6):
   `git log --oneline origin/loop-v1..origin/main` prints nothing.
3. Every `main` commit since the fork point that changes behaviour the loop reimplements is listed in
   the U18 PR as already in the loop or not applicable. If `main` moved, repeat the list:

   ```sh
   git log --oneline b3a2d95..origin/main -- bin/sweep.sh bin/lib/lib.sh bin/lib/watch.sh \
     bin/role/finish-unit.sh bin/lib/accounts-refresh.sh bin/backend/orca.sh
   ```

   A commit that is neither gets its own PR into `loop-v1` first.
4. Pick a quiet hour: no squad mid-merge, nobody waiting on the operator.

## The switch

```sh
cd "$(readlink -f ~/.dev-studio)"
git fetch origin && git checkout loop-v1 && git pull --ff-only
bin/host/install.sh --check     # changes nothing
bin/host/install.sh
```

Run them one after the other, not with `&&`: `--check` also exits non-zero on an account's plugin record,
which has nothing to do with the switch and does not stop the install.

The install runs these steps in this order. A crash at any point is safe to rerun with `bin/host/install.sh`:

1. `bin/loop/db/migrate-host.ts` takes the sweep's lock (it waits up to 5 minutes for a run in flight, then
   fails with the host still on the sweep). It imports every project's squad JSON, marker files, config
   and `board-serve.want` in one transaction, then writes `state/.loop-migrated` by atomic rename, last.
   Until that mark lands the scripts behave as on `main`.
2. `ds-loop.service` is rendered and enabled. A set `ORCA_USER_DATA_PATH` other than the default goes in
   the unit. An install from a shell without the variable keeps the unit's path; to clear it, install with
   the variable set to the default path. A changed path restarts a running loop. The watchdog line in step 3
   carries the path by the same rules on every host, since a unit that works now is out of reach at cron
   time without a user session. Without a working unit a changed path stops a running loop for that line to
   start again, and `/ds-update` only stops a loop whose line has a path, so the line does the start. With no
   crontab and no working unit, the install prints the path to run the loop with.
3. One crontab write swaps the sweep's line for the watchdog line (`bin/loop/loop.sh --ensure`, every minute),
   so an install that dies at any later point still leaves a driver. Next to it goes
   `state/.loop-reconcile`: the rows may be behind the files. While that file is there, a loop starting
   first imports what changed, and exits 0 while a sweep still holds its lock, for the watchdog line to
   try again a minute later.
4. A sweep that started just before is waited for, then the sweep's boards stop (their ports are the
   loop's now). The want files stay for a rollback.
5. The migration runs once more for anything written since, and removes the file. A sweep still stuck
   after 5 minutes gets a warning, not a failure: the loop does this itself once that run is done or its
   lock goes stale after 10 minutes.
6. The unit starts. Without a systemd user session the watchdog line starts the loop within a minute.

`/ds-update` never makes this switch: on a host without the mark it installs with `--no-loop`. The one
exception is a sweep host already on a `loop-v1` from before this install: the update runs the script
it started with, and that one calls the install without the flag. Switch such a host by hand first.

Live squads keep their terminals and conversations: the loop takes over the workers it finds, and
the switch restarts no role. The one thing that moves a role in the first ticks is the loop's own
limit handling (U40): a stopped member out of usage, stuck on a limit dialog, or on an account no
longer listed restarts on another account, one at a time (an `action` event of kind `run-switch`). The
source files stay in place for a rollback.

## Proving it

During the next hour:

```sh
crontab -l | grep -c bin/sweep.sh     # 0
bin/loop/loop.sh --status
bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database("state/loop.db", { readonly: true });
  const since = Math.floor(Date.now() / 1000) - 3600;
  console.table(db.query("SELECT project, kind, count(*) n FROM events WHERE at >= ? GROUP BY project, kind ORDER BY project, n DESC").all(since));
  console.table(db.query("SELECT name, project, topic, port, status, want FROM services").all());
'
```

`events` must show the loop acting for both projects, and each board that had a want file must be
running. The transcript of these commands goes in the U18 PR.

A Claude start that never came up (or got no tab) writes one `start_failed` event (U270): project,
squad, member, worktree, account, the failure, the tab's last 40 screen lines or what Orca's
`terminal create` printed, and load1. Its refusal text points at it ("screen in event start_failed <id>").

## The quiet week

Watch for:

- no Studio alert about the loop,
- no squad lost: every squad on the board before the switch is still there, with its workers,
- no double poke reported by a Lead or Builder,
- the health row never older than the banner threshold (the board shows the banner when it is).

Until U19 removes the sweep:

- A fix for the running host goes to `loop-v1`, not `main`.
- A merge changes nothing on the host until `/ds-update` runs.
- Anything merged to `main` meanwhile is merged into `loop-v1` before that update (KTD6).

## Rollback

```sh
cd "$(readlink -f ~/.dev-studio)"
git checkout main
bin/host/install.sh
```

- The loop sees `bin/loop/main.ts` gone within one tick and looks again 2 s later, because a reset rewrites
  the file. It waits up to 30 s for a start in flight, notes what it still holds in `loop_exit`, exports
  every squad except one whose file changed or went since its last export (main's scripts write those
  now; `squad_export_kept` in `events`, and the re-switch imports them), stops its boards, and exits.
  The unit's `ConditionPathExists` keeps systemd from restarting it.
- `main`'s install puts the sweep's crontab line back. The sweep reads the squad JSON the loop kept
  exporting and the marker files as they stood at the switch.
- Each project's board returns through the sweep's `board-serve.want`.
- The watchdog line stays in the crontab, because `main` does not know it. It is guarded by
  `[ -x bin/loop/loop.sh ]`, so it does nothing and says nothing.

## Switching again after a rollback

```sh
git checkout loop-v1 && git pull --ff-only
bin/host/install.sh
```

Run the install straight after the checkout. In between, scripts queue wishes for a loop that refuses
to start, and read rows from before the rollback.

The mark is still there, so nothing is imported wholesale. A squad JSON newer than the loop's last
export of it and different from its rows is imported again, on its own (`squad_reimported` in `events`).
A squad whose file went while the sweep ran is closed. What the loop still held when it left, a wish or
a request it had not finished, is given up rather than run against a squad that has moved on:
`want_result` / the request's result says so, the install prints it, `queued_given_up` in `events` lists
it, and it runs again only if asked again. A loop killed before it could leave says nothing, so its
queue does run. Between the checkout and the install, the loop
refuses to start: it exits at once while the crontab still runs this checkout's sweep, so the two never
drive the host together. A script that writes a squad in that time imports the sweep's file first, so
it does not overwrite it with the rows from before the rollback.

A rollback that does not finish is covered as well. The loop's exit writes `state/.loop-reconcile`, so if
you check out `main` and come back without `main`'s install having put the sweep's line back, the loop the
watchdog line restarts imports what `main`'s scripts wrote, and gives up what it held, before its first
tick. No install is needed for that. A loop killed before it could leave writes no file: nothing marks
its rows as behind unless the sweep's line came back.

Markers the sweep wrote during the rollback are not read again, so a poke the sweep sent in that time
may be sent once more. A board stopped through `ds want board --stop` before the rollback stays stopped.
A board stopped with `board.sh --stop` during the rollback stays stopped too, and a port changed then is
taken, for a wish the install made from the want file.

## `--no-loop`

`bin/host/install.sh --no-loop` keeps a host that has not switched on the sweep. It refuses on a host that
has the mark, because it would leave nothing driving it. The way back from the loop is the rollback above.

A host that runs `bin/sweep.sh` another way installs with `--no-sweep --no-loop`; `--no-sweep` alone is
refused, because the loop would run beside that sweep. A host with neither a systemd user session nor a
crontab is not switched: nothing would start the loop.
