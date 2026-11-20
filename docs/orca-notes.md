# Orca notes

Durable facts about the Orca backend that dev-studio depends on, plus the Orca-source
improvement ideas we considered. Read this before debugging a runtime stall or proposing
a change that leans on Orca internals. (Learnings about a *worked project* still live in
that project's `docs/solutions/` — see `conventions/learnings.md`. This file is about
dev-studio's own relationship with Orca.)

## Cross-Run delivery to idle standing roles (smoke 2026-10-28, fix F1)

`send-peer.sh <squad> thinker …` failed for every normal peer Thinker with "no live
dispatch". Root cause (before U64): a standing Thinker or Lead sent `worker_done` after each wake and
idled until the next rewake, so its newest dispatch was `completed` almost all the time —
`worker-list` shows it as `completed` + `terminalState: retained`, and neither field can
tell whether it is alive. Sending to `dispatch:<completed id>` is refused
(`dispatch_inactive`: "its worker will never read that mailbox").

What works: scope the worktree address to the peer Run —

```sh
orca orchestration send --run <peer run_id> --to "@worktree:<peer thinker wt>" --subject … --body … --json
```

Receipt `to_handle: term_7e198ccc…` (the peer's live terminal), `run_id: <peer run>`,
message `msg_bed3f6d823cc`; the idle peer Thinker's rewake hook picked it up (`read: 1`
within a minute). The 2026-10-16 "@worktree never leaves the sender's Run" note below
applies to sends **without** `--run`; with an explicit `--run`, `@worktree:` resolves
inside that Run.

Rules around it (all probed on the host, 2026-10-28):

- **No-terminal target → `terminal_not_found`.** Sending to a worktree id with no terminal
  fails the CLI (exit 1, `ok:false`, "No recipients resolved for group address") — nothing
  is queued or misfiled. `send-run-worker` maps this to exit 3, never delivered.
- **`--run` must match an active sender dispatch (`dispatch_run_mismatch`).** A sender
  terminal with an ACTIVE dispatch may only pass `--run` of its own run; a terminal with
  no active dispatch may target any run. Since U64 a standing Lead/Thinker never calls
  `worker_done` and is started `--keep-open`, so its spawn/restart dispatch stays ACTIVE
  for the life of the session and its own terminal can no longer send `--run <peer>`. The
  loop therefore replays `send-peer` with `DS_ORCA_FROM` set to the asking squad's sender pane
  (a plain terminal with no dispatch; `bin/loop/replay.ts` peerFrom), while
  `ORCA_TERMINAL_HANDLE` stays the asker so the roster still names the right sender. Run
  directly, without the loop, a standing role's `send-peer` gets exit 3 and a note to use
  the Studio route. `send-run-worker` can never be sent without a
  sender at all (`no_active_sender_terminal`), so there is no sender-less fallback.
- **Receipt validation.** `--run` sends return the message under `.result.messages[0]`
  (dispatch sends use `.result.message`; the adapter reads either). `send-run-worker`
  treats the send as delivered only when `to_handle` is a live handle (not `run:*`, not
  empty) and the message's `run_id` equals the target run — anything else is exit 3. A
  successful cross-Run receipt also carries a `legacy_terminal_recipient` warning (terminal
  mailboxes are not durable after the terminal closes); that is expected here.
- **Liveness = terminal presence.** `orca terminal list` still shows an idle standing
  role's terminal (`connected`, `agentIdentity` set), so the phone book's liveness source
  is the new `wt-terminals` op (worktrees with a non-orphaned terminal), not dispatch
  status. Delivery itself is judged by the send receipt, never the phone book.

## Runtime constraints (these bite, and recur if forgotten)

**1. `runtime_busy: long-poll capacity reached` — the real mechanism.** From the Orca
source (`src/main/runtime/runtime-rpc/runtime-rpc-long-poll.ts`): Orca has a **32-slot
connection budget**, and **long-polls are capped at half: `LONG_POLL_CAP = 16`**. A
"long-poll" is any RPC that **blocks on an external event** (`classifyRuntimeLongPoll`):

- `orchestration.workerStart` — holds a slot **90–110 s** while the worker becomes ready
- `orchestration.check --wait` — inbox-wait (what a blocking `watch.sh` / rewake does)
- `terminal.wait`, `agent.launch`+prompt (~60 s), `orchestration.dispatch` inject (~60 s)
- `orchestration.ask` — blocks minutes (its own sub-cap ≈ 8; ask+browser-host ≈ 12)

A plain `orchestration.check` **without** `--wait` is a short RPC and holds **no** slot.

So the ceiling is **≈16 concurrent long-polls** — not terminal tabs per se, but how many
agents are simultaneously blocked in one. ~17 live worktrees each inbox-polling ⇒ 17 > 16
⇒ saturated even at idle. Closing a terminal freed capacity only because it **killed the
agent**, releasing its inbox-wait. The cap is a hardcoded constant — not in `orca status`,
not CLI-configurable.

**Implications for dev-studio:** keep total live inbox-polling agents + in-flight starts
well under 16. Serialize `worker-start`s (never fan out in a burst), retire done Builders
promptly (frees their inbox-wait), cap concurrent Builders across all squads (~8–10), and
don't run many squads at once. The wake redesign (push-on-idle primary + poll-with-gaps
fallback, see `conventions/wake.md`) means agents hold **~0** long-polls at rest, which is
the main lever that keeps us under the cap.

- **Recovery = close terminal tabs**, not release dispatches. `restart-role` closes a
  worktree's tabs (`orca terminal close --worktree <sel> --all`) before starting fresh;
  `close-squad` closes them before `rm`; `reclaim.sh --all` closes host-wide
  `orphaned:true` tabs.
- `orca orchestration reset` does **not** help (it clears runs/tasks/messages; `--all`
  wipes the runs the squad state files depend on). Real recovery is closing tabs, or
  quitting+reopening the Orca app to drop all long-polls.
- `worker-release`/`reclaim` only free **settled** worker terminals (`reclaimable`);
  `retained` ones (user-takeover / no-terminal) are protected and never freed — don't
  count them as leaks.

**2. dev-studio needs Orca "Nested worker depth" ≥ 2 — set it on the Orca that RUNS the
squads, which is usually NOT your local desktop.** This is the single most confusing failure
mode; the source settles it (`src/shared/nested-worker-depth.ts`, `dispatch-depth.ts`,
`orca-runtime-resolve-worktree-selector.ts`, `ipc/settings.ts`):

- **Depth model:** a root coordinator is depth 0; the workers it dispatches are depth 1;
  *their* workers are depth 2. The check is `childDepth = creatorDepth + 1; reject if
  childDepth > max`. The **default max is 1.**
- **dev-studio structurally needs max ≥ 2.** The **Studio** is a root (depth 0), the **Lead**
  it spawns is depth 1, and a **Builder the Lead dispatches is depth 2.** So any Builder
  started by the Lead (the normal ready-units flow) needs max ≥ 2. The error reads
  `Sub-worker dispatch is not permitted at depth 2 (max 1)`.
- **Why "other squads still work" under max 1:** Builders dispatched by the **Studio** at
  spawn are depth 1 (allowed under max 1); only Builders the **Lead** dispatches are depth 2
  (need ≥ 2). So a squad can look fine until its Lead starts fanning out its own units.
- **The max is read LIVE at every worker-start** (`store.getSettings().nestedWorkerMaxDepth`,
  default 1 if missing) — it is NOT baked into the worker. So **re-dispatching or restarting
  the Lead does nothing**; the Lead's very next retry passes the instant the stored value is
  ≥ 2. (What IS stamped at dispatch is each worker's own depth, and the Lead's is correctly 1.)
- **Settings are per Orca instance / per runtime environment** (`activeRuntimeEnvironmentId`,
  `readSettingsWithRuntimeEnvironmentPreference`). The limit is enforced by **whichever Orca
  runtime owns the dispatch**. If your squads run on a **remote host** (its own `orcad`), that
  host's setting applies — raising the depth in your **local desktop** never reaches it. This
  is why the UI can show 5 while the error still says `max 1`.

**Set it to ~5** (margin for any extra nesting) **on the runtime that runs the squads.**
Check where it actually is:

```sh
# the stored value, per profile (macOS desktop):
grep -o '"nestedWorkerMaxDepth":[0-9]*' \
  ~/Library/Application\ Support/orca/profiles/*/orca-data.json 2>/dev/null
# on a Linux host that runs the squads (userData is usually ~/.config/orca):
grep -o '"nestedWorkerMaxDepth":[0-9]*' ~/.config/orca/profiles/*/orca-data.json 2>/dev/null
# can't find it? locate the settings doc:
find ~ -maxdepth 5 -name orca-data.json 2>/dev/null
```

**Never set it by editing `orca-data.json`.** That file is Orca's whole profile store, MIRRORED
to a SQLite copy — a raw edit leaves the two inconsistent, so Orca refuses to start and you have
to recover with `orca profile state exports` + `orca profile state rollback` (learned the hard
way Oct 2026; it cost a crash-loop, a profile rollback, AND then a version-skew mess because the
host was behind — don't do it).

**How to set it — depends on local vs a remote host:**

- **Local (you run Orca desktop on this machine):** just set it in the UI — **Settings → Agent
  Orchestration → Nested worker depth → 5**. Done.
- **Remote host (the squads run on another machine via a paired/managed Orca `serve`):** the UI
  can't do it — this is the limitation. The control is **host-only and hidden from paired clients**
  (`OrchestrationPane.tsx`: `showNestedWorkerDepth = !isPairedWebClientWindow()`), so setting it on
  your Mac writes the *Mac's* store, not the host's. And there's **no `orca` CLI setter**, **no
  `orca serve` flag**, and **no env var** (all confirmed in source). The RPC `settings.update` has a
  `.strict()` schema that rejects `nestedWorkerMaxDepth`, so no client/API call works either.

  The supported way is the **profile-state export→edit→import** path, wrapped in a script so you
  never do it by hand. **On the host:**
  ```sh
  bin/host/set-orca-depth.sh 5 --auto      # systemd host: stops Orca, sets it, restarts — one command
  # or, if it can't auto-detect how Orca runs:
  #   stop Orca, then  bin/host/set-orca-depth.sh 5 , then start Orca
  ```
  Under the hood (and why it's safe): `orca profile state rollback --latest-json` exports the live
  state to JSON **and deletes the SQLite copy**, so the JSON is the sole source of truth; the script
  then edits `settings.nestedWorkerMaxDepth` in the exact file the rollback reports, and startup
  re-imports it into a fresh SQLite. The earlier crash came from editing the JSON **while** SQLite
  still existed (the two diverged and Orca refused to start) — the `--latest-json` step is exactly
  what removes that divergence. The scripts are idempotent (no-op if already ≥ 5) and Orca-specific.

Two more gotchas: (a) the limit is only checked at **worker-start**, so already-running
Builders keep going after the setting drops; (b) the setting can **reset to its default on an
app restart/update**, so re-check it if starts suddenly fail. Failed spawns can leave stray
Builder worktrees — sweep them with `/ds-reclaim <project>` (or `bin/commands/reclaim.sh --all`).

**3. Starting/adopting workers needs a live Orca sender terminal** (`ORCA_TERMINAL_HANDLE`)
— run restarts from the **Studio**, never a plain SSH shell. (`reclaim.sh` is the
exception; it needs no terminal.)

## Orca-source improvements — considered, and what we decided

We audited the Orca source (`github.com/stablyai/orca`) for things dev-studio hand-rolls
that Orca does natively. Decisions (Oct 2026):

1. **Native task dependency graph** — **dropped.** It would require every unit to exist as
   an Orca task up front, so the Thinker would have to materialize all Builders at plan
   time. That fights lazy dispatch (spawn a Builder only when its deps are green, to stay
   under the long-poll cap). Our jq level-derivation on the board stays.
2. **`worker-list` fleet projection / studio-scoped capacity** — **done.** The board's
   capacity signal scopes to this studio: `bin/backend/orca.sh capacity <name-prefix>`
   joins `worktree ps` (displayName startswith `ds-<label>-` → path) against terminals'
   `worktreePath`. No prefix = machine-wide totalCount.
3. **Native decision gates** (`orchestration gate-*`) — **deferred.** Our plan-approval
   gate is bespoke but holds no long-poll and works. Revisit only if it misbehaves.
4. **Worktree metadata** — **deferred.** We encode role/topic in the worktree *name* and
   parse it back; Orca supports attaching key/values. Pure neatness, nothing broken.
5. **Lifecycle automations** (run a command on worker-settled / run-done) — **deferred.**
   Could replace some reclaim-on-close polling with event-driven cleanup. Biggest + most
   speculative; the wake redesign already killed the leak it would guard.

## `@worktree:` never leaves the sender's Run (confirmed on the host, 2026-10-16)

(Without an explicit `--run` — with `--run <peer>`, `@worktree:` resolves inside that Run;
see "Cross-Run delivery to idle standing roles" above.)

`@worktree:<id>` is a group address, resolved only among the sender's own Run (`send --help`:
groups "reach the live Dispatches of your own Run"). From a squad member, `--to
@worktree:<studio-or-other-squad-wt>` reports success but is stored as `to_handle:
run:<sender's own run>` — its own Lead reads it; the target never does. Evidence:
`msg_9d59434a25b2` (Thinker → Studio worktree) stored as `run_id=run_b4cb262fc194,
to_handle=run:run_b4cb262fc194, read=1`. A raw terminal handle kept its target (three notes
to `term_2f8bbb92…`, another squad, `read=1`), but a second send to the Studio's terminal
handle (`msg_5b49b03d0a73`) was rewritten the same way — likely a stale handle. Handles change
on every terminal restart, so don't rely on them. Same-squad messages work
(both sides share the Run). Down-messages from the Studio (`send run:<id>`) work. So
cross-squad escalation goes through `ask-operator.sh` (the board), never a message
(`conventions/escalation.md`). A sender in **no** Run (a cron script) must use `run:<id>` or
`dispatch:<id>` (`send --help`).
`send --json` returns the stored message (`result.messages[].to_handle`), so `send-worker` now
checks it: `run:<id>` whose coordinator terminal is not the target's worktree means rerouted,
and it exits 3 "NOT delivered" (the copy still sits at the sender's Lead).

## Terminal last-output time

`orca terminal list --json` gives each terminal `lastOutputAt` (epoch ms) plus `worktreeId` —
the signal for "working but no output for N minutes" (hung) that `worker-states` lacks.

## What a cron job can reach (U0 probe, historical)

> Historical probe from 2026-10-19: the sweep was removed in U19, and the probe
> script itself was deleted in U184. These results
> document the original host constraints; current runtime coordination belongs to the loop.
> Nothing here names a script to run.

`bin/sweep.sh` ran from cron: no Orca terminal, a bare environment, cwd `/`. The probe re-ran
itself that way (`env -i HOME PATH`, `cd /`) and printed works/fails per call.

**local macOS, 2026-10-19:**

| call | result | detail |
|---|---|---|
| worker-states (worktree ps) | works | 39 worktrees |
| terminal-activity (terminal list `lastOutputAt`) | works | output times per worktree |
| gh pr view 3 | works | state=MERGED |
| inbox-peek (`check --run … --peek`) | **fails** | `consumer_fenced` — only the Run's coordinator may `check` its inbox |
| inbox-unread (`orchestration inbox`) | works | the host-wide listing is not fenced; has `read`, `run_id`, `to_handle`, `created_at` |
| worktree-rm (close-role) | works | reached Orca: a fake id is rejected as `selector_not_found` |
| terminal-close-worktree, worker-release (close-role) | n/a | best-effort in close-role; the adapter swallows their errors |
| notify | osascript available | a candidate for `DS_NOTIFY_CMD` |

**Linux host (dev-host), 2026-10-19:** same result. worker-states works (25 worktrees),
terminal-activity works (24), `gh pr view 17660` works (MERGED), inbox-peek fails, inbox-unread
works, worktree-rm reaches Orca (`selector_not_found` on a fake id). `orca` and `gh` live in
`~/.local/bin`, which is not on cron's default PATH; the crontab line carries it.

So "not responding" (unread mail older than 10 minutes) uses `inbox-unread`, not a peek. It
covers a Lead only: a Lead's mail is addressed `run:<run_id>`; other roles' mail goes to
dispatch/terminal handles the state file does not record. `worker-start` (so `restart-role.sh`)
still needs a sender terminal, so the sweep never restarts anything — it writes a request file.
Cron's PATH is minimal, so `install.sh` writes the install-time PATH into the crontab line.

**Typing into an agent needs no sender terminal** (macOS, 2026-10-19, the deleted probe's `--poke`
on a throwaway agent, cron-like env: `env -i`, cwd `/`): `terminal send --terminal <h> --text …
--enter --wait-submit 10 --json` → `result.send.prompt.stages` includes `turn_started`; `terminal
read --screen --json` → `result.terminal.tail[]`. The agent terminal of a worktree is the
`terminal list` row with `agentIdentity` set, `connected`, not `orphaned`. `worktree create
--agent claude --prompt … --no-parent --json` also works without one (handle at
`result.agentTerminalHandle`). Hence the sweep's poke (`orca.sh poke`) and limit check (`screen-tail`).

## Cross-Run delivery by dispatch id (probed 2026-10-28, cross-squad-comms U1)

- **P1 — own inbox sees dispatch mail.** `send --to dispatch:<own id>` from a worker, then `check --peek --json` (no `--run`) lists it with `to_handle: dispatch:<id>`. So `inbox-peek-self` / `inbox-wait-self` need no fallback; the rewake hook wakes on it.
- **P2 — no body limit found.** 100 B, 2 KB, 8 KB and 32 KB bodies were all accepted and read back whole. `send-run-worker` therefore has no size guard (no exit 4).
- **P3 — `check --all`** exists (`--unread | --peek | --all`; `--all` returns every message and marks nothing read). The result carries `runId`, `dispatchId`, `count`, `acknowledged`, `messages`; a peek carries **no** delivery id.
- **Receipt shape.** `send --json` returns the single message under `.result.message` (not `.result.messages[0]`); `send-run-worker` reads either.

## worker-done self-discovery (probed 2026-10-28, register-plan U7)

- **`check --peek` carries `dispatchId` with zero unread.** `check --terminal <h> --peek --json` on a dispatched worker with no waiting messages still returns `.result.dispatchId` (+ `runId`, `count: 0`) — the dispatch is envelope metadata, not message content. So `worker-done` needs no fallback when the inbox is empty.
- **`worker-show` carries task + sender.** `worker-show --dispatch <id> --json` returns `.result.dispatch.taskId` and `.result.dispatch.assigneeHandle` (the worker's own terminal handle); `worker-done` sends `--from` that handle with both ids + `--outcome succeeded`.
