---
description: List the accounts agents run on, or disable/enable one so no pick uses it
argument-hint: [list] | disable <agent>:<account|label> | enable <agent>:<account|label>   (omit to list)
allowed-tools: Bash(~/.dev-studio/bin/ds account:*)
---
Run `~/.dev-studio/bin/ds account $ARGUMENTS` and show its output.

- List (no arguments, or `list`): JSON with each account's `agent`, `account`, `label`, `plan`,
  `state` (`enabled` or `disabled`), whether accounts.tsv still lists it (`listed`) and how many
  members run on it now (`running`). Show it as a short table.
- `disable <agent>:<account|label>` — no pick puts a member on that account any more: not a start,
  restart, limit move, fallback return or held pick. Members already running on it keep running
  and move at their next restart (a resumed squad's members on it start fresh from their journal
  on another account). An agent whose accounts are all disabled starts nothing until one is
  enabled; it never falls back to its default login.
- `enable <agent>:<account|label>` — the account is pickable again.

The name is an account id or its accounts.tsv label (such as an email). An unknown or ambiguous
name exits 2: show the error and the list, then ask which account was meant. The switch is
host-wide (every project) and lives in loop.db, so an accounts.tsv refresh keeps it.
