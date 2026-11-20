# A shared plugin registry recorded through a managed profile's path dangles when that profile goes

Date: 2026-11-02. Found by the review-plugin-path squad (receipt-guard plan, U1/U2).

## Symptom

Every Claude role on the host lost the `ce-*` skills at once, with no error at launch:

- `claude plugin list` still showed `compound-engineering@compound-engineering-plugin` as
  installed and enabled, so the old `install-skills.sh --check` grep said "ok".
- The headless claude `review-unit.sh` starts had no `ce-*` skills and printed no review report.
  Before U1 the script said "no receipt written; re-run" and **exited 0**; `finish-unit.sh` then
  refused for the missing receipt, and the Builder looped or stalled.
- It hit the `system` login and every managed Orca account whose profile shares the system plugins dir.
  A worktree with its own project-scope entry still worked; dev-studio worktrees fall back to the
  user entry and got nothing.

## Cause

Orca's managed Claude accounts run with `CLAUDE_CONFIG_DIR=<orca-data>/claude-profiles/<id>/home`.
On this host profile `dd3c77e4…` shares the system plugin dir by symlink
(`claude-profiles/<id>/home/plugins -> ~/.claude/plugins`), so it and `system` read one
`installed_plugins.json`.

Claude records `installPath` through the config dir it ran under, without resolving symlinks.
compound-engineering 3.34.0 was last updated (2026-10-31) from profile `6b9a19e7…`, whose `plugins`
was then a symlink too. So the shared registry's user-scope entry said
`…/claude-profiles/6b9a19e7…/home/plugins/cache/compound-engineering-plugin/compound-engineering/3.34.0`.
On 2026-11-02 that profile was re-created as a plain dir (no symlink, a near-empty `plugins/`). The
real files still sat under `~/.claude/plugins/cache/…`, but the recorded path no longer existed.
Claude still lists the entry as enabled, then loads no skills from it. A role launched on the new
`6b9a19e7…` sees no compound-engineering at all.

Re-creating or removing a profile can leave this behind. The cause is the symlinked registry plus an
install or update run from the profile.

## Probe

`bin/lib/lib.sh` `ds_ce_skill_probe <skill> [<dir>]` reads `claude plugin list --json` and resolves the
entry Claude would use for `<dir>` (local > project > user). It checks that
`<installPath>/skills/<skill>/SKILL.md` exists, and prints
`ok` / `missing-path` / `not-installed` / `unknown`.

- `review-unit.sh` preflights `ce-code-review` with it and exits 3 with the repair line (U1).
- `install-skills.sh --check` and `install.sh --check` run `ds_account_skills_check` (bin/lib/lib.sh)
  once per Claude account. It takes the accounts from the backend's `account-list` and each one's
  config dir from `claude-config-dir` (empty = `system`, `~/.claude`). It reads
  `<cfg>/plugins/installed_plugins.json` and `<cfg>/skills/` directly (no `claude` call), so the
  sweep can run it. It checks:
  1. every registered installPath exists (any plugin, any scope; a dangling project-scope entry
     counts only while its `projectPath` exists, else it is a one-line note);
  2. the user-scope compound-engineering install is enabled in `<cfg>/settings.json`
     (`enabledPlugins`), carries every role skill (`DS_ROLE_CE_SKILLS`),
     and `<cfg>/skills/` has `no-mistakes` (missing `lavish` only warns);
  3. the user-scope path is not recorded through a profile's symlinked `plugins/`
     (`ds_account_owner` is the dir that owns the real one). Such a path exists today but dangles when that profile is
     re-created: a warning, exit 0.
  Output is `claude[<account>]: skills ok (<path>)` or a ⚠ block naming the config dir (and its
  plugins symlink), the path and the repair. Any broken account makes `--check` exit 1; the plain
  install stays exit 0. `--tsv` prints `<account>\t<ok|broken|warn>\t<reason>` for the sweep. If the
  backend can't be reached, only the caller's current env is checked.

## Repair

Run `bin/host/install-skills.sh` (account-skills U2). It does the repair below for every account the
backend lists: once per owner of the real plugins dir, under the owner's env, never through a
symlinked profile. It also enables the plugin where an account's `settings.json` doesn't and links the
user skills into each account's `skills/`. It never edits `installed_plugins.json` itself (only
`claude plugin` does) and never touches a project-scope entry: `--check` prints that repair for the
operator.

By hand, run it from the config dir that **owns** the real plugins dir (the symlink target), so the new
`installPath` is recorded through a path that lasts:

```bash
env -u CLAUDE_CONFIG_DIR claude plugin uninstall compound-engineering@compound-engineering-plugin --scope user \
  && env -u CLAUDE_CONFIG_DIR claude plugin install compound-engineering@compound-engineering-plugin --scope user
```

`ds_ce_repair_cmd` prints this line: `env -u CLAUDE_CONFIG_DIR` when the owner is `~/.claude`,
`env CLAUDE_CONFIG_DIR=<owner>` otherwise. Then re-run `bin/host/install-skills.sh --check`; every
account sharing the registry should flip to `ok`.

## Lesson

- "Listed and enabled" is not "loadable". Check the skill file on disk, per config dir.
- With a symlinked, shared plugins dir, install plugins only from the dir that owns it. An install
  run from a managed profile ties the whole host to that profile staying around.
