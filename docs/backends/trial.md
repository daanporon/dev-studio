# Trial comparison: orca-lite, tmux, herdr (orca-backend-alternatives U16d)

This page compares the three backends that can run a squad besides `orca` itself, and says which one
new squads should try next. Each backend has a trial doc with a runbook and a record. The page
reads what those docs recorded and says which cells are still open.

**State of the evidence (2026-11-24).** Each backend has had one live trial squad, and its record is in
its own doc: [orca-lite](trial-orca-lite.md#record-run-2026-11-24), [tmux](trial-tmux.md) ("Record") and
[herdr](trial-herdr.md#record-run-2026-11-24). The table below reads those records and keeps three kinds of
cell apart:

- **measured**: a number or result a drill or test produced, with the doc that holds it;
- **by design**: what the contract, the registry and the fake-backed tests show; no live squad has proved it;
- **open**: the trial's record is empty, so there is no answer.

Fill the open cells from each trial's record as the trials run, and change the recommendation if they
disagree with it.

## The table

| | [orca-lite](trial-orca-lite.md) | [tmux](trial-tmux.md) | [herdr](trial-herdr.md) |
|---|---|---|---|
| What it is | Orca's terminals and worktrees with no Run, task or dispatch | One tmux server per project, one session per squad, one window per member | herdr 0.9.5 (pinned): one workspace per squad, one tab per member |
| Worktree tool | the `orca` provider (Orca makes them); not `treehouse` | `git` or `treehouse` | `git` or `treehouse` |
| Capabilities (`parents` / `state` / `turn_confirm` / `keys`) | native / native / native / native | groups / none / none / native | groups / native / none / native |
| Memory | open (loop RSS and agents' RSS are in the record) | measured: the server was 6.5 MB RSS in the drill, with one stand-in agent; a loaded squad is open | open (herdr server RSS is in the record) |
| Calls per tick | open. By design every call is an Orca CLI spawn through the loop's runner, so the Orca cost stays | open. By design one tmux call per member read, no Orca call | open. By design one socket call per read, no Orca call |
| Failures | open | open | open |
| Crash restart | open. By design the loop's process walk decides, as on every backend | open. Same; the shadow exit also forces a crash | open. Same |
| Loop restart | open. By design agents are Orca terminals and outlive the loop | open. By design the server runs as its own unit (`server-unit`), so agents outlive the loop; the live check is empty | open. By design its own unit and `resume_agents_on_restore = false`; the live check is empty |
| Upgrade | open (the Orca upgrade is the trial's step) | measured: a tmux 3.8 client was not refused by a 3.4 server, the agent survived, the old client still answered. A release that changes the protocol version would refuse every call; the drill reports `refused` | open. A herdr upgrade restarts every agent on it; the trial measures how many and how long |
| State detection | native, from Orca's pane state | none from the backend; the loop's own reader gives state (output, transcript, `esc to interrupt`) | native, but weak without herdr's hooks: the trial's sampling table is empty |
| Set on a project with | `default_backend orca-lite` | `default_backend tmux` | `default_backend herdr` |

Each backend's own row of tests is green on its fake or real binary (`tests/loop/backend-orca-lite.test.ts`,
`backend-tmux.test.ts`, `backend-herdr.test.ts`, the conformance suite in `backend-contract.test.ts`), so
the table's "by design" cells are what those tests prove and nothing more.

## Treehouse's measured speed gain

The worktree provider is the second choice, so it has its own trial
([trial-treehouse.md](trial-treehouse.md)).

- **Measured:** on a one-commit repo with `--test true`, a fresh git worktree is quicker than a pooled one
  (about 50 ms against 500 ms on this host), because there is nothing to keep warm and treehouse's own
  bookkeeping is the whole cost. That run says the pool costs time when there is nothing to reuse.
- **Open:** the speed gain on a real repo. The drill needs a repo with a test command that installs first,
  for example `ds treehouse-drill time --repo <clone> --test "bun install --frozen-lockfile && bun test tests/loop/kinds.test.ts" --n 3`,
  and the live start-to-first-test times of at least three Builders on each provider. Neither is recorded.
- **By design, covered by `tests/loop/contract-treehouse.test.ts`:** a close, a forced cancel and a leftover pass
  return the lease, a crash restart adopts its own lease with no second slot, and the host tidy scan lists
  no slot. The same test found and fixed one cancel bug. No lease check on a live squad is recorded.

## Recommendation

**Run tmux next, with `worktree_provider` left at `git`.** Treehouse follows on a proven tmux squad, as the
plan says, and gets its own go only after the drill has a real-repo number.

Why tmux:

- It is the only backend with a measured result on a risk the plan named: an upgrade does not stop agents.
- It needs no Orca call per member, so it is the backend that most lowers the loop's cost on Orca.
- It carries the least new surface: one server and plain panes. herdr adds a pinned third-party server
  and state detection that may be weak. orca-lite keeps Orca's cost, so the trial tells least.
- Its missing `state` capability is covered by the loop-side reader that every non-Orca squad already uses.

What would change the recommendation:

- A tmux trial that loses an agent on a loop restart or a crash restart goes back to orca-lite, the least
  change from today.
- herdr's trial is cheap to run beside tmux. If its state detection without hooks proves right, it is the
  better long-term backend, because it gives native state and groups.
- Whether any of these replaces `orca` as the default is decided at the clean-up's go (U18), not here.

Order of the next trials: tmux (forced crash, loop restart, retirement after merge), then treehouse on that
tmux squad, then herdr and orca-lite in parallel on their own trial projects.
