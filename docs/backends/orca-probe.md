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
| `state native` | **no** | `worktree ps` never lists the worktree, so there is no `agents[].state` for a tab in it (Q2) |
| `turn_confirm` | **no** | no Orca agent state to confirm a turn; it needs the screen or the transcript |
| tab close without a dispatch | explicit only | nothing closes or keeps a tab for you (Q4) |

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

## What this means for `orca-lite`

- Claim: terminal start, send, read, close in a plain worktree; `parents native` through `worktree set --parent-worktree`, read back with `worktree show`.
- Do not claim `state native` or `turn_confirm`: take working/idle from the screen or the session transcript.
- Own the tab lifecycle, including the folder-trust prompt on a first start.
