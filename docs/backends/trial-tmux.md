# Trial: tmux (orca-backend-alternatives U16b)

**Status: not run.** This page is the runbook and the empty record for the live trial. The live run waits for
two things: the shadow exit (`docs/backends/shadow.md`, earliest 2026-11-30) and the operator's go for the trial
project and the loop restart (the board question `trial-live-go`). Only the version-change drill below has run.
Nothing under "Record" is filled in yet.

What this unit shipped so the trial can run:

- `tmux` is pickable at spawn, on trial (`bin/backend/registry.ts`, `conventions/backend.md`, "On trial").
  A squad starts on it only in a project whose `default_backend` is `tmux`. A `--backend tmux` anywhere
  else is refused.
- `ds tmux-drill` (`bin/commands/tmux-drill.ts`):
  - `version` runs the version-change drill on a private socket.
  - `snapshot <project>` is the read-only before/after capture each step below asks for.

## Version-change drill (run 2026-11-24)

An upgrade of tmux leaves the project's server running the old build, because nothing restarts it. Every
call after the upgrade, from the loop or a role script, then runs the new binary as a client against that
old server. The drill does exactly that, in a temp folder that holds no project's socket:

```
nix build --no-link --print-out-paths nixpkgs#tmux     # a second build in its own prefix
bin/ds tmux-drill version --new <prefix>/bin/tmux      # --old defaults to tmux on PATH
```

The drill runs these steps:

1. It starts a server of the old build through `server-unit`, the same way the loop starts one.
2. It starts one terminal running a stand-in agent (`sleep`).
3. It runs every contract op through a client of the new build.

It reports three results:

- whether the new client was refused;
- whether the agent survived;
- whether the old client still answers.

The server it started is stopped at the end.

Result on this host:

```
old: tmux 3.4 (/usr/bin/tmux) — server pid 805304, server reports 3.4, rss 6548 kB
new: tmux 3.8 (/nix/store/…-tmux-3.8/bin/tmux)
  ok     list-sessions (new client): drill
  ok     terminal.list: 1 terminal(s), gen drill-old
  ok     terminal.read: 1 line(s)
  ok     terminal.last_output: 1795478348
  ok     terminal.create: %1
  ok     terminal.send: accepted
  ok     terminal.close
new client on the old server: accepted
agent pid 805332 after the new client: alive
old client after: ok (1 terminal(s))
```

The 3.8 client is not refused by the 3.4 server. The two share a protocol version, and the `@ds_meta`
option, the `-N` flag, paste buffers and `window_activity` behave the same on both. An upgrade from 3.4
to 3.8 is therefore safe while the server runs. A tmux release that changes the protocol version would
print `protocol version mismatch` on every call. The drill reports that as `refused`.

The recovery for a refused client is outside dev-studio:

- Keep the old build's client on PATH until the squads on that server have closed, or
- stop the server, which ends every agent in it, and let the loop start the squads again on the new build.

Rerun the drill before every tmux upgrade. `DS_TMUX_NEW=<new tmux> bun test tests/loop/tmux-drill.test.ts`
runs it as a test.

## Runbook (the live trial)

The same trial as orca-lite (U16a), on plain git worktrees.

1. **Before the run.**
   - Get the operator's go on `trial-live-go`.
   - Update the host (`/ds-update`).
   - Pick a throwaway trial project and run `bin/ds config set <trial> limits.conf default_backend tmux`.
     Leave `worktree_provider` at `auto`, which is git. Treehouse is U16e.
   - Give the trial project a roster that names only `claude`, fallbacks included. The shipped `builder` row
     falls back to `muse:muse-spark-1.3`, and off Orca only Claude has a launch line, so spawn-squad refuses
     it. Run `bin/commands/roles.sh <trial> set builder claude opus ondemand - claude:sonnet`.
2. **Spawn.**
   - Start one small feature squad on the trial project (`spawn-squad` or the board).
   - Check its row: `ds squads` shows `backend tmux`, `worktree_provider git`, and the board shows the `tmux` chip.
   - Run `ds tmux-drill snapshot <trial> --json > before-start.json`.
3. **Let it work.** The Lead plans, and a Builder starts and works towards a PR. During this step:
   - `ds tmux-drill snapshot <trial>` shows the squad's tmux session, one window per member, with label and gen.
   - `tmux -L ds-<trial> attach -t <squad session>` lets you watch. Detach with `C-b d`, and never kill the server.
4. **Crash.**
   - While the Builder works, run `bin/host/shadow-drill.sh crash <builder worktree>`, which kills only the
     agent processes in that folder.
   - Note the time.
   - The loop starts the member again on a new generation. Read the event with
     `ds events --kind member_started` and `ds events --kind shadow_crash`.
5. **Loop restart.**
   - Take a snapshot.
   - Run `systemctl --user restart ds-loop`.
   - Take a snapshot again.
   - Every agent pid under the windows must be the same in both, because the tmux server is its own unit
     (`ds-tmux-<trial>`) and the loop does not own it.
6. **Upgrade.**
   - Install the newer tmux on PATH, the same way the drill above did, and leave the server running.
   - Take a snapshot.
   - Run `ds observed worktrees --project <trial>`, then compare the snapshots' `worktrees` rows: the loop
     must still find every worktree by path.
7. **Finish.**
   - The PR merges.
   - The Builder is retired only after the merge: the loop's `want` event that sets its member `gone`
     (`why: unit <slug> done`) comes after the merge.
   - The squad closes, and its worktrees are removed through the git provider (U11c).
   - Take a last snapshot. The squad's session is gone.
8. **Measure.** Record:
   - the tmux server's RSS from the snapshots;
   - the backend calls per tick and tick times: `loop.sh --status`, and `ds events --kind tick_slow` over the run;
   - each failed contract call: `ds events` and the Studio cards.

## Record (fill in when run)

- Trial project and squad: _
- Merged PR: _
- Forced crash: time, member, restart event id (`member_started`), `shadow_crash` event id: _
- Builder retirement (`want` event id, `gone`, `unit <slug> done`) and its time against the merge: _
- Agent pids before and after the loop restart (from the two snapshots): _
- Sessions and windows per squad (the tmux view of `orca worktree show`: `ds tmux-drill snapshot` → `windows`): _
- `worktrees` rows before and after the upgrade: _
- tmux version on the live server before and after the upgrade, and the client version after: _
- Memory (tmux server RSS), backend calls per tick, tick times: _
- Failures (contract calls, cards) and the fix or follow-up unit for each: _
- Version-change result: see "Version-change drill" above; the live upgrade's outcome: _
