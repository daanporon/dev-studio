# Question routing and no-burial

Questions are answered at the lowest competent level and can never get buried.
They are durable orchestration state, not terminal messages (R11). **The Lead is
the hub: every squad question flows through it, and the Lead decides who answers.**

## One Run per squad, coordinated by the Lead

Each Squad has its **own** `orchestration run` (created at spawn, recorded as
`run_id` in the squad state file). Where the loop runs, the loop's own pane coordinates
the Run and the Lead never adopts (U159: `orch.sh` refuses `adopt`, since taking the seat
only starts a tug-of-war). On a root without the loop, the **Lead adopts the Run to become
its coordinator** through the backend adapter directly
(`bin/backend/orca.sh adopt <run_id>`, see `roles/lead.md`). Only then does a
role's blocking `ask` resolve at the **Lead** (the sole Run coordinator) — `ask`
addresses a Run mailbox, never a peer worker. The Thinker is not a Run coordinator;
it is reached on its own worktree inbox (below).

## The path (R12–R15)

1. A role with a question runs `~/.dev-studio/bin/role/orch.sh ask <squad-run> "<q>"`
   (reaches the Run the Lead coordinates). A blocking `ask` waits until answered.
   **On a loop root (U276) every step below is a loop.db message row** (`ds msg`): the `ask` is a
   needs-reply row to the Lead and returns when the reply row lands; an Orca `ask` from a worker
   reaches the Lead as a row the loop writes from the Run's mail (`[run mail · question … · id
   <msg_id>]`). The `id` below is then the row id `watch.sh` prints, `reply` is
   `~/.dev-studio/bin/ds msg reply <id> "<answer>"` (the reply row links to the question; for a
   relayed Orca `ask` the loop also answers it from its pane), and `send-worker` writes a row to
   that worktree's member. Nothing is read through an Orca inbox there.
2. The Lead mirrors it into the squad state file's `waiting_on_you` queue:
   `bin/role/squad-state.sh <state> enqueue-question <id> <asker> <blocking> "<q>"` (`<asker>` = the role's label, e.g. `builder-b`), where
   **`id` is the orchestration message id of the `ask`** (needed later for `reply`).
3. The Lead **decides one of three**:

   **(a) Answer it itself** — then `reply <id> <squad-run> "<answer>"` (only the Run
   coordinator can reply) and `resolve-question <id> --answer "<answer>"`.

   **(b) Ask the Thinker.** Only the Lead coordinates/acks the squad Run, so the
   Thinker is reached on *its own* worktree inbox, never the Run:
   - Forward: `orch.sh send-worker <thinker-wt> question "msg_id=<id> <q>"`. It must be
     `send-worker` (`@worktree:`), **never** `send <squad-run>` — a Run group excludes
     its own coordinator, so `send run:<own>` loops back to the Lead's inbox.
   - The Thinker (woken by its rewake hook, watching `watch.sh --worktree`) answers
     back: `orch.sh send-worker <lead-wt> answer "msg_id=<id> <answer>"`.
   - The Lead then `reply <id> <squad-run> "<answer>"` and `resolve-question <id> --answer "<answer>"`.
   - **More than one Thinker:** a Builder is spawned under one Thinker's scope (names
     match: `builder-<scope>` ↔ `thinker-<scope>`), recorded in `assignments`
     (`add-role … --for <thinker>`). The Lead looks the asker up there, then resolves
     that Thinker's worktree from the team check-in (`orch.sh worker-states`, the
     `-thinker-<scope>-` row) — durable, survives a Lead restart.
   - **Tester bug reports** ride this same forward: the Tester surfaces each bug tagged
     `blocking` or `minor` (`roles/tester.md`), and a Builder's discovered follow-up
     comes the same way. Carry the tag in `<q>` so the Thinker can loop blocking bugs
     (at most two fix→retest rounds, then it pings the operator) and record minor ones
     as held follow-up units — the Thinker plans the fix, the Lead dispatches it.

**Ask the operator before parking work or changing scope.** Fixing a bug or gap inside this
squad's work needs no approval — just fix it. But two things go on the board first, and wait
for the answer:
- When a question blocks a particular unit, pass `--unit <slug>` to `ask-operator.sh`.
  The board shows that unit waiting on the question, and the loop pauses its PR repair
  and merge prompts until the answer reaches its recipient (including delivery retries). Mirrored asks with
  `asker=builder-<unit-slug>` already identify the unit. Unrelated or non-blocking
  questions do not pause that Builder. A hold or wait must be recorded, not left only
  in the Lead's terminal.
- **How to write the question** (the board lists every question as one row — its title — and
  opens it in an overlay with numbered option buttons): `--title` is the decision itself in
  about 8 words, 80 characters at most ("Let directory readers see multisig wallets?", not "PR3
  is blocked on…"). `--question` is the 2–3 plain sentences the operator needs to decide — no
  file dumps, no option list (the options go in `--option`). Give 2–4 `--option "<label>" "<what
  happens>"`: a short label (it is typed into your terminal as the answer, so no `|`) and one
  line saying what you will do if it's picked. `--recommend` names one of them (its number or
  label) and `--why` says why in one line. The old form `"<q>" "<suggestion>" "<why>"` still
  works but prints a nudge; use the flags.
- **Storing something for later, or anywhere outside this squad** — a held unit, a Linear
  ticket, a GitHub issue, a PR outside the squad: `~/.dev-studio/bin/role/ask-operator.sh <state>
  <id> <asker> false --title "[follow-up] <what>" --question "<what + why>" --option "file it" "<…>"
  --option "fix it now" "<…>" --option "drop it" "<…>" --recommend <n> --why "<why>"`. Nothing gets recorded or filed before the answer.
- **A scope change** — growing or cutting what the squad (or a unit) delivers versus the
  approved plan: `ask-operator.sh … --title "[scope] <change>" --question "<change + why>" --option yes "<…>" --option no "<…>" --recommend <n> --why "<why>"`.

Both are usually **non-blocking** (`false`): ask, then **carry on** with your current work —
the squad stays `running` and the question waits on the board. When the operator answers, the
**Lead** carries it out (records the held unit, files the ticket, or has the Thinker re-plan),
so the asker never waits for it. Use `true` only when the work you are doing right now
can't continue without the answer (e.g. a scope cut that removes the thing you're building).

   **(c) Ping the operator** — for anything the Lead and Thinker can't answer, or that
   needs the operator (a policy, a cross-topic call). First check what is already open:
   `jq -r '.waiting_on_you[]? | "\(.id): \(.question)"' <state>`. If the same decision is
   there, re-ask under **that id** — it replaces the old entry (new text, new blocking), so
   the board shows it once; a new id would show both. Then run
   `~/.dev-studio/bin/role/ask-operator.sh <state> <id> <asker> true --title "<~8 words>" --question "<2-3 sentences>" --option "<label>" "<what happens>" --option "<label>" "<what happens>" --recommend <n> --why "<one line>"` (status + queue + card-note ping +
   an `ON BOARD` receipt; add `--doc <path>` to link one `.md` in `state/<label>/squads/` or `archive/` so the board
   offers Open doc — a `plan-*` question links its plan by the id rule or `--doc`, and the plan must carry
   `## In plain words`, see `conventions/plan-shape.md`) and **end the turn** — never `AskUserQuestion` (it holds the turn open so the rewake
   hook never arms and other messages rot). The operator answers you **in your own
   terminal** (a user turn needs no wake), or from the web board, which types
   `dev-studio board: the operator answered question <id>: …` into your terminal; either way
   you then `reply <id> <squad-run> "<answer>"` and `resolve-question <id> --answer "<answer>"` (a Thinker acts
   on it, then resolves). The squad resumes (R15).
   If you do open a terminal picker anyway (`/ds-q`, or the Lead's engage flow), the
   picker-mirror hook (`conventions/wake.md`) puts it on the board automatically as a
   `picker-…` entry — answering in the terminal clears it. That is a backstop, not the way
   to ask: `ask-operator.sh` first is still the rule (it carries your suggestion and why, and
   the entry is answerable from the board).
   When the answer is one of a few choices, add them as a last arg — `"A|B|C"` — so the
   board shows them as buttons (your suggestion pre-selected; the operator can still type
   their own).

## Asking for a review or sign-off on a PR

**The loop asks the PR questions.** Once a unit PR's only remaining blockers are human gates (a
required review, `signoff`, a proof hold that waits for a review) and its Builder has finished, the
loop files one question per PR naming the gates, withdraws it when the PR goes back to not ready,
and routes the operator's answer: "Done" hands the PR back to the loop, "Send back" and free text
are poked to the unit's Builder (a copy to the Lead). A Builder or Lead never asks the operator
about a PR: `ask-operator.sh --pr <n>`, and a question naming one of the squad's unit PRs, is
refused for them with "the loop asks PR questions" and a line naming who posts it: (a) the loop, its
question is already on the board as `<id>`; (b) the loop, once the Builder has finished, because only human
gates are left; (c) nobody yet, because the PR is not ready: the Builder fixes it (a Lead sends it
`send-role.sh <topic> builder-<slug>`, a Builder tells its Lead if the cause is outside its unit), and a
Lead who needs the operator to decide asks about the unit with `--unit <slug>` and no PR number
(routing metadata, allowed while the PR needs repairs); an unread PR state gets the (c) step. A `--unit` that is
not a unit slug exits 2 with one line listing the squad's slugs. If the PR goes back
to not ready, the loop closes the question (answered via `reality`); its Builder gets the pr-stale
poke. A Builder that goes quiet after the first pr-stale poke without pushing gets the second
after `stale_repoke_min` minutes (default 30; 0 = only after a push) of quiet: idle at its prompt, no push,
its worktree under 5% CPU, no check running. Pokes about open review threads name each one (author,
file:line, link). If the PR is still not ready `stale_lead_min` minutes (default 30; 0 = off) after the
Builder's second poke, the Lead gets one request naming the PR, its reasons and the Builder's
state, and decides: look, re-dispatch or ask.

## Never decide alone

Some calls are the operator's, in every mode — `lfg` included. Ask with
`ask-operator.sh` (with your suggestion and why) before you:

- **close a squad** — the Lead marks it done and hands the operator `/ds-close-squad <topic>`
  for the Studio; never run `close-squad.sh` yourself;
- **merge or close a PR**, or **force-push**;
- **delete a branch or worktree** outside the normal retire flow;
- **park work for later or outside the squad**, or **change scope** (above);
- touch anything about **cost, secrets or access**;
- do anything you are **not sure you can undo**.

Everything else is your call: decide, write it in your journal (`AGENTS.md`, "Your journal"),
carry on.

## Cross-squad only: the Studio

A question that isn't about this squad at all (a cross-topic call, a scope, ownership,
or policy call) goes to the operator **through the board**, not by message — except for
technical peer clarification, which has its own path (Peer clarification, below). The Lead runs
`~/.dev-studio/bin/role/ask-operator.sh <state> <id> <asker> <true|false> --title "[cross-squad] <decision>" --question "<q>" --option … --recommend <n> --why "<why>"`
(same receipt-checked path as (c) above). The operator decides at the Studio; the Studio
sends the decision down with `send <squad-run> answer "msg_id=<id> <answer>"` (and, if it
concerns another squad, `send <that-squad-run> …` to that squad's Lead), which wakes the
Lead to `reply`. This is rare — almost everything is a squad question and resolves at its Lead.

**Never message out of your own squad — except through `send-peer.sh`, for clarification**
(Peer clarification, below). `send-worker` addresses `@worktree:<id>`, a group
address Orca resolves only inside the sender's own Run: aimed at the Studio or another squad
it is silently rewritten to `run:<own-squad-run>` — it reports success and lands at your own
Lead (confirmed on the host 2026-10-16, `docs/orca-notes.md`). A raw terminal handle can cross
squads, but don't use one: handles change on every terminal restart and a stale one falls
back to your own Lead the same silent way. `orch.sh send-worker` now catches the reroute and
exits 3 with "NOT delivered"; a send that landed prints `send-worker: delivered to <handle>
(<msg id>)` — trust that receipt, don't re-check. The NOT-delivered case also happens for a worker in your own squad that is
`done`/stopped (no live dispatch): restart it with `restart-role.sh`, then send. Outside your
squad, raise it with `ask-operator.sh` instead. Messages *down* from the Studio (`send run:<id>`) work, because the
Studio is in no squad Run and addresses the Run explicitly.

## Peer clarification

The one message path between squads: a Thinker (or Lead) may message another squad's
Thinker or Lead with `~/.dev-studio/bin/role/send-peer.sh` — for **technical clarification
only**: what a unit exposes, a field name, a merge order. Scope, priority, ownership,
policy, and anything on the "Never decide alone" list still go Lead → operator / Studio
(above). `send-worker`'s exit 3 and the Studio route stay as they are.

- `send-peer.sh <squad> <role[-suffix]> <subject> <body>` resolves the peer through the
  phone book (`bin/lib/directory.sh`) — a Lead at its Run inbox, a Thinker at its worktree in
  its Run — and prefixes the subject `peer:<from squad>/<role>` so the receiver sees who is
  asking. Only Thinker/Lead targets are accepted; anything else exits 2 ("ask your
  Lead"). Exit 3 means the peer isn't live: ask your Lead, who raises it to the Studio.
- Every send is logged: one line per message in `state/<label>/cross-squad.md`, and each
  Lead's tick shows the last 24 h naming its squad (`CROSS-SQUAD:`). An answer both
  squads must follow is sent with `--ruling`: the log line carries the body and both
  Leads' journals get it as a `decision`. A Lead that disagrees with a logged ruling
  raises it to the Studio.

## The guarantee

A question is either answered below the operator or sitting in one durable queue with a
card-note ping on the Lead that raised it. It can't scroll away and survives a restart,
because it lives in a loop.db message row (the Run inbox where the loop is not running) and the squad
state file — never only in a terminal.
