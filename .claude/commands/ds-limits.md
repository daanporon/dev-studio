---
description: View or change the limits (context thresholds, usage %, token caps) for a project
argument-hint: [<project>] | set <key> <value> | rm <key>   (omit to view)
allowed-tools: Bash(~/.dev-studio/bin/commands/limits.sh:*)
---
Run `~/.dev-studio/bin/commands/limits.sh` to view or change the thresholds in
`conventions/limits.conf` and show its output verbatim.

Resolve the project first: if **you are a project's Studio** (your prompt says
"You are the Studio for project '<label>'"), use that `<label>`; else if
`$ARGUMENTS` starts with a project selector, use it.

- View: `~/.dev-studio/bin/commands/limits.sh show <project>` — every key, its value, and its source
  (`default`, `override`, or `env`).
- Change: `/ds-limits set <key> <value>` → `~/.dev-studio/bin/commands/limits.sh set <project> <key> <value>`.
  `compact_mode_<lead|thinker|builder>` takes `compact`, `clear` or `off` (`off` = the loop never
  compacts that role; `clear` applies to a Lead with nothing in flight or a Thinker with nothing open, else it compacts);
  `compact_mode_studio` takes `compact` or `off`.
- Drop an override: `/ds-limits rm <key>` → `~/.dev-studio/bin/commands/limits.sh rm <project> <key>`.

Overrides are the project's rows in `state/loop.db` (survive `git reset --hard`; `docs/settings.md`). The
loop and the board read them on their next run; an env var (e.g. `DS_RESUME_MAX_CTX`) still wins.
