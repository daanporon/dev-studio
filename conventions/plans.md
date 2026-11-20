# Where plans live

The canonical plan is a file in **dev-studio's own state**, outside every project repo:

    ~/.dev-studio/state/<label>/squads/<topic>-<short-name>-plan.md

One squad can hold several plans (name each for what it covers, e.g.
`manual-testing-onboarding-custody-plan.md`), so the Thinker writes one file per plan
and hands its path to the Lead as the handoff `report-path` (`roles/lead.md`). The
board and the Lead's `units[]` track the work; this file holds the plan's durable text.

## Why outside the repo (for now)

- A project's repo stays clean — no plan docs in its history.
- Plans survive a squad **close** (the loop moves the squad's `<topic>.json` and its
  `<topic>-…-plan.md` files to `state/<label>/archive/`) and a dev-studio **update**
  (`state/` is gitignored, so the untracked plan file survives `git reset --hard`).
- One rule for every project — no per-project config to reason about yet.

## ce-plan's repo-side copy

`ce-plan` / `ce-brainstorm` also write their own artifact under `<project>/docs/plans/`
(the tool can only write inside the repo it runs in). Treat that as a **scratch copy**
and keep it out of the project's history by gitignoring that folder in the project
(a one-line `.gitignore` entry, per project). The **canonical** plan is the
dev-studio-state file above — the Thinker saves the finished plan there explicitly.

## Per-project override (future, unbuilt)

If a project ever wants its plans committed to its own repo (shared history, PR
review), that becomes a per-project setting. **Not built until a project needs it** —
today every project keeps plans in dev-studio state. When it's needed, the toggle is a
per-project flag that points the canonical plan path back at `<project>/docs/plans/`.
