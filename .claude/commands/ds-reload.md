---
description: Reload dev-studio instructions — yourself (in a role terminal) or all squads (in the Studio)
argument-hint: [<project>]   (only used in the Studio; omit inside its own Studio)
allowed-tools: Read, Bash(~/.dev-studio/bin/commands/notify-squads.sh:*)
---
Reload the latest dev-studio **instructions** from disk. Scripts you call already
run their latest version; only instruction files need a re-read. Your startup
prompt says who you are — act on that:

- **If you are a role agent** (Lead, Thinker, Builder, Reviewer, Tester, Researcher):
  **reload yourself** — re-read `~/.dev-studio/AGENTS.md` and your own
  `~/.dev-studio/roles/<your-role>.md` (and any convention files they point to that
  bear on your current work), then continue. If you are the **Lead**, also write a
  reload wish for each running child — the loop delivers it to their own inbox, and
  each child confirms with `ds reload ack`:
  ```sh
  for r in $(~/.dev-studio/bin/lib/directory.sh list --project <label> --json | jq -r '.[] | select(.squad=="<topic>" and .name!="lead") | .name'); do
    role=${r%%-*}; sfx=${r#"$role"}; sfx=${sfx#-}
    if [ -n "$sfx" ]; then m="<label>/<topic>/$role/$sfx"; else m="<label>/<topic>/$role"; fi
    ~/.dev-studio/bin/ds want member "$m" --reload --by lead
  done
  ```
- **If you are the Studio**: **reload all squads, then yourself** — run
  `~/.dev-studio/bin/commands/notify-squads.sh <project>` (use your own project label; or
  `$ARGUMENTS`) and show its output. It writes a reload wish on every roster member;
  the loop delivers each one to its owner's inbox. Then re-read `~/.dev-studio/AGENTS.md`
  and `~/.dev-studio/studio/studio.md` yourself, so your own rules are current too.

So you can run `/ds-reload` in any one terminal to refresh just that agent, or in
the Studio to push a reload to the whole project. Squads also self-refresh each
cycle, so this is only to apply an update immediately.

**This reloads instructions only — not code or skills.** If you just **pulled** a dev-studio
update and want everyone on the latest *everything* (code, commands, and new skills), use
**`/ds-update`** instead (it pulls, relinks, refreshes roles, and restarts the squads).
