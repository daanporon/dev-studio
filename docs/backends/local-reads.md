# Local reads: what the loop reads straight from this machine

The backend contract (`conventions/backend.md`, "Contract v2") covers terminals and agent state.
The loop also reads a lot from the host it runs on without asking the backend: processes in `/proc`,
agent transcripts, git, account folders and its own `state/` files. Today the loop, the backend
server and every agent all run on one host, so these reads just work.

When the agents run on another host, each read below has to happen over there: in a small
sideloop on that host that writes the same facts back. **This page is the sideloop's job list.**
Each entry names the file that does the read and what it reads. A read that stays on the loop's
host (because it reads the loop's own files) is marked **loop host**.

Keep this page current: a change that adds a new direct read of `/proc`, a transcript, a git
checkout, an account folder or a disk path adds its line here.

## `/proc`: processes

| File | What it reads |
|---|---|
| `bin/loop/io/proc.ts` | The shared `/proc` reader: per process its pid, ppid, comm, start time, CPU ticks (its own and its reaped children's) and RSS; `cwd`, `uid`, `cmdline` and boot time. Every reader below goes through it. Takes a root, so tests use a fixture tree. |
| `bin/loop/observers/machine.ts` | Load, memory, swap, PSI and per-name CPU groups (`/proc/loadavg`, `meminfo`, `pressure/*`, `stat`), plus disks through `statfs`, into `observed_machine`. |
| `bin/loop/observers/procs.ts` | Each process's tree, mapped to the worktree it belongs to, into `observed_procs` / `observed_host_procs`; each worktree's listening TCP ports (`/proc/<pid>/net/tcp*`, socket inodes in `fd/`) and its containers' published ports. |
| `bin/loop/observers/reviews.ts` | Is a review-unit run still alive: the pid and start time it recorded, checked against `/proc/<pid>/stat`. |
| `bin/loop/observers/cleanup.ts`, `bin/loop/io/tidy.ts`, `bin/loop/fulfil/cleanup-act.ts` | Processes of this uid whose cwd is deleted or inside a `ds-*` worktree; the paths live processes hold (cwds, open files in `fd/`) before anything is removed. |
| `bin/backend/orca.ts` (`agentAccounts`, `agent-accounts` verb) | Each top-level agent's account: its `environ` (`CLAUDE_CONFIG_DIR`, `ORCA_TERMINAL_HANDLE`) and start time, from `$DS_PROC` (default `/proc`). |
| `bin/loop/fulfil/board.ts`, `bin/commands/loop-ts.ts` | Is the pid in a pid file still the board / the loop: `/proc/<pid>/cmdline`. **Loop host.** |

## Transcripts and rollouts

| File | What it reads |
|---|---|
| `bin/loop/observers/state.ts` | Each member's newest Claude transcript under `$DS_TOKEN_DIR` (default `~/.claude/projects/<mangled worktree>/*.jsonl`): path, mtime, size, last model and effort, entrypoint, into `observed_transcripts`; the picker's transcript into `observed_pickers`. |
| `bin/loop/observers/codex.ts` | Each recent Codex rollout `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`: cwd, originator, newest model and effort, into `observed_rollouts`. |
| `bin/loop/observers/chat.ts`, `bin/loop/chat/claude.ts`, `bin/loop/chat/codex.ts` | The bytes appended to a live member's transcript or rollout since the last read, turned into chat turns in `observed_chat`. |
| `bin/loop/reconcilers/compaction.ts`, `bin/loop/core/decide.ts` | A fresh transcript or rollout after a clear (the clear is confirmed); the files of a transcript's folder (the session file and `subagents/`) written inside the idle window. |
| `bin/loop/settings/skills.ts` | The newest `skill_listing` in the session logs under `$CLAUDE_CONFIG_DIR/projects` (or `~/.claude/projects`). |
| `bin/lib/token-cache.ts` (with `bin/lib/token-usage.sh`) | Tokens per role and model from every transcript, only the bytes appended since the last scan. |

## Git

| File | What it reads |
|---|---|
| `bin/loop/io/wt-probe.ts` | Is a worktree safe to remove: `git status --porcelain --untracked-files=all` and commits on HEAD that no remote has. Used by close, the leftover-worktree fulfiller and tidy. |
| `bin/loop/fulfil/worktree.ts` | The checks and the `git worktree` calls around removing a leftover worktree. |
| `bin/loop/fulfil/cancel.ts` | A worktree's HEAD, read and set back (`rev-parse`, `update-ref`) when a unit is cancelled. |
| `bin/loop/io/rescue.ts` | The untracked and ignored files in a worktree, copied into `state/<label>/pages/…` before the worktree is removed. |
| `bin/loop/io/git-dir.ts`, `bin/loop/observers/reviews.ts` | A Builder worktree's git dir and the review-unit files kept there (`ds-review`, `ds-review-log`, `ds-review-stop`, `ds-review-start`). |
| `bin/loop/reconcilers/liveness.ts` | A worktree's HEAD (`git rev-parse HEAD`). |
| `bin/loop/observers/cleanup.ts` | `git worktree list` of each project clone (helper checkouts, `ds-*` folders git lists but the backend does not). |
| `bin/loop/squad/exposed.ts` | The worktree a `ds expose` runs in (`git rev-parse --show-toplevel`). Runs in the role's own shell, on the agents' host. |
| `bin/loop/settings/projects.ts` | A project clone's `origin` URL. |
| `bin/loop/observers/update.ts`, `bin/loop/main.ts`, `bin/loop/settings/settings.ts` | The dev-studio checkout: HEAD, upstream fetch, `rev-list`, `log`, `status`. **Loop host.** |

## Account folders

| File | What it reads |
|---|---|
| `bin/backend/orca.ts` | Each listed account's folder, as its `accounts` row names it: the login file the usage and reset calls read (Claude's `.credentials.json`, Codex's `auth.json`), a Claude folder's `.claude.json` and its `projects/` link; `system`'s `~/.claude`. |
| `bin/lib/accounts-list.ts` | The accounts refresh's folder scan: Orca's `<orca data>/claude-profiles/*/home`, `<accounts root>/<agent>/*` and each agent's own folder: whether the login file is there, and the login id in it (`.claude.json`, `auth.json`). Only the id leaves the file. |
| `bin/lib/account-dirs.ts` | Whether a listed account's folder still exists (the list; the picker's "account gone"). |
| `bin/loop/fulfil/account-add.ts`, `bin/lib/account-folder.ts` | A new account's folder: made with links into the agent's own folder, then watched for the login file, the login id and `.ds-login-exit`; a `--dir` folder's login file and id, read only. The kind's `afterLogin` copies Claude's onboarding keys from the system `.claude.json`. |
| `bin/loop/fulfil/account-move.ts`, `bin/lib/account-folder.ts` | `ds account move`: `cp -a` of an Orca-folder account into the accounts root (Orca's folder is left alone), and the copy's plugin `installPaths` that still point into Orca's folder. |
| `bin/loop/observers/codex.ts` | `~/.codex/sessions/` (see Transcripts). |
| `bin/loop/settings/skills.ts` | `$CLAUDE_CONFIG_DIR` (or `~/.claude`): `commands/`, user skills, `~/.claude.json`'s MCP servers; a project's own `.claude/skills/*/SKILL.md`. |
| `bin/lib/account-skills.ts`, `bin/host/install-skills.sh` | Each Claude account's `plugins/installed_plugins.json`, `settings.json` and `skills/`. Install time, not the loop. |

## Disk

| File | What it reads |
|---|---|
| `bin/loop/observers/disk-usage.ts`, `bin/loop/io/du.ts` | `docker system df --format json` and `du -sk` over each `disk_watch_paths` entry. |
| `bin/loop/observers/cleanup.ts` | The Claude temp root, `cleanup_tmp_globs` and `cleanup_trim_globs` matches, folder sizes through `io/du.ts`. |
| `bin/loop/observers/exposed.ts` | A TCP connect to each `ds expose` URL (a probe from the loop's host, so a port only open on the agents' host reads `host-only` or `down`). |

## `state/`: the loop's own files (loop host)

These stay on the loop's host. A sideloop writes its facts into the same files or rows; the
readers do not change.

| File | What it reads |
|---|---|
| `bin/loop/observers/state.ts` | `accounts.tsv`, `accounts-orca.tsv` and `account-folders.tsv` (the refresh's Orca list and folder scan), `tokens.tsv`, Lavish `state.json` and start log; per project `dispatcher.json`, `requests/<dir>/*.txt`, `alerts.json`, `loop/squad-spent.tsv`, `loop/limited.json`, `picker-done/`, `squads/<topic>.beat`. |
| `bin/loop/observers/documents.ts` | Plans and brainstorms (`squads/*.md`), `journals/*.md`, `cross-squad.md`, `archive/*`. |
| `bin/loop/observers/config.ts` | The shipped `conventions/*.conf`. |
| `bin/loop/observers/update.ts` | `state/loop/host-update.json`, each project's `squads-rev.json`. |
