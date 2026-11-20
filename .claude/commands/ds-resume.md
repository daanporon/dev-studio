---
description: Resume paused work fresh from its journal; use --suspended for an existing suspended squad
argument-hint: <project|squad|member> <project> [squad] [role] [suffix] | --suspended <project> <topic>
allowed-tools: Read, Bash(~/.dev-studio/bin/ds resume:*), Bash(~/.dev-studio/bin/commands/suspend-squad.sh:*)
---
For paused work, run `~/.dev-studio/bin/ds resume $ARGUMENTS` and show its state and reason.
This only restores desired eligibility, including when the loop is unavailable. The loop
picks eligible unfinished roles and starts each fresh from its retained journal on the normal
role/tier/phase/account picker. No account or start slot means a visible Resuming wait.
Resume squad clears all role pauses in that squad; Resume project cascades over its paused
squads and roles. Resume member cannot bypass a paused squad or project. Explicit Resume
clears dependency-wait intent without changing prerequisites, unit holds or blocking rulings;
finished, cancelled, archived and suspended work keeps its existing lifecycle.

For `--suspended <project> <topic>`, resume the squad that was suspended with `/ds-suspend`: run
`~/.dev-studio/bin/commands/suspend-squad.sh <project> <topic> --resume` (your own project label,
or take it from `$ARGUMENTS`) and show its output.

It writes the squad's running wish and returns at once. The loop starts each member fresh
from its journal in a new worktree (Lead first). The squad goes back to `running`.
