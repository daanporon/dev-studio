---
description: Pop this squad's pending operator questions into a picker and answer them
argument-hint: (run inside a squad Lead or Thinker — no args)
allowed-tools: AskUserQuestion, Bash(~/.dev-studio/bin/role/squad-state.sh:*), Bash(~/.dev-studio/bin/role/orch.sh:*)
---
Surface the open questions this squad is waiting on **you** for, as a blocking picker, and
answer them here. This is the on-demand version of the Lead's engage-the-operator flow
(`roles/lead.md`, `conventions/escalation.md`) — run it when you open a squad terminal and
want to clear its queue.

**Resolve your squad's state file** the way `/ds-board` does: you are a squad role agent, so
your spec names `state/<label>/squads/<topic>.json` — use that. If your prompt is **not** a
squad Lead or Thinker (no such state file), say so and stop; this command only works inside a
squad.

**Read the queue** — `~/.dev-studio/bin/role/squad-state.sh <state> get`, then its `.waiting_on_you`
(and keep `.run_id` for replies). If it's empty, tell the operator "no open questions" and
stop — don't invent any.

**Leave the loop's PR questions to the loop.** An entry whose `asker` is `loop` (a PR question:
its text starts "PR #… waits on:") is answered by resolving it here with the operator's words
(`resolve-question <id> --answer "<answer>"`) and nothing else — there is no asker agent to
`reply` to; the loop routes a send-back answer to the unit's Builder itself.

**Leave `picker-…` entries alone.** An entry whose id starts with `picker-` mirrors a live
terminal picker in the asker's session (`source:"picker"`): answer it in `<asker>`'s
terminal or on the board (which presses the option there by keystroke; a permission entry is pressed from
the board only when its card offers Yes and No, otherwise it is answered in the asker's terminal). Never fold it into your picker,
never `reply` to it (an `orch.sh reply` can't reach a picker) and never resolve it — that
would hide a picker that is still open. Just list each one as "open picker in `<asker>`'s
terminal — answer it there".

**Ask, most-blocking first.** Order the remaining questions `blocking: true` before `false`.
Fold them into **`AskUserQuestion`** — up to **4 per picker**; if more remain, fire another
picker on the same turn until the queue is clear. **Start each picker question with the
entry's `title`** (then its text) — the picker-mirror hook matches on that to know this
picker restates a queued question instead of asking something new. Build each question's
options from its text:
- It has a `suggestion` → the **first** option is **Accept: `<suggestion>`** (its description
  is the `why`); picking it applies the suggestion verbatim as the answer. The options below follow.
- It has `options` (a list) → one option per choice; an inline choice list in the text
  (`(a) … (b) … (c) …`) → the same.
- An approve/changes gate (`reply 'approved' or 'changes: …'`) → **Approve** / **Request changes**.
- Otherwise → **Answer** (type it via the picker's free-text "Other") / **Skip**.
**Skip leaves the question enqueued** (it stays on the board) — nothing is lost.

**If the picker doesn't render** (some squad terminals don't surface `AskUserQuestion`),
fall back to prose: print a compact **numbered list** of the open questions — each with its
options — and ask the operator to reply `N: <answer>` (e.g. `2: approved`). Take their reply
and apply it the same way. Don't silently skip asking.

**Apply each answer by your role** (`conventions/escalation.md`) — the two paths differ:
- **You are the Lead** (the Run coordinator): reply it down to the asker, then resolve it —
  `~/.dev-studio/bin/role/orch.sh reply <id> <run_id> "<answer>"` (on a loop root `<id>` is the
  question's message row id or its relayed Orca id, and the reply is a loop.db row linked to it) and
  `~/.dev-studio/bin/role/squad-state.sh <state> resolve-question <id> --answer "<answer>"`. (`<id>` is the question's
  `id`; `<run_id>` is the squad Run.)
- **You are the Thinker** (not the Run coordinator — don't `reply` down the Run): **act** on the
  answer yourself, then resolve your own gate with
  `~/.dev-studio/bin/role/squad-state.sh <state> resolve-question <id> --answer "<answer>"`. e.g. a plan-approval gate →
  on **approved** run `approve-plan <plan-path>` and hand the plan to the Lead, on **changes**
  revise and re-ask; the post-build test gate → add the Tester / test by hand / skip
  (`roles/thinker.md`).

**When the queue empties**, set the squad back to running —
`~/.dev-studio/bin/role/squad-state.sh <state> set-status running`. If you skipped some, leave the
status as it is.

Notes:
- `AskUserQuestion` is a **blocking picker** — it only works on this interactive turn, which is
  exactly when you (the operator) are here. Never reach for it during a hook-driven tick; no one
  is attached to answer.
- This changes nothing except the questions you actually answer — it reads the same
  `waiting_on_you` queue the board shows.
