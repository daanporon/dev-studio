---
description: Close a squad — remove its worktrees and archive it off the live board
argument-hint: [<topic>]   (omit the topic to pick from a list)
allowed-tools: Bash(~/.dev-studio/bin/commands/close-squad.sh:*)
---
Close the squad for **$ARGUMENTS** by running `~/.dev-studio/bin/commands/close-squad.sh <project> <topic>` and show its output. It writes the archived wish and returns at once; the loop closes the agents, removes the worktrees and archives the squad.

Resolve the project: if **you are a project's Studio** (your prompt says "You are
the Studio for project '<label>'"), use that `<label>`; else take it from `$ARGUMENTS`.

**If no topic was given**, don't guess — run `~/.dev-studio/bin/commands/close-squad.sh <project>`
with no topic to get the list of open squads (it prints each topic with its type/status),
show that list to the operator, and **ask which one to close** (`AskUserQuestion`). Then
run it again with the chosen topic. Closing is destructive, so a blank invocation always
becomes a pick-from-list, never a guess.

The loop removes exactly this squad's recorded worktrees (Lead + roles + any fanned-out
Builders) and **archives** its state (+ plans) to `state/<label>/archive/`, so it leaves the
live board but stays viewable in the board's collapsed **Archived** section (`/ds-board`).
This is destructive, so
**confirm the topic with the operator first** if there's any doubt. Notes:

- Branches and PRs are kept. A worktree that is dirty or unpushed is recorded as a leftover,
  never force-deleted, so unmerged Builder work is **not** lost.
- `--force`, `--keep-state` and `--purge` are still accepted but ignored: the loop never
  force-deletes and always archives.
- The loop reclaims the squad's Run workers as part of the close.
- **A Lead doesn't close its own squad.** Closing removes the Lead's own worktree — so a Lead
  that's done marks the squad `done` and **pings the operator**; the operator closes it from
  the **Studio**.
