# dev-studio

A personal work-orchestration system. It runs on Orca today — the only backend
implemented — behind a swappable backend interface (`conventions/backend.md`). You
run many topics of work in parallel on your host while staying in control: a
protected place to think, a glanceable board of every topic's true state, and
questions that reach you instead of getting buried.

It is **instruction-sets + conventions + a thin state schema over native `orca
orchestration` commands** — not new infrastructure. It is not fire-and-forget: you
are present by design and can see and step into any topic.

## The two pieces

- **Studio** (`studio/studio.md`) — your one standing cockpit: thinking home + the
  overview board. Where you live: brainstorm, plan, spawn/close/restart squads, and
  answer the rare cross-squad escalation. There is no Dispatcher — you drive from here.
  It has its own `studio` row in `conventions/roles.conf` (model, effort, fallbacks) and its own
  `*_studio` limits (`auto_compact_studio`, `context_compact_studio`, `compact_mode_studio`, `studio_move`); `spawn-squad` never starts it.
- **Squad** — one topic (feature or testing, `conventions/squad-types.md`): a Lead
  worktree (`roles/lead.md`) coordinating its own Run, with role children
  (`roles/{thinker,builder,reviewer,tester,researcher}.md`), each on a model from
  `conventions/roles.conf`. The Lead is the squad's hub: you operate a squad by talking
  to its Lead, and think with its Thinker; you never touch its Builders.

## Staying current (every agent)

Your instructions are plain files on a fixed path (`~/.dev-studio/AGENTS.md`,
`~/.dev-studio/roles/<role>.md`, `~/.dev-studio/conventions/*.md`), and the host
updates them with `git -C ~/.dev-studio pull` / `reset --hard`. **Scripts** you call
(`bin/*/*.sh`, the backend adapter) always run their latest on-disk version — nothing
to refresh. The **loop** restarts itself on new loop code: between ticks it compares its commit with
the checkout's HEAD and exits 75 for systemd to start the new code (`bin/loop/core/code-watch.ts`).
**Never pull, reset or check out the host checkout yourself** — only `/ds-update` (or the operator's `ds update <project>`) moves it. To read
the newest code, run `git -C ~/.dev-studio fetch -q` and `git -C ~/.dev-studio show origin/main:<path>`.
**Instructions** only change for you when you **re-read the file**, so:

- Read your role file + this `AGENTS.md` when your session starts. After that, re-read them
  only when your `watch.sh` tick says **`INSTRUCTIONS: changed`** — it fingerprints the
  instruction files and tells you when they differ from what this worktree last read
  (`AGENTS.md` plus your own role file; a change to `conventions/*.md` alone does not trigger it).
  `unchanged` means skip the re-read (you already have the text; re-reading every tick
  only piles duplicate copies into your context).
- When you receive a **`reload`** message in your Run inbox, re-read them immediately
  and, if you are the Lead, tell your running children to do the same (the reload
  cascades Studio → Leads → their teams).
- `/ds-reload` triggers this on demand: in your terminal it refreshes just you (a
  Lead also relays to its team); in the **Studio** it pushes a reload to every squad
  (`bin/commands/notify-squads.sh`) and then re-reads the Studio's own `AGENTS.md` and `studio/studio.md`.
- **The Studio is reloaded by an update too** (elsewhere-no-other-work U1): when `update-squads` writes
  reload or restart wishes, it also writes a reload wish (never a restart) on the project's `_studio`
  member if the loop recorded one; `reconcilers/studio.ts` (`reloadStudio`) types one line naming
  `AGENTS.md` and `studio/studio.md` and ending with `ds reload ack <project> _studio studio -` into the
  adopted handle through `wake()` once `studioReady()` holds. Only an ack from that handle counts
  (`acknowledgeReload`), and a Studio session adopted after the wish satisfies it without one.
  Skills too (board-actions-as-wishes U3): a Claude Studio gets `/reload-skills` typed once (`reloadStudioSkills`, same
  `wake()` and `studioReady()`, episode `reload-skills:<request id>`) after an `update` request ends done with `skills`
  among its classes; a Studio adopted after it finished, or another agent, gets nothing.

### Your journal (Lead, Thinker, Studio, Builder)

Your memory across restarts is a journal file, not your conversation:
`~/.dev-studio/bin/role/journal.sh <project> <topic> <role[-suffix]> …` (the Studio uses
`studio` as topic; a Builder uses `builder-<unit-slug>`, so the journal belongs to the
unit and a fresh Builder on it inherits it).

- **At session start** (and after a restart) read it: `… briefing` — every `keep` plus
  the latest 30 decisions.
- **`add decision "<what>" "<why>"`** for each non-trivial call: an answer you gave, an
  approach you picked, a unit re-tiered, a Builder restarted, an operator decision received.
- **`add keep "<what>" "<why>"`** for what must never be missed: operator instructions and
  constraints, an approach that failed ("tried X — fails because Y"), an answer you got.

One line each; skip the trivial. A role that died sent no last report — only its journal
knows what it tried. Before a planned restart (a restart wish, a fallback or pin move, memory over
`restart_rss_gb`) the loop asks the idle role for a journal checkpoint first, through
`bin/role/pause-checkpoint.sh` with a `stop-…` generation (`bin/loop/pause/stop-checkpoint.ts`; after 5
minutes it restarts anyway and journals `checkpoint failed`); the briefing ends with the newest one.

There is no "refresh skill" to install — refreshing is re-reading a path. The
operator triggers a project-wide reload from the **Studio** (their cockpit).

### Your project notes (every role)

Earlier roles on this project leave tips for the next one, per role, in
`state/<label>/notes/<role>.md`. Your start spec carries the absolute command that prints
yours (`~/.dev-studio/bin/role/notes.sh <project> <role> print`): run it before you start work. If
you lose time on project know-how that is not in the repo's docs, add a note before you finish
(`… add "<note>" "<why>"`); at the project's cap (`notes_cap`, default 20), drop or merge a stale note yourself
(`… drop "<fragment>"`) before adding. Notes are tips, not orders: the operator, the plan, your role file
and the repo's docs win (`conventions/learnings.md`, "Notes").

## Messages and being blocked (every role)

Messages do **not** interrupt a terminal — they sit in your inbox until you look. So two rules keep nothing buried:

- **How standing agents wake** (`conventions/wake.md`). The **Lead**, **Thinker(s)**,
  and **Studio** *receive routed/async work*, so each is armed at spawn with a **rewake
  Stop hook** that wakes it the moment a message lands in its inbox. They do not run a
  forever foreground loop and do not rely on a clock: on each wake, do one tick (pull via
  `watch.sh … 4000`, handle, ack) and stop; the hook wakes you on the next message.
  **Builders, Testers, and Researchers** mostly *send*: use a blocking `ask` when you need
  an answer (it waits for you), and check your inbox before going idle.
- **During long work, poll your own inbox — don't go dark.** The rewake hook wakes an
  **idle** worker, but a worker busy in a long step (a pipeline, a long build/test) is not
  idle and won't be interrupted. So run the long step **in the background** and loop on
  `watch.sh --worktree 60000` (your own inbox — **no `<project> <topic>`, just the ms**) each
  cycle, acting on a Lead message
  (abort / base-update / redirect / nudge) **before** continuing — a redirect supersedes the work
  in flight. Never hand-roll a heartbeat-only loop that skips the inbox, and never call
  `orca` directly; the helpers ack correctly so nothing replays.
- **Every message is a loop.db row** where the loop owns the root (U45, U276): `send-role.sh`,
  `send-peer.sh` and `orch.sh send|send-worker|reply|ask` write `ds msg` rows, and the loop writes a
  worker's Run mail to its Lead as one (kind `run`); nothing a role sends waits only in an Orca inbox.
  `watch.sh` (`--worktree` or the Lead's `<project> <topic>`) reads and waits on your rows, prints
  `ACK-ID: msg:<ids>` and acks that batch on the next `--ack`; the loop pokes you once per batch
  ("N new messages for you"). `~/.dev-studio/bin/ds msg inbox` lists them too, `ds msg ack <id>` acks
  one, and `ds msg reply <id> "<answer>"` answers one: the reply row links to the message it answers,
  and when that message is a worker's parked `ask` the loop also answers the ask in Orca. A blocking
  `orch.sh ask` returns when the reply row lands.
- **A line typed into your terminal as `dev-studio board, the operator says: <text>` is the
  operator**, sent from the board once you sat idle at your prompt. Treat it as an operator
  instruction and answer it in your terminal (a Builder, Tester or Researcher: your Lead sees a
  copy on its next tick).
- **If you're blocked, raise it to the Lead** (your Run coordinator) with `ask`/`send` to
  the squad Run. The Lead mirrors it into the state's `waiting_on_you` queue and decides:
  answer it, ask the Thinker, or **ping the operator**. A worker blocked but silent to the
  Lead is a **buried question** — the exact failure this system exists to prevent.
  A blocker goes to the Lead — never park it in ds-feedback.
- **Snagged by dev-studio itself? Jot it, don't fix it** — when the *orchestrator* got in
  your way (an awkward escalation, a role instruction that misfires, an idea to improve it),
  not the project code and not blocking you now, note it with `bin/role/ds-feedback.sh "<what>"` (it records
  your project, squad and role itself). ds-feedback reaches no one until the operator's next dev-studio
  session. Never use it for something that blocks you or needs the operator: tell your Lead,
  and a Lead raises it with `bin/role/ask-operator.sh … --unit <slug>`. **Never edit dev-studio to fix
  a dev-studio snag:** the host's copy is a `reset --hard` mirror of its branch, so any change
  is wiped on the next sync. A failure in the project's own CI or tools is the project's problem,
  not dev-studio's. The note lands as a row in the host's loop.db (`ds feedback list`) the operator
  reviews in a dev session and promotes into the repo. Project-code learnings still go the usual way (`ce-compound`
  into the project's `docs/solutions/`) — this is only for the orchestrator.

## Stopping processes (every role)

Every squad's agents share the host: never `pkill`/`killall`/`kill $(pgrep …)` — stop
only processes you started, by a PID you recorded or with `ds stop-mine <pattern>`
(signals only matches under your own worktree). A guard hook in each role worktree that
`reassert-roles.sh` has armed blocks the broad forms; see `roles/builder.md` and `conventions/wake.md`.

**Large files:** read a large file in parts (Read with `offset`/`limit`, or `ctx_execute` with
`file`): context-mode turns whole-file reads of big files into snippets. Check that a file
exists with `test -f <path>` on its own, because context-mode can cut a combined output down to snippets.

## How it works

- **State** (`conventions/state.md`, `state/SCHEMA.json`) — each Lead writes its squad's
  state to `state/<project>/squads/<topic>.json` via `bin/role/squad-state.sh`, always, so
  the board is ground truth. `squads/` holds only `<topic>.json` squad state files (written by `bin/role/squad-state.sh`) and `.md` plans and brainstorms, and the approved copy of each plan (`<plan>.approved.md`); notes, reviews and experiment records go in `state/<project>/notes/` or as `.md` next to their plan, and a JSON file in `squads/` that is not a squad is skipped with a warning. Lavish review pages and their files go in `state/<project>/pages/<topic>/` (the Studio: `pages/_studio/`), opened with `lavish-axi <path>`; the worktree's `.lavish/`, `.scratch/`, `<project>/docs/plans/` and the scratchpad are lost on close or suspend. Each `ds up <project>` is a per-project instance
  (`ds-<project>-studio`, state under `state/<project>/`).
- **Escalation** (`conventions/escalation.md`) — a squad question flows role → Lead, and
  the Lead decides: answer it, ask the Thinker, or **ping the operator** (a card note on
  its worktree). Nothing gets buried.
- **Autonomy** (`conventions/autonomy.md`) — squads run to checkpoints by default
  (`orchestration` gates on the squad task); `lfg` is fire-and-forget (decide, log the
  assumption, continue).
- **Shipping** (`conventions/ship-modes.md`, `conventions/projects.conf`) — each project
  ships via `ce-pipeline` (default), `no-mistakes`, `direct-PR`, or `local-only`.
- **Sequencing** (`conventions/sequencing.md`) — intra-squad order comes from the
  Thinker's plan (the Lead holds a dependent unit until its prerequisites finish).
- **Backend** (`conventions/backend.md`) — all `orca` access is behind `bin/backend/orca.sh`;
  set `BACKEND=bin/backend/<name>.sh` to swap it.
- **Learnings** (`conventions/learnings.md`) — squads compound learnings into each worked
  project's `docs/solutions/` via the existing `ce-compound` skill; no store of our own.

## Scripts

Entry points a role calls by hand. Every script, reconciler and table in detail: `docs/scripts.md`.
A unit documents its scripts, tables and events in `docs/scripts.md`. AGENTS.md takes at most one index line for a new entry point a role calls.

- `bin/role/squad-state.sh` — read/write a squad's state file (units, plans, status, debrief); the board reads it.
- `bin/commands/spawn-squad.sh` — ask the loop for a squad (`--framing-file`, `--backend`); a wish writer.
- `bin/lib/watch.sh` — a Lead/Thinker's tick: wait for messages, report them with a team check-in; `--worktree <ms>` is your own inbox.
- `bin/role/orch.sh` — the roles' entry point to the backend (`send`, `reply`, `ask`, gates); roles never call `orca`.
- `bin/role/send-role.sh` — message a squad member by squad and role; `bin/role/send-peer.sh` — the cross-squad path.
- `bin/ds msg send|inbox|ack|reply|show` — role-to-role messages as loop.db rows.
- `bin/role/ask-operator.sh` — a Lead pings the operator with a card (`--unit <slug>`).
- `bin/role/journal.sh <project> <topic> <role> briefing|add decision|add keep` — your memory across restarts.
- `bin/role/notes.sh <project> <role> print|add|drop` — per-project, per-role tips for the next role.
- `bin/role/ds-feedback.sh "<what>"` — jot a dev-studio snag for the operator; never edit dev-studio.
- `bin/ds finish <unit|-> --outcome … --body …` — the finish record a worker writes when its work ends.
- `bin/ds update <project>` — the operator's or Studio's update, never a squad role's: the loop pulls, reinstalls, restarts itself and refreshes the project's squads, no Studio turn.
- `bin/ds expose <name> <url> [--stop "<cmd>"] [--squad] [--self]` — publish a URL you host so the board lists it.
- `bin/lib/directory.sh list|reach <squad> <role>` — the phone book: who a member is and how to reach it.
- `bin/board/board.sh` — the board (text, `--json`, `--serve`).
- `bin/ds` — the loop's CLI over `state/loop.db` (`want`, `nudge`, `account`, `config`, `focus`, `override`, `lanes`, `shadow`, …); `bin/ds help` lists it.

## Commands

Slash-commands in `.claude/commands/` wrap the scripts (all `ds-` prefixed):
`/ds-update`, `/ds-board`, `/ds-start-squad`, `/ds-q`, `/ds-roles`,
`/ds-limits`, `/ds-accounts`, `/ds-mode`, `/ds-reload`, `/ds-restart`, `/ds-suspend`,
`/ds-resume`, `/ds-pause`, `/ds-reclaim`, `/ds-team`, `/ds-approve-fix`, `/ds-close-squad`
(see `docs/USAGE.md`).

## Verify

- `shellcheck bin/*/*.sh bin/backend/*.sh bin/ds tests/*.sh tests/lib/*.sh` passes locally, and so do the tests for what the change touches (below).
- A PR's title follows conventional commits, `<type>(<scope>)!: <summary>` (types `feat fix docs refactor perf test build ci chore revert`; the scope and `!` are optional; summary starts lowercase; at most 72 characters), because squash merging makes it the only message that reaches `main`; branch commits are free. Check one with `tests/pr-title.sh "<title>"` (`.github/CONTRIBUTING.md`; `githooks/gh-text-check` and `.github/workflows/pr-title.yml` run it too). `tests/pr-title.sh` with no argument runs its own cases, and `tests/ci.sh` runs it.
- `tests/ci.sh` runs that shellcheck line and every `tests/*.sh`; `.github/workflows/tests.yml` runs it on every PR into `main` when it is opened, pushed to or reopened, and on every push to `main` (so a red main shows right after the merge; a push run is never cancelled by a newer one), never on a PR edit: an edit run on the same head adds a newer `tests` run whose job is skipped, and GitHub then holds the PR BLOCKED with green checks (a retarget without a push gets no run: push, or close and reopen). The ruleset requires `tests` and `pr-title`. `CI_JOBS=N` runs N test scripts (and N shellcheck slices) at once, lines still in name order; the default is 1 because the host is already loaded, and `CI_JOBS=4` matches the runner the workflow used (`tests/ci-jobs.sh`). A test that cannot run next to the others is made hermetic or named, with the reason, in `serial_reason` in `tests/ci.sh`.
- `tests/leak-guard.sh` (run by `tests/ci.sh`) keeps private words, addresses, hosts and databases off the repo; it names file and line and the kind of hit, never the value. The tracked hooks `githooks/pre-commit` and `githooks/pre-push` and the `PreToolUse` hook `githooks/gh-text-check` run it on every commit, push and GitHub text a session posts. **A refused commit, push or post is fixed, never retried with `--no-verify` or a `core.hooksPath` override; a false positive is fixed by changing the made-up value, not by widening the guard's allow lists.** Modes, word list, hooks and the gh check in detail: `docs/scripts.md`, "Verify detail"; `.github/CONTRIBUTING.md`, "Leak hooks".
- Tests never touch the live state (U253): a test that writes `state/<project>/…` sources `tests/lib/state-root.sh` (a temp `DS_STATE_ROOT`), and `tests/ci.sh` fails when the suite added a project to the live `state/`. Detail: `docs/scripts.md`, "Verify detail".
- A Builder runs targeted tests before it opens its PR, not the full suite (the repo is public, so GitHub minutes are not a limit): the shellcheck line plus every `tests/*.sh` whose script, or whose code under test, the change touches, and `tests/loop.sh` for a change under `bin/loop/`; on its branch merged with `origin/main`. A failure is fixed before the PR. The PR body's Tests section names those commands and gives each one's summary line. GitHub's `tests` check is the full suite and the gate: the Builder watches it after each push (the loop pokes on a failed check) and fixes a red run. Exceptions that still run `CI_JOBS=4 tests/ci.sh` locally first, with its final summary line (`ci: <seconds>s, 0 failed`) in the PR body: a change to `tests/ci.sh`, `tests/lib/` or `.github/workflows/`, or one touching more than about 30 files.
- Thin-slice end-to-end (run on the Orca host): see the plan's Verification Contract —
  bring up a project (`bin/ds up <url>`), spawn a squad, see it on the board, ask and answer a blocking
  question, confirm an `lfg` squad logs an assumption and stays on the board.
