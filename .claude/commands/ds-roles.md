---
description: View or configure the squad role roster (agent + model per role)
argument-hint: [set <role> <agent> <model> [always|ondemand|elevate] | rm <role>]   (omit to view)
allowed-tools: Bash(~/.dev-studio/bin/commands/roles.sh:*)
---
Run `~/.dev-studio/bin/commands/roles.sh` to view or change which agent/model each squad
role uses, and show its output verbatim.

Resolve the project first: if **you are a project's Studio** (your prompt says
"You are the Studio for project '<label>'"), use that `<label>`; else if
`$ARGUMENTS` starts with a project selector, use it; else view the repo default.

- View (no args, or `list`): `~/.dev-studio/bin/commands/roles.sh list <project>`.
- Change a role: `/ds-roles set <role> <agent> <model> [always|ondemand|elevate] [effort] [fallbacks] [plan] [up|stay]`
  → `~/.dev-studio/bin/commands/roles.sh set <project> <role> <agent> <model> [spawn] [effort] [fallbacks] [plan] [up|stay]`
  (fallbacks: ordered `agent:model,agent:model`; omitted = keep the role's current list, `-` = none).
  Positional: to set only fallbacks pass `""` for spawn (keeps the kind) and `-` for effort, e.g.
  `roles.sh set <project> builder claude opus "" - claude:sonnet`.
  `effort` is the model's reasoning effort (`low|medium|high|xhigh|max`; omit for default).
  `up|stay` (column 8): whether an idle member of the role moves back up to a higher rung once it
  has room; omitted keeps the row's own, `-` inherits (default row, then base role, else `stay`).
  Example: `roles.sh set <project> builder claude opus "" "" "" "" up`.
- Remove a role: `/ds-roles rm <role>` → `~/.dev-studio/bin/commands/roles.sh rm <project> <role>`.

Changes write a per-project override, the project's `roles.conf` row in `state/loop.db`
(survives `git reset --hard`); the repo default is never touched. New values apply
to the **next** spawn, not to running squads.
