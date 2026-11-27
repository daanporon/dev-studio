# How standing agents wake

A standing agent (a Lead, a Thinker, the Studio) has to act on things that arrive when it
isn't looking: a message in its inbox, a worker that died silently. An LLM can't hold a
foreground loop open forever, so "just watch in a loop" is not enough — the loop stops when
the turn ends. dev-studio uses **one** mechanism for this: the rewake Stop hook.

## Two wakes: Orca's push-on-idle (primary) + a poll-with-gaps Stop hook (fallback)

Which one wakes a Lead depends on who runs its squad:

| Squad | Wakes the Lead | Rewake hook |
|---|---|---|
| The loop runs it (a `coordinators` row with a `run_id`) | the loop's poke for new message rows ("N new messages for you", `bin/loop/reconcilers/messages.ts`) | off: `bin/hooks/rewake-hook.sh` `loop_squad` exits at once |
| The loop does not run it | Orca's push, plus the Stop hook below | on |

**Never park in `check --wait`.** Orca caps concurrent long-polls at **16** (half its 32-slot
connection budget), and a `check --wait` is a long-poll. A hook that sat blocked in one held a
slot **per agent, continuously** — with ~17 agents that alone exceeds 16 (`runtime_busy`), and it
also **disabled Orca's free push** (Orca treats a parked unfiltered waiter as "this mailbox is
owned, don't push"). So we don't park; agents idle at their prompt holding **zero** slots.

On a loop root (U276) every message is a `loop.db` row (`ds msg`): the loop writes a worker's Run
mail to its Lead as one, wakes the receiver with one poke per batch, and `watch.sh` reads and acks the
rows; nothing below reads an Orca inbox there. The two wakes below are for a squad the loop does not run.

1. **Orca push-on-idle (primary, zero-cost).** When mail arrives and the agent is sitting idle,
   the Orca runtime types its inbox command into the agent's terminal and submits it —
   a push that holds no slot. The agent wakes, reads the message, handles it. This is confirmed
   working for Claude Code agents (verified live). It only fires when the agent is **idle** and
   its pane is **Run-bound or Dispatch-owned** — which dev-studio agents already are (the Lead
   `run-use`s its Run; every other role is a `worker-start` dispatch).
2. **The asyncRewake Stop hook (fallback).** After the turn ends it does a **non-blocking peek**
   (`watch.sh --poll`, a short RPC that holds no slot) then **sleeps** a gap (default 20s), looping
   over its window. It **exits 2** the moment a peek finds a real message — waking the same session
   (no new session, nothing piles up). Between peeks the agent is idle, so push can wake it first;
   the peek just catches anything Orca didn't push. On a long window with nothing, a Lead exits 2
   once to reconcile (catch a silently dead Builder); a Thinker/Studio just stops.
   A Lead's peek also wakes it when a Builder has **sat** idle 15m+ (and again at 45m) with
   its unit not done — once per stage, so a sitting Builder costs two Lead turns, not a
   drumbeat (`roles/lead.md`). The loop delivers newly ready units to the Lead.

`bin/hooks/arm-rewake.sh <worktree_id> -- <watch-args>` installs it (writing
`<worktree>/.claude/settings.local.json` with `asyncRewake: true` + a long timeout);
`bin/hooks/rewake-hook.sh` is the hook body. One mechanism, every standing agent, differing only
in what it watches:

| Agent | Watches | Armed by |
|---|---|---|
| Lead | its squad Run | `arm-rewake <lead_wt> -- <project> <topic>` |
| Thinker | its own worktree inbox | `arm-rewake <wt> -- --worktree` |
| Studio | its own worktree inbox + `requests/_studio/` | `up.sh` → `arm-rewake <studio_wt> -- --worktree --requests <label>` |
| every other worker (Builder, Tester, …) | its own worktree inbox | `arm-rewake <wt> -- --worktree` |

It is armed from outside (never by the agent itself — a wedged agent never reaches its own
arm step). On a loop root only `up.sh` arms it, for the Studio: the loop starts squad members
without it and wakes them with its own poke, and the hook exits at once on a loop squad. The
squad rows are for a squad the loop does not run. There is no heartbeat, no clock, no `automations`.

**Everyone stays wakeable while they have work; a finished Builder goes dark.** On the long
window elapsing with no message, an agent **re-arms** (exits 2 → a brief turn → stops → a new
hook), so it stays wakeable indefinitely — a Lead also reconciles, a Thinker/Studio/working
Builder just re-arms. The one exception: a **Builder whose unit is marked `done`** exits 0
and goes dark (its work is finished — `arm-rewake … --done-check <state> <wt>` gives the hook
the unit to check). So a Builder waiting on a dependency stays pokeable in the SAME session
(no churn); only a done Builder sleeps, and only a genuinely-gone worker needs `restart-role`.

## The picker hook (terminal pickers onto the board)

A second hook pair lives next to the rewake Stop hook in every squad role's worktree
(`.claude/settings.local.json`): PreToolUse + PostToolUse with matcher `AskUserQuestion`,
armed by `bin/hooks/arm-picker.sh <wt> <state> <role>`, which `reassert-roles.sh` runs for each live
squad role (`/ds-update`, through the loop's `reassert-roles` request). The loop's member start does
not run it, so a member started since the last reassert has neither this pair nor the guard below.
A member on a side host is the exception: that host installs both at every start of its terminal
(`bin/link/channels/contract.ts`).
The Studio is not a squad role and is never armed. Both entries carry `timeout: 15`.

- **Pre** (`bin/hooks/picker-hook.sh pre <state> <role> <wt>`) copies its hook JSON to a temp file,
  queues a `picker-…` entry through `ask-operator.sh` **detached**, and exits at once — backend
  latency never delays the picker. It skips when the question is already queued: a blocking
  entry for this worktree (the role asked through `ask-operator.sh` first), or a picker
  question whose text contains a queued entry's title (`/ds-q` and the Lead's engage flow
  start each picker question with the title). It resolves any earlier `picker-…` entry for the
  worktree first — a role has at most one live picker.
- **Post** (`… post …`) resolves the `picker-…` entry once the picker records an answer — but
  only an entry with `source:"picker"`, so a picker the pre hook skipped never clears someone
  else's question.
- **Board answers** go in as keystrokes, never prose: the board server files an `answer` request and
  the loop's answer fulfiller (`bin/loop/fulfil/answer.ts`) types it: a digit with no
  Enter (`$BACKEND keys`) picks that option, free text is the "Type something." digit then
  the text, then Enter as its own send (Orca refuses text + Enter in one send while a picker
  shows) — prose + Enter into a live picker would select the highlighted option.
  The server first checks the state observer's picker mirror (`observed_pickers`; a closed or
  unknown picker gets nothing, 409) and the fulfiller checks the transcript for a `tool_result` on
  the entry's `tool_use_id` before each key; the server refuses a multi-question or multiSelect picker
  (`picker_answerable:false` — "answer it in the terminal"), and leaves resolving to Post.

**Safety-check prompts** use a third entry, `PermissionRequest` with matcher `*` (`… permission …`,
armed the same way, `timeout: 15`). A role runs with permissions skipped, so the prompts left are
Claude's safety checks. The hook returns no decision and queues a `picker-…` entry with
`picker_kind: "permission"` holding the command or file change, even beside an open blocking
question. The board shows it and sends the operator to the role's terminal; the loop's picker sweep
clears it once the call has a result or the role stops waiting (`docs/scripts.md`).

Like rewake, the hooks always exit 0 and print nothing to the agent: a hook failure must
never block the picker. Detached-run output goes to `state/<label>/picker-hook.log`.

## The broad-kill guard (Claude only)

A third hook lives next to the picker pair in every squad role's worktree
(`.claude/settings.local.json`): PreToolUse with matcher `Bash`,
`bin/hooks/no-broad-kill-hook.sh`. It blocks a command that runs `pkill`, `killall`, or
`kill` fed by `pgrep`/`pidof` (not `kill <pid>` or `kill %job`) — exit 2 with a
reason naming `ds stop-mine`, the worktree-scoped way to stop your own processes
(`bin/commands/stop-mine.ts`). It is armed by `bin/hooks/arm-picker.sh`, which
`reassert-roles.sh` runs on live squads (the loop's member start does not, above);
the merge is idempotent and keeps foreign Bash entries.
Unlike the picker hooks it *does* block: exit 2 is the documented Claude Code
PreToolUse refusal, and anything the guard cannot parse it allows (exit 0), so a
guard failure never stops legitimate work.

Codex and Muse have no per-worktree blocking hook dev-studio controls — their
hooks are Orca-owned global files (`~/.codex/hooks.json`,
`~/.orca/agent-hooks/muse-hooks.json`) whose handlers always exit 0 — so on those
agents only the role rule (`roles/builder.md`, `AGENTS.md`) and `ds stop-mine` apply.

## What makes it work (host facts)

Rewake rests on two Orca/Claude-Code facts, both **confirmed on the host**:

1. a `worker-start` session honors the worktree's `.claude/settings.local.json` Stop hook;
2. this Claude Code build supports `asyncRewake`, so a Stop hook can run after the turn ends
   and its **exit 2 wakes the idle session** (verified live: a message woke an idle Lead).

If a worktree is on a remote host whose filesystem isn't local, `arm-rewake` can't write the
file and prints a notice (a no-op) — arm it on the host where the worktree lives.

## The agent loop, with rewake

Every standing agent does the same thing on each wake: **pull once, handle, ack, stop.**
It does *not* sit in a long blocking `watch.sh` call or re-run ticks forever — it handles
what's in the inbox and ends its turn; the hook re-arms and wakes it on the next message.
A woken agent must **ack** a message it handles (`watch.sh … --ack <id>`) or the same
message re-wakes it (the hook backs off, then retries, rather than spinning or going dormant).

The wake banner prints the full message plus the exact commands to run: a `READ:` line
(`watch.sh <same args> 4000`) and an `ACK:` line (with `--ack <id>` when the peek carried
one). If the re-read comes back empty, Orca's push already delivered it — handle what the
banner printed and ack. Bodies are never truncated (a long body costs context; that is
accepted). To re-read an already-consumed message, add `--all` to any `watch.sh` shape
(`inbox-all` / `inbox-all-self` underneath) — it prints the whole inbox with no `ACK-ID`.

## Loop messages (`ds msg`)

On a root the loop owns, `send-role.sh` and `send-peer.sh` write one `messages` row in loop.db
(U45), not Orca mail. The `messages` reconciler wakes the receiver's live worktree with one
`wake()` poke per batch of new rows ("N new messages for you … ds msg inbox"), under wake()'s
rules: a busy Claude member is still poked, a gone, paused or limited one is not and its rows
wait. The rows are written `sending_at` before the poke and `delivered_at` after it; a poke Orca
refused is retried on wake()'s doubling gap, and a row a loop crash left sending is settled
delivered after `DOUBT_S` (120 s) rather than poked again. The receiver reads with `ds msg inbox`
(also listed by `watch.sh --worktree`) and acks with `ds msg ack <id>`; acking does not wake anyone.

## The loop and watchdog

`bin/host/install.sh` installs the loop for every project together and a crontab line
running `bin/loop/loop.sh --ensure` every minute. `--check` fails if migrated state or
the watchdog is missing. The loop owns liveness, PR changes, merge completion,
ready-unit messages, limits, compaction, spend and cleanup. Its durable observations
and episodes are in `state/loop.db`; runtime limit and spend files are under
`state/<label>/loop/`. The board reports a stopped or stalled loop, and the watchdog
restarts it. Historical switch and rollback evidence remains in `docs/runbooks/loop-switch.md`.

## How this compares to firstmate

firstmate runs a dedicated hook-armed watcher process plus a supervision daemon — a lot of
machinery, because it supports ~14 harnesses. dev-studio needs far less because **Orca is
already the daemon**: `inbox-wait` (Orca's `check --wait`) *is* the blocking wait primitive,
and the asyncRewake Stop hook calling `watch.sh` *is* the watcher, in the agent's own
session. Same outcome — wake on work, not on a clock — with a fraction of the code.

## Paused roles

Durable project, squad and member pause intents suppress ordinary wake, assignment, rebind,
restart, phase, compaction and retirement paths. The loop delivers one generation-bound pause
control instruction through an idempotent prompt to the exact live agent terminal, including
an idle standing role whose dispatch is done. The role finishes its current local work and
runs the supplied journal checkpoint helper; only matching acknowledgment plus positive idle
permits agent terminal closure. Shells and loop/Studio control terminals remain.

After confirmed delivery the loop only observes the checkpoint and closure; it sends no
reminder turns. Paused Lead mail remains queued with its retry clocks frozen. Dependency
waits use observed tracked units/PRs and explicit human holds, never agent polling. Resume
clears intent and invalidates pending closure; the loop starts unfinished roles fresh from
their retained journals. Capacity waits remain Resuming with a reason.
