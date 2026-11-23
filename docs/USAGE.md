# Using dev-studio

A personal way to run many topics of work in parallel while staying in control: a
**Studio** is your thinking home with a glanceable board, and from it you spawn
per-topic **Squads** of role worktrees. It runs on Orca today — the only backend
implemented — behind a swappable backend interface.

This page is the step-by-step reference behind the README: install once, bring
up a project, spawn squads, read the board. For the concepts (how one topic
flows through the system, who answers what) see
[`how-it-works.md`](how-it-works.md); for every setting in one place see
[`settings.md`](settings.md); [`AGENTS.md`](../AGENTS.md) is the agent-facing
map of the system.

## Prerequisites

`bin/host/install.sh --check` verifies all of these and changes nothing — run it
first. In short:

- An Orca host with the `orca` CLI (`orca status` shows `runtimeReachable: true`).
- `git`, `jq`, and `claude` on PATH.
- **A managed agent account on the host.** Squads launch as supervised workers
  (`worker-start --agent claude`), which Orca can only start if that account is
  registered on the host that runs the workers. Check with `orca account list`; if
  it's empty, run `orca account add` once (it runs `claude login` with your own
  account). Without this, `/ds-start-squad` fails at `worker-start` — see
  `docs/solutions/2026-10-06-worker-start-needs-managed-account.md`.
- The role skills the agents invoke, installed **on the host** (the squad agents
  run there as Claude Code): `ce-brainstorm`, `ce-plan`, `ce-work`,
  `ce-code-review`, `ce-compound`, `ce-babysit-pr`, `lfg` (the compound-engineering
  plugin) and `no-mistakes`. Install them with `bin/host/install.sh --skills`
  (which runs `bin/host/install-skills.sh`: the `compound-engineering` plugin via
  `claude plugin` into every Claude account Orca manages, and `no-mistakes` via its
  official installer, linked into each account's `skills/`). Verify with
  `bin/host/install-skills.sh --check` (one verdict per account; exit 1 when one is broken).
- **Lavish (OPTIONAL)** — a visual HTML review surface the Thinker can offer for a plan
  (`roles/thinker.md`); the operator annotates the rendered plan instead of replying inline.
  Install the skill so agents discover it: `npx skills add kunchenguid/lavish-axi --skill
  lavish -g` (also run by `bin/host/install-skills.sh`). No other setup — the CLI runs on demand
  via `npx -y lavish-axi`, and **Lavish picks its own network binding**: loopback, or this
  machine's Tailscale address when it detects a tailnet (phone-ready MagicDNS link). It's
  optional — without it the Thinker just uses inline plan approval. Pages and their files live in
  `state/<label>/pages/<topic>/` (the Studio's in `pages/_studio/`), not the worktree, whose
  `.lavish/` and `.scratch/` are lost on close. Security: a tailnet-bound
  Lavish server is **unauthenticated and can serve local files** to anyone on the tailnet, so
  keep the tailnet trusted, or set `LAVISH_AXI_HOST=127.0.0.1` to force loopback-only (view it
  over an SSH tunnel).
- **Orca's "Nested worker depth" set to ≥ 2** (default is 1). A squad is
  Studio → Lead → Builder, and a Lead-dispatched Builder is **depth 2**, so with the
  default 1 every Builder start fails with `nested_worker_depth_exceeded`. `install.sh`
  checks and warns. To set it:
  - **Local Orca desktop:** Settings → Agent Orchestration → "Nested worker depth" → 5.
  - **Remote `serve` host** (the UI can't reach it — it's host-only, hidden from paired
    clients): on the host run **`bin/host/set-orca-depth.sh 5 --auto`** once (it stops Orca,
    sets it via the profile-state export→edit→import path, and restarts). If it can't
    auto-detect how Orca runs, stop Orca, run `bin/host/set-orca-depth.sh 5`, start Orca.
    **Never hand-edit `orca-data.json`** — it's a SQLite-mirrored store and a raw edit
    makes Orca refuse to start. The why + full detail: `docs/orca-notes.md`.

## Setup

Clone this repo **onto the Orca host**, at an absolute path the squads' agents can
read (they run in the *target* project's worktree, so their specs point back here
by absolute path):

```sh
git clone git@github.com:OWNER/dev-studio.git
cd dev-studio
shellcheck bin/*/*.sh bin/backend/*.sh && ./tests/squad-state.sh && ./tests/backend-seam.sh
```

## Install the commands (once per host)

The `/ds-*` slash commands live in this repo, but the Studio and squad agents run
inside each *project's* worktree — a different folder, where
Claude Code can't see this repo's `.claude/commands/`. Install them into your
global command dir so they work everywhere. One command does it all:

```sh
bin/host/install.sh --check    # verify prerequisites and required loop installation; change nothing
bin/host/install.sh --skills   # link commands, install role skills, and install the loop + watchdog
```

`install.sh` first **preflights** the prerequisites: a missing `git`, `jq`,
`claude`, or reachable Orca runtime stops it with a one-line fix, while a
missing Claude login or low nested-worker depth only warns. It then
**symlinks** the commands (so they always reflect this checkout) and points
`~/.dev-studio` at it (the stable path the commands resolve scripts through),
**prunes** links for commands deleted since the last install (foreign files are
never touched), and **installs the required loop** with its systemd user unit and minutely
watchdog (`bin/loop/loop.sh --ensure`). Hosts without a systemd user session run it through the
watchdog. Missing Bun is an error; `--check` also fails when the loop database, migration
mark or watchdog is missing. The retired `--no-loop`, `--no-sweep` and `--sweep` options
are rejected. Existing runtime files are copied into `state/<label>/loop/` without
replacing newer data; the operator backs up and removes the old marker directories after
the new code is active. See the historical [switch runbook](runbooks/loop-switch.md).
and with `--skills` also installs the role skills. It ends by
printing the next step (`~/.dev-studio/bin/host/up.sh <git-url>`). A
later `git pull` updates existing commands' content with no re-install; re-run
`install.sh` after a pull that **adds or removes** a command (a new file needs its
own symlink) or if you **move** the checkout. It's idempotent — running it after
every pull is safe. Without installing, `/ds-board` in a Studio worktree shows "No
commands match" — run `<dev-studio>/bin/board/board.sh <project>` directly, or install.

### The `/ds-*` commands in a Muse terminal

Muse never sees `~/.claude/commands/`, so the symlinks above don't reach it.
Instead, one wrapper skill — `ds` (source: `skills/ds/SKILL.md` in this
checkout) — routes any `/ds-*` request to the live
`.claude/commands/ds-<cmd>.md` body and follows it verbatim. Command bodies
stay live by reference, so a `git pull` is fresh with no reinstall.

Install and refresh it with:

```sh
bin/host/install.sh --skills          # full install, includes the Muse ds skill (quiet skip when `muse` is absent)
bin/host/install-skills.sh --muse-only  # refresh just the Muse skills — this is also the `/ds-update` hook
bin/host/install.sh --check           # verify, change nothing (reports a `muse: ds skill ok` line when `muse` is present)
```

Caveat: a command file's `allowed-tools` frontmatter is **unenforced
advisory on Muse** — it grants nothing and restricts nothing, so every
`ds-*` command runs on ambient permissions. In particular `/ds-update`
runs `git fetch` + `git reset --hard origin/<its branch>` in the dev-studio checkout and restarts squads: confirm with
the operator before running it from Muse when the worktree has
uncommitted work.

Claude Code users see no behavior change: the `~/.claude/commands/`
symlink path is byte-identical to before.

### Codex terminals

The Roles tab offers Codex models and each model's supported reasoning efforts.
The host's Codex configuration chooses the provider (including Azure); select a
model that provider can serve. The loop starts Codex roles, delivers questions and
answers, and restarts them fresh from their journal and role brief. See
[`conventions/models.md`](../conventions/models.md#codex-roles) for fallback setup.

After installing Compound Engineering for Codex or Claude, install the role skills
and the `ds` wrapper for `/ds-*` commands:

```sh
bin/host/install-skills.sh --codex-only
bin/host/install-skills.sh --codex-only --check
```

The full `bin/host/install.sh --skills` install and `/ds-update` also refresh Codex skills
when the CLI is present. Existing operator-owned skill folders are preserved.

## Where to run what: `up` in a host shell, squads from the Studio

Two different contexts, and mixing them up is the most common first stumble:

- **`up` runs from a plain host shell — or as `/ds-up` in any Claude session.**
  `up.sh` only touches worktrees, repos and the Studio's own tab (no orchestration), so run
  `~/.dev-studio/bin/host/up.sh <git-url>` from a normal SSH/terminal session on the
  Orca host — the shell creates the `ds-<project>-studio` worktree for you.
  `/ds-up` is the same script wrapped as a slash command, so it only works
  **inside a Claude session** (a bare shell can't run a slash command). **Don't**
  run it from inside an Orca agent terminal bound to another project (it warns
  if you do); a plain host shell is correct.
- **Everything orchestration runs from the Studio terminal.** `spawn-squad` (creating
  Runs, starting workers), escalations, restarts — each needs a **sender terminal**: it
  only works where `ORCA_TERMINAL_HANDLE` is set, i.e. **inside a live Orca terminal**. A
  bare shell fails these with `no_active_sender_terminal`. The Studio worktree `up` just
  created **is** that Orca terminal (open it in the Orca UI), so you run `/ds-start-squad`
  and the rest from there — never from a bare shell.

## Bring it up (per project)

Each project is a **separate instance**. From a plain
host shell in this repo, the easiest form is a git URL — it clones the repo for you
(like firstmate: into `repos/<project>/`, gitignored, never pushed) and registers
that local path:

```sh
bin/host/up.sh https://github.com/you/your-app    # in a shell; /ds-up <url> is the same inside a Claude session
```

If the project is already a registered Orca repo, pass a selector instead (no
clone): `bin/host/up.sh name:your-app` (or `/ds-up name:your-app` in a Claude
session). Confirm registered repos with `orca repo list`.

Either form creates one worktree **under that project**:

- **`ds-<project>-studio`** — your thinking home + the board + where you spawn squads.

It then starts the Studio in that worktree the way the loop starts every role: claude
with the `studio` row's model and effort (the project's `studio` row, else
`conventions/roles.conf`'s), the Studio's auto-compact window (`auto_compact_studio`) and its skill list,
on the default login, or on `--account <id>` (`ds account list`) when you pass one:

```sh
bin/host/up.sh name:your-app --account acctB
```

The Studio's terminal handle goes into `state/<project>/dispatcher.json`
(`studio_handle`), so the loop knows it from the start. A Studio already running in
the worktree is left alone; if claude never comes up, `up` says so, closes that tab
and exits non-zero.

State lives under `state/<project>/`. It's idempotent — re-run to reconcile after
a worktree is killed. Then open the `ds-<project>-studio` worktree in the Orca UI
and work there. Run it once per project you want to orchestrate.

## Start a feature squad

From the Studio terminal, describe the topic in plain words — `/ds-start-squad`
derives the slug, framing, and repo for you:

```sh
/ds-start-squad add a login page to the web app
```

With explicit flags (`--repo` + `--topic`) it passes them straight through to
`bin/commands/spawn-squad.sh`, which stays the underlying entry point:

```sh
/ds-start-squad --repo <project-selector> --topic add-login [--autonomy checkpoints|lfg] [--framing "what this squad should do"]
```

This creates the squad's Run + task and starts **the Lead + the Thinker** (the
Lead `run-use`s the Run to become its coordinator). **Builders are on-demand** —
the Lead spawns one per unit from the Thinker's plan, never before there's a plan
to build. So a fresh feature squad is just Lead + Thinker until the plan is ready.

## Start a testing squad

From the Studio terminal:

```sh
/ds-start-squad run the app and smoke-test the checkout flow --type testing
```

The Tester runs the dev env and surfaces issues. **You test by hand and mention
everything you see** — send each observation to the squad's Run:

```sh
orca orchestration send --to run:<squad-run> --subject "<what you saw>" --type question
```

The Lead routes both streams to the Thinker, which triages each into a fix the
Builder ships through the project's mode.

When the Tester brings the env up it reports where it's reachable, and the Lead
records it in the squad state (`set-devenv`) — so the board shows **dev env:
`<url>`** for that squad. That's the one env everyone uses: the Thinker reasons
against it, you open it to test by hand (over your tailnet), and no role starts a
second one. On the web board (`--serve`) the URL is a clickable link.

Roles can also publish what they host with `ds expose <name> <url> [--note <text>] [--squad]
[--stop "<cmd>"] [--self] [--ports <p,p>]` (`ds unexpose <name>` or `ds expose --remove <name>` ends
it, `ds exposed` lists open entries, `--all` includes ended ones). The board's squads table has an
Open column (the count of entries you can open, then muted `· N down`);
a squad's Open box links only entries that are up and reachable, and one muted line says how
many are down, host only or not checked yet (click it for the details, never as links). A
`--self` entry is never listed, and there is no Running now list. An entry made inside a role worktree belongs to that
member and ends when it goes; `--squad` keeps it until the squad closes (use it for a detached env).
Every entry ends when its squad is done (`squad-done`) or closing (`squad-closed`), and `ds expose`
refuses a squad that is done or closing. The loop probes each entry and ends one that stays down
longer than `expose_down_min` (default 15 min). `set-devenv` keeps working.

`--stop "<cmd>"` registers how to stop what the entry hosts (one line, at most 500 characters; write
it so it works from any folder, e.g. `docker compose -p <name> down`). When the entry ends with its
squad or its owner (not when it is only down, and never on `ds unexpose`), the loop runs the command
once, in the owner's worktree (or the project's state folder when that is gone), for at most
`expose_stop_s` seconds (default 90, 10-100), before the worktree is removed or the squad archives;
two entries with the same owner and command stop once. A failed, timed-out or lost stop raises one
Needs-you card. `--self` marks a tool only the member uses (not listed for you); `--ports` names
extra ports the entry covers (up to 16). A squad's `add-cleanup` command still runs at close for
things nobody exposed; one that already ran as a stop command is skipped.

The loop also watches which TCP ports each member's worktree listens on (its own processes, never the
agent CLI itself, and the host ports its containers publish). A port no open entry of the squad covers
(by its URL's port or `--ports`) for `expose_warn_min` minutes (default 5, `0` turns it off) gets one
message to that member with the `ds expose … --stop "…"` command to run (`--squad` for a Tester).
Each port is named once per member. A container on the host network publishes no ports, so the loop
cannot see it: expose it by hand.

## Read the board

### Squad states

One name per state; the pill's hover, the expanded squad and the text board say what it means and what you can do.

| State | Set by | Means | You can |
| --- | --- | --- | --- |
| `planning` `implementing` `testing` `fixing` `retest due` `queued` | the loop (computed) | work is in flight | nothing, unless a question is in Needs-you |
| `blocked` / `waiting-on-you` | the Lead | a question or blocker needs you | answer it in Needs-you |
| `parked · N held` | the loop (computed) | nothing dispatched or ready; the only open work is N held units | release them, cancel them, suspend the squad, or leave it parked |
| `wrapping up` | the loop (computed) | every unit done or cancelled, no open PR, no Tester; the Lead owes the test check and the debrief | nothing; a "Wrap-up stalled" card comes only if the Lead stops answering |
| `done` | the Lead, after the debrief | finished; waits only for you | read the debrief, then Close squad (a Needs-you row says so) |
| `pausing` `paused` `resuming` | you (Pause) | agents stopped, worktrees kept | Resume |
| `suspended` | you (Suspend) | worktrees removed, branches kept | Restore |
| `archiving` `suspending` | you | the loop is carrying it out | wait; it reads stuck after 15 min |
| `failed` | spawn | the squad never fully started | Close it |

Paused, suspended and parked differ: paused — you stopped its agents; suspended — you removed its worktrees; parked — nobody stopped it, it only has held work left.

In the Studio:

```sh
bin/board/board.sh name:your-app                   # this project; omit the arg for all projects
bin/board/board.sh name:your-app --watch           # live-refresh in the terminal (default 5s; --watch 10)
bin/board/board.sh name:your-app --serve           # serve a live web page (default port 8787)
```

**The web board (`--serve`).** It serves a live page over HTTP that polls every 5s and
updates in place (expanded rows, scroll and an open plan stay put). It listens on
`127.0.0.1` and the Tailscale IP only (never every interface, so other networks the host is
on can't reach it), so it's reachable **both** from the host's own browser (`http://127.0.0.1:<port>/`
— Orca's in-app browser routes there, so open it **next to the Studio terminal**) and from
your laptop over the **tailnet** (`http://<tailscale-ip>:<port>/`). The loop runs it:
`--serve` only writes the wish (`bin/ds want board --project <label> [--port <n>]`, a
`services` row in `loop.db`, carrying your `DS_BIND` and `DS_BOARD_HOSTS`), waits up to 15 s
(`DS_BOARD_SERVE_WAIT`) for the loop to start it and prints both URLs, or exits 1 with the
reason when it failed; the loop starts `bin/board/board-server.ts` as its
child, pings `/healthz` every tick and restarts it within a tick when it dies or stops
answering. More than three restarts in ten minutes raise one Studio alert and leave the row
`failed` until you ask again (`bin/ds services` shows each row's status, pid and why). When
another process already holds the port (a second project's board, any other tool), the loop
takes the next free one, up to `DS_BOARD_PORT_TRIES` (20) further, skipping ports another
board's row has registered; the port it bound becomes that board's port from then on, so the
address stays the same between runs, and `--serve` prints it with `(8787 was taken)`. Its log is
`state/<label>/board-serve.log`.

```sh
bin/board/board.sh name:your-app --serve           # the wish; prints the 127.0.0.1 and tailnet URLs
bin/board/board.sh name:your-app --stop            # the loop stops it on its next tick
```

Pass a port as `--serve 9000` (`--serve-fg [port]`, the server in the foreground by hand, also
moves on to the next free port). Without Tailscale it serves on `127.0.0.1` only (there is
no file-based page, browsers won't load the board data from `file://`). `DS_BIND` overrides
the addresses, space-separated (`DS_BIND=127.0.0.1` for host-only, `0.0.0.0` to open it up on
purpose). It serves the page and `/board.json`, plus same-origin JSON APIs —
and nothing else (no state files). The server only talks to `loop.db`: most buttons write
one request row (the reply is `202` with its id) and the loop does it on its next tick; the
page hears how it went over `GET /api/stream` (server-sent events) and shows a toast — done,
failed with the reason, a member started, a unit done, a usage limit, a Studio alert.
Answering a question (`POST /api/answer`) marks it answered at once and the loop types your
answer into the asking agent's terminal (a mirrored terminal picker gets it as keystrokes:
the option's digit, or "Type something." + your text); if that never lands, the question
opens again. The action buttons (`POST /api/request`: close, restart, suspend, resume,
reload, start) have the loop file the `/ds-…` command for the Studio to run. Settings
(`/api/limits`, `/api/roles`) go through `limits.sh` / `roles.sh` on the loop's side, and a
crew row's **pin** / **auto** (`POST /api/override`) sets a member's model or account until its
work is done, or clears it. Each squad lists its **past answers**
(`GET /api/questions?squad=<slug>&status=answered`), and the event log shows each answered
question as title, answer and where it was answered. If a render fails,
the page shows **stale since …** with the error instead of freezing silently. Stop it with
`--stop`. `board.sh --json` prints the same data the page renders.

The top bar puts **Pause all** beside **Reload all**, changing to **Resume all** while paused.
Each crew row puts **Restart** and **Pause role** beside **pin**, including Leads, Thinkers
and suffixed Builders, Testers, Reviewers and Researchers; a paused role shows **Resume role** and hides Restart.
Pause and Resume are also available at squad scope. Project checkpoint details appear
while pausing, paused or resuming. These controls use `POST /api/pause` and `/api/resume` with
`{scope, project, topic?, wt?}`; member scope uses the exact registered worktree, or `role` + `suffix` for an unplaced role. They
return `200` with the shared lifecycle projection, without a Studio request or immediate
backend call. Resume works with the loop stopped: it restores eligibility, and the loop
picks eligible roles when it returns. Repeated clicks keep the same pending generation.

**Pausing** means the role is finishing its current step, writing its journal checkpoint,
or waiting for verified terminal closure. **Paused** keeps unfinished files and worktrees; a role
with no agent and no worktree goes straight to Paused and says so, with nothing to checkpoint.
**Resuming** waits for fresh placement; the crew row shows account/slot waits, missing
checkpoint notices and closure failures. Resume squad clears every individual role pause;
Resume project clears its paused squads and roles while leaving suspended and archived
work alone. A role cannot resume through a parent pause: its row names the parent to
resume first. Poke and Restart controls respect pause. These sit in the ⋯ menu at the end of each squad row (Pause squad, Events, Focus squad, Restart Lead, Restart squad, Suspend squad, then Archive squad in red). **Suspend squad** removes worktrees,
**Resume squad** (on a suspended squad) recreates them, and **Archive squad** remains permanent.

A crew row's **Wait for dependencies** selects tracked unit or PR prerequisites and uses
the same pause operation as `ds pause member … --prerequisites '<json>'`. Pause details
link prerequisites and list unresolved references, unit holds and blocking rulings.
Automatic resume requires every prerequisite and hold to clear; explicit Resume clears
the wait without changing prerequisite facts or releasing a human hold. Remote CI and
PR updates remain visible while roles are paused.


The server is a **singleton per scope**: one `services` row per scope, so re-running
`--serve` is always safe (the same port is a no-op, another port moves it). It renders
`board.sh --json` **per request**, so a `git pull` applies on the next poll (a page change
on the next browser reload) — no restart needed. `--topic <slug>` scopes the board to one
squad (its own server); `/ds-board` inside a squad uses this to show just that squad.

Shows, per squad: `topic (type/autonomy) [status] task= lfg-assumptions= gates=`,
plus the **WAITING ON YOU** queue (every squad question the Lead pinged you about,
each tagged with the Lead to answer at, blocked first). It recomputes each time —
never a stale snapshot. By default it prints once; `--watch` re-renders until Ctrl-C.

**WORK ITEMS (the plan on the board).** Under each squad the board lists the plan's
units from the squad state's `units[]`, each with a live status: `✓ done`,
`⟳ dispatched` (with the Builder's live state), `⚠ dispatched — builder GONE`
(the worker vanished — re-dispatch it), and `○ planned` (handed off but no Builder
yet). The two warning states are the dropped-handoff failures made impossible to
miss. The LEAD column shows a Lead only when the loop's own liveness check says it is stuck, never
for being idle: `⚠LEAD-NOT-RESPONDING(Nm)` (idle with Run mail unread for `DS_SWEEP_SILENT_MIN`, 10 minutes; the loop pokes it
twice and then asks for a restart), `⚠LEAD-HUNG(Nm)` (working with no output for `DS_SWEEP_HUNG_MIN`, 30 minutes, no long
step open, and its last turn neither ended nor stopped with Esc) and `⚠LEAD-UNREACHABLE` (Run mail the loop cannot deliver to it). The web board shows the
same words in red. A Lead that is idle with nothing waiting shows nothing however long it has been idle.

On the web board each squad has two dropdowns: **work units** (the list above, with
each unit's live status and PR chip); with the light lane on (`max_light_builders` > 0) a light unit also carries a `light` chip next to its Tier (`light→normal` once its CPU passed `light_lane_cpu_h`; the tooltip names the rule and CPU-hours), and the Builders tile reads `normal x/max_builders · light y/max_light_builders` and **pipeline graph** (the unit dependency graph,
drawn with Mermaid — an add-on that needs internet to render; offline it degrades to the
graph's text, the work-units list is unaffected). Closed squads collapse into a separate
**Archived** section at the bottom, so a finished squad's units/PRs/plan stay viewable
without cluttering the live board.

## Recover a wedged or dead role

A worker can get stuck (looping, parked on a prompt) and still read `working`, or the
Lead can go silent. Recycle one worker **in place** without losing its branch:

```sh
bin/commands/restart-role.sh name:your-app <topic> <role> [suffix]   # e.g. … login builder checkout
```

It stops that worker and starts a fresh one in the **same** worktree; the new agent
re-reads its role and resumes from the squad state + its inbox. Use it for the Lead
(`role=lead`) too, and to apply a dev-studio update to an agent that isn't watching.

**Member wishes (`bin/ds want member …`).** A member's row also holds what you want of
it: a standing state (`running`, `stopped`, `archived`) and one-time wishes, each stamped
with when and who (`--by`, `--why`). Repeating a one-time wish collapses into one.

```sh
bin/ds want member <project>/<topic>/<role>[/<suffix>] stopped     # or running, archived
bin/ds want member <member> --restart [now|idle]   # once: now (default) or when idle
bin/ds want member <member> --reload --clear       # re-read the instructions; clear the chat
bin/ds want member <member> --model sonnet         # pin (and --account <a>); restarts once idle
bin/ds want member <member> --unpin                # back to the picker's choice
```

`bin/ds members` (and the board's crew row) shows each member's **effective** state —
archived or suspended from its squad, paused from any pause on it or above it, else its
own wish — and every pending one-time wish with its age and author. A squad or project
resume clears manual pauses only; a member waiting on a dependency stays paused until the
prerequisite is met or you resume that member by name. The decider acts on the
one-time wishes (restart, reload, clear): a restart closes and starts the member, a reload
is typed into its inbox for the member to confirm, a clear is typed and confirmed by a
fresh transcript or rollout.

**How standing agents wake (`conventions/wake.md`).** The Lead, Thinker, and Studio are
each armed at spawn with an **asyncRewake Stop hook** — the one wake mechanism. It wakes
the agent the moment a message lands in its inbox (and a Lead once per window to reconcile
a silently dead Builder), in its own session, with no clock and no new sessions. There is
no heartbeat. Arm an already-running worktree by hand (e.g. after a manual restart) with
`bin/hooks/arm-rewake.sh <worktree_id> -- <project> <topic>` for a Lead, or
`bin/hooks/arm-rewake.sh <worktree_id> -- --worktree` for a Thinker/Studio.

## Answer questions

A squad's question is answered **at its Lead**: the Lead pings you (a card note on its
worktree in the Orca sidebar, plus the board's WAITING ON YOU). Open that Lead and answer
in its terminal — your reply is a normal turn, no wake needed — and the Lead relays the
answer down to the asker (`orchestration reply`). Only a genuinely cross-squad question
lands in the Studio's own inbox. See `conventions/escalation.md`.

**Chat with a member from the board.** A crew member's **⋯ → chat** and a question card's
**Chat with <asker>** open a Chat panel: that member's recent turns as the loop last read
them (the newest 20, secrets redacted, tool calls as one muted line; a Muse member shows
its screen tail) and your recent chats with where each one is: `queued` (with why, e.g.
`working`), `sent`, `turn started`, `not taken` or `failed`. Type one line (at most 2000
characters, no newlines) and Send: the loop types `dev-studio board, the operator says:
<text>` into that member's own terminal once it sits idle at an empty prompt, never while
it is paused. A chat to a Builder, Tester, Reviewer or Researcher also lands in the
squad's `crew-chat.md`, so its Lead sees it on its next tick. The panel reads
`GET /api/chat` every 3 s while open; `board.json` carries no turns.

**Switch members inside the Chat panel.** With two or more live members in the squad, the panel
shows a tab per member under its title (lead, thinker, each builder, …) in the Crew box's order, each
with the box's mail count and a dot when that member wrote a reply you have not seen in this browser;
one click shows that member's chat without closing the panel. On a phone the title's name is a button
(`<member> ▾`, with the other members' mail and a dot) that opens the same list. What you typed for
each member stays with it (per browser tab, kept across a switch, a close and a reload) until you send it.

**Chat with the Studio from the board.** The board's top bar has a **💬 Studio** button (one per
project on a host-wide board) that opens the same Chat panel on the project's Studio, titled
`Chat · Studio · <project>`. The loop types your line in once the Studio has been quiet for two
minutes. The button shows the mail waiting for the Studio (the Crew box's unread + waiting-for-reply
count), a dot when the Studio wrote a reply you have not seen in this browser, and `working` while it
is mid-turn. Until the loop has adopted the Studio's terminal the button is greyed out and says so.

**Take back a plan approval.** Approved the wrong plan, or changed your mind? Run
`bin/role/squad-state.sh <state> revoke-plan <plan> --why "<why>"` (or tell the Thinker to).
The plan leaves `approved_plans` (the squad keeps `revoked_plans`: who, when, why), its
approved copy is moved to `<plan>.revoked-<stamp>.md` (never deleted), and a queued Builder of
any of its units is dropped at once. A started Builder is paused on the plan with its work and
worktree kept (the board shows `plan approval: <file>` under its pause); `--keep-started` leaves
it running. It prints one line per unit (`dropped`, `paused`, `left`) and the Lead gets the
same lines. Approving the plan again releases those pauses; a manual pause stays. A plan that
is not approved is a no-op.

On the board, open the squad and use the ⋯ next to an approved plan in its **Plans** list:
**Take back approval…** names how many queued Builders it drops and how many started ones it
pauses, asks a short why (the Lead is told it), and has a box to leave started Builders
running (`--keep-started`). It files one request; the loop runs the command above.

## Autonomy

- `--autonomy checkpoints` (default): the Lead stops at gates (plan drafted, tests
  green, PR ready) and waits for you (`orca orchestration gate-resolve`).
- `--autonomy lfg`: fire-and-forget — the squad decides, logs the assumption, and
  keeps going; assumptions show on the board. See `conventions/autonomy.md`.

## Shipping

Each project ships via `ce-pipeline` (default), `no-mistakes`, `direct-PR`, or
`local-only`. View or change a project's mode with `/ds-mode <project>
[<mode>]`. See `conventions/ship-modes.md` — and [`settings.md`](settings.md)
for where the mode lives.

## Configure roles and models

View and change which agent/model each role uses with `/ds-roles` (or
`bin/commands/roles.sh`):

```sh
bin/commands/roles.sh list your-app                             # view the effective roster
bin/commands/roles.sh set  your-app thinker claude fable         # thinker -> fable for this project
bin/commands/roles.sh set  your-app thinker-deep claude opus elevate  # hard-topic planning model
bin/commands/roles.sh set  your-app builder claude opus always high   # ...with high reasoning effort
bin/commands/roles.sh set  your-app builder claude opus "" - claude:sonnet  # fall back to sonnet when no account has opus left
bin/commands/roles.sh set  your-app builder claude opus "" "" "" "" up     # ...and move an idle Builder back to opus once it has room
bin/commands/roles.sh reset your-app thinker                     # back to the default row
```

The optional 5th column is **effort** — the model's reasoning effort
(`low|medium|high|xhigh|max`; blank = the model's default).

The optional 8th column is **return**: `up` moves an idle member back up to a higher
rung of its row once it has room, `stay` keeps it on its fallback, `-` or omitted inherits
(the default row, then the base role's row, else `stay`). The default roster moves only the
Thinker back up; `roles.sh list` shows the resolved value in its `back up` column.

`thinker-deep` is an `elevate` row: it never starts a terminal. It names the model
the Thinker hands one hard planning step to (`conventions/thinker-routing.md`); its
effort column is ignored.

Changes write a **per-project override**, the project's `roles.conf` row in `state/loop.db`
(it survives `git reset --hard` and can differ per project; `docs/settings.md`); the
repo default `conventions/roles.conf` (`name agent model spawn`) is never touched.
The override is **per role**: `set` writes that one role's row, every role the project
never set runs the default row (and follows later changes to it), and `reset` or `rm`
drops the project's row so the role runs the default again.
New values apply to the **next** spawn, not running squads. Rationale for the
defaults is in `conventions/models.md`. Available accounts: `orca account list`.
Every role row, limit key, and other setting is described in
[`settings.md`](settings.md).

### Lift an account's limit by hand

A limit blocks its account until the notice's reset. A Muse or Codex notice counts only on a
`muse` or `codex` worker, so one quoted on a Claude screen no longer blocks anything; if an
account is blocked that should not be (or you know its limit has passed), lift it:

```sh
bin/ds limit-lift claude acct-a    # [--wait <s>] until the loop has done it
```

The loop clears the account's host-wide limit episodes, `limited_until` in the board's account rows
and `accounts.tsv` (so `accounts-refresh.sh` does not restore it) and on its members, and logs one
`account_limit_lifted` event. A new real notice blocks the account again as before; so does the same notice while it is still on
screen, so lift after it has gone.

## Closing a squad

When a squad is done (or you want to abandon it), close it with `/ds-close-squad
<topic>` (or `bin/commands/close-squad.sh <project> <topic>`):

```sh
bin/commands/close-squad.sh name:your-app add-login              # remove worktrees, ARCHIVE the squad
bin/commands/close-squad.sh name:your-app add-login --force      # also delete unmerged branches (careful)
bin/commands/close-squad.sh name:your-app add-login --keep-state # worktrees only, stays live on the board
bin/commands/close-squad.sh name:your-app add-login --purge      # hard-delete, no archive kept
```

It removes exactly this squad's recorded worktrees (Lead + roles + any fanned-out
Builders — tracked in the state file, so a sibling topic with a shared name prefix is
never touched) and, by default, **archives** its state + plans to
`state/<project>/archive/`. So the squad leaves the *live* board but stays viewable in
the board's collapsed **Archived** section (its units, PRs and plan are still there).
Removing a worktree stops its worker. **Without `--force`, Orca keeps any branch whose
changes it can't prove are merged** — unmerged Builder work is preserved, only the
worktrees go. `--purge` hard-deletes instead of archiving; `--keep-state` leaves it live
on the board. The squad's lightweight Run is left as-is.

**A Lead can't close its own squad** (removing its own worktree would kill it, and there
is no Dispatcher to hand off to). So when a squad finishes, its Lead marks it `done` and
**pings you**; you close it from the **Studio** (close-squad refuses to run from inside
the squad).

## Updating, and reloading running squads

Update the host checkout with `/ds-update` in the Studio (pull, relink, and do
only what the new commits need: skills changed → workers restart once idle; instructions changed →
workers re-read them, no new session; code only → no worker restarts), or by hand: `git -C
~/.dev-studio pull` (or `fetch && reset --hard origin/<its branch>`); re-run
`bin/host/install.sh` if a command was added/removed. Two things
then propagate differently:

- **Scripts** (`bin/*/*.sh`, the backend adapter) — run their latest version on the
  next call. Nothing to do.
- **Instructions** (`roles/*.md`, `conventions/*.md`, `AGENTS.md`) — a running agent
  only picks them up when it **re-reads** the file. Agents self-refresh when their
  `watch.sh` tick prints `INSTRUCTIONS: changed` (a fingerprint of the files), so they
  catch up on their own; to apply an update **immediately**, run
  **`/ds-reload`** in the Studio (or `bin/commands/notify-squads.sh <project>`), which
  writes a reload wish on every roster member; the loop delivers each one to its
  owner's inbox. (You do this from the Studio, your
  cockpit.)

**A reload is a message, so the agent must be reachable to see it.** Each standing agent
(Lead, Thinker, Studio) has its **rewake Stop hook** (armed at spawn), so a reload message
wakes it even if it's idle. An agent started *before* the hook existed in its worktree has
no hook, so a message won't wake it — and a plain `restart-role` does **not** add one (it
only reuses the existing `settings.local.json`). For those, either **close and re-spawn the
squad** (a fresh spawn arms everything) or arm it by hand:
`~/.dev-studio/bin/hooks/arm-rewake.sh <wt> -- <project> <topic>` for a Lead, `-- --worktree` for a
Thinker/Studio. New squads started after an update are fine.

## Learnings

Squads compound learnings into each **worked project's** `docs/solutions/` using
the existing `ce-compound` skill — the Reviewer captures a non-obvious lesson at
ship time, the Thinker reads prior learnings when planning. Nothing to maintain
here; see `conventions/learnings.md`.

## Swap the backend

All `orca` access is behind `bin/backend/orca.sh`. To run on another backend,
write `bin/backend/<name>.sh` implementing the ops in `conventions/backend.md`
and run with `BACKEND=bin/backend/<name>.sh`.

## Commands and skills

Convenience slash-commands live in `.claude/commands/` (all `ds-` prefixed to
avoid collisions; installed into `~/.claude/commands/` by `bin/host/install.sh` so
they work in every worktree):

- `/ds-up <git-url-or-selector>` — bring up / reconcile a project's Studio worktree (idempotent).
- `/ds-update [<project>]` — bring everything to the latest dev-studio: pull, relink, then (`update-squads.sh <project> --auto`) restart, reload or leave the squads alone, by what the new commits touch (skills / instructions / code). Each project records the commit its squads run (`state/<project>/squads-rev.json`), so a project the shared checkout moved ahead of is refreshed by its next `/ds-update` even when the checkout is current.
- `/ds-board [<project>]` — run `bin/board/board.sh` and show the overview (one project, or all).
- `/ds-start-squad <plain topic>` — spawn a squad (derives slug/framing/repo); explicit `--repo`/`--topic` also work.
- `/ds-q` — inside a squad's Lead or Thinker: pop its open questions into a picker and answer them.
- `/ds-roles [set|rm …]` — view or change the per-role agent/model/effort/fallbacks (per-project override).
- `/ds-limits [set|rm …]` — view or change the context/usage/token thresholds (per-project override).
- `/ds-accounts [list | disable|enable <agent>:<account|label>]` — list the accounts agents run on (with `state`), or switch one off/on host-wide (`bin/ds account`). No pick uses a disabled account; members running on it switch at their next restart. See `docs/settings.md` (Accounts). The board's Accounts table has a **Free resets** cell per account (`2 · first by 10 Dec` = two grants, the earliest use-by date; hover for each grant's label, what it refills, use-by date and left/total; `0`, `not reported` for Muse, `?` when unknown), and the text board's account strip adds `free resets <n>`. Click any account row to open it: each grant is listed with what it refills, left/total and use-by date and, when the provider says it is usable now, a **Use** button (it asks first); the opened account also holds its **Enable/Disable** button, and the roles table when it has roles. The closed row shows only the summary and a small marker for a use in the last hour. A grant usable now has a **Use** button: it asks first (a reset cannot be undone), then the loop uses that grant once (`POST /api/account-reset`; a second press waits for the first) and a toast says what happened (`reset used`, `nothing to reset` keeps the grant, `no grant left`, `already used`, `failed`); the cell shows `last HH:MM · <outcome>` for an hour and the accounts are read again. The Accounts section has the same switch: an **Enable/Disable** button on each row (`POST /api/account`; a dimmed row with a `disabled` badge, no top-strip flag; disabling an agent's last enabled account asks first).
- `/ds-mode [<project>] [<mode>]` — view or change a project's ship mode.
- `/ds-reload [<project>]` — reload instructions: yourself in a role terminal (a Lead also writes a reload wish per running child), or all squads from the Studio.
- `/ds-restart [<project>] [--topic …] [--role …]` — restart roles fresh: a whole project, one squad, or one role. Each restart picks from the top of its role, tier and current phase ladder before stopping anything. With no room, a running member stays put (`WAIT <epoch>`, exit 3); a stopped member waits for the next free pick. Direct `restart-role.sh` placement flags (`--agent`, `--model`, `--effort`, `--account`) force a choice, with an active member override taking priority. `/ds-resume --suspended` restores a suspended squad's conversation.
- `/ds-suspend <topic>` — suspend a squad: remove its worktrees to free terminal slots, keep state, branches, and conversations.
- `/ds-pause <project|squad|member> <project> [squad] [role] [suffix]` — checkpoint and pause work without removing worktrees.
- `/ds-resume <project|squad|member> <project> [squad] [role] [suffix]` — clear pause intent; the loop starts eligible unfinished roles fresh from journals.
- `/ds-resume --suspended <project> <topic>` — restore a suspended squad and its conversations.
- `/ds-reclaim <project> [--topic …]` — free leaked Orca long-poll slots (settled dispatches) that pile up across restarts.
- Orphaned worktree folders and Orca entities: the board's **Host tidy** card (shown only when something needs you; its first line says why) and `ds observed cleanup --project <label>`, which lists every row.
- `/ds-team [--topic …] [--switch … | --reap]` — show a squad's roster, jump to a role's terminal, or clean up stale terminals.
- `/ds-approve-fix …` — approve a testing squad's proposed fix and spawn it as an independent squad.
- `/ds-close-squad [<topic>]` — close a squad: remove its worktrees and archive it off the live board (omit the topic to pick from a list).

They are thin wrappers over the `bin/*/*.sh` scripts — the scripts remain the real
entry points. The system *uses* the `orca` CLI and these environment skills:
`ce-brainstorm` / `ce-plan` (Thinker), `ce-work` (Builder), `ce-code-review`
(Reviewer), and `no-mistakes` (ship gate).
