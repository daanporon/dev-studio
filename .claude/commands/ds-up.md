---
description: Bring up (or reconcile) a project's Studio
argument-hint: <git-url-or-selector> [--account <id>]   (e.g. https://github.com/you/acme or name:acme)
allowed-tools: Bash(~/.dev-studio/bin/host/up.sh:*)
---
Run `~/.dev-studio/bin/host/up.sh $ARGUMENTS`. `up.sh` only touches worktrees, repos and the Studio's own tab (no
orchestration), so it needs **no** sender terminal — a plain shell is fine. Given a git
URL it clones the repo into `repos/<project>/` (gitignored, never pushed) and registers
it; given a selector (`name:`/`id:`/`path:`) it uses the repo as-is. Then it brings up (or
reconciles) the per-project **Studio** — `ds-<project>-studio` — as a worktree under that
project, and starts the Studio's claude there through the loop's launch path (the
`studio` row's model and effort, its auto-compact window and skill list, on the default
login or the `--account` given), recording its handle; a Studio already running there is
left alone. Idempotent: re-run to reconcile after a worktree is killed (reuses an existing
clone). Report what it brought up, and tell me to open and work in the `ds-<project>-studio`
worktree.
