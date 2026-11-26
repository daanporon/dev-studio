# Squad state convention

Each squad has one **state file** that its Lead owns and writes. It is the only
thing the board needs that Orca does not already model.

## Where it lives

`state/<project>/squads/<topic>.json` — per-project (each `ds up <project>` is
its own instance), one file per live squad. The instance's own state (home repo,
label, Studio worktree id) is `state/<project>/dispatcher.json` (kept as the
filename). The schema is `state/SCHEMA.json`.

`state/.removed/<label>-<YYYY-MM-DD>[-<n>]/` is the archive of a removed project (`ds remove-project`): its
old `state/<label>/` folder, its `loop.db` rows in `loop-rows.db`, and the record `removed.json`, written once
the removal finishes. Project discovery skips dot folders, so nothing there is ticked or listed, and the label
is free again. The loop moves the folder and never deletes it; no role writes there (`docs/USAGE.md`,
"Remove a project").

`squads/` holds only `<topic>.json` squad state files (written by `bin/role/squad-state.sh`) and `.md` plans and brainstorms, and the approved copy of each plan (`<plan>.approved.md`, saved by `approve-plan`; the loop's squad close archives it with its plan); notes, reviews and experiment records go in `state/<project>/notes/` or as `.md` next to their plan, and a JSON file in `squads/` that is not a squad is skipped with a warning.

## Who writes it

Of the roles, only the squad's **Lead** writes it, through `bin/role/squad-state.sh`. The loop
writes it too: each tick it exports every squad that changed in `loop.db` back into this file
(`exportChanged` in `bin/loop/core/tick.ts`, through `bin/loop/db/export-json.ts`), it runs the same
script for a board cancel (`cancel-unit`) and after it removes a leftover worktree
(`drop-leftover`), and it moves the file to `state/<project>/archive/` when it closes the squad. There is no
locking: writes are atomic (temp file + rename), which is enough for crash safety. No other role writes it; roles raise
questions through orchestration (see `conventions/escalation.md`), and the Lead
reflects them into the file.

Per-project role notes live beside it in `state/<project>/notes/<role>.md`, written only by
`bin/role/notes.sh` (`conventions/learnings.md`).

## What it carries, and what it does not

Carries only the gaps Orca leaves:

- `task_id` — the squad's orchestration task (checkpoint gates target it).
- `status` — the semantic status enum (`running` / `blocked` / `waiting-on-you` / `done`). `set-status done` on a feature squad refuses while any unit is dispatched, planned or held (each named with the command that settles it); it needs no debrief (debrief-in-needs-you U2: the Lead writes it only when the loop asks at archive, `set-debrief`); a Tester member or no units does not refuse, and a testing squad refuses only for a dispatched unit. `register-plan` or `add-unit` that leaves a planned or dispatched unit (a held one alone does not count) on a `done` squad sets it back to `running` in the same write (note on stderr, a Lead journal decision); a suspended, failed or closing (`want = 'gone'`) squad keeps its status.
- `waiting_on_you` — pending questions, for the board's blocked-first queue.
- `lfg_assumptions` — assumptions an `lfg` squad logged instead of blocking.
- `units[].title`, `about`, `done`, `check` — the unit's text for the board's unit overlay (click a row
  in Work units, or Details in its ⋯ menu). `register-plan` stores the title from the unit line and, from
  the indented lines under it, `about` (the `What:` text, 1200 characters at most), `done` and `check`
  (the `Done:` and `Check:` lines, 400 each), and updates them on every re-registration; `add-unit
  --about <text>` sets `about` for an ad-hoc unit. A unit without them shows "not stored" and how to add it.
- `units[].links` — http(s) URLs with more on the unit, from the `Link:` lines in its plan block (`register-plan`,
  following the plan like `about`) or `add-unit --link <url>` (repeatable); at most 5, 500 characters each
  (`conventions/plan-shape.md` step e). Absent = none.
- `units[].hold` — a minor follow-up unit (a non-blocking bug the Tester found) stays
  `planned` but `ready-units` excludes it, so the Lead's auto-picker never dispatches it.
  A hold with no `hold_reason` is a parked follow-up or a plan `HELD` line. A plan `HELD`
  hold (`hold_by: "plan"`) is released by dropping HELD from the unit's line and
  re-registering after approval (`approve-handoff.sh`); a parked follow-up (`hold_by:
  "parked"`, or no marker) is promoted at triage with `set-unit-status … dispatched` /
  `add-role … builder`. `set-unit-hold … off` refuses both.
  A squad whose only other open units are unheld planned units waiting (through `deps`, directly
  or through other such units) on a held unit is still parked (`parked · N held`, N = held units):
  they can never be dispatched while the dep is held (`squad-finish.ts`).
- `units[].hold_reason` — an operator freeze on existing planned work, set with
  `squad-state.sh <file> set-unit-hold <slug> on --why "<text>"`. It sets `hold: true`;
  `ready-units` and ready pokes skip the unit, and the board reads `held · <text>`.
  A Builder queued for the unit and not started yet (status `wanted`, no worktree, no start out)
  is withdrawn in the same write, whoever filed it, and `cancel-unit` does the same; the loop also
  withdraws a queued loop-filed Builder whose unit stops being ready or whose plan loses its approval,
  and checks once more right before a spawn (`bin/loop/squad/queued-builder.ts`, event
  `builder_wish_withdrawn`). A started Builder is never touched. Releasing the hold wishes a fresh one.
  `on` requires a non-empty reason and refuses dispatched, done and cancelled units.
  Repeating the same reason changes nothing; a different reason refuses. Release it with
  `squad-state.sh <file> set-unit-hold <slug> off`, which clears the hold and removes
  `hold_reason`. Releasing an unheld unit changes nothing. `register-plan` preserves a
  reasoned hold on re-runs, except `revalidate after resume`: the hold a suspended feature
  squad's resume puts on its approved plan's not-started units. `approve-plan` of that plan
  marks them `revalidated: true` and the next `register-plan` releases them; `set-unit-hold …
  off` releases one directly (`roles/thinker.md`, "After a resume"). Each command targets one unit; a Lead loops over its own units
  to hold or release a freeze.
- `approved_plans` / `revoked_plans` — the plans the operator approved (`approve-plan <plan>`,
  canonical paths; the loop dispatches a unit only once its plan is in the list), and the
  approvals taken back: `revoke-plan <plan> --why "<text>" [--keep-started]` removes the plan from
  `approved_plans`, moves `<plan>.approved.md` to `<plan>.revoked-<YYYYMMDD-HHMMSS>.md`, appends
  `{plan, why, at, by}` to `revoked_plans` and logs one `plan_revoked` event. In the same write a
  queued Builder of each not-done unit of the plan is dropped; a started one gets a dependency
  pause with a `plan` prerequisite (resolved once the plan is approved again) unless
  `--keep-started`. One line per unit and one message to the Lead. A plan not approved is a no-op;
  approving it again keeps `revoked_plans`.
- `units[].urgent` / `units[].urgent_why` — a unit the operator needs first, set with
  `squad-state.sh <file> set-unit-urgent <slug> on|off [--why "<text>"]` on a planned or
  dispatched unit (refused on done or cancelled). Its Builder ranks ahead of every non-urgent
  candidate and starts on the next tick even at `max_builders`; unmarking it changes nothing
  for a Builder that is already running.
- The project's **focus squad** (squad-priority U1) is not a state field: it is the limits key
  `focus_squad` (default `-`, none), set with `ds focus <project> [<squad> | --clear]` or the
  board's Settings ("Agents & nudges"). While seats are full, its queued Builders take the next
  free seat after urgent units and units that block started work, ahead of older units of other
  squads, and never over `max_builders`. In each lane it gets at most that lane's seats − 1 (normal:
  `max_builders`, light: `max_light_builders`), so the last seat still goes oldest first and a lane
  of one seat ignores it. Only a live feature squad can be the focus; a suspended one keeps the key
  without effect, a closed, done or gone one has it cleared by the loop. Each change logs one
  `focus_set` event (`from`, `to`, `by`).
- **Unlocks first** (picker-prefers-unblocking-units U1) is not a state field either: the limits key
  `unblock_first` (default `on`). After urgent, blocks-started, focus and resumed work, a queued unit
  with more open dependents (the `planned` or `dispatched` units that wait on it through `deps` and
  `ext_deps`, each once, not held or superseded, in a live squad) takes the next free seat before an
  older one. Inside the focus squad's room it always counts; outside it only while the lane has
  unlock room (its seats − 1 − its live seats whose unit has open dependents), so the last seat of
  each lane still goes oldest first. `off` gives the oldest-first order back.

- `units[].wait_on` — a started unit that waits on another unit: `squad-state.sh <file> wait-on
  <slug> <dep-slug> [--ext-dep <squad>/<slug>] --why "<text>"` adds the dep to `deps` (or
  `ext_deps`) and records dep -> why here; refused for a done/cancelled/unknown unit, a dep on
  itself or a cycle; running it again changes nothing. A plan line ending `— blocks: U109[, U105]`
  runs it for each named unit at `register-plan` (all-or-nothing; a re-run keeps those deps).
  The loop's `dependency-waits` reconciler gives a `dispatched` unit with an unmet dep a
  dependency pause on its Builder (`by wait-on`), unless that Builder has a pause already; the
  pause follows the unit's deps and clears when they merge (or at `wait-off <file> <slug>
  <dep-slug>`). A planned unit's dep places no pause. The resumed Builder is told what it waited on.

- `members[].account` / `members[].fallback` — the account the member runs on (missing = its
  agent's default login) and whether it is on a fallback model (`add-member --account <id>
  --fallback`; stored because the picker decided it).
- `units[].wait_until` — epoch seconds; `ready-units` skips the unit until it passes
  (`set-unit-wait`). The loop no longer sets it: a Builder start with no account free stays
  pending in the loop (`bin/loop/fulfil/pending.ts`, which clears any old value), and starting
  the Builder clears it.
- `units[].ext_deps` — `["<squad>/<unit>"]` refs to another squad's units this unit waits
  on (same label). `ready-units` holds the unit until each is `done` in the sibling squad
  state or its `archive/<squad>-*.json`; a missing squad or unit blocks fail-closed until
  the Lead drops it (`drop-ext-dep`). The board resolves each to
  `done|dispatched|planned|closed-done|missing`. An ext dep on a sibling squad's
  `cancelled` unit resolves to `cancelled` and blocks fail-closed — the Lead drops it with
  `drop-ext-dep`.
- `units[].status: cancelled` — the unit's work folded elsewhere or was dropped
  (`cancel-unit`: a Lead always goes through `close-role.sh --cancel` and never calls
  `cancel-unit` directly; the board's cancel has the loop run it). The loop never restarts, retires, or questions it; `ready-units`
  never lists it. `set-unit-status` refuses `done`/`dispatched` on it — back to `planned`
  to revive it, which clears the cancel fields.
- `units[].superseded_by` — what a cancelled unit folded into: a unit slug or `PR#<n>`;
  absent means the work was dropped. A dep on a cancelled unit counts as satisfied when it
  folded into the dependent itself, into a unit that is `done` (cancelled→cancelled chains
  followed, 10 hops), or into a PR that merged (`into_merged`, set by the loop). A
  cancelled dep with no `superseded_by` never counts — the dependent stays blocked until
  the Lead drops the dep or replans.
- `leftovers[]` — worktrees kept because removing them would lose work (`add-leftover` /
  `drop-leftover` / `leftovers`; upsert by `wt`). Each records path, branch, reason,
  `waits_on`, the unit, and the probe counts (`n_files`, `unpushed`, first 20 `files`).
  Nothing here is ever force-deleted by automation: the loop removes one only when clean
  and pushed/merged, `rekey-member` follows its `wt`, and `add-member` clears the record
  when a revived unit's Builder reuses the worktree.

Does **not** carry activity, lineage, agent status, comments, or linked issues —
the loop's observers read those from Orca into `loop.db`, and the board
(`bin/board/board.sh`) reads `loop.db` alone. Do not duplicate Orca metadata here.

## Cross-squad log

`state/<project>/cross-squad.md` is the one shared record of peer messages (per label,
not per squad): `send-peer.sh` appends one line per send
(`- <ISO> <from squad>/<role> → <to squad>/<role> [<subject>] <msg_id>`; a `--ruling`
carries the body). Each Lead's tick shows the last 24 h naming its squad (`CROSS-SQUAD:`);
rulings are also copied into both Leads' journals. Plain pings live only here — a journal
is the role's own record.

## The one hard rule

**Every Lead writes this file regardless of the squad's autonomy** — including an
`lfg` (fire-and-forget) squad. Otherwise the squads the operator most needs
visibility into go dark, which is the firstmate trust gap this system exists to
avoid.

## Helper

`bin/role/squad-state.sh <file> <command>` exposes `get`, `set-task`, `set-status`,
`enqueue-question`, `resolve-question`, and `log-assumption`. Run
`tests/squad-state.sh` to verify it round-trips every field.

It is a Bun program (`bin/loop/squad/squad-state.ts`). Once the state root carries
`state/.loop-migrated`, a squad file under `state/<project>/squads/` is served from
`loop.db`: each write is a fact (its rows and an events row), then the JSON is exported, and
reads come from SQLite. The JSON is then only an export: a hand edit of it is overwritten by the
next write (change state through `squad-state.sh`), and a squad whose file was removed (closed)
starts again from the default. Pass the answer when resolving — `resolve-question <id> --answer
"<answer>" [--via terminal|picker|board|reality]` (default via terminal) — and the store keeps
it: `answered-questions <file> [--limit N] [--before <seq>]` lists them, newest first. A
question that leaves `waiting_on_you` any other way (cancel-unit) is kept as
answered via `reality`.

## Pause overlay

On loop hosts, pause lives in SQLite, separately from squad/member status and unit/PR facts.
`pause_intents` stores independent manual and dependency sources at project, squad or member
scope; `pause_scopes` versions fence queued activity. `pause_members` keeps each role slot's
generation, delivery/session/dispatch identity, journal checkpoint and hash, acknowledgment,
terminal closure progress and Pausing/Paused/Resuming reason across member row rekeys.
The squad export includes `.pause` and each `.members[].pause`, with remaining tracked
prerequisites and explicit unit hold or blocking ruling reasons.

`ds pause <project|squad|member> <label> [topic] [role] [suffix]` records intent.
`ds resume` with the same identity atomically clears that scope and its descendants as
appropriate, preserves checkpoints and leaves lifecycle/completion facts alone. It performs
no backend call, picker run or imperative restart request, even while the loop is down.
The loop derives one fresh member wish per eligible retained role; existing start slots and
the normal tier/phase/account picker govern placement. Missing retained worktrees require
repair, never an implicit replacement. A late checkpoint from a cancelled generation has
no closure authority. Pause acknowledgment is not worker_done or unit/task completion.

For dependency waits, append `--prerequisites` with a JSON array of tracked unit or PR
references (a `plan` reference, `{kind: "plan", project, squad, plan}`, is placed only by
`revoke-plan` and resolves when the plan is in its squad's `approved_plans` again). All references and human gates must satisfy the wait before only that dependency
source clears; manual pauses remain. Explicit Resume clears applicable wait intents without
altering prerequisites, unit holds or operator rulings.

## Cancellation

Another non-cancelled unit sharing the Builder worktree or PR keeps that resource.
This also protects work folded into a unit slug and later reuse of a cancelled
unit's worktree. Reviving a cancelled unit clears its pending cancellation wish.
Cleanup failures keep retrying and raise one board alert per stuck step; the alert
clears when observations show that step no longer needs doing.

`cancel-unit <slug> [--into <unit-slug|U-number|PR#N>] [--why <reason>]`
writes `status = cancelled` and keeps the Builder member with `want = gone` until
cleanup is observed. `--check` validates without writing. `close-role.sh … --cancel`
writes the same wish; any role can ask and only the loop carries it out.

On its next tick the loop closes all Builder terminals, busy or idle, then removes
the worktree including dirty and ignored files. Local branches and commits survive.
It independently closes the unit's open PR unmerged, keeping its remote branch,
unless `--into` names that same PR. Each step retries after failure or a loop restart;
a Builder or PR that reappears is closed again. Old cancellations with no member row
are cleaned up using `units.builder_wt`. Plain `close-role.sh` keeps its leftover
behaviour, and pause retains its checkpoint and file preservation rules.
