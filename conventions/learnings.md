# Learnings

Squads compound what they learn so the next squad starts smarter — the
compound-engineering way, in each worked project's own repo.

**We maintain no learnings store of our own, with one exception: notes** (below). Everything
else is a convention over existing skills: `ce-compound` (capture) and `ce-compound-refresh`
(update/retire) write to `docs/solutions/`, and `ce-plan` / `ce-brainstorm` already read it
back. This file just says *when* the roles invoke them.

## Where learnings live

In the **worked project's** `docs/solutions/` — not in dev-studio. That is
where `ce-plan` and `ce-brainstorm` already look, so a learning one squad captures
is read by the next squad on that project automatically. Nothing new to maintain.

## When to capture

Capture a learning only when a solve produced **non-obvious reasoning that the
final code, tests, and existing docs do not already explain** — a gotcha, a
hard-found root cause, a pattern worth repeating, a dead end worth warning about.
Do not capture routine changes whose diff already tells the story (`ce-compound`
enforces this bar).

- The **Builder** captures a learning at ship time when its change
  carried a non-obvious lesson: run `ce-compound`.
- The **Thinker** captures a cross-topic or architectural insight when one
  surfaces during planning or triage.

## When to read

The Thinker reads the project's existing `docs/solutions/` when planning a topic
(`ce-plan` / `ce-brainstorm` do this), so prior learnings shape new work before a
squad repeats an old mistake.

## Two scopes

There are two kinds of learning, captured the same way (`ce-compound`) into two
different `docs/solutions/` directories:

1. **Project learnings** — about the *worked* project's code (above). Target: the
   worked repo's `docs/solutions/`.
2. **System learnings** — about how the orchestration *itself* should behave: how
   the Studio surfaces things, how escalations route, spawn patterns that
   work, responses that didn't. Target: **this** repo's own `docs/solutions/`.

## System-learnings loop

- **Capture:** when the operator or a standing agent notices an orchestration
  lesson (an escalation handled awkwardly, a pattern worth repeating, a response
  that should change), run `ce-compound` *here* so it lands in `docs/solutions/`.
- **Read:** the Studio reads this repo's `docs/solutions/` on start
  (its instruction-set says so), so the system applies what it has learned
  about operating — not just what the projects learned.
- **Promote:** when a system learning is settled and should always hold, graduate
  it into the relevant `conventions/*.md` or role file by editing it. The solution
  note keeps the reasoning; the convention becomes the enforced rule. If a script,
  test or lint can catch the mistake, add that check instead — text only works when
  an agent reads it, a check fails either way.

## Where a lesson goes: the three places

Pick by audience:

1. **Everyone on the repo** goes in the worked repo, through a normal squad PR: `AGENTS.md`
   for a standing instruction, `docs/solutions/` (`ce-compound`) for a solved problem's
   reasoning. Outside your unit's scope, raise it as a follow-up (`roles/builder.md` step 2),
   never as a direct write.
2. **dev-studio roles on that project** go in notes (below).
3. **How dev-studio works** goes in this repo's `docs/solutions/`. A role on the host jots it
   with `bin/role/ds-feedback.sh`.

**Tie-breaker.** When a role needs the know-how now and a repo change is in doubt or outside its
unit, it writes the note now. If everyone on the repo needs it too, it also raises the follow-up,
and drops the note once that merges. Example: "start devenv before e2e".

## Notes

Per-project, per-role tips for the next role on the same project, in
`state/<project>/notes/<role>.md` (host-local, gitignored). Use
`~/.dev-studio/bin/role/notes.sh <project> <role> [print | add "<note>" "<why>" | drop "<fragment>" | path]`
(absolute path, like the journal). One dated line each, the why required.

- **Notes vs the journal:** would the next role on a *different* topic need this? No means
  journal (`AGENTS.md`, "Your journal"); yes means a note.
- **Precedence:** a note loses to the operator, the plan, the role file and the repo's docs. A
  role that finds a conflict follows the source and drops the note. No secrets in notes.
- **Cap and prune:** at most `notes_cap` notes per role per project (the per-project setting, default 20, 1-100: the operator's call, and a higher cap costs context at every start), note plus why at most 300 characters;
  `add` refuses at the cap. Drop a note on sight when it proved wrong or stale, or was promoted
  to the repo. At the cap, drop or merge one before adding.
