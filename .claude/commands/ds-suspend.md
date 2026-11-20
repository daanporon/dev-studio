---
description: Suspend a squad — remove its worktrees to free terminal slots; keep state, branches and conversations for /ds-resume
argument-hint: <topic>   (run in the Studio)
allowed-tools: Read, Bash(~/.dev-studio/bin/commands/suspend-squad.sh:*), Bash(~/.dev-studio/bin/role/orch.sh:*)
---
Suspend the squad **$ARGUMENTS** by running `~/.dev-studio/bin/commands/suspend-squad.sh <project> <topic>` and show its output. It writes the suspended wish and returns at once; the loop checkpoints each agent, closes it and removes its worktrees.

Resolve the project: if **you are a project's Studio** (your prompt says "You are the Studio for
project '<label>'"), use that `<label>`; else take it from `$ARGUMENTS`.

What it does: the loop asks each live agent for a journal checkpoint (after 5 minutes it closes
it anyway and journals `checkpoint failed`), closes it, removes every worktree of the squad (which
frees their terminal slots), and marks the squad `suspended`. It keeps the state file, every
branch (so open PRs stay as they are) and each member's journal.
`/ds-resume --suspended <project> <topic>` brings it back: each member starts fresh from its
journal in a new worktree.

A worktree with uncommitted or unpushed work is removed only as a recorded leftover (its
branch is kept); it does not block the suspend.

While it is suspended nobody watches its PRs — CI results and review comments wait until resume.
