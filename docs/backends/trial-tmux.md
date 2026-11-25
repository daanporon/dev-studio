# Trial: tmux (orca-backend-alternatives U16b)

**Status: done for steps 1-6 (step 7, the live upgrade, was not run; the version-change drill covers it).** The live
trial ran on 2026-11-24 with the operator's go. The crash and loop-restart steps passed. The first Builder never
started (the shell fault below, fixed by U20a); the second, after U20a, took its brief, opened PR #155 and was
retired after the merge. See "Record" below.

What this unit shipped so the trial can run:

- `tmux` is pickable for a project (`bin/backend/registry.ts`, `conventions/backend.md`, "A backend per
  squad"). A squad starts on it only in a project whose Studio runs on `tmux`. A `--backend tmux`
  anywhere else is refused.
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
   - Pick a throwaway trial project and set its backend: `bin/ds up <trial> --backend tmux`
     (checked first; running squads must be closed). Leave `worktree_provider` at `auto`, which is git. Treehouse is U16e.
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

## Record (run 2026-11-24, partial)

- Trial project and squad: dev-studio-public, squad `backend-pick-guide` (id 134, task: a "Which backend to pick" section in `docs/USAGE.md`), spawned 09:50:30Z on tmux (socket `-L ds-dev-studio-public`, server pid 2044300). Only that squad ran on tmux; `default_backend` went to `tmux` and back to `orca` in the same second. The roster was overridden to claude-only for the trial; U26 restores it.
- Merged PR: #155 (`docs(usage): add a which-backend-to-pick guide`), merged 15:57:11Z (auto-merge armed, event 615638). It came from the Builder started after U20a: `member_started` #615547 at 15:49:08Z; the Builder took its brief at 15:49:12Z (its transcript) and `unit_pr` #615594 recorded the PR at 15:52:03Z. The first Builder (`u1-docs-usage-add-a`, before U20a) never started work.
- Forced crash: 10:42:33Z, member `thinker`; the loop restarted it (`member_started` #610666) and logged `shadow_crash` #610668.
- Builder retirement: `unit_done` #615640 at 15:57:43Z (PR 155, 32 s after the merge, so after it), then `want` #615641 (`gone`, why `unit u1-docs-usage-add-a done`), `member_closed` #615644 at 15:57:44Z, `worktree_removed` #615647 and `wish_done` #615649 at 15:57:49Z (`archived: worktree removed`), `squad_all_done` #615642. The earlier Builder's window had been `gone` twice within 30 minutes and the loop stopped restarting it (see Failures).
- Agent pids before and after the loop restart (from the two snapshots): loop restart 10:44:17-10:45:02Z. Tmux server pid 2044300 and agent pids 2044334 (thinker), 2044367 (lead) and 3038652 were identical before and after. The agents survived the loop restart.
- Sessions and windows per squad (the tmux view of `orca worktree show`: `ds tmux-drill snapshot` → `windows`): one session `backend-pick-guide` with windows `thinker`, `lead`, `builder-u1-docs-usage-add-a` (live check 14:50Z).
- `worktrees` rows before and after the upgrade: not run (no live upgrade).
- tmux version on the live server before and after the upgrade, and the client version after: 3.4 server and client; no upgrade was done.
- Memory (tmux server RSS), backend calls per tick, tick times: server RSS about 7.9 MB (8.3 MB earlier); no `tick_slow` events from the trial squad; backend calls per tick not measured.
- Failures (contract calls, cards) and the fix or follow-up unit for each: the Builder window of `backend-pick-guide` held a bare `bash` (pid 1729923) instead of `claude`. The loop's brief was typed into that shell and bash answered `syntax error near unexpected token '('`, so the Builder never started. The loop reported it was "sent its brief 2 times and never started", then "gone again within 30 min of a restart; the loop does not restart it again". The thinker and lead windows (claude) were healthy. Finding: on tmux a Builder window whose agent launch fails falls back to a shell and still looks alive to the backend, so the loop pastes the brief into a shell. Not restarted by hand, per the Lead. Follow-up for the Thinker: find why the Builder launch left a shell, and make the tmux backend report a pane whose foreground command is a shell as agent-gone.
- Version-change result: see "Version-change drill" above; the live upgrade's outcome: not run.
- Failures after U20a (both fixed by U20b, `tmux: read an idle prompt as empty, and give a typed brief time to be taken`):
  - False "Poke not taken" card. The Builder started at 15:49:08Z and took its brief at 15:49:12Z, yet `delivery_sent` #615551 (15:49:15Z, try 2) and `delivery_escalated` #615553 (15:49:18Z) put a card on the board. Every tmux brief so far ended this way (deliveries 1841 to 1889: 10 of 14 escalated, each within about 5 s; Orca had 442 verified and none escalated in the same 3 days). A tmux `terminal.send` answers `accepted` with no `turn_started`, so the delivery was due one second later and was resent and escalated before the contract observer read the member `working`. Fix: a send that is only `accepted` on a backend off Orca waits `DS_LOOP_DELIVERY_TAKE_S` (30 s) before its resend, and the member's transcript growing since the send counts as taken (`bin/loop/fulfil/poke.ts`; Orca's sends keep their 1 s).
  - An idle tmux member never read `idle`. `capture-pane -p` drops styles, so Claude's grey prompt suggestion (`❯ mark the unit done`, faint) read as typed text; `promptDraft()` returned it, `readState()` gave `unknown` and `memberReady()` answered "text at the prompt", which held board chats and answers. Fix: the screen is read with `capture-pane -e`, faint runs are dropped and the other escapes stripped (`plainScreen` in `bin/backend/tmux.ts`); a really typed draft stays text.
