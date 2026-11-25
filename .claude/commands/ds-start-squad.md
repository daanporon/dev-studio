---
description: Spawn a squad from a plain-language topic (derives the slug, framing, and repo)
argument-hint: <plain description of the topic>   (or explicit --repo/--topic flags)
allowed-tools: Bash(~/.dev-studio/bin/commands/spawn-squad.sh:*), Bash(~/.dev-studio/bin/role/orch.sh:*)
---
The operator's request: **$ARGUMENTS**

Spawn a squad for it, deriving what the operator didn't spell out:

0. **`--framing-file <path>` in `$ARGUMENTS`** (a board Start filed before the loop took them over; the board's
   Start squad dialog now starts its squad through the loop, `squad-start`, and sends you nothing): the brief is in that file.
   Read it only to derive what is missing (the `--topic` slug by the rule in step 2, when there is no `--topic`);
   pass `--framing-file <path>` through to `spawn-squad.sh` with the other flags, and never use `--framing`
   or retype the brief.
1. **Already explicit?** If `$ARGUMENTS` already contains `--repo` and `--topic`,
   pass it straight to `~/.dev-studio/bin/commands/spawn-squad.sh` unchanged.
2. **Otherwise treat `$ARGUMENTS` as a plain-language topic** and derive:
   - `--topic`: a short **kebab-case slug** (lowercase, `[a-z0-9-]`, ~2-4 words)
     capturing the topic — e.g. "add a login page to the web app" -> `login-page`.
   - `--framing`: the operator's sentence, verbatim.
   - `--repo`: run `~/.dev-studio/bin/role/orch.sh project-list`. One project registered -> use its selector.
     Several -> ask which. None -> tell the operator to run `bin/ds up <git-url>` first and stop.
   - Honor intent in the wording: "testing"/"run the env" -> `--type testing`;
     "fire and forget"/"lfg" -> `--autonomy lfg`.
   - `--start plan|brainstorm|ask|investigate|fix` (optional, feature squads): the operator's own `--start` or Start-dialog pick wins over cues. Cues by meaning: something broken the operator wants gone -> `fix`; "investigate", "why does",
     "what is", to understand -> `investigate`; "think about", "brainstorm", "how can we improve", "what makes sense" ->
     `brainstorm`; "small fix", a ticket or note with the decisions made -> `plan`. Unsure -> leave `--start` off
     (the Thinker's Start triage in `roles/thinker.md` picks).
   - `--backend orca|orca-lite|tmux|herdr` (optional): pass the operator's own `--backend` or Start-dialog pick
     through unchanged; never derive one. Left off, the squad starts on the Studio's backend (`ds up <project> --backend <x>` moves the project).
3. **Show the derived slug, repo, and framing**, then run
   `~/.dev-studio/bin/commands/spawn-squad.sh --repo <sel> --topic <slug> --framing "<sentence>" [flags]`
   and report that the squad wish is written: the loop creates its Run, Lead and
   always roles, and the board follows. On a non-zero exit show the exact error and stop.
