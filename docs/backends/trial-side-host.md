# Trial: a real second host (side-loop-host U23)

**Status: not run yet.** The script is ready; it needs a second machine and the operator. It was checked only
against a made-up `loop.db` on one machine. See "Result" below.

`tests/side-host.sh` proves the join, a placement, a lost link and the requeue on one machine. This trial is the
same path on two real machines, plus what that test does not run: the board, the update, Drain and Remove.
What each action does and costs: [`docs/runbooks/side-host.md`](../runbooks/side-host.md).

## Before you start

- **Main runs the side-host code.** On main: `ds update <project>`.
- **The second machine** has what the runbook's "Join" lists (`ds join` names what is missing), reaches main
  over the tailnet, and has a dev-studio clone.
- **Real work:** a project with at least two units ready to build, one of them long enough to unplug the host
  in the middle of it. You review and merge both PRs (or the project's ship mode does).
- **Another seat** for the unit of the lost host: a free Builder slot on main, or a second side host.
- **Time:** the lost-host step alone takes `host_grace_min` (15 minutes) plus a minute, then a whole build.

## Run it

By hand, on main, from the checkout main's loop runs, in a plain shell:

```sh
bin/host/side-host-trial.sh <host-name>
```

The script changes nothing on either host. At each step it says what you do, reads main's `loop.db` (read only)
until it sees that it happened, and prints what it is still waiting for. It exits 1 at the first failed step
and prints the command that takes the run up again:

```sh
bin/host/side-host-trial.sh <host-name> --from <step>
```

A run without `--from` starts over. Each wait ends after 10 minutes (the machine sample), 8 hours (a unit being
built) or 1 hour (the rest); `DS_TRIAL_TIMEOUT_S` sets one limit for all of them. If you override
`DS_LIMIT_HOST_GRACE_MIN` for the loops, give the script the same value.

| Step | You | It passes when |
|---|---|---|
| `join` | turn `link_listen` on, run `ds join` on the second machine, compare the fingerprint and accept | the host is accepted and its link is up |
| `machine` | look at the board's Machine panel and answer `y` | fresh machine and process samples came from the host, and you saw its own section |
| `seats` | change its seats on its row in Settings → Hosts | the board wrote a new seats value, 1 or more (`ds host set` does not count) |
| `build` | give the host a unit (`add-role.sh <project> <topic> builder <unit-slug> --host <name>`) and merge its PR | a unit whose Builder stayed on the host finished `ok` and is done |
| `update` | with something new merged since the host's commit, run `ds update <project>` on main | the update's step for the host is done and the host moved to main's commit |
| `lost` | give the host a second unit, unplug it when told, leave it unplugged, merge the new attempt's PR | main saw the link drop, waited at least the grace, queued the unit again, and it finished on another seat |
| `return` | plug it back in | main took the host back and closed the old terminals there |
| `remove` | `ds host drain`, `ds host remove` (or Remove on the board), then stop the side loop there | the host is removed with no member left on it |

**What the script does not check:** the screens, beyond your `y`; the processes on the second machine (that
its loop stopped after Remove, or that it pushed and closed its Builders when it fenced itself — a machine
without power cannot); and a late `ds finish` from the old Builder being refused (`tests/side-host.sh` does).
After `lost`, close the old PR if the new attempt opened another one.

## Result

The run writes `state/link/trial-<host>.md`: main's starting commit and one line per step, with what it saw.
When the trial is over, paste that file here, add what the script could not see (anything that looked wrong on
the board or on the second machine, how long the requeue took, what was lost), change **Status** above, and
send it as a PR.

_Not run yet._
