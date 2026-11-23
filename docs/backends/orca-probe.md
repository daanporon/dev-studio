# Orca without Runs: probe

Probed on the host with Orca CLI 1.4.246 (2026-11-23), using a scratch worktree made by plain
`git worktree add -b <branch> <path> HEAD` from this repo and nothing from Orca's `worktree create`.
The scratch worktrees, tabs and branches were removed after the probe. No dev-studio behaviour changed.
Ids below are shortened where long: `R` is the repo id `7e1bb2f9-…`, `W` is `~/orca/workspaces/dev-studio-public/probe-plain-u1`.

## Summary: what `orca-lite` can claim

| Capability | `orca-lite` | Why |
| --- | --- | --- |
| terminals in a plain worktree | yes | `terminal create` and `terminal send` work (Q1) |
| `parents native` | **yes, with a limit** | `worktree set --parent-worktree` works and the parent lists the child (Q3); the plain worktree is not in `worktree list` or `worktree ps`, so read lineage with `worktree show` |
| `state native` | **no** in a git-made worktree, **yes** in an Orca-made one | `worktree ps` never lists a git-made worktree, so there is no `agents[].state` for a tab in it (Q2); it lists one made by `orca worktree create` with no agent and reports the plain tab's state (Q5) |
| `turn_confirm` | **no** in a git-made worktree, **yes** in an Orca-made one | no Orca agent state to confirm a turn in a git-made worktree; in an Orca-made one a new `stateStartedAt` with `working` confirms it (Q5) |
| tab close without a dispatch | explicit only | nothing closes or keeps a tab for you (Q4) |
| tab shown in Orca's window | unproven | on this headless host every tab is a background surface, `--focus` too (Q6) |

## Probe

### Q1 Does Orca list and accept a terminal in a worktree it did not create, and under what id?

```
$ git worktree add -b probe-scratch-u1b W HEAD
$ orca worktree list --json | (rows with "probe-plain")      -> none (68 rows, truncated: false)
$ orca worktree ps --json   | (rows with "probe-plain")      -> none
$ orca worktree current --json     (run inside W)            -> selector_not_found: No Orca-managed worktree contains the current directory
$ orca worktree show --worktree path:W --json                -> ok, id "R::W", branch refs/heads/probe-scratch-u1b
$ orca terminal create --worktree "id:R::W" --title probe-plain --command 'echo hello-probe; sleep 300' --json
  -> ok, handle term_46bac873-…, worktreeId "R::W", surface "background",
     warning "Orca could not make it discoverable"
$ orca terminal list --json     -> the terminal is listed, worktreeId "R::W", preview "…hello-probe"
```

Answer: yes for terminals, no for the worktree lists. The id is `<repo-id>::<absolute path>`, the same shape as an Orca-made worktree.
`worktree show` (by `path:`) finds it, and `terminal create/list/send/read/show/close` accept it. `worktree list`, `worktree ps` and
`worktree current` do not list it, before or after the terminal exists. The repo must already be one Orca knows: a worktree of
this repo placed in the scratchpad under `/tmp` was not found by `show` (`selector_not_found`), one under
`~/orca/workspaces/dev-studio-public/` was. The terminal came back as a background surface (a tab that is not shown in the UI), still writable.

### Q2 Does `worktree ps` report `agents[].state` for a Claude tab never bound by `worker-start --terminal`?

```
$ orca terminal create --worktree "id:R::W" --title probe-claude --command 'claude "reply with the single word ok, nothing else"' --json
  -> handle term_81899c22-…; Claude stops at the folder-trust prompt (this repo's .claude/settings.json declares hooks)
$ orca terminal send --terminal term_81899c22-… --text $'\e[A'; orca terminal send … --enter   (choose "Yes, I trust this folder")
  -> Claude answers "● ok"
$ orca worktree ps --json | (rows with "probe-plain")        -> none, so no agents[] at all
$ orca terminal show --terminal term_81899c22-… --json       -> handle, worktreeId, title, preview, lastOutputAt; no agent or state field
$ orca orchestration worker-list --json | grep -c probe-plain -> 0
```

Answer: no. Orca does start the tab's `claude` with its own agent-view plugin (the typed line shows `--plugin-dir …/orca-agent-view`),
but `worktree ps`, the only place `agents[].state` appears, does not list the worktree, and `worker-list` has no entry for the tab.
The first `claude` also stops at the trust prompt in a fresh worktree path, and an Enter there picks "No, exit" if the selection is
not moved first, so a start in a plain worktree must handle that prompt (or trust the path beforehand).

### Q3 Does `worktree set --parent-worktree` work on such a worktree?

```
$ orca worktree set --worktree "id:R::W" --parent-worktree "path:<this builder worktree>" --json   -> ok
$ orca worktree show --worktree "id:R::W" --json     -> parentWorktreeId "R::<this builder worktree>", childWorktreeIds []
$ orca worktree show --worktree "path:<this builder worktree>" --json   -> childWorktreeIds ["R::W"]
$ orca worktree list --json / ps --json              -> still no row for W
```

Answer: yes. The link is stored and shows on both worktrees through `worktree show`. It does not make the child appear in `worktree list` or `ps`.

### Q4 Does anything close or keep a tab differently without a dispatch?

```
$ orca terminal close --terminal term_81899c22-… --json      -> ok, ptyKilled true; gone from `terminal list`
$ orca terminal close --terminal term_46bac873-… --json      -> ok; gone from `terminal list`
```

Answer: the tabs stayed until they were closed by hand, an idle Claude tab (finished its turn) and a `sleep` tab alike. There is no Run, so no
dispatch-end or Run-close accounting acts on them (`worker-list` is empty for them), and nothing is reclaimed for the Run's worker budget.
`terminal close` (one terminal, `--tab`, or `--worktree … --all`) is the only way a tab ends, so `orca-lite` must close its own tabs and cannot lean on
Orca to release them.

## Probe of an Orca-made worktree (U8b)

Probed the same day with the same CLI, after the first probe found Orca does not see a git-made worktree. The scratch worktree
was made by `orca worktree create` with no `--agent` and no Run, as the `orca` worktree provider does. `M` is the main checkout
of this repo, `P` the builder worktree used as parent, `W2` is `~/orca/workspaces/dev-studio-public/probe-u8b-q5`.

```
$ orca worktree create --repo path:<this builder worktree> --name probe-u8b-q5 …   -> repo_not_found
$ orca worktree create --repo path:M --name probe-u8b-q5 --branch probe-scratch-u8b --base-branch origin/main \
    --parent-worktree path:P --setup skip --json
  -> ok, worktree.id "R::W2", path W2, branch refs/heads/probe-scratch-u8b, baseRef refs/remotes/origin/main,
     parentWorktreeId "R::P", displayName probe-u8b-q5, cliProvenance created-by-cli
$ orca worktree list --json | (rows with "probe-u8b-q5")     -> one row
$ orca worktree ps --json   | (rows with "probe-u8b-q5")     -> one row, agents []
$ orca terminal list --json | (rows in W2)                   -> one shell tab Orca opened itself at create, titled "<user>@<host>: W2"
```

`--repo` must name the repo's main checkout (or its id); a linked worktree's path is `repo_not_found`. The create opens one plain
shell tab in the new worktree by itself, so a stray-shell check must expect it. Orca picks the folder itself
(`~/orca/workspaces/<repo>/<name>`), and it never checks out a branch that already exists: asked for an existing branch it made
`<branch>-2` from the base, in a folder `<name>-2`. So the `orca` provider refuses an existing branch it does not already hold,
and refuses (after removing it again) a worktree Orca made under another path or branch than the one asked for.

### Q5 In an Orca-made worktree with no `--agent`, does a tab opened by `terminal create` (no `worker-start`) get `agents[].state` in `worktree ps`?

```
$ orca terminal create --worktree "id:R::W2" --title probe-u8b-claude --command 'claude "reply with the single word ok, nothing else"' --json
  -> ok, handle term_5fea1623-…, surface "background", warning "Orca could not make it discoverable"
   (no folder-trust prompt: the screen went straight to the turn)
$ orca worktree ps --json | (agents of W2)    -> [{state "done", agentType "claude", hasLivePty true, paneKey "<tab>:<leaf>",
                                                  prompt "reply with the single word ok…", stateStartedAt 1795451157688}]
$ orca terminal send --terminal term_5fea1623-… --text 'count slowly from 1 to 60, …' --enter
$ orca worktree ps --json | (agents of W2)    -> [{state "working", stateStartedAt 1795451221081, prompt "count slowly from 1 to 60, …",
                                                  programStatus.state "working"}]
```

Answer: yes. `worktree ps` lists the Orca-made worktree and reports `agents[].state` for the plain tab (`working` during a turn,
`done` after it), with the tab's `paneKey`, the turn's `prompt` and a `stateStartedAt` that moves when a new turn starts, so a
turn start can be confirmed by a new `stateStartedAt` with `working`. Claude started without the folder-trust prompt the git-made
worktree showed (Q2). A first-run Claude dialog ("Teach auto mode about your environment?") did take the next typed line, and an
Esc cleared it; a start must still look at the screen once before it types.

### Q6 Is that tab visible in Orca's window rather than a background surface?

```
$ orca status --json                           -> app.desktopWindowStatus "blocked", remoteUpdateSupport.installMode "unsupported-headless-serve"
$ orca terminal create --worktree "id:R::W2" --title probe-u8b-focus --command 'sleep 600' --focus --json
  -> ok, surface "background", the same "could not make it discoverable" warning
$ orca terminal focus --terminal term_5fea1623-… --json   -> ok, navigated false
$ orca terminal list --json | (rows in W2)     -> the shell tab and both new tabs, each with its own tabId, the same fields as a
                                                  worker-start tab (no surface field on any of the 81 rows)
$ orca worktree rm --worktree path:W2 --delete-branch --json   (after one commit on the branch)
  -> ok, removed true, preservedBranch {branchName probe-scratch-u8b}; the folder and all three tabs are gone, the branch is kept
```

Answer: not provable on this host. Orca here runs as a headless `serve` with no desktop window attached, so every `terminal create`
answers `surface "background"`, with `--focus` too, and `terminal focus` cannot navigate. The tab itself is no different from a
worker's: it is a tab of the worktree in `terminal list` with its own `tabId`, and the worktree is in `worktree list` and `ps`, which
the git-made one never was (Q1). A client attached to Orca should therefore show it under the worktree; that is to be checked by eye
in the Orca window during the orca-lite trial. `worktree rm` keeps a branch with unmerged commits even with `--delete-branch`
(`preservedBranch`) and closes the worktree's tabs.

## What this means for `orca-lite`

- Claim: terminal start, send, read, close in a plain worktree; `parents native` through `worktree set --parent-worktree`, read back with `worktree show`.
- Do not claim `state native` or `turn_confirm`: take working/idle from the screen or the session transcript.
- Own the tab lifecycle, including the folder-trust prompt on a first start.
- In a worktree the `orca` provider makes (Q5, Q6), these change: `state native` is provable (`worktree ps` `agents[].state` for the
  tab's `paneKey`), and `turn_confirm` can be read from a new `stateStartedAt` with `working`. No trust prompt was seen there; a
  first-run dialog can still take the first typed line. Whether the tab is shown in Orca's window is to be checked by eye in the trial.
