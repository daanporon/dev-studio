---
name: ds
description: dev-studio cockpit commands (ds-accounts, ds-approve-fix, ds-board, ds-close-squad, ds-limits, ds-mode, ds-pause, ds-q, ds-reclaim, ds-reload, ds-restart, ds-resume, ds-roles, ds-start-squad, ds-suspend, ds-team, ds-up, ds-update). Use when the user invokes any /ds-* command or asks for the dev-studio board, squads, or studio operations.
---

# dev-studio commands (`ds-*`) on Muse and Codex

You are in a Muse or Codex session on a dev-studio host. The operator's `/ds-*`
commands live in the dev-studio checkout, outside the agent's built-in commands.
This skill routes any `ds-*` request to the live command file and you
follow that file verbatim.

## Route

1. The user names a command (`/ds-board`, `ds-q`, "run ds-update", …).
   The command word is `ds-<cmd>`. If no command is recognizable, ask
   which of the commands below they mean — never guess a different command.
2. Resolve the live checkout: `~/.dev-studio` is a symlink to it
   (`readlink ~/.dev-studio`; if it is a plain directory, use it as-is).
3. Read `<checkout>/.claude/commands/ds-<cmd>.md` and follow it verbatim.
   Command bodies are never copied here — they stay live by reference,
   so a `git pull` is fresh without any reinstall of this skill.
   Wherever the body says `$ARGUMENTS`, use the text the user gave after the
   command name (empty if none); ignore the `allowed-tools`/`argument-hint` frontmatter.

The commands:

- `ds-accounts` — List the accounts agents run on, or disable/enable one so no pick uses it
- `ds-approve-fix` — Approve a testing squad's proposed fix and spawn it as an independent squad
- `ds-board` — Render the squad overview board (text, live --watch, or a live web page via --serve)
- `ds-close-squad` — Close a squad — remove its worktrees and archive it off the live board
- `ds-limits` — View or change the limits (context thresholds, usage %, token caps) for a project
- `ds-mode` — View or change a project's ship mode (how a squad's finished work reaches the target)
- `ds-pause` — Checkpoint and pause a project, squad or registered role while retaining its worktree
- `ds-q` — Pop this squad's pending operator questions into a picker and answer them
- `ds-reclaim` — Free leaked Orca long-poll slots (settled dispatches) that pile up across restarts
- `ds-reload` — Reload dev-studio instructions — yourself (in a role terminal) or all squads (in the Studio)
- `ds-restart` — Restart running roles (hard reset) — a whole project, one squad, or one role
- `ds-resume` — Resume paused work fresh from its journal; use --suspended for an existing suspended squad
- `ds-roles` — View or configure the squad role roster (agent + model per role)
- `ds-start-squad` — Spawn a squad from a plain-language topic (derives the slug, framing, and repo)
- `ds-suspend` — Suspend a squad — remove its worktrees to free terminal slots; keep state, branches and conversations for /ds-resume --suspended
- `ds-team` — Show a squad's roster (who owns each role), jump to a role's terminal, or clean up stale terminals
- `ds-up` — Bring up (or reconcile) a project's Studio
- `ds-update` — Bring EVERYTHING to the latest dev-studio — pull, relink, and do only what the new commits need (restart / reload / nothing)

## Caveat: `allowed-tools` is advisory on Muse and Codex

A command file's `allowed-tools` frontmatter is **unenforced on Muse and Codex** —
it grants nothing and restricts nothing. Every `ds-*` command runs on
your ambient permissions. In particular `/ds-update` runs
`git fetch` + `git reset --hard origin/<its branch>` in the dev-studio checkout and restarts squads: confirm with the
operator before running it when the worktree has uncommitted work.
