---
description: Show a squad's roster (who owns each role), jump to a role's terminal, or clean up stale terminals
argument-hint: [<project>] [--topic <slug>] [--switch <label> | --reap]
allowed-tools: Read, Bash(~/.dev-studio/bin/commands/team.sh:*)
---
Print the roster so you can see **who owns each role + what it's working on**, and map each
role to the **live worktree** you see in the Orca sidebar. Each member shows its role (+ scope
suffix), its live state (`working`/`waiting`/`idle`/`GONE`), the worktree `displayName`, who it
reports to (`for:`), and what it owns. One worktree = one live session, so `displayName` +
state is the active session — the dead `+N` children under it in the sidebar are just history.
When the backend has extra per-worktree detail it adds it in `[…]` (on Orca: the live terminal
handle, e.g. `[term term_…]`) — the view just prints whatever the backend enriches with, so a
backend without the concept shows no such column.

A worktree can hold **more than one live terminal** (duplicate sessions). When it does, the row
shows `[⚠ N live terminals — duplicate; --reap keeps the owner]` instead of a handle, so you can
SEE the duplicate rather than guess which is which.

**Jump to a role's terminal (no eye-matching tabs).** Name the role and the adapter resolves its
owner (newest live terminal):
- `~/.dev-studio/bin/commands/team.sh <project> --topic <slug> --switch <label>` — focus that role's live
  terminal in the UI (`<label>` is a roster row's name, e.g. `thinker-structures`). Needs
  `--topic` unless the project has exactly one squad.

**Clean up stale terminals (one command).** `~/.dev-studio/bin/commands/team.sh <project> [--topic <slug>]
--reap` keeps only what's meaningful: for each worktree it **keeps the owner** (the live session)
and **closes everything else** — the dead `+N` history *and* any stray duplicate live terminal.
It reports how many it closed. (Restarts — including every `/ds-update` — now reap their own
worktree automatically, so this is for clearing backlog or a duplicate.) Durable state —
branches, files, memory — is never touched; only terminal sessions are closed.

**Scope is automatic.** Run from **inside a squad** (e.g. a Lead) with no `--topic`, `--reap` and
the roster scope to **that squad only** — a Lead never reaps a sibling squad. Run from the
**Studio** (outside every squad) with no `--topic`, they cover **all** squads. `--topic <slug>`
overrides either way.

Your startup prompt says who you are — act on that:

- **If you are the Lead of a squad**: show your own squad —
  `~/.dev-studio/bin/commands/team.sh <project> --topic <your-topic>`. Use it to answer "which Thinker
  is which" and to spot a `GONE` member (its worktree was deleted; `/ds-update` prunes it).
- **If you are the Studio**: show every squad of the project —
  `~/.dev-studio/bin/commands/team.sh <project>` (your own label, or `$ARGUMENTS`), or scope to one with
  `--topic <slug>`.
- **If you are any other role**: scope to your own squad with `--topic <your-topic>`.

Without `--switch` or `--reap` it's a read-only projection (no state changes): it joins the
recorded roster with the backend's live worker states, so it's safe to run any time. For the cross-squad overview
(escalations waiting on you, per-squad status, gates), use `/ds-board` instead.
