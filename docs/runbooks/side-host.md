# Side hosts: join, drain, remove, and what a lost host costs

A side host is a second machine that runs worker seats (Builders, Testers, Researchers) for the loop on your
main host. Leads, Thinkers and the Studio stay on main, and so do `loop.db`, the board and every decision.
The side host runs its own loop, which dials main, does what main asks on its own disk and sends what it
observes back over the link. Terms: **main** is the host that runs your projects; **side host** is the other
one. `tests/side-host.sh` runs a join, a Builder's placement, a lost link, the requeue and the refused late finish
on one machine; it does not run Drain, Remove or the side's own fence.

## Join

**You need,** on the new host: `bun`, `git`, `jq`, `claude`, `crontab`, tmux or herdr, git push rights
(`gh auth status` passes), and an agent login main also has. Orca is not needed. Both hosts must reach each
other over the tailnet.

1. On main, turn the link server on. By default (`link_listen auto`) it runs only while a host is pending or
   accepted, so the first host needs it turned on:

   ```sh
   bin/ds config set <project> limits.conf link_listen on     # link_port defaults to 7790
   ```

2. On the new host, in a plain shell (not an agent's terminal), clone dev-studio and run:

   ```sh
   bin/ds join <main-address>:7790 [--name <host-name>] [--repo <git-url>]...
   ```

   It names everything that is missing before it writes anything. `--repo` also checks that this host can push
   to that repo. It then installs the side loop, makes the host's key (the private key never leaves
   `state/link/host.key`), prints a fingerprint and waits. The request lasts 15 minutes.

3. On main, check that the fingerprint is the one `ds join` printed, then accept it, on the board's
   Needs-you card or with:

   ```sh
   bin/ds host list
   bin/ds host accept <name> [--seats N]      # seats: how many workers it may run at once, default 2
   ```

4. `ds join` finishes by itself: it installs the role skills for the host's logins, probes tmux or herdr,
   starts the side loop and prints `connected`. Running it again is safe.

**When work goes there.** Main fills itself first. A Builder goes to a side host when main would make it wait
(no `max_builders` slot, or main's host brake). A Tester or Researcher goes there when main's machine level is
critical. A side host takes a start only while it is online, has main's link version and database layout, has a
free seat and a fresh machine sample, is not over its own brake, and holds a usable login for the account the
picker chose. A worker there runs on its squad's backend, or on tmux when the squad runs on Orca.

**Settings** for one host: `bin/ds host show <name>`, `bin/ds host set <name> <key> <value>`,
`bin/ds host rm <name> <key>`, or the board's Settings → Hosts.

## Drain

Draining stops new starts on a host. The members it already runs carry on, finish and may restart there.

```sh
bin/ds host drain <name>           # `ds host list` then shows `draining`
bin/ds host undrain <name>         # it takes new starts again
```

The host is empty when no member in any squad's crew list on the board carries its name. To empty it sooner,
open a member's ⋯ menu in that list and press **Move to main**. Once the member is idle it writes a journal
checkpoint (a Builder commits its work first), then the loop pushes the Builder's branch, closes the member there
and starts it again on main when main has room. A Builder's unit goes to its next attempt, on `<branch>-r2` and
so on, from the pushed commit. Only commits move: with uncommitted files the move is refused, the member carries
on and its row says why. The old worktree stays on the side host.

## Remove

**Drain first.** `ds host remove` does not stop or move anything:

```sh
bin/ds host remove <name>          # or Remove on the host's row in Settings → Hosts
```

It deletes the host's key and drops its settings, so main refuses the link from then on. Main only requeues
work from an **accepted** host. A member still running on a host you removed is never requeued: it stays
`unknown`, and closing it from main does nothing. If a host is broken and not coming back, do not remove it first: wait until
main has moved its work (next section), then remove it.

Then, on the removed host, stop the side loop for good:

1. Delete the watchdog line (`bin/loop/loop.sh --ensure`) with `crontab -e`, or cron starts the loop again.
2. Stop the loop with `bin/ds loop-ts --stop`.
3. If systemd runs it: `systemctl --user disable --now ds-side-loop.service`.

To join it again later, run `ds join` and accept the new request. It starts from the default settings.

## A lost host: what happens and what it costs

A host is lost when it is switched off, asleep, or cut off from main.

| When | Main | The side host, if it is still running |
|---|---|---|
| after 30 s without an answer | the host's members read `unknown`. Nothing is restarted, closed or placed there. | its workers keep working. Their `ds` calls to main exit 75 (main unreachable, nothing ran); they retry. |
| after `host_grace_min` (15 minutes) | still `unknown` | it pushes each Builder branch that has unpushed commits, then closes its own workers. |
| 60 s later | each unit goes back to the queue as attempt n+1, on branch `<branch>-r<n+1>`, starting from the last commit main finds on the old branch on origin. The new Builder's journal gets a note naming the host, the old branch and that commit. | |
| the link returns | main closes any old terminal that is still open, then uses the host again. | a late call from an old worker is refused with exit 78, `you were replaced`, and writes nothing. |

A link that returns before main has moved the work costs nothing: the same workers carry on. A host that says
on reconnect that it already closed its workers has its units moved at once.

**What it costs:**

- **Time.** About 16 minutes before the work starts again, plus the time the new worker needs to read its
  plan and journal. It also needs a free seat, on main or another side host; until then it waits.
- **Uncommitted work.** It is not moved. It stays in the old worktree on the lost host's disk.
- **Unpushed commits.** The side loop pushes committed work as it goes, and once more when it closes its
  workers. A host that lost power or its network cannot push, so commits made since its last push are only on
  its disk. The new branch starts without them (from the default branch when nothing was pushed).
- **The conversation.** The new worker starts fresh. It has the plan, the unit's journal and the pushed
  commits. The journal may be behind: no checkpoint can be asked of a host main cannot reach.
- **Finished-but-open work.** Every worker still live on the host is moved, including a Builder that already
  reported and is waiting for its PR to merge. When the old branch's PR is still open, the Studio gets a card:
  the new attempt is on another branch, so decide which PR to keep and close the other.
- **Tokens.** Whatever the new worker has to redo is paid for twice.

**The grace** is `host_grace_min` in `conventions/limits.conf`. Main and the side host each count it
themselves, and main's extra 60 s is what keeps it from starting a new worker while the old one still runs.
If you override it with `DS_LIMIT_HOST_GRACE_MIN`, give both loops the same value. A side grace longer than
main's means two workers can run the same unit at once until the link returns.

## Checking on a host

```sh
bin/ds host list                   # on main: status, seats, when it was last seen
cat state/link/status.json         # on the side host: is its link up, and why not
```

The board shows each side host's load, memory and top processes in the Machine panel, and online state, seats
and brake in Settings → Hosts. A host marked **behind** has another link version or database layout than main
and takes no new work until it is updated.
