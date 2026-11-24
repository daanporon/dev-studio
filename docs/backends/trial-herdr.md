# Trial: herdr (orca-backend-alternatives U16c)

**Status: not run.** This page is the runbook and the empty record. The code the trial needs is merged with
U16c: the loop runs a squad on `herdr` through `projectHerdr` (`bin/backend/herdr.ts`), and the registry lets a
spawn pick it only on a trial project (`conventions/backend.md`, "On trial"). The live run waits for the
operator's go (the board question `trial-live-go`). Nothing below the "Record" heading is filled in yet.

## Before the run

- The shadow's exit is met (`docs/backends/shadow.md`).
- The host is updated (`/ds-update`) to a dev-studio that has U16c, and the loop restarted on it.
- herdr's pinned release is installed: `bun bin/backend/herdr.ts install` (it downloads herdr 0.9.5 into
  `~/.local/share/dev-studio/herdr/0.9.5/`, checks its sha256 and touches nothing else). `DS_HERDR_BIN` may name
  another binary; its protocol is still checked on the first call.
- The trial project has `default_backend herdr` (`ds config set <trial> limits.conf default_backend herdr`,
  or Settings → Agents & nudges). Every other project stays on `orca`: a `--backend herdr` spawn anywhere else is
  refused.
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

## Record (fill in when run)

- Squad: _
- Merged PR: _
- Forced crash (time, member, restart event id): _
- Retirement (event id, its time, the merge time): _
- Agent pids before and after the loop restart: _
- herdr layout (one workspace for the squad, a tab per member; a note or a screenshot path): _
- `worktrees` rows before and after the upgrade: _
- Upgrade drill (from 0.9.5 to _): the old server refused or not, members restarted (count, time taken), anything
  left behind: _
- State detection without hooks, per sampled moment (herdr's state, the truth, which was right): _
  - Turn running: _
  - Long tool call: _
  - Turn just ended: _
  - Permission or menu question open: _
  - Agent exited to its shell: _
  - Right after a restart: _
  - Summary (how often herdr was right, which states it misses, whether the observer should trust it): _
- Memory (herdr server rss) and backend calls per tick: _
- Failures, and the fixes or follow-up units they led to: _
