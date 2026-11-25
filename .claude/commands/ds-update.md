---
description: Bring EVERYTHING to the latest dev-studio — pull, relink, and do only what the new commits need (restart / reload / nothing)
argument-hint: [<project>]   (run in the Studio)
allowed-tools: Read, Bash
---
The one command to bring this project fully up to date with the latest dev-studio — **code,
commands, instructions, AND skills**. Run it in the Studio. Do the steps in order:

1. **Pull + relink** the dev-studio checkout, and learn whether its branch actually moved —
   a restart only earns its keep when code or skills changed. If the branch is unchanged, a
   restart just ends every worker's session and starts a new one for nothing, littering each
   worktree with dead sessions.
   ```
   "$(readlink -f ~/.dev-studio)/bin/host/update-host.sh"
   ```
   It moves the checkout to the head of the branch it is on (`origin/<branch>`, not always
   `origin/main`: on another branch it stays there), reinstalls and, when the commit moved,
   restarts a running loop so the new code runs and its migrations apply. A rollback stays
   explicit: `git checkout main` and `bin/host/install.sh`.
   (`install-skills.sh --muse-only`, which it runs, refreshes the Muse copies of the passing
   ce-* skills (from the newest installed CE plugin version) *and* the ds skill —
   idempotent, a quiet no-op when `muse` is not installed, and a failing
   `muse skills install` only warns, so it is safe to run on every update.)
   It then runs `install-skills.sh --check`: an `update: WARNING` block names any Claude account a
   role would stall on (no ce-* skills) and the repair, `bin/host/install-skills.sh`. Show it to the
   operator; it never changes the exit code or the `DS-UPDATE:` line.

2. **Branch on what step 1 printed:**
   - **`refused`** or **`failed`** (it exits non-zero) → **stop here.** Show the line to the
     operator; it says where the host is and what to run. A detached checkout is refused: it has
     no branch to follow, so `git checkout` one first.
   - **`advanced …`** or **`already current`** → bring this project's squads to the checkout, doing
     only what the new commits need (graded):
     ```
     ~/.dev-studio/bin/commands/update-squads.sh <project> --auto
     ```
     (use your own project label, or `$ARGUMENTS`). The squads' last commit is recorded per project
     (`state/<project>/squads-rev.json`), so after `already current` it still refreshes a project the
     checkout moved ahead of (another project's `/ds-update` pulled it), and is a no-op
     (`squads already on <sha>`) when this project's squads are current — running it on a hunch
     churns nothing. It prints one summary line `update-squads: [<project>] <need> — <classes> — <n> wish(es)`:
     - **`none`** (code only): scripts run their latest version; no worker restarts, nothing to do.
     - **`reload`** (instructions changed): every worker re-reads its instruction files, no new session.
     - **`restart`** (skills changed, or no record of the squads' commit): every worker restarts once idle.
     Show its output, then do step 3.

3. **Refresh the Studio itself** — after `reload` or `restart`, update-squads also wrote a reload
   wish on this Studio (never a restart; the summary says `one a reload of the Studio`). The loop
   types a `dev-studio reload:` line into this terminal once you are idle with an empty prompt: re-read
   `~/.dev-studio/AGENTS.md` and `~/.dev-studio/studio/studio.md` then, and run the `ds reload ack`
   command it ends with. Only when step 2 printed `restart` with `skills` among its classes, type
   `/reload-skills` here too: the loop does not refresh the Studio's skills from a `/ds-update` run here
   (no restart/reopen needed). An update started from the board or `ds update` is different: the loop
   types `/reload-skills` into the Studio itself once it is idle (Claude Studio, skills among the classes).
   After `none` or `squads already on …` there is nothing to refresh.

Report what refreshed. **When to use the others instead:** `/ds-reload` = re-read instructions
only, no new sessions (quick, but won't pick up new skills); `/ds-restart` = restart workers
without pulling (recover a wedged agent); `ds up <project>` (a shell command) = create/reconcile the Studio for a project.
`/ds-update` is the "I just pulled, bring everyone fully current" button — and now a no-op when
there's nothing new, so running it on a hunch won't churn sessions.
