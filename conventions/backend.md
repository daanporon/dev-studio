# Backend interface

All backend access goes through a defined interface so the system is not
hardwired to Orca (R19, KTD9). Orca is the only backend the loop runs on now; another is
a sibling adapter under `bin/backend/` (herdr, contract v2, below).

There are two contracts:

- **Contract v2** (below, `bin/backend/contract.ts`): the one a new backend implements (tmux,
  herdr, orca-lite). A backend runs terminals and nothing else; the loop keeps everything else.
- **The Orca adapter, contract v1** (from "Selecting the backend" on): the verbs
  `bin/backend/orca.sh` answers today. The loop still runs on it; nothing in the Orca path
  changes until a later unit moves the loop onto v2.

## Contract v2

### Requests and answers

Every op is one JSON request and one JSON answer, so a backend can sit in the loop's process, behind
a unix socket, or on another host over ssh. On the wire a request is the envelope `{op, req}`.
Every answer has `ok`: `{ok: true, …fields}` on success, or `{ok: false, error: {code, message}}`.

| Error code | Meaning |
|---|---|
| `not_found` | No terminal with that `id` (never made, closed, or the process behind it ended). |
| `unsupported` | The request needs a capability this backend says it lacks (keys with `keys: none`). |
| `bad_request` | The request is outside its op's type. `handle()` answers it before the backend sees it. |
| `failed` | Anything else: the server is down, a command failed. The message says what. |

`bin/backend/contract.ts` defines each request and answer once (`bin/loop/core/schema.ts` shapes),
which gives both the TypeScript types (`Request<op>`, `Answer<op>`, the `Backend` interface) and the
run-time checks (`checkRequest`, `checkAnswer`, each naming the wrong field). `handle(backend,
envelope)` is the wire entry: an unknown op or a bad request answers `bad_request`, a backend that
throws answers `failed`. `checked(backend)` wraps a backend so a request or answer outside its type
throws a `ContractError`; the conformance suite runs every backend through it.

### Ops

| Op | Request | Answer |
|---|---|---|
| `backend.info` | `{}` | `{name, version, capabilities}` |
| `terminal.create` | `{cwd, env?, label, group?, parent?}` | `{terminal}` |
| `terminal.list` | `{}` | `{terminals: [terminal]}` |
| `terminal.close` | `{id}` | `{closed: boolean}` |
| `terminal.send` | `{id, text?, keys?, submit?}` | `{delivery: "turn_started" \| "accepted"}` |
| `terminal.read` | `{id, screen?, lines?}` | `{text}` |
| `terminal.last_output` | `{id}` | `{at: epoch seconds \| null}` |
| `agent.state` | `{id}` | `{state: "working" \| "waiting" \| "idle" \| "unknown"}` |

A **terminal** is `{id, cwd, label, group, parent, gen, created_at}`:

- `id` is the backend's own handle. It is opaque to the loop.
- `gen` is the `DS_GEN` in the create's `env`, or null without one. The loop puts a fresh generation
  in every start and matches a retried start on it, so a backend needs no idempotency of its own.
- `group` echoes the request's `group` when `parents` is `groups`, else it is null. `parent` echoes the
  request's `parent` when `parents` is `native`, else it is null.
- `created_at` is in epoch seconds.

The rules per op:

- `terminal.create` starts a shell in `cwd` with `env` added to its environment (names
  `[A-Za-z_][A-Za-z0-9_]*`, string values). The loop types the agent's launch line into it afterwards;
  the backend never knows which agent runs.
- `terminal.close` is idempotent: a terminal already gone answers `{closed: false}`, not an error, so a
  replayed close is safe.
- `terminal.send` carries exactly one of `text` and `keys`. `submit` (text only) presses Enter after the
  text. `keys` are named keys (`Enter Escape Tab Backspace Up Down Left Right C-c C-d`) or one digit or
  lowercase letter (a menu pick), and there is at least one. The answer is `turn_started` only when the
  backend saw the agent start a turn; otherwise it is `accepted`.
- `terminal.read` with `screen` gives the visible screen. Without it, it gives the scrollback too, at most
  `lines` lines.
- `terminal.last_output` is the last time the terminal printed anything. It is null when it never did,
  or when the backend cannot tell.

### Capabilities

`backend.info` names what the backend can do. The loop reads the answer and does the rest itself.

| Capability | `native` | other values |
|---|---|---|
| `parents` | The backend nests a terminal's worktree under its `parent` (Orca). | `groups`: the backend places the terminal in its `group` (a tmux session, a herdr workspace). `none`: neither; the tree is in loop.db only. |
| `state` | `agent.state` reads the agent's state. | `none`: it always answers `unknown`, and the loop works out the state from the screen and the transcript. |
| `turn_confirm` | A submitted send answers `turn_started` once a turn started. | `none`: a send only ever answers `accepted`, and the loop confirms the turn itself. |
| `keys` | `terminal.send {keys}` types named keys. | `none`: it answers `unsupported`. |

### What stays in the loop

The contract is small because the loop keeps the rest:

- **Launch drivers.** The agent's command line, its flags and model, the account it runs on, and
  reading a menu or a limit notice off the screen.
- **Accounts and the picker.** Account folders, usage and credentials are read on the loop's side
  (`docs/backends/local-reads.md`).
- **Agent state** when `state` is `none`, and the turn check when `turn_confirm` is `none`.
- **The parents tree** when `parents` is not `native`, and **start idempotency**, through `gen`.
- **Worktrees.** The loop makes and removes the worktree; the backend gets a `cwd`.

### Backend servers live outside the loop

A backend with a server of its own (a tmux server, herdr) must never run as the loop's child. Every
loop restart (an update, the watchdog) would take every agent on it down. `bin/backend/server-unit.ts`
starts one the way `bin/loop/fulfil/board.ts` starts the board:

- `startServer({name, argv, log, cwd?, env?})` runs it in its own transient user unit
  (`systemd-run --user --collect --unit ds-<name>`). `systemctl --user restart ds-loop` then stops the
  loop's cgroup and not this one.
- Without systemd (no `systemd-run`, no user bus, the unit name already taken, or
  `DS_SERVER_SYSTEMD=0`) it starts the server detached, in its own session.
- The handle is `{pid, via: "systemd" | "detached", unit, log}`. The server's output appends to `log`.
  In a unit, its pid is kept in `<log>.pid` and its exit code in `<log>.exit` (`exitCodeOf`).
- `serverAlive(pid)` and `stopServer(handle)` check and stop it.
- The unit does not inherit the caller's environment: `env` is the server's whole environment. The
  default is the caller's, without `ORCA_*`.

### Conformance

`tests/loop/backend-conformance.ts` is the suite every v2 backend must pass. An adapter's test registers
it on its own backend: `conformance({name, make, cwd, wait?, survive?})`.

- Every call goes through `checked()`, so an answer outside its type fails the case.
- Each case holds the backend to the capabilities it states. It covers create and list (with the `gen`,
  `group` and `parent` echoes), an idempotent close, `not_found` on a gone id, typed text on the screen,
  `last_output`, env and cwd (`echo $NAME`, `pwd`), screen reads, keys or `unsupported`, `agent.state`,
  and `bad_request` from the wire entry.
- `survive` (a backend with a server): a caller starts the server through `server-unit.ts`, creates a
  terminal and is SIGKILLed. The server and its terminal must still be there afterwards.

`tests/loop/backend-contract.test.ts` runs the suite against the in-memory fake
(`bin/loop/fakes/contract.ts`, switchable capabilities) in all 24 capability mixes, over a unix socket,
and as a server that outlives its caller. It also shows the checks catch an answer outside its type.
`tests/loop/server-unit.test.ts` covers `server-unit.ts` on both paths.

### The tmux backend

`bin/backend/tmux.ts` (U14) is the first v2 backend on a real multiplexer. Capabilities: `parents`
`groups`, `state` `none` (`agent.state` is always `unknown`; the loop's own readers give the state),
`turn_confirm` `none`, `keys` `native`.

- One tmux server per project: `projectTmux(<project>, {stateRoot})` uses the socket `-L ds-<project>`
  and starts its server through `server-unit.ts` (unit `ds-tmux-<project>`, log
  `<state root>/<project>/loop/tmux-server.log`) on the first create. The server runs
  `tmux -f /dev/null -D`, so no user config is read, with `exit-empty` off. Its environment is the
  caller's without `ORCA_*`, `TMUX*`, `DS_MEMBER`, `DS_WT`, `DS_GEN` and `DS_BACKEND`.
- Every client call passes `-N`, so a call never starts a server inside the loop's cgroup.
- One session per squad (the terminal's `group`; `.`, `:` and other characters become `_`; no group
  means session `_ds`) and one window per member, made with `-c <cwd>` and `-e` for each env entry.
- A terminal's id is its pane id (`%7`). The window option `@ds_meta` keeps cwd, label, group, gen and
  the create time. It is set in the same tmux command list as the window, so a listed terminal always
  has its gen.
- Text is loaded into a paste buffer from stdin and pasted, so tmux never parses it. `submit` then
  presses Enter. Keys go through `send-keys`.
- `read` is `capture-pane`. `last_output` is the window's `window_activity`, because tmux 3.4 has no
  `pane_activity` and each window holds one pane.
- No server, or a server with no session left, lists no terminals and answers `not_found` for an id.

`tests/loop/backend-tmux.test.ts` runs the conformance suite, including `survive`, on a private socket
(`tmux.ts caller` is its caller). When no `tmux` binary is on `PATH` it skips with the reason printed.

### The orca-lite backend (`bin/backend/orca-lite.ts`)

Orca's terminals with no Run, task, dispatch or coordinator (orca-backend-alternatives U13), in worktrees
the `orca` worktree provider makes (`bin/loop/io/providers/orca.ts`, its only provider). Every Orca call is
an adapter verb of the Operations table below, through the loop's Orca runner (`bin/loop/io/orca.ts`), so
the tick's shared reads, the in-process verbs and the fake Orca all apply. The actuator makes one per
project on its own runner (`core/actuator.ts` `contracted`); the registry still refuses a spawn on it.

- **create.** `wt-show path:<cwd>` gives the worktree's Orca id; a folder Orca has no worktree at is
  `failed`. A `parent` other than the cwd is set with `wt-set-parent` when `wt-show` reads another
  parent. Then `terminal-create <id> <label> <command>`: Orca types the command into the new shell, and
  the command is `export K='v' …` of the request's env, so a launch line typed later runs with it. An env
  value holding a control character is `bad_request`.
- **Facts kept by the backend.** Orca keeps no env and no facts of ours on a tab, and Claude rewrites a
  tab's title, so cwd, label, parent, gen and created_at are kept in one JSON file per project
  (`<state root>/<project>/loop/orca-lite-terminals.json`, written whole through a rename). The terminal id
  is the handle Orca gave at create. A restarted Orca hands out new handles for the same tabs: the entry
  keeps the tab's pane key (`tabId:leafId`) and follows it to the new handle. `terminal.list` lists only
  the tabs of the file that `terminal-panes` still shows, and drops the others' entries; every other op on
  such an id is `not_found` (a closed handle still reads `ok` in Orca, so liveness is the list).
- **send** is `terminal-type`: text as is, keys as their bytes (Enter `\r`, Escape `\x1b`, Backspace
  `\x7f`, arrows `\x1b[A`…, `C-c` `\x03`, `C-d` `\x04`), and with `submit` Enter through
  `--enter --wait-submit 10`. **read** is `terminal-read` (`--screen` for `screen`), **last_output** the
  tab's `lastOutputAt`, **close** `terminal-close`.
- **Capabilities.** `parents: native` (`wt-set-parent`, read back with `wt-show`), `state: native`
  (`pane-state`: `worktree ps` reports the agent of a plain tab in an Orca-made worktree, `working` →
  working, `waiting`/`blocked` → waiting, `done`/`idle` → idle, else unknown), `turn_confirm: native`
  (`turn_started` when Orca's send receipt has that stage; a plain shell answers `accepted`), `keys: native`.
- `tests/loop/backend-orca-lite.test.ts` runs the conformance suite on the fake Orca (`bin/loop/fakes/orca.ts`,
  whose `terminal-create` tabs are small shells) and the cases it does not reach: parents, an unknown
  folder, a restarted Orca's handles, the agent state and a confirmed turn.

### Adding a v2 backend

1. Implement `Backend` (`call(op, req)`) under `bin/backend/<name>.ts`.
2. Start its server, if it has one, through `server-unit.ts`.
3. State its capabilities in `backend.info`.
4. Pass the conformance suite in a test of its own.
5. Anything it needs from the agents' host beyond these ops is a local read: list it in
   `docs/backends/local-reads.md`.

### The herdr backend (`bin/backend/herdr.ts`)

The first v2 backend (orca-backend-alternatives U15). [herdr](https://github.com/herdrdev/herdr) is a
terminal multiplexer for agents: a server owns workspaces, tabs and panes, and sees which agent runs in a
pane and whether it is working. The adapter speaks herdr's socket API (newline-delimited JSON). The loop
runs a squad on it through `projectHerdr` (U16c, below), on a trial project only.

- **Pinned.** `HERDR_VERSION` 0.9.5, protocol 22. A server that answers another protocol fails every op.
  `fetchHerdr(dir)` downloads that release's Linux binary and checks its sha256. `DS_HERDR_BIN` names a
  local binary instead, and `DS_HERDR_FETCH=0` downloads nothing. `bun bin/backend/herdr.ts install`
  downloads it into `herdrPinnedDir()`, `$XDG_DATA_HOME` (else `~/.local/share`)`/dev-studio/herdr/<version>/herdr`,
  and touches nothing else (no PATH entry, no `herdr integration install`). The loop's binary is
  `herdrBin()` (`bin/backend/herdr-bin.ts`): `DS_HERDR_BIN`, else that install, else `herdr` on PATH.
- **Its server.** `startHerdr({bin, dir, name})` writes `<dir>/config.toml`, starts `herdr server` through
  `server-unit.ts` and waits for an answer on `<dir>/herdr.sock`. The server runs in its own session
  (`HERDR_SESSION=ds-<name>`, `HERDR_SOCKET_PATH`, `HERDR_CONFIG_PATH`), apart from any herdr the
  operator runs. The config sets `resume_agents_on_restore = false` (the loop restarts its members
  itself), turns off herdr's update and agent-manifest checks, and turns off sound. `herdr integration
  install` is never run.
- **Layout B.** There is one workspace per group (a squad) and one tab per terminal (a member), each
  started with its own cwd and env. The group's first terminal makes the workspace and takes its first
  tab. A later one adds a tab. Closing the last tab closes the workspace. A terminal made without a
  group goes to one shared workspace.
- **Facts live in herdr.** Any client reads the same answers, so a new loop process, or a client after
  its caller is killed, sees the same terminals. The terminal id is the adapter's own (`h-<random>`),
  kept as the pane token `ds_id`, because herdr's pane ids (`w1:p2`) are positions that are not stable
  over a server's life. cwd, label, group, gen and created_at are base64url JSON cut into 80-character
  tokens (`ds_n`, `ds_m0`…). Facts too long for 13 pieces answer `bad_request`. A group's workspace
  carries `ds_g`. Only panes with a `ds_id` are listed. Tokens are not restored after a herdr server
  restart, so the restored panes are not listed.
- **Capabilities.** `parents: groups`, `state: native` (herdr's `agent_status`: `working` → working,
  `blocked` → waiting, `idle` and `done` → idle, else unknown), `keys: native`, `turn_confirm: none`. A
  send answers once herdr has taken the bytes. herdr's turn signal, `agent prompt --wait`, only works
  for an agent herdr already recognises.
- **`last_output`** hashes the visible screen and keeps the hash and the time it changed in pane tokens
  (`ds_oh`, `ds_oa`). The time is when a read first saw the change.
- **The loop's backend for a project (U16c).** `projectHerdr(project, {stateRoot})` is what
  `squad/contracts.ts` (the actuator and the contract observer) and `bin/lib/contract-roles.ts` (the role
  scripts) make: its server is the unit `ds-herdr-<project>` (session `ds-herdr-<project>`), its files in
  `<state root>/<project>/loop/herdr/` (or a short folder under the runtime dir when that socket path
  would pass 100 bytes). Only a `terminal.create` starts the server; with none answering a list is empty,
  a close closes nothing and any other op on a terminal is `not_found`, so the observer reads the members
  gone and the loop starts them again. A server a previous loop process started is used as it is, and
  its protocol is checked again after it was gone. A create with no binary fails naming the install command.
- `bun bin/backend/herdr.ts states <state root> <project>` prints what herdr says each of a project's terminals
  is doing (read only, no server started), the trial's sampler.
- `bun bin/backend/herdr.ts caller <bin> <dir> <name> [home]` is the conformance suite's survive caller.
- `tests/loop/backend-herdr.test.ts` runs the conformance suite (the server outliving its caller
  included) and layout B against the pinned binary in a temp HOME. When the binary can't be fetched,
  it skips those cases and prints why. The mappings and the protocol pin always run, and so do
  `projectHerdr`'s no-server cases; with the binary it also starts a project's server on a create, finds
  it from a second client and starts it again after it was stopped. How well herdr reads agent state
  without its hooks is the trial's to record (`docs/backends/trial-herdr.md`, not run yet).

## A backend per squad

Each squad runs on one terminal backend for life (orca-backend-alternatives U9). `bin/backend/registry.ts`
lists them: `orca` (Orca with Runs, today's path), `orca-lite` (Orca terminals, no Runs), `tmux` and
`herdr`, each with the worktree tools it can use (`orca` for the Orca ones; `git` or `treehouse` for the
others, the first being its default). `orca` is the one a spawn picks by default. `herdr` (U16c) can be
picked on a trial project; the others with no adapter yet are listed so a project can name them, and a
spawn on one is refused with a line that says it is not built yet. The loop itself can run a squad on any
contract backend (U11, "Started" below).

- **On trial (U16).** A backend marked `trial` (orca-lite, tmux, herdr) starts squads only in a project
  whose `default_backend` names it: `--backend herdr` in any other project is refused (`is on trial: only
  a project whose default_backend is herdr starts squads on it`), so a trial stays on its trial project.
  An entry's `find` looks for its binary where PATH would not (herdr: `herdrBin()`), and `install` is
  named when it is missing.

- **Chosen at spawn.** `spawn-squad --backend <name>` (the board's Start squad dialog sends its Backend
  pick) wins; else the project's limits key `default_backend` (default `orca`). The worktree tool is the
  project's `worktree_provider` (`auto`, the default, is the backend's own default). `chooseSquadBackend`
  refuses, naming why, an unknown backend, a tool the backend cannot use, a backend not built yet, a
  backend on trial outside its trial project and a binary missing on PATH; a refused spawn writes no wish and never falls back to `orca`.
- **Written once.** The squad's row keeps `backend`, `backend_host` (`local`; the machine it runs on) and
  `worktree_provider` (migration 0054; every existing squad reads `orca`/`local`/`orca`). Once the loop
  has started the squad the columns cannot change (a table trigger), and `spawn-squad` refuses a different
  `--backend` for it; a later change of `default_backend` touches only new squads. A closed squad started
  again under its topic may pick again.
- **Not `squads.host`.** That column is spawn-squad's dev-env host (`--host`), unchanged; the backend's
  machine is `backend_host`.
- **Shown.** The board's squad row and box carry a chip with the backend (and the tool, when it is not the
  backend's default) for a squad off `orca`; the text board adds ` · on:<backend>[/<tool>]` to its line.
  Settings → Agents & nudges lists both keys.
- **Started (U11).** A squad on another backend is run through the contract (`bin/backend/contract.ts`),
  not Orca: `fulfil/squad.ts` makes no Run, task, dispatch, coordinator pane or sender for it, and wishes
  its roles; the actuator's contract seat (`core/actuator.ts` `contractSeat`) starts, pokes, stops and
  closes them with the contract driver (`drivers/contract.ts`). The actuator reaches `tmux` through
  `bin/backend/tmux.ts`, `orca-lite` through `bin/backend/orca-lite.ts` (U13) and `herdr` through
  `projectHerdr` in `bin/backend/herdr.ts` (U16c). The registry marks tmux and orca-lite not built (their
  `adapter` is null), so a spawn on one is still refused; herdr is on trial. A test reaches this path through `LoopActuator`'s `backends` option and the
  contract fake.
  - **Start.** The member's worktree comes from the squad's recorded `worktree_provider` through
    `io/worktrees.ts`, its parent the Lead's (the Lead's own is none while the Studio is on Orca); its `wt`
    is `local::<path>`. The folder is marked trusted in the account's `.claude.json` first
    (`drivers/claude-launch.ts` `markTrusted`), then one `terminal.create` (cwd, label `<role>[-suffix]`,
    `group` = the squad on `parents: groups`, `parent` = the Lead's path on `parents: native`) with env
    `DS_GEN` (the call's retry id), `DS_BACKEND`, `DS_MEMBER` and `DS_WT`, and the Claude launch line
    (`claudeLine`, the one Orca's adapter types, here as `exec env …` so claude replaces the shell and the
    terminal ends with it: a poke never types into a bare shell) sent once with `submit`. Only Claude has a launch
    line: `spawn-squad` refuses a non-Orca squad whose roster names Codex or Muse (primary or fallback).
  - **Ledger.** Starts and closes are `orca_calls` rows with the contract verb as `op` (`terminal.create`,
    `terminal.close`), in `LOCK_OPS`, `stopOpen()` and `startInFlight()`. A start lists the terminals
    first: one carrying this row's `DS_GEN` is this start's own (its answer was lost; no second create),
    and any other in the folder is an old agent's, closed before the new one is made (a crashed member's
    restart). The line's send is noted (`typed`) before it goes, so a replay never types it twice. A
    second start under the same key while one runs is answered busy. Pokes are not ledgered:
    `terminal.send` with `submit`, `turn_started` read as started, `accepted` as accepted.
  - **Finish.** `finish-unit` and `ds finish` know the squad's backend (`DS_BACKEND`, else its loop.db
    row): off Orca there is no Run, so the finish row is the whole finish and no `worker_done` is sent.
  - **Removal (U11c).** Every removal path closes the member's terminals with `terminal.close` (by the
    folder path, through the contract seat, one `orca_calls` row per step key so a replay closes nothing
    twice) and removes its worktree through the squad's recorded provider (`io/worktrees.ts`
    `removeWorktree`, by path), all in `squad/removal.ts`: a close (`fulfil/close.ts`), a cancel
    (`fulfil/cancel.ts`: the stop closes, the remove closes again and is forced as `worktree-rm force` is on Orca), a
    leftover pass (`fulfil/worktree.ts`) and a host tidy of a class `d` tree (`fulfil/cleanup-act.ts`,
    found by its live `worktrees` row; no `worktree ps` read, and the tree is probed again before the
    removal). The provider keeps the branch (an unmerged one always); a dirty or unpushed tree is kept as
    a leftover as on Orca. Before the provider runs, the removal checks the fence Orca's `worktree-rm`
    checks (`pause.ts` `gateBlock` on the action's `childActivity` gate; blocked answers 75, a wait), and
    a `terminal.close` that fails keeps the tree, since no backend drops a terminal with its folder. A cancel reads the tree from the `worktrees` row when Orca has none. Squads on
    `orca` keep `terminal-close-worktree` and `worktree-rm` by id. `tests/loop/contract-removal.test.ts`.
  - **Observed (U12).** `observers/contract.ts` reads these members, not the Orca observer (whose known
    worktrees and gone sweeps skip every worktree and folder of a squad off Orca): per member the newest
    terminal `terminal.list` shows in its folder (its own `DS_GEN` first), `terminal.last_output`,
    `terminal.read` and, on `state: native`, `agent.state`, plus the host's process walk. Its state is
    idle when the walk finds no agent process, else the native answer; on `state: none`, working while
    the transcript or output moved within `chat_quiet_s` (or `esc to interrupt` shows), idle at an empty
    prompt with the agent alive, else unknown. A terminal no longer listed marks the worker gone; a
    failed list marks nothing. The decider reads the walk alone (`walkReality`), and the finish row
    (`ds finish`, of the member's generation) stands in for Orca's dispatch: it ends a one-shot role,
    retires a Tester, lets a done Builder retire and carries the Lead's failed / no-PR report.
  - **Pause, Lead health, guards (U12b).** A pause snapshots the member from its member row and the
    observer's rows (session = its terminal id, dispatch `-`, no dispatch refusal), types the checkpoint
    with `terminal.send` and closes with `terminal.close` through the seat; the ack takes `-` for the
    dispatch. Liveness reads a Lead's unread mail as its unread `messages` rows (`rowsUnread`), so a
    Lead idle with mail unread is poked and then carded or restarted as "not responding" exactly as on
    Orca (the board's `leadVerdict` too). The observer also lists every other terminal in a member's
    folder (`observed_terminals`, `doc.extra`): one with no `DS_GEN` is a plain shell, a `stray` once
    quiet for `STRAY_QUIET`, closed only while `agent.state` says idle and carded otherwise (on
    `state: none` the card says the backend cannot tell); one with another generation is a second agent,
    a `duplicate`, closed once it is not busy. Both fulfillers read `terminal.list` again before a close
    (`squad/contract-terminal.ts`). The board's failed-report reader matches the generation's episode.
    `tests/loop/contract-guards.test.ts`.
  - **Role scripts (U11b).** See "Role scripts off Orca" below.
  - **Not yet.** `nesting.ts` skips such a squad (only Orca moves a worktree under a parent).

### Role scripts off Orca

The scripts a role runs (ask-operator, the watch tick, the phone book, the team listing, squad-state)
reach the squad's own backend, not Orca (U11b). `backendPath()` (`bin/lib/shared.ts`) picks the adapter:
`$BACKEND` when set, else `bin/backend/contract.sh` when this process belongs to a squad off Orca
(`contractHere` in `bin/lib/contract-here.ts`, which shared.ts imports alone: `DS_BACKEND`, which every contract terminal carries, else
the `squads.backend` of `DS_MEMBER`'s squad in loop.db, read-only), else `orca.sh`. Reads about the host
(accounts, skills, the Orca nesting depth) use `hostBackendPath()`, which never picks the contract.

`contract.sh` (`ds contract-backend`) answers the adapter verbs those scripts call, from the contract:

- `current`: `local::` + `DS_WT`, else the git top level.
- `ping`: exits 0 and writes nothing. A squad off Orca has no card note; the `waiting_on_you` question is
  the board card, so answering it clears nothing (squad-state's resolve and the loop's answer fulfiller
  skip a `local::` card).
- `worker-states` and `wt-terminals`: Orca's line shapes over `terminal.list`, `agent.state` and
  `terminal.last_output` of each project's contract squads (`contractStates`, `contractLive`). The newest
  terminal of a worktree speaks for it. A backend with no adapter or a list that fails goes to stderr, and
  the verb exits 1 only when no project could be read.
- `worker-detail` prints nothing and `terminal-reap` prints `0`.
- Any other verb exits 2 with `contract adapter: no '<verb>' off Orca`.

The phone book and the team listing read each `local::` member from the contract in process and every
other member from Orca, so a project with squads on both makes no Orca read for its contract members.
A Lead off Orca has no Run. Its address is its worktree (`send-worker`), its watch tick reads only its
loop.db rows (header `no Run: the squad runs on <backend>`), and ask-operator takes a state file with no
`run_id` when the squad's row names a contract backend. `tests/loop/role-scripts-contract.test.ts`
covers it, with a real tmux server when one is on PATH.

## The Orca adapter (contract v1)

### Selecting the backend

`$BACKEND` points at the adapter script, defaulting to `bin/backend/orca.sh`.
Callers invoke `"$BACKEND" <op> [args]` and never call `orca` directly.
The loop is the one exception to the spawn: when `$BACKEND` is unset or is this checkout's
`orca.sh`, it calls the verbs of `bin/backend/orca.ts` in process, with the environment orca.sh
would have had and the same `{code, stdout, stderr}` (U227). Any other `$BACKEND` (a sibling
adapter, a test's fake script) is still a program the loop spawns.

## Worker identity

A start or resume of a Claude worker the loop makes passes `DS_START_MEMBER`
(`<project>/<squad>/<role[-suffix]>`) and `DS_START_GEN` (the generation: the start call's retry id,
also on the member's row as `members.gen`) to the adapter, and the adapter puts `DS_MEMBER`, `DS_WT`
and `DS_GEN` on the terminal's launch line (`identity()` in `bin/backend/orca.ts`). Only that pair
sets them: the adapter never passes its caller's own `DS_MEMBER` on, and the loop's children never
inherit one (`childEnv`). A start the backend makes itself (Orca's `--agent` launch for Codex and
Muse, a `--on` host) carries only the Orca handle. Code that asks who it runs as calls `whoAmI()`
(`bin/loop/core/whoami.ts`): `DS_MEMBER` first, then `ORCA_TERMINAL_HANDLE`. A sibling adapter sets
the same three variables on every Claude terminal it starts.

The Orca adapter chooses its CLI once per process: `DS_ORCA_CLI_BIN_DIR`, then
`ORCA_CLI_BIN_DIR`, then an executable `orca` in `<Orca data path>/cli/bin`, then
PATH. An explicit directory must contain an executable `orca`; a missing one
fails with the directory named and never falls through. The loop copies the
Orca CLI variable to `DS_ORCA_CLI_BIN_DIR` before stripping `ORCA_*` from children,
and install preserves an explicit CLI directory across reinstalls in its systemd
unit and cron command. Tests that
fake `orca` must pin their fake directory with `DS_ORCA_CLI_BIN_DIR`.
The local `claude-config-dir` and `agent-accounts` lookups, plus `pr-close`,
still work while the CLI is unavailable; operations that use Orca fail before a
best-effort read can hide a missing pin.

Inbox checks retain `--full` and fail with Orca's error code and message on
stderr when the CLI exits non-zero, returns invalid JSON, reports `ok:false`,
or omits its result. A successful `timedOut:true` response remains an empty
inbox. On a failed foreground read, `watch.sh` still prints pending REQUESTS
and, for a Lead, its team and work sections, then `INBOX READ FAILED`; it exits
non-zero with no empty-inbox line or ACK-ID. A failed `--poll` prints only a
REQUESTS block when a request is pending; otherwise stdout stays empty. The
failure goes to stderr, so the rewake hook wakes only for a real request.
When worker states are unavailable on a failed Lead read, the team and unit
sections show unknown state rather than advising re-dispatch.

### Operations

Script-callable (implemented by the adapter, used by the loop's observers and fulfillers and by `bin/host/up.sh`; `spawn-squad.sh` only writes a wish and `bin/board/board.sh` reads loop.db):

| Op | Args | Returns |
|---|---|---|
| `run-create` | `<objective>` | run id (`run_…`) |
| `task-create` | `<run_id> <spec> <title> [parent_task_id]` | task id (`task_…`) |
| `lead-start` | `<run> <task> <repo> <agent> <model> <name> [parent_wt] [host] [effort] [account] [window]` | the Lead's worktree id (nested under `parent_wt`, else top-level) |
| `role-start` | `<run> <repo> <lead_wt> <spec> <agent> <model> <name> [host] [effort] [account] [window] [role]` | — (worktree under the Lead + a supervised worker in it) |
| `worktree-ensure` | `<repo> <name> <agent> <prompt> [parent_wt]` | worktree id (created + agent launched if absent; idempotent). An empty `<agent>` creates the worktree only (`/ds-up`, U262) |
| `studio-start` | `<wt> <account> <model> <effort> <window> <prompt>` | handle of a new Studio tab: claude on `<account>` (`-` = the default login) with the auto-compact window and the Studio's skill list in one `--settings`, the prompt last (U262). No Orca worker, no fresh-start guard: the worktree's other terminals are never touched; a tab whose claude never comes up is closed, exit 1 |
| `repo-ensure` | `<path>` | — (registers the home repo, idempotent) |
| `status` | — | `reachable` when the runtime answers and reports reachable (exit 1 otherwise; install.sh's preflight) |
| `project-list` | — | registered projects (raw backend JSON; `/ds-start-squad` reads it) |
| `account-list` | — | `<agent>\t<account_id>\t<label>` per account; **the first line per agent is that agent's default login** (a one-account backend: one line per agent, id `default`) |
| `claude-config-dir` | `<account_id>` | the `CLAUDE_CONFIG_DIR` a Claude role on that account runs with (its plugin registry lives under it); **empty** = run with `CLAUDE_CONFIG_DIR` unset (Orca's `system`); exit 1 when the account's config dir is missing. `install-skills.sh --check` / `install.sh --check` probe each account's compound-engineering install under it. A one-login backend prints nothing |
| `preflight` | — | install.sh's one read (U246): exit 1 with nothing on stdout when the runtime is unreachable, else the `account-list` rows, each Claude row with a fourth column, its `claude-config-dir` (empty = unset or no home); `wrap-hooks.sh` reads the same rows. A backend without it fails install, so implement it alongside `status` |
| `agent-accounts` | — | Per live agent process on this host, whoever started it (a hand restart, `/ds-restart`, an Orca restart). A top-level agent (no agent above it) prints a main line, `<cwd>\tmain\t<agent>\t<model>\t<account_id>\t<effort>\t<pid>\t<start>\t<rss_kb>` (muse/codex: `default`; the model and effort are its `--model`/`--effort` flags, the start is epoch seconds from the process table, each `-` when unread; U149, a backend may still print the older `<cwd>\t<agent>\t<account_id>`); the loop's Orca observer maps the cwd to a worktree (`observed_workers` presence, agent, account, pid, start, RSS and live model) and the record reconciler makes the member's record follow it (U55, U149). An agent under another agent (a review-unit `claude -p` under a muse Builder) prints a sub line, `<cwd>\tsub\t<agent>\t<model>\t<account_id>[\t<effort>]` (`-` when its `--model` flag can't be read; the effort is its `--effort` flag, left off when it has none, U105); the observer keeps those in `observed_workers.sub_agents` and a sub line never overwrites the main account (U90). So does a headless `claude -p` anywhere (U98: review-unit.sh runs detached, or under a claude Builder's own claude); a claude without `-p` under another claude stays skipped; a backend that can't tell prints nothing |
| `account-usage` | — | `<agent>\t<account_id>\t<session_pct>\t<session_reset>\t<weekly_pct>\t<weekly_reset>` (resets as epoch s, `-` = unknown; a backend with no usage data prints nothing) |
| `account-resets` | — | `<agent>\t<account_id>\t<json>` per `account-list` account: its free limit resets in one generic shape, `{"state":"reported"\|"not_reported"\|"unknown", "count", "grants":[{"id","label","left","total","use_by","refills","usable_now"}], "reason"?, "at"?}` (`use_by` epoch s or null; `refills` from `session`, `weekly`, `weekly_model`, or the provider's own word; `count` = resets left over all grants). `not_reported` = the provider has no such thing; `unknown` = not read or not readable, never 0 |
| `account-reset-use` | `<agent> <account_id> <grant_id> <key>` | `<outcome>\t<detail>`: uses that one free reset grant (account-free-resets U4). `outcome` is `used`, `nothing_to_reset`, `no_grant`, `already_used` or `failed` (detail = the provider's words); exit 0 once the provider answered, or when the call is refused before it (an agent with no free resets, a bad id, no login). No answer at all (network, timeout) is exit 1 with no outcome: the claim is in doubt and the caller retries with the **same** `key`, which the provider uses to make the retry the same claim. After `used`, `already_used` or `no_grant` the account's cached usage and resets are dropped. Only the loop's `account-reset` fulfiller calls it |
| `limited` | — | `<worktree_id>\t<reset_epoch or ->\t<notice text>` per worker showing a usage limit that has been idle/done for the silent threshold (`DS_SWEEP_SILENT_MIN`, default 10 — so a transient 429 on a working agent doesn't count); nothing if none or unsupported |
| `gate-list` | `<run_id>` | integer count of pending checkpoint gates |
| `current` | — | this terminal's own worktree id (close-squad's self-close guard) |
| `wt-make` | `<repo> <name> <branch> <base> [parent_path]` | the new worktree as one JSON line (`id`, `path`, `branch`, `head`, `parentWorktreeId`): `orca worktree create` with no agent and no Run, `--setup skip`, nested under `<parent_path>` or `--no-parent`; Orca picks the folder and suffixes `-2` on an existing branch or taken name, so the caller checks it (the `orca` worktree provider, `bin/loop/io/providers/orca.ts`) |
| `wt-show` | `<selector>` | the worktree as one JSON line, as `wt-make` prints it; exit 3 when Orca has no such worktree (`path:<path>` also finds one Orca no longer lists) |
| `wt-list` | `<repo>` | one JSON line per worktree Orca lists for the repo, the main checkout left out; exit 1 when the list cannot be read whole |
| `worktree-rm` | `<selector> [force]` | — (remove a worktree + stop its worker; keeps unmerged branches unless `force`) |
| `attention` | — | displayNames of worktrees whose agent is **waiting for input** (the board's live backstop; the backend owns what "waiting" means, so the board stays backend-agnostic) |
| `activity` | — | `<worktree-id>\t<active\|waiting>` per non-idle worktree (lets the board show live truth — e.g. flag a stale `done` squad whose workers are still active) |
| `inbox-wait` | `<run_id> <timeout_ms>` | blocks until a message lands on the Run or the timeout; prints the batch (empty on timeout) — the agent-agnostic "watch" primitive (`bin/lib/watch.sh`) |
| `worker-states` | — | `<worktree-id>\t<working\|waiting\|done\|idle>\t<displayName>` per worktree (lets `bin/lib/watch.sh` give a Lead/Thinker a team check-in without touching `orca`) |
| `worker-start`, `lead-worker-start` | as `role-start`: `… [host] [effort] [account] [window] [role]` (`lead-worker-start` takes no role: always the Lead) | — (start/restart a supervised worker in an existing worktree; U97: first closes the worktree's other live agent terminals — `ds-loop` panes and plain shells kept — and starts only once they are gone; an agent mid-turn refuses with exit 3 and `agent_busy`, a failed close with exit 1, so no second session is ever made) |
| `run-workers` | `<run_id>` | `<worktree_id>\t<live yes\|no>\t<dispatch id or ->\t<terminal handle or ->\t<task id or ->\t<status or ->` per worker of the Run (live = a `dispatched` dispatch; handle, task and status are that dispatch's, else the newest one's). The loop's members reconciler (U71) compares the handle with the worktree's live agent terminal; exit 1 when the worker list can't be read |
| `agent-handles` | — | `<worktree_id>\t<handle>\t<title>` per live AGENT terminal (agent identity, connected, writable, not orphaned), host-wide, newest output first within a worktree (U71: the terminal a member is rebound to; exit 1 when the terminal list can't be read or parsed) |
| `terminal-shells` | — | `<worktree_id>\t<handle>\t<idle\|busy\|unknown>\t<last output, epoch s\|->\t<title>` per live PLAIN terminal in a worktree (no agent identity, connected, not orphaned), host-wide; idle = its shell is the foreground process group of its tty (from `$DS_PROC`, default /proc, by `ORCA_TERMINAL_HANDLE`), unknown = no readable session leader (U79: members.ts closes idle strays; exit 1 when the list can't be read or parsed) |
| `terminal-close` | `<handle>` | `terminal-close: closed <handle>` (close one terminal; exit 1 when Orca refuses) |
| `terminal-create` | `<worktree_id> <title> [command]` | `<handle>\t<tabId:leafId>` of a new plain shell tab in that worktree (the pane key empty when Orca does not list it yet); `[command]` is typed into the new shell (orca-lite's env line) |
| `terminal-panes` | — | `<handle>\t<worktreeId>\t<tabId:leafId>\t<last output, epoch s\|->` per terminal Orca lists that is not orphaned, agent or shell (orca-lite's list); exit 1 when the list can't be read |
| `terminal-type` | `<handle> <text> [enter]` | `turn_started` when Orca's receipt saw the agent start a turn (it waits up to 10 s), else `accepted`; `<text>` is written as is (control bytes pass), any terminal, Enter after it with `enter`; exit 1 = not sent |
| `terminal-read` | `<handle> [screen\|stream] [limit]` | the terminal's output lines: the rendered screen with `screen`, else the accumulated output, at most `[limit]` lines; exit 3 when Orca has no such terminal |
| `pane-state` | `<worktree_id> <tabId:leafId>` | the state `worktree ps` gives the agent in that pane (`working`, `done`, …), or nothing when it lists none there (only an Orca-made worktree is listed, `docs/backends/orca-probe.md` Q5) |
| `task-spec` | `<run_id> <task_id>` | that task's spec (exit 1 when the task isn't in the Run) |
| `dispatch` | `<task_id> <handle> <run_id>` | the dispatch id: hand an existing task to a live terminal with `--inject`, from the coordinator (`DS_ORCA_FROM`); exit 1 when refused (U71's rebind; never the squad's umbrella task, which Orca refuses `task_not_startable`) |
| `dispatch-abandon` | `<dispatch_id>` | — (fence one dispatch: a rebound member's old one, or a Run worker that is no longer a member; exit 1 when refused) |
| `run-dispatches` | `<run_id>` | `<worktree_id>\t<dispatch id>\t<status>` for each worktree's newest dispatch in the Run (the loop's liveness sees a standing role's dispatch settle, U64; a backend without dispatches prints nothing) |
| `wt-terminals` | — | `<worktree_id>` per worktree with a live terminal, host-wide (the phone book's liveness source; exit 1 when the terminal list can't be read, so liveness reports unknown instead of guessing) |
| `worker-resume` | `<run> <worktree_id> <spec> <model> [account] [agent] [window] [role]` | — (restart in place keeping the conversation; missing agent = claude; exit 1 when the agent can't resume, so the caller starts fresh; the U97 fresh-start guard above runs first, with the same `agent_busy` exit 3) |
| `ps` | — | merged `worktree ps` JSON across the default host and omitted hosts |
| `worker-done` | `[--outcome succeeded\|failed] <subject> <body>` | — (complete THIS terminal's active dispatch with that outcome, default succeeded; discovers task/dispatch/sender ids itself — `bin/role/finish-unit.sh`) |

**Accounts.** `account` is the last optional argument of the start ops; a backend with one login
ignores it. A caller that passes `account` but skips an earlier optional positional (`host`,
`effort`, `parent_wt`) passes `-` for it, and adapters treat `-` as empty. A member with no
`account` runs on its agent's default login — core resolves it from the first `account-list` line
for that agent and never hardcodes an id. The loop turns `account-list` + `account-usage` +
`limited` into `state/accounts.tsv` (`bin/lib/accounts-refresh.sh`); nothing in core names how a
backend switches accounts, so a one-account backend degrades to model fallbacks + wait.

**Standing roles.** `role` is the last optional argument of `role-start`, `worker-start` and
`worker-resume` (`lead-start` and `lead-worker-start` always start the Lead). A standing role
(`lead`, `thinker`, `studio`) lives across turns, so the adapter keeps its session open after a
turn or a stray finish; Orca starts it with `--keep-open` on both start paths. A Builder or Tester
is started as before (U64).

**Auto-compact window.** `window` is the last optional argument of the start ops (and
`worker-resume`): the context size, in tokens, at which the agent compacts itself. Core passes the
role's `auto_compact_<role>` from `conventions/limits.conf` (`ds_compact_window`; `-` = keep the
agent's own default) and never says how; an adapter whose agent has no such knob ignores it. Orca
launches a Claude worker with `--settings '{"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"<n>"}}'`, which
outranks `~/.claude/settings.json` (an env var on the command does not). `worker-start --agent` takes
no Claude flags, so a windowed start opens a claude tab and supervises it (`--terminal`), the same
path a non-default account uses. With `--on <host>` the window is dropped. Muse and Codex ignore it.

**A start under a crash.** A killed loop's `role-start` child keeps running while the restarted loop
replays it, so two runs do one start. Orca's adapter keeps them to one worktree and one tab, so Orca
sees the same input under the retry id: `wt_create` holds a lock per name across its check and create
(`$DS_STATE_ROOT/.wt-locks`, a dead holder's is taken over, `DS_WT_LOCK_WAIT` s for a live one), and a
tab opened for a start or a resume belongs to the retry id, so a replay reuses it while it is live, and it closes
when Orca has no receipt for a failed start, since the next try gets a new id. A run that cannot tell
yet (a live holder past the wait, a failed worktree or terminal list) says `still pending`: the actuator
then keeps the id and waits. A live holder is said as `pid N holds its lock`, which the actuator reads to try again only every 5 minutes and to name the pid in its one Studio alert after 10. A replay sends the args of the first try and the member records its pick.

Orca's `account-usage` reads each Claude account's OAuth token (`<home>/.credentials.json`;
`system` = `~/.claude`, a managed account = Orca's `claude-profiles/<id>/home`) and calls the
usage endpoint Orca's own credits poll uses. The endpoint is undocumented and rate-limited, so
the adapter calls it at most once per account per `DS_USAGE_TTL_S` (300 s), in a host-wide cache
that every project's loop shares. It never refreshes a token. A failure (no token, expired, 429,
network) prints `-`, which means unknown. It never means exhausted. A failed check is retried after
`DS_USAGE_FAIL_TTL_S` (60 s). A 401 on a token that has not passed its own `expiresAt` is noted
`refused`, not `expired`; a refused or failed check keeps the last good figures with the note
`refused@<epoch>` / `stale@<epoch>` (when they were good), blanking a window that has reset since.

The same call carries `cedar_ember=1&skip_spend=1` and Claude Code's own User-Agent
(`claude-cli/<version> (external, cli)`, pinned in `bin/backend/orca.ts`, `DS_CLAUDE_CLI_UA` replaces
it), which adds the account's free-reset grants to the answer; the session and weekly figures are the
same either way. Each fetched answer writes `claude-<id>.resets.json` beside the usage row, and
`account-resets` only reads those files (it calls no provider). A cached row or a failed fetch keeps
the last file. An answer without the grants, `eligible:false` (its `ineligible_reason` kept as
`reason`; `surface` means the pinned User-Agent went stale) or a malformed one reads `unknown`. Muse
reads `not_reported`.

Codex's row and resets come from one `codex app-server` JSON-RPC read (`initialize`, the
`initialized` notification, `account/rateLimits/read`; no model turn), cached in the same dir with the
same TTL, fail TTL and kept-stale figures as a Claude row. The process runs with its cwd in the cache
dir (so the process walk never puts it on a role worktree), its stderr dropped, and is killed after the
answer or after `DS_CODEX_USAGE_TIMEOUT_S` (15 s). A window of up to 300 minutes is the session
column, a longer one the weekly column (the free plan's 30-day window reads as weekly). The same answer
writes `codex-default.resets.json`: `availableCount` is the count, each listed credit a grant
(`codexRateLimits` refills `session` and `weekly`, `available` is usable now, a null `expiresAt` is no
use-by), and `credits: null` is the count with an empty list. A missing, logged-out, failing or slow
Codex prints no codex row (`-`) and leaves the last resets file (`unknown` when there is none).

Orca's `account-reset-use` redeems the way each agent's own CLI does. Claude: `POST
/api/organizations/<org>/reset_rate_limits` with `{"program":"cedar_ember","grant_id","request_id":<key>}`,
the usage call's token (on stdin) and User-Agent, `<org>` being `oauthAccount.organizationUuid` from the
account's `.claude.json`; the answer's `result` maps `reset` → `used`, `already_used` → `already_used`,
`not_limited` → `nothing_to_reset`, `unavailable` → `no_grant` (its `reason` and `resets_left` in the
detail), and any other result or HTTP status is `failed`. Codex: one app-server exchange with
`account/rateLimitResetCredit/consume {"creditId":<grant>,"idempotencyKey":<key>}`; `reset`,
`nothingToReset`, `noCredit`, `alreadyRedeemed` map to `used`, `nothing_to_reset`, `no_grant`,
`already_used`, and a JSON-RPC error is `failed` with its message.

Ids come from the envelope's `.result`, never the top-level `.id` (a request
UUID). A backend must return `run_…`/`task_…`-shaped ids so the spawn's shape
assertions pass.

Agent-facing (the roles call these through **`bin/role/orch.sh <op> …`** — a thin
passthrough to `$BACKEND` for the worker protocol — so the instruction-sets never name `orca`; on a loop
root `send`, `send-worker`, `reply` and `ask` are `ds msg` rows in loop.db instead, U276).
U159: only the loop talks to Orca for lifecycle, in Bun through the adapter; `orch.sh`
refuses the lifecycle ops (`adopt`, `run-create`, `role-start`, `worker-start` and the other
start/stop/release/remove ops), so they are not listed here:

| Op | Args | Returns |
|---|---|---|
| `send` | `<run_id> <subject> <body>` | — (message a Run's inbox — the coordinator reads it; a Run group **excludes** its own coordinator) |
| `send-worker` | `<worktree_id> <subject> <body>` | — (message ONE worker's own inbox; the Lead uses it to reach a child, since `send run:<own>` loops back to itself) |
| `send-run-worker` | `[--to <handle>] <run_id> <worktree_id> <subject> <body>` | — (message ONE worker of ANOTHER Run at its worktree in that Run (`--run` + `@worktree:`), or with `--to` at that exact terminal (U79: the relay names the Lead's agent terminal, never a plain shell); exit 3 = no live terminal, an active sender dispatch, a misfiled receipt (`run:*`/`run_id` mismatch), or with `--to` a receipt naming another terminal (`misdelivered: the receipt names <got>, not <handle>`; a `dispatch:<id>` receipt is resolved through `worker-show`, exit 1 when it can't be); no body limit up to 32k, probed) |
| `reply` | `<msg_id> <run_id> <body>` | — (the Run coordinator relays an answer to the asker) |
| `ask` | `<run_id> <question>` | the answer, raw backend JSON (blocks until answered) |
| `inbox-wait` | `<run_id> <timeout_ms> [ack_delivery_id]` | ack the prior batch, then block for a message or timeout; prints the batch (`bin/lib/watch.sh`). An unacked batch **replays** until acked. |
| `inbox-wait-self` | `<timeout_ms> [ack_delivery_id]` | same, but on the CALLER's own worktree inbox (a non-coordinator worker, e.g. a Thinker, receiving `send-worker` messages) |
| `inbox-all` | `<run_id>` | the Run's FULL message list (read ones too; marks nothing read), keepalives stripped — re-read a consumed message (`watch.sh --all`) |
| `inbox-all-self` | — | same as `inbox-all` on the CALLER's own worktree inbox |
| `gate-create` | `<task_id> <question>` | gate id |
| `gate-resolve` | `<gate_id> <resolution>` | — |
| `poke-terminal` | `<terminal_handle> <text>` | — (type `<text>` + Enter into that terminal; exit 1 = not a live agent terminal (a plain shell is never typed into) / not sent. The loop tells a sender its message was not delivered) |
| `ping` | `<worktree_id> <text>` | — (set a card note on a worktree, visible in the Orca sidebar; the Lead→operator "NEEDS YOU" ping. `<text>` empty clears it) |

A new backend implements these (and the script-callable ops above) its own way;
nothing in the roles, conventions, or scripts changes.

**Addresses come only from the phone book.** Nothing outside `bin/lib/directory.sh` builds a
`run:` / `@worktree:` / `dispatch:` address: scripts and roles resolve through
`directory.sh list|reach` (or `send-role.sh`, which wraps `reach`), and `send-worker`
stays the low-level same-Run op. A new backend implements `wt-terminals` (worktrees with
a live terminal) so the phone book's liveness keeps working; dispatch ids are never a
delivery address (an idle standing role's newest dispatch is `completed`).

### Adding a v1 adapter

A new backend implements contract v2 (above). A v1 adapter is a sibling of `orca.sh`: write `bin/backend/<name>.sh` implementing the script-callable ops (and, for a
full port, the agent-facing ones), then run with `BACKEND=bin/backend/<name>.sh`.
Nothing in the Studio, Squad helpers, or conventions should need to change — that
is the seam's whole purpose.
