---
description: Bring up (or reconcile) a project: install, loop, Studio and board
argument-hint: <git-url-or-selector> [--label <name>] [--backend <orca|orca-lite|tmux|herdr>] [--worktree <auto|git|treehouse>] [--account <id>] [--skills]   (e.g. https://github.com/you/acme or name:acme)
allowed-tools: Bash(~/.dev-studio/bin/host/up.sh:*)
---
Run `~/.dev-studio/bin/host/up.sh $ARGUMENTS`. It needs **no** sender terminal — a plain shell is fine. In
order, skipping each step already done (U53):

1. installs dev-studio on this host when `install --check` fails (`--skills` adds the role skills);
2. starts the loop unless it runs (`loop --ensure`);
3. adds or reconciles the project. Given a git URL it clones the repo into `repos/<label>/` (gitignored, never
   pushed); given a selector (`name:`/`id:`/`path:`) it uses the repo as-is. The label is `--label`, else the
   repo's name; a label already up with another repo is refused (give the new one its own `--label`).
   `--backend` (default orca) is checked like a squad's and, on first bring-up, written as the project's
   `default_backend`; a roster role the backend cannot start is refused before anything is made. A different
   `--backend` on a project already up is refused (moving a project is U54). `--worktree` writes
   `worktree_provider`. The Studio's worktree is `ds-<label>-studio` (off Orca, made by the project's
   worktree tool);
4. files the Studio's start for the loop, which starts its claude (the `studio` row's model and effort, on the
   default login or the `--account` given) and adopts it; a Studio already running there is left alone. With the
   loop down, an Orca project's Studio is started directly; off Orca it stops and says to start the loop;
5. files the board's serve wish and prints its address, and how to reach the Studio.

Idempotent: re-run to reconcile (reuses the clone, no second Studio). Report what it brought up, the board's
address, and how to reach the Studio (the Orca worktree, `tmux -L ds-<label> attach -t _studio`, or herdr's
command, as it printed).
