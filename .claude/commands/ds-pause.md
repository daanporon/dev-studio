---
description: Checkpoint and pause a project, squad or registered role while retaining its worktree
argument-hint: <project|squad|member> <project> [squad] [role] [suffix] [--prerequisites <json>]
allowed-tools: Read, Bash(~/.dev-studio/bin/ds pause:*)
---
Run `~/.dev-studio/bin/ds pause $ARGUMENTS` and show the returned state and reason.
The scope is explicit: `project <label>`, `squad <label> <topic>`, or
`member <label> <topic> <role> [suffix]` (for example `member acme deposit builder unit-slug`).

This records durable intent immediately. The loop instructs each affected agent to finish its
current step, checkpoint its journal and acknowledge; only then, after verified idle, does the
loop close its agent terminals. Worktrees, shells, branches, unfinished files and remote CI stay.
The Studio and board remain available during project pause. Missing checkpoints and failed
closures stay Pausing with a reason; never force-close a terminal as part of this command.

A role or its Lead may record a dependency wait with `--prerequisites` followed by a JSON array
of tracked references: `{"kind":"unit","project":"acme","squad":"deposit","slug":"before"}` or
`{"kind":"pr","project":"acme","ref":"owner/repo#7"}`. All prerequisites and explicit human
holds must clear before the loop releases the wait; manual parent or role pauses remain.
