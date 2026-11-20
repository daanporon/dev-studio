---
description: Restart running roles (hard reset) — a whole project, one squad, or one role
argument-hint: [<project>] [--topic <slug>] [--role <role>]   (run from the Studio)
allowed-tools: Read, Bash(~/.dev-studio/bin/commands/restart-squads.sh:*), Bash(~/.dev-studio/bin/commands/restart-role.sh:*)
---
**Restart** (not reload) stops and restarts a worker in place — it re-reads its role
**and** restarts its coordination loop on the latest scripts, and clears a wedged
agent. Branches are kept. Use this (instead of `/ds-reload`) after an update that
changed **how** an agent runs (the watch loop, the backend interface), or when a role
is stuck. For a markdown-only change, prefer `/ds-reload` — it keeps the agent's
working context.

Your startup prompt says who you are — act on that:

- **If you are the Studio** (or any terminal outside a squad): restart the project's
  running roles with `~/.dev-studio/bin/commands/restart-squads.sh <project>` (use your own
  project label, or `$ARGUMENTS`). Scope it with `--topic <slug>` for one squad or
  `--role <role>` for one kind of worker; it writes a restart wish for every recorded worker
  it finds (fanned-out Builders included) and reports each; the loop stops and starts them.
- A restart always starts fresh from the member's journal (U158: there is no `--resume`
  restart; bring a suspended squad back with `/ds-resume --suspended`).
- **If you are the Lead of a squad**: to recycle **one specific child**,
  `~/.dev-studio/bin/commands/restart-role.sh <project> <topic> <role> [suffix]` — it writes a
  restart wish and the loop stops and starts the child fresh on its next pick (U153).
  It no longer takes `--account <id>`, `--agent <a>` or `--model <m>`: only the operator
  pins a place, through `bin/ds want member <id> --model <m> --account <a>`. You **cannot restart yourself** (stopping your own
  worktree kills you, and there's no Dispatcher to hand off to): if you're wedged or need
  the whole squad migrated, **ping the operator** to run
  `~/.dev-studio/bin/commands/restart-squads.sh <project> --topic <your-topic>` from the Studio.
- **If you are any other role agent**: ask the operator to run `/ds-restart` from the
  Studio; you can't restart yourself.

So: `/ds-restart` in the Studio recycles the workers in place (new sessions); `/ds-reload`
is the lighter option when only instructions changed. **If you just pulled a dev-studio
update, use `/ds-update`** — it does the pull + relink + role refresh + this restart in one
step, so everyone lands on the latest code, instructions, and skills.
