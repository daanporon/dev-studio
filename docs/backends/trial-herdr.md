# Trial: herdr (orca-backend-alternatives U16c)

**Status: run 2026-11-24, partly.** The squad ran on herdr from spawn to its merged PR, and the crash, loop-restart and
retirement drills passed. The upgrade drill was not run: herdr 0.9.5 is the newest stable release, so there is no
next pinned release to move to (the operator's Lead chose to skip it rather than install a preview build). State
detection was sampled only at 2-minute steps without a side-by-side truth for the hard moments, so that part of the
Record is thin. The run is in the "Record" section below.

## Before the run

- The shadow's exit is met (`docs/backends/shadow.md`).
- The host is updated (`/ds-update`) to a dev-studio that has U16c, and the loop restarted on it.
- herdr's pinned release is installed: `bun bin/backend/herdr.ts install` (it downloads herdr 0.9.5 into
  `~/.local/share/dev-studio/herdr/0.9.5/`, checks its sha256 and touches nothing else). `DS_HERDR_BIN` may name
  another binary; its protocol is still checked on the first call.
- The trial project's backend is set to herdr (`ds up <trial> --backend herdr`; the move is checked first). Every other project stays on `orca`: a
  `--backend herdr` spawn anywhere else is refused.
- The trial project's roster names Claude only (no Codex or Muse, and no fallbacks to them): `spawn-squad` refuses
  a squad off Orca whose roster names another agent (`/ds-roles`).

## Runbook

1. Start one small feature squad on the trial project (`/ds-start-squad`, or the board's Start squad dialog with
   Backend `herdr`). Its row reads `backend herdr`, `worktree_provider git`. The first member start brings up the
   project's server: the user unit `ds-herdr-<trial>` (`systemctl --user status ds-herdr-<trial>`), files in
   `state/<trial>/loop/herdr/`.
2. Check the layout: one herdr workspace for the squad, one tab per member. Attach to look at it with
   `HERDR_SOCKET_PATH=state/<trial>/loop/herdr/herdr.sock HERDR_SESSION=ds-herdr-<trial> <herdr bin>`.
2b. **Idle reads idle.** With a member at its prompt showing Claude's grey suggestion (it appears after a turn),
   check `ds observed workers --project <trial>` reads it `idle` (not `unknown`) and a board chat to it is sent, not held
   at "text at the prompt". Type a few real characters in its prompt: it must read as a draft and hold the chat.
   (tmux had this fault, U20b: a screen read that drops styles shows the suggestion as typed text.)
3. Let the Lead plan and a Builder start. While the Builder works, sample states (below) every few minutes.
4. **Crash.** Kill the Builder's agent process (only that pid: `ds stop-mine` from its worktree, or the pid from
   `ds observed workers`). Note the time. The loop sees no agent in the folder and starts the member again
   (a new generation); note the restart's event id (`ds events --project <trial>`).
5. **Loop restart.** Note the agent pids (`ds observed workers --project <trial>`), run
   `systemctl --user restart ds-loop`, and note them again. The herdr server is its own unit, so the agents
   must keep running and the same pids must come back.
6. Let the Builder open its PR and the PR merge. The Builder is retired only after the merge: note the
   retirement's event id and that its time is after the merge.
7. **Upgrade drill.** With the squad still open, move herdr to the next pinned release: a branch that sets
   `HERDR_VERSION` (`bin/backend/herdr-bin.ts`) and the release's `ASSETS` sha256 and `HERDR_PROTOCOL` in
   `bin/backend/herdr.ts`, installed with
   `bun bin/backend/herdr.ts install`, the host updated to it. Note the `worktrees` rows of the squad before and
   after (`bun -e` on `state/loop.db`, or `ds worktree list`). Then stop the old server
   (`systemctl --user stop ds-herdr-<trial>`); until then the new code refuses the old server's protocol (when the
   protocol changed), so record whether it did. The next
   member start brings up the new server. herdr does not restore pane tokens or (with `resume_agents_on_restore =
   false`) agents, so every member reads gone and the loop starts each again. Record how long that took and
   whether anything was left behind (`systemctl --user list-units 'ds-herdr-*'`, a leftover folder).
8. Close the squad. Check the unit `ds-herdr-<trial>` is still there (it serves the project, not the squad) and
   the squad's workspace is gone.

### Sampling states

herdr reports an agent's state (`agent_status`) from what it sees in the pane, because dev-studio never installs
herdr's hooks (`herdr integration install`). The contract maps it as `working` → working, `blocked` → waiting,
`idle` and `done` → idle, else unknown, and the contract observer takes it over its own guess unless it is
`unknown` (`bin/loop/observers/contract.ts` `readState`). To see what herdr says, with no server started:

    bun bin/backend/herdr.ts states <state root> <trial>

prints one line per terminal: time, terminal id, `<squad>/<role>`, generation, state. Put each line next to the
truth at the same moment: the member's transcript (a turn running or ended), the screen (`esc to interrupt`, an
empty prompt, a permission question) and `ds observed workers --project <trial>`. Sample the moments that matter:
a turn running, a long tool call, a turn just ended, a permission or menu question open, an agent that exited to
its shell, a member right after a restart.

## Record (run 2026-11-24)

- Squad: dev-studio-public `pause-fanout-test-timeout` (ds-feedback #1: a `tests/loop/pause-fanout.test.ts` case timed out at 5000 ms in a builder worktree). Spawned 18:43Z with `default_backend herdr`, set back to `orca` right after. Row: `backend herdr`, `worktree_provider git`. The server is the user unit `ds-herdr-dev-studio-public`; it stayed active through the whole run.
- Merged PR: #168 `test(loop): run pause-fanout scripts from the checkout`, merged 19:51:05Z.
- Forced crash (time, member, restart event id): `shadow-drill.sh crash` at 19:29:14Z on `builder-u1-pause-fanout-runscript-runs` (pid 1193417 and its context-mode child). Its tab left herdr, the loop's pick said `WAIT host: load 176.3% >= crit 150%`, and `member_started` #617787 came at 19:31:20Z, about 125 s later, with `shadow_crash` #617789. The delay was the host-load gate, not herdr.
- Retirement (event id, its time, the merge time): `unit_done` #618042 at 19:51:35Z, `member_closed` #618046 at 19:51:36Z, the merge at 19:51:05Z. Right order. (A `member_stopped`/`member_started` pair at 19:46:52Z/19:46:56Z, #617976 and #617984, was the build to babysit phase change, not a fault.)
- Agent pids before and after the loop restart: `systemctl --user restart ds-loop` at 19:31:42Z (loop pid 115456 replaced). Builder 1220028, Lead 721451 and Thinker 721478 were the same before and after, no `member_*` event came for them, and the herdr server (pid 721367) kept running.
- herdr layout (one workspace for the squad, a tab per member; a note or a screenshot path): not as the runbook expects. herdr listed two workspaces, `w1` (tab `lead`) and `w2` (tab `thinker`), both labelled with the squad name, one tab each; a Builder appeared as its own terminal in `herdr.ts states`. So the squad is one workspace per member, not one per squad. Not fixed here; it does not affect the loop, which finds members by their tokens.
- `worktrees` rows before and after the upgrade: not run (no newer stable release).
- Upgrade drill (from 0.9.5 to _): not run: no newer stable release (0.9.5 of 2026-10-14 is the latest; a preview build exists and was not installed host-wide). The old-server-refused and members-restarted questions stay open for the first newer pin.
- State detection without hooks, per sampled moment (herdr's state, the truth, which was right): sampled every 2 minutes from 18:44Z (scratchpad log, 113 lines): Lead 34 `idle`; Thinker 29 `idle`, 5 `working`; Builder 9 `working`, 2 `idle`. I compared them with `ds observed workers` (which takes herdr's state) at a few moments, not with the transcripts one by one.
  - Turn running: Builder `working` while it built and tested; Thinker `working` while it planned. Right.
  - Long tool call: not isolated (the Builder's test runs read `working`, right, but I did not time a single long call).
  - Turn just ended: Lead and Thinker read `idle` from the first sample after their turn (the Lead showed its prompt, and `ds observed workers` read it `idle`). Step 2b's draft half (typing characters in a prompt) was not run, and the Builder's 2 `idle` reads were not checked against its transcript.
  - Permission or menu question open: not sampled.
  - Agent exited to its shell: not sampled; after the forced kill the tab simply left the list (no shell state to read).
  - Right after a restart: Builder read `working` at the first sample after its start (19:32:59Z), right.
  - Summary: no wrong read found among the moments I checked, but most samples were not checked against the truth, and the hard moments (permission question, exit to shell, a typed draft) were not covered, so the observer should keep using the shadow's own checks for them until they are.
- Memory (herdr server rss) and backend calls per tick: server rss 17.8 to 19.2 MB over the run; backend calls per tick not measured.
- Failures, and the fixes or follow-up units they led to: no `action_failed` event for the squad. The layout above (one workspace per member) and the untried state moments are the open items. The squad itself was not closed by this unit (the Lead or the operator closes it), so runbook step 8 (the unit stays, the squad's workspaces go) is not checked.
