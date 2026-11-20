---
description: View or change a project's ship mode (how a squad's finished work reaches the target)
argument-hint: <project> [<mode>|default]   (modes: ce-pipeline | no-mistakes | direct-PR | local-only)
allowed-tools: Read, Bash(~/.dev-studio/bin/commands/ship-mode.sh:*)
---
Show or set how a project ships its squads' work (`conventions/ship-modes.md`). Run from the
Studio.

- **View:** `~/.dev-studio/bin/commands/ship-mode.sh <project>` — prints the project's current mode and
  where it comes from (your override, `conventions/projects.conf`, or the default).
- **Set:** `~/.dev-studio/bin/commands/ship-mode.sh <project> <mode>` — one of `ce-pipeline` (default:
  dev-studio's own routed delivery), `no-mistakes` (the external pipeline gate), `direct-PR`
  (push + PR + babysit, skipping review/simplify/e2e), or `local-only` (commit, no push).
- **Reset:** `~/.dev-studio/bin/commands/ship-mode.sh <project> default` — clear the override and fall
  back to `conventions/projects.conf` / the default.

The mode you set is the project's `ship-mode` row in the loop's database (`state/loop.db`, with a
history row and the backup `state/<label>/settings.export`), so it **survives `git reset --hard` and
`/ds-update`**. It applies on each squad's **next ship** (the Builder
reads the mode at ship time), so no restart is required; run `/ds-reload <project>` afterward
if you want running squads to re-read their briefs immediately. The mode also shows on
`/ds-board` (text and web page) per squad as `ship:<mode>`.
