# Settings

Every setting in one place, grouped by where you change it. For each one:
what it does, its default, its allowed values, and how to change it.

Quick map:

| What | Where it lives | Change it with |
|---|---|---|
| Role models (who runs on what) | `conventions/roles.conf` | `/ds-roles`, or board Settings → Roles |
| Thresholds (context, compaction, picker) | `conventions/limits.conf` | `/ds-limits`, or board Settings → Limits |
| Ship mode (how work reaches its target) | `conventions/projects.conf` | `/ds-mode` |
| Autonomy (checkpoints vs fire-and-forget) | per squad, at spawn | `/ds-start-squad` options |
| Accounts (whose quota a role spends) | `orca account …` + `state/accounts.tsv` | `orca account add`, automatic after that |
| Host behaviour (board, loop) | environment variables | export them where the loop/board runs |

Per-project overrides of roles, limits, models and ship mode are rows in the loop's
database (`state/loop.db`, table `config`), so they survive `git reset --hard` and
`/ds-update`. The repo defaults are never edited in place. Every change goes through
`bin/loop/settings/settings.ts`: `/ds-roles`, `/ds-limits`, `/ds-mode`, the board's Settings
and `ds config set|rm|reset` all write a row and one `config_history` row (who, when,
old and new value; `ds config history`). The board's Settings and Roles tabs show the last one per override (who, when; "imported <date>" for the migration) with an undo button that files a `config-undo` request and so leaves a history row of its own. See [Project overrides](#project-overrides-the-rows-and-their-backup)
for the backup and how to put one back.

## Roles: which agent and model each role runs on

Default roster: `conventions/roles.conf`. One row per role:

```
name  agent  model  spawn  [effort]  [fallbacks]
```

- `agent` — which agent runs the role (`claude`, `muse`). The agent and its
  model are picked together; see `conventions/models.conf` for the valid pairs.
- `model` — the model alias (`sonnet`, `opus`, `fable`, …). Aliases move with
  the agent's latest; never a version number.
- `spawn` — `always` (started at squad spawn), `ondemand` (the Lead starts it
  later), or `elevate` (never starts a terminal; names the model for a one-shot
  call).
- `effort` — optional reasoning effort (`low`, `medium`, `high`, `xhigh`,
  `max`, and `minimal` on models that offer it — see `conventions/models.conf`;
  `-` or blank = the model's default).
- `fallbacks` — optional ordered `agent:model[:effort],…` list. The picker
  tries the role's own model first, then each fallback in order. `-` = none.

The default roster:

| Role | Agent | Model | Spawn | Effort | Fallbacks |
|---|---|---|---|---|---|
| `lead` | claude | sonnet | always | default | none |
| `thinker` | claude | opus | always | default | none |
| `thinker-deep` | claude | fable | elevate | default | none |
| `builder` | claude | opus | ondemand | default | claude:sonnet, muse:muse-spark-1.3 |
| `builder-standard` | claude | sonnet | ondemand | default | claude:opus |
| `builder-standard-babysit` | claude | sonnet | ondemand | default | claude:opus |
| `builder-hard-babysit` | claude | sonnet | ondemand | default | claude:opus |
| `builder-review` | claude | opus | elevate | default | muse:muse-spark-1.3 |
| `builder-review-standard` | claude | sonnet | elevate | medium | muse:muse-spark-1.3 |
| `review-leaf` | claude | sonnet | elevate | default | claude:opus |
| `reviewer` | claude | fable | ondemand | default | claude:opus |
| `tester` | claude | opus | ondemand | default | none |
| `researcher` | claude | fable | ondemand | default | none |

Six rows need one extra line:

- `thinker-deep` is the model the Thinker passes to `ce-plan` for a hard topic.
- `builder-standard` is the model a Builder gets when its unit is tiered
  `standard`, and only in the `ce-pipeline` ship mode (whose review runs on the
  `builder-review-standard` row for a standard unit).
  Everything else uses the `builder` row. See `conventions/plan-shape.md`.
- `builder-review` is what `bin/review/review-unit.sh` runs a `hard` unit's full
  review on; `builder-review-standard` is the cheaper row every delta review
  and every other unit runs on (a unit with no tier counts as `standard`).
  Without a `builder-review-standard` row everything runs on `builder-review`.
- `review-leaf` names the model for the merge, report and validator steps of a
  review (the bookkeeping that collects and formats the reviewers' findings). It
  resolves like the review rows (account, fallbacks, usage limit); when it
  resolves to a Claude model, the review prompt tells ce-code-review to run those
  subagents on it while every reviewer stays on the session's model, and the review
  log line names it after the engine in the same column (`claude:opus leaf=sonnet`). With no row, or a review on Codex
  or Muse, nothing changes.
  A review never starts on a fallback agent whose
  accounts are all disabled or limited, and the cross-model peer runs only on
  an enabled, unlimited account.
- `builder-standard-babysit` and `builder-hard-babysit` are what a Builder
  moves to once its unit's PR is open and it sits idle: the loop restarts it
  fresh in the same worktree, with a prompt naming the unit, branch, PR and
  journal, to take the PR to merge-ready (`bin/loop/reconcilers/phases.ts`).
  Not in `local-only` mode. With no row, it stays on `builder-<tier>` /
  `builder`.

Change it per project (the normal way):

- `/ds-roles` — `bin/commands/roles.sh list [<project>]` shows the effective roster;
  `set <project> <role> <agent> <model> [spawn] [effort] [fallbacks]` writes that one
  role's row for the project; every role the project has no row for runs the default
  row (U267); `reset <project> <role>` (or `rm`) drops the project's row, so the role
  follows the default again.
- Web board: ⚙ Settings → **Roles** tab (the same row, via `POST /api/roles`).
  A change applies to the next spawn, not to running roles.

## Limits: thresholds the board and loop use

Defaults: `conventions/limits.conf`, one `key value` per line. Resolution
order for every key: **env var** beats **per-project override**
(the project's `limits.conf` rows) beats **repo default**. `show` marks each
key's source.

| Key | What it does | Default | Allowed | Env override |
|---|---|---|---|---|
| `context_warn` | Context tokens at which the board goes amber; a Builder under this resumes on an account switch | 100000 | non-negative integer | `DS_RESUME_MAX_CTX` |
| `context_compact` | Context tokens at which the board goes red; an idle agent above this gets compacted | 150000 | non-negative integer | `DS_LIMIT_CONTEXT_COMPACT` |
| `context_compact_lead` / `_thinker` / `_builder` / `_studio` | Per-role threshold for the loop's idle compaction; falls back to `context_compact` when unset | 100000 / 120000 / 150000 / 150000 | non-negative integer | `DS_LIMIT_CONTEXT_COMPACT_<ROLE>` |
| `compact_idle_min` | Minutes idle before an agent is compacted. Main sessions cache for one hour: an agent woken within it needs no compaction, one left idle compacts just before its cache expires. Keep it under 60. | 55 | non-negative integer | `DS_LIMIT_COMPACT_IDLE_MIN` |
| `compact_cooldown_min` | Minutes between two compactions of the same agent | 30 | non-negative integer | `DS_LIMIT_COMPACT_COOLDOWN_MIN` |
| `auto_compact_lead` | Auto-compact window (tokens) set at launch for the Lead | 200000 | non-negative integer, or `off` (= the agent's own) | `DS_LIMIT_AUTO_COMPACT_LEAD` |
| `auto_compact_thinker` | Same, for the Thinker | 200000 | same | `DS_LIMIT_AUTO_COMPACT_THINKER` |
| `auto_compact_builder` | Same, for Builders | 200000 | same | `DS_LIMIT_AUTO_COMPACT_BUILDER` |
| `auto_compact_studio` | Same, for the Studio (a `studio` role, not `auto_compact_other`) | 200000 | same | `DS_LIMIT_AUTO_COMPACT_STUDIO` |
| `auto_compact_other` | Same, for every other role | 400000 | same | `DS_LIMIT_AUTO_COMPACT_OTHER` |
| `limit_pct` | Account usage % treated as the limit | 100 | non-negative integer | `DS_SWEEP_LIMIT_PCT` |
| `limit_wait_max` | Minutes: a limited Lead, Thinker or Builder whose limit reset is known and at most this far away is parked until the reset (one `limit_wait` event, a poke after the reset) instead of being switched to another account; a later or unknown reset switches. 0 = always switch | 30 | non-negative integer | `DS_LIMIT_LIMIT_WAIT_MAX` |
| `pick_session_max` | Picker skips an account at or above this session % | 95 | non-negative integer | `DS_PICK_SESSION_MAX` |
| `pick_weekly_max` | Picker skips an account at or above this weekly % (opus/fable models) | 95 | non-negative integer | `DS_PICK_WEEKLY_MAX` |
| `pick_room_pct` | Loop picker: an account has room while its real session % + the load of members placed on it in the last `pick_ttl_s` + the new member's stays under this. Members running longer are already in the real %, so they add nothing | 95 | non-negative integer | `DS_LIMIT_PICK_ROOM_PCT` |
| `pick_load_hard` / `pick_load_standard` | Session % one hard / standard (or untiered) member adds to its account while it counts as newly placed | 20 / 10 | non-negative integer | `DS_LIMIT_PICK_LOAD_HARD` / `DS_LIMIT_PICK_LOAD_STANDARD` |
| `pick_load_lead` / `pick_load_thinker` | Session % one Lead / Thinker adds to its account while it counts as newly placed, whatever its tier (U180). Measured on 2026-11-09/10: the real 5-hour % rose at most 3% on a Max account in a Lead or Thinker's first 10 minutes, so 1 × the Max scale of 4 | 1 / 1 | non-negative integer | `DS_LIMIT_PICK_LOAD_LEAD` / `DS_LIMIT_PICK_LOAD_THINKER` |
| `pick_ttl_s` | Seconds a newly placed member's load counts (a start or a `run-switch`); also how long a limit switch the actuator holds back keeps its first pick before it picks again, and how long a fallback stop holds its reservation (below) | 600 | non-negative integer | `DS_LIMIT_PICK_TTL_S` |
| `fallback_return_min` | Loop: an idle member on a fallback rung (any rung below the first of its `roles.conf` row, on any agent) is moved to the highest rung above it that has room again; this is the minutes between tries per member. `0` turns it off. In one tick the moves share the room: a member is stopped only when its pick, with the tick's earlier picks and moves counted as load, still lands above its rung, so three Thinkers aiming at room for one stop one. The stop reserves that place until the member is placed or `pick_ttl_s` passes: other picks count it as load, and its own start keeps it while it still fits. A start that lands on another agent or model anyway logs `fallback_missed` with the pick's reason, and the member waits out this window | 15 | non-negative integer | `DS_LIMIT_FALLBACK_RETURN_MIN` |
| `unit_token_x` | Runaway-unit alert: × the median of done units of its tier | 3 | non-negative integer | `DS_UNIT_TOKEN_X` |
| `unit_token_max` | …or this absolute cache-write cap | 20000000 | non-negative integer | `DS_UNIT_TOKEN_MAX` |
| `max_builders` | Live Builder agents the project runs at once (U145). A Builder start over it (add-role, a restart, a resume after pause, a crash restart) waits for a slot: `add-role.sh` exits 3 `WAIT slot: <project> at max_builders <n>` and leaves the unit planned; the loop leaves the wish open and asks again each tick. A free slot goes to the oldest work first: a dispatched unit before a planned one, then the lower unit id. Live = not paused and its agent runs; a live Builder's own restart (hung restart, run-switch, limit move, phase switch) never waits. The check lives in the account pick (`bin/loop/capacity/pick.ts`, so `bin/ds pick` answers it too); Leads, Thinkers and the other roles are never limited | - (no limit) | positive integer, or `-` | `DS_LIMIT_MAX_BUILDERS` |
| `max_light_builders` | Light lane (adaptive-builder-capacity U3): extra Builder slots on top of `max_builders` that only units marked `Lane: light` on their plan line take. A normal unit starts while live normal Builders < `max_builders` and the live total < `max_builders` + `max_light_builders`; a light unit starts while the live total is under that sum, in a light slot, or in a free normal slot while no normal unit of the project waits. The wait names both lanes: `WAIT slot: <project> normal 6/6, light 2/2`. Needs `max_builders` set; `0` is today's single lane | 0 | non-negative integer | `DS_LIMIT_MAX_LIGHT_BUILDERS` |
| `light_lane_cpu_h` | CPU-hours (the unit's `unit_cpu`) after which a light unit counts as normal: it keeps running, the loop records one `unit_lane_moved` event (unit, CPU-hours, rule), and the project starts no new normal unit while normal Builders are over `max_builders` | 3 | positive number | `DS_LIMIT_LIGHT_LANE_CPU_H` |
| `focus_squad` | The project's focus squad (squad-priority U1; one at most). While Builder seats are full, its queued units take the next free seat after urgent units and units that block started work, ahead of older units of other squads, never over `max_builders`. Per lane it gets at most that lane's seats − 1, so the last normal and the last light seat still go oldest first and a one-seat lane ignores it. Only a live feature squad can be set; a suspended one keeps the key without effect; the loop clears it when the squad closes, finishes or goes. Set with `ds focus <project> [<squad> \| --clear]` or the board; each change logs one `focus_set` event | - | a squad slug, or `-` (none) | `DS_LIMIT_FOCUS_SQUAD` |
| `flow_stuck_floor_min` | The board's Flow calls a card late when its time in the stage passes the larger of twice the typical time and this many minutes. The typical time is the median over the project's units done in the last 7 days, per tier (standard, hard) once a tier has 5 of them, else for the project | 10 | minutes | `DS_LIMIT_FLOW_STUCK_FLOOR_MIN` |
| `flow_quiet_min` | A late Flow card reads **stuck** (red) only when its Builder shows no sign of work for this many minutes: not working, no review or checks running, no output, and under 5% CPU. A late card whose Builder is active reads **slow** (amber). A stale card, and a ready PR waiting for its Builder to run `finish-unit`, are stuck whatever the activity (U279) | 20 | positive integer, minutes | `DS_LIMIT_FLOW_QUIET_MIN` |
| `builder_host_brake` | With `on`, no new Builder agent starts, in any project that has it on, while the latest host sample (the board's machine panel) crosses a `machine_*_crit` line: load, memory, swap or pressure (U4; the same levels the board colours red). The start waits with `WAIT host: <metric> <value> ≥ crit <line>` and is asked again next tick. A missing or stale sample (older than 3 × `DS_LOOP_MACHINE_S`) never brakes; a running Builder, a live Builder replacing its own agent and every other role are never braked | off | `on` or `off` | `DS_LIMIT_BUILDER_HOST_BRAKE` |
| `restart_rss_gb` | An idle agent whose resident memory (RSS, U149) passes this many GB is restarted once it is idle (U153), at most once per 60 minutes per member; a fresh start drops a Codex agent's retained heap. `-` turns it off | - (off) | positive number, or `-` | `DS_LIMIT_RESTART_RSS_GB` |
| `expected_checks` | Checks a PR must have run before `finish-unit.sh` and the board read it ready; absent or only skipped reads `required:<context>` | - (none) | comma-separated context names, no spaces | `DS_LIMIT_EXPECTED_CHECKS` |
| `auto_merge` | Merge method the loop arms GitHub auto-merge with on a merge-ready unit PR (U166): `off` keeps today's Lead merge poke (KTD17) | `off` | `off`, `squash`, `merge`, `rebase` | `DS_LOOP_AUTO_MERGE` |
| `base_update` | How a Builder brings a moved base into its unit branch (U182): `merge` never rewrites the pushed branch, so it is the default; a rebase needs an operator-approved force-push | `merge` | `merge`, `rebase` | `DS_LIMIT_BASE_UPDATE` |
| `github_budget_share` | Share of the hourly GitHub GraphQL budget (5000 points) the PR observer may spend (U286): the next read waits `max(DS_LOOP_GITHUB_S, cost × 3600 / (share × limit))`, and for GitHub's reset when fewer than two reads' cost remain. Host-wide (one gh user): the smallest share any project sets wins | 0.5 | number above 0, at most 1 | `DS_LIMIT_GITHUB_BUDGET_SHARE` |
| `pr_stale_min` | Minutes a blocked unit PR stays blocked before the loop flags it stale on the board | 0 | non-negative integer | `DS_LIMIT_PR_STALE_MIN` |
| `stale_repoke_min` | Minutes of quiet (no push, Builder idle at its prompt, its worktree under 5% CPU, no check running) after a blocked unit PR's first pr-stale poke before the second comes without a push; `0` = only after a push | 30 |
| `stale_lead_min` | Minutes after a Builder's second pr-stale poke (or after the second's due time, `stale_repoke_min` after the first, when it could not be sent) before a unit PR still not merge-ready is reported to its Lead, once per red stretch | 30 | non-negative integer, `0` = never | `DS_LOOP_STALE_LEAD_MIN` |
| `stale_alert_min` | Minutes after that Lead request before a unit PR still blocked raises one Studio alert for the stretch (U178) | 60 | non-negative integer, `0` = never | `DS_LOOP_STALE_ALERT_MIN` |
| `prompt_wait_min` | Minutes a Builder that Orca reads `working` may sit at its prompt before the loop nudges it: its transcript has not moved, its worktree is under 5% CPU, no review runs on its unit, the only thing open is a background command (say a wait loop that never ends) and the unit has no open PR. The nudge names the command; the idle ladder follows (a second nudge `stale_min` later, then a report to its Lead), and its Builder gets no quiet poke meanwhile (builder-idle-no-pr-card U1) | 20 | non-negative integer, `0` = off | `DS_SWEEP_PROMPT_WAIT_MIN` |
| `msg_chase_min` | Minutes a `ds msg` message may stay unread after its poke before the loop pokes the receiver once more, while it is idle (U277); `0` = never | 15 | non-negative integer | `DS_LIMIT_MSG_CHASE_MIN` |
| `notes_cap` | Most notes a role keeps per project in `notes.sh`; every role prints all its notes at start, so a higher cap costs context in every session of that role. Lowering it deletes nothing: a role over the cap just cannot add until it drops one | 20 | whole number 1-100 | `DS_LIMIT_NOTES_CAP` |
| `msg_reply_alert_min` | Minutes a needs-reply message may get no reply before one Studio alert names sender, receiver and subject; the reply clears it (U277); `0` = never | 60 | non-negative integer | `DS_LIMIT_MSG_REPLY_ALERT_MIN` |
| `required_wait_min` | Minutes a unit PR waits on `required:<context>` alone (no human gate) with its Builder idle before the Builder gets one poke, and again before its Lead gets one request (U179) | 15 | non-negative integer, `0` = never | `DS_LOOP_REQUIRED_WAIT_MIN` |
| `red_repoke_min` | Minutes after the last pr-news poke before a red unit PR whose failed check ran again and failed again gets one more poke naming the failed lanes (U214). Only while the Builder is idle, at most 2 per head; a new head, a new failing check or more threads are news at once | 15 | non-negative integer, `0` = never | `DS_LOOP_RED_REPOKE_MIN` |
| `compact_mode_lead` | How the loop compacts the Lead | compact | `compact`, `clear`, `off` (`off` = never) | `DS_LIMIT_COMPACT_MODE_LEAD` |
| `compact_mode_thinker` | How the loop compacts the Thinker. `clear` types `/clear` only when nothing is open: no open question it asked, the squad past planning, every `<topic>-*-plan.md` approved, no file of its transcript dir (session and `subagents/`) written within `compact_idle_min`, no unread mail; otherwise it types `/compact`. `compact` turns clearing off. | clear | `compact`, `clear`, `off` | `DS_LIMIT_COMPACT_MODE_THINKER` |
| `compact_mode_studio` | How the loop compacts the Studio: `compact` types `/compact` into the Studio's own terminal when it is idle and its input line is empty (see below) | compact | `compact`, `off` (`off` = only the `studio.ctx` card) | `DS_LIMIT_COMPACT_MODE_STUDIO` |
| `studio_move` | What the loop does when the Studio's account is limited: `auto` moves it to the account the picker chooses for the `studio` role (its own tab closed and a fresh one started there from studio.md and its journal), only while it sits idle with an empty prompt; `ask` shows a card whose "move it" answer does the same; `off` only shows the card with the command to run. No adopted Studio terminal or no account with room always gives the card | auto | `auto`, `ask`, `off` | `DS_LIMIT_STUDIO_MOVE` |
| `compact_mode_builder` | How the loop compacts Builders | compact | `compact`, `clear`, `off` | `DS_LIMIT_COMPACT_MODE_BUILDER` |

The Studio's compaction (U263) types `/compact` only into the Studio terminal the loop adopted
(never by worktree: the Studio's worktree also holds the `ds-loop` panes and a shell), at most once
per `compact_cooldown_min`, when its context is at `context_compact_studio` and it is ready: no
output on that terminal and no transcript write for `compact_idle_min`, an empty input line, no
unread mail, no request waiting for the Studio and no open question it asked. The check runs again
right before the text is typed. A busy Studio is left alone. When it is idle but something else
blocks the compaction (text on the input line, unread mail, a waiting request, an open question), the
`studio.ctx` card appears after `DS_LOOP_STUDIO_COMPACT_HOLD_S` seconds (600) and names the reason.
With `compact_mode_studio off`, or when the loop holds no Studio terminal, the Studio gets only the
card, once it is idle. The card clears once the context drops.

A Studio out of credits (U264) is moved per `studio_move` through the one terminal the loop adopted,
under the same ready check, which runs again right before anything is closed. The loop closes that
tab only (never the worktree's other panes), starts the Studio in the same worktree on the pick
(`studio-start`, with the auto-compact window and the Studio's skill overrides), tells it to read its
journal briefing, and records the new terminal; the board shows "Studio moved to <agent>:<account>"
for a day. A Run the old tab coordinated is bound again from a fresh `ds-loop` pane, and the rewake
hook lives in the worktree, so the new tab keeps it. While the Studio is busy nothing happens; when
it stays not ready (text on the input line, unread mail, a waiting request) for
`DS_LOOP_STUDIO_MOVE_HOLD_S` seconds (600) the `studio.limit` card says why and gives the command to
run. One move at a time: the next waits `DS_LOOP_STUDIO_MOVE_SETTLE_S` (300) after the last try. A
start that fails after the close leaves a `studio.move` card with the command to start it by hand. A
replay of a start that may still be running (a crash, or the background call timing out) records the
new Studio tab it finds instead of starting another, or waits `DS_LOOP_STUDIO_MOVE_START_S` (300)
first. With `ask`, only answering the card with its suggestion "move it" approves the move; Dismiss
or any other answer (for instance after restarting it yourself) only clears the card.

A red unit PR is one stretch from the read that blocks it until it is ready, merged,
closed or waits on a `required:<context>` alone; GitHub reshuffling its reasons on one
head does not start a new one (U178). In a stretch the Builder gets two pr-stale pokes (the second after a push, or after `stale_repoke_min` of quiet),
plus one per new session (placed or cleared after its last poke about the PR); pr-news
only for a new head or a blocking reason the stretch has not sent yet; the Lead one
request `stale_lead_min` after the second poke (or after its due time when the loop could not
send it: a limited, paused or busy Builder, a draft in its prompt); and the Studio one alert
`stale_alert_min` after that.

A unit PR that waits on `required:<context>` alone waits on a context nobody has posted,
often the Builder's own ship receipt (U179). When none of those contexts is a human gate
(those go through the PR-question path), the wait is `required_wait_min` old and the
Builder has been idle that long, the Builder gets one poke: post it if its ship step
does, else ask the Lead. `required_wait_min` later, still waiting on the same contexts,
the Lead gets one request. A new head or other missing contexts start over; a working
Builder and a `local-only` squad get nothing.

Change it:

Review thresholds apply when a Builder runs `bin/review/review-unit.sh`:

| Key | Default | Values and effect |
|---|---|---|
| `review_block_severity` | `P1` | `P0`, `P1`, `P2`, `P3`; findings at or above this severity block |
| `review_block_severity_risky` | `P2` | Same values; threshold for a finding on a matching risky path |
| `review_risk_paths` | `-` | Comma-separated shell globs on repo-relative file paths; `-` means none. A delta re-review touching one runs full |
| `briefing_time` | `off` | `HH:MM` (24h, host clock) the Studio's morning brief is sent; `off` = no brief |
| `briefing_days` | `mon-fri` | Days it is sent: `daily`, `mon-fri`, or a comma list/ranges (`mon,wed,fri`, `mon-wed,fri`) |
| `briefing_merges_lag_min` | `15` | Minutes (0-120) the repo's merge record may end before the brief closes and still count as `complete up to HH:MM`; further back it is `partial` (counts still shown). The next brief carries the unread minutes over |
| `review_delta_wide_lines` | `400` | A delta re-review with more non-test executable changed lines than this runs wide: the full reviewer set on the delta's scope, not the whole branch (legacy `review_delta_full_lines` still read when unset) |
| `review_skip_lenses` | `-` | Comma-separated reviewer lenses the project drops (`security`, `learnings`, …); never `correctness`; `-` means none |
| `host_tidy` | `report` | `report`: the loop only keeps the Host tidy card. `apply` (exactly that word): it also removes, one at a time per project, each row the card calls removable, after reading it again (processes are stopped, Claude temp dirs and glob files removed, helper checkouts and orphaned worktrees removed without force, their branches kept). A paused or refused project gets no removal. Each removal writes one `cleanup_removed`, `cleanup_stopped` or `cleanup_failed` event. The card is in Needs-you only when something needs the operator (a refusal or failed backend list, an invalid glob, a removable row while not `apply`, a failed removal under `apply`) and starts with `Needs you:`; `ds observed cleanup --project <label>` lists every row at any time |
| `cleanup_tmp_globs` | `-` | Comma- or space-separated absolute globs of host temp files the loop may clear: wildcard in the last path segment only, at least 3 literal characters there, and a parent that is not `/`, the home dir, the dev-studio root, the state dir, a workspaces dir or a repo clone. An invalid glob matches nothing. `-` means none. Read whole (`limitLine`), unlike other keys |
| `cleanup_tmp_age_h` | `48` | Hours a match must be untouched before it is cleared; non-negative integer, else 48 |
| `cleanup_on_close` | `-` | Command run in a member's worktree before the loop removes it (read whole, e.g. `docker compose down -v`). A ` #` starts a comment, so point it at a script when the command needs one. `-` means none |
| `disk_card_free_pct` | `20` | A Studio card `Disk <path> low: <free> free (<pct>%)` opens when a disk's free share drops below this percent and names up to 8 consumers (Docker build cache, images and volumes, the Host tidy rows, `disk_watch_paths`). It clears once free space is above the value plus 5 points. `0` = off. The card deletes nothing. |
| `disk_watch_paths` | `-` | Host-level (read from the default row, a project value is ignored): comma- or space-separated absolute paths (a leading `~/` is the home; no `..`, no wildcard) the disk card sizes with `du -sk`, e.g. `~/.bun/install/cache,~/.claude/projects`. Set it through an import like `cleanup_tmp_globs`. |

`cleanup_tmp_globs`, `cleanup_on_close` and `disk_watch_paths` hold spaces, slashes and `*`, which `limits.sh set` and `ds config set` refuse today: set them through an import, `ds config export --project <project> > f`, add the line under `#== limits.conf` in `f`, then `ds config import --project <project> f`.

For example, `/ds-limits <project> review_risk_paths contracts/*.sol,src/auth/*`
uses the risky threshold for those files. Globs match the whole path; `*` also
matches `/`. Invalid severities and empty or whitespace-separated path lists
refuse before review starts. A finding with no severity or one outside P0–P3
always blocks.

A PR gets one full review, then deltas. The line count is the review skill's
non-test executable lines when it can count them, else added plus removed lines
outside test paths. A skipped lens leaves a delta's reviewer list, and a full
review asks the skill not to select it, unless the unit touches a
`review_risk_paths` file. If the report still lists a skipped lens, the run warns
and still writes its receipt. Every run appends
`<epoch> <sha> <full|delta|carried> <reason> <lenses> <engine:model>` to
`.git/ds-review-log`.

A completed review writes `blocking-findings.json` and `noted-findings.json`
beside its report and prints their counts and paths. Builders fix the blocking
findings and put noted titles and file:line under **Review notes (not fixed)** in
the PR description, without another fix round. At the defaults, an ordinary P2
bug can remain unfixed; its note keeps it visible. The receipt still counts all
actionable findings and retains its existing format.

- `/ds-limits` — `bin/commands/limits.sh show [<project>]` lists every key with its
  value and source; `set <project> <key> <value>` writes the project's row;
  `rm <project> <key>` drops back to the default.
- Web board: ⚙ Settings → **Limits** tab (the same row, via `POST /api/limits`).
  Applies on the next loop minute.

## Skills and MCP servers: what each role's session loads

`conventions/skills.conf` holds `<role> <pattern> <level>` rows; the board's Settings → Skills tab edits them per
project (`config` rows, file `skills.conf`). Skill rows set `skillOverrides`; `hook:<name>` rows (level `on` or `off`)
gate start hooks; **`mcp:<server>` rows (level `on` or `off`, globs as for skills) set which MCP servers a session
loads** (U283). Servers: `linear-server` (a user server in `~/.claude.json`), `claude-docs` (the claude.ai connector
"claude.ai Claude Docs"), `context-mode` (plugin server, on for every role but `review`: a `required` row) and
`easel` (plugin). Shipped: all off except context-mode; `thinker` and `studio` keep Linear. A project turns one on for a role with a
row such as `lead mcp:linear-server on`, or in the Skills tab's "MCP servers" group, which takes effect at that
role's next start.

**`plugin:<plugin id>` rows (level `on` or `off`) turn a whole plugin off** for a role's sessions (review-unit-no-receipt
U1): the id as `enabledPlugins` keys it (`<name>@<marketplace>`, no glob), and an `off` puts
`enabledPlugins: {"<id>": false}` in the one `--settings`, which drops the plugin's skills, hooks and MCP server
together. Only a plugin a row names is set, and only `plugin:` rows set it: a role's blanket `*  off` reaches no plugin. Shipped:
`review plugin:context-mode@context-mode off required`, because the plugin's output stubs hid the review's own run
folder from the reviewer; every other role keeps context-mode. Probed on Claude Code 2.1.327: the review session's
init lists no context-mode server, plugin or `ctx_*` tool, and a long command output has no stub. Claude Code itself
still saves a tool output over about 30 KB to a file and shows a 2 KB preview with the file's path, which the
reviewer reads with Read.

How it reaches a session: `ds skills resolve <project> <role> --all` (or `--wt <worktree>`) prints `{skillOverrides,
mcp, deniedMcpServers, plugins, enabledPlugins}`; `bin/backend/orca.ts` (`compactSettings`: role start, resume,
Studio start) and `bin/review/review-unit.ts` (`reviewSettings`, role `review`) put `deniedMcpServers` and
`enabledPlugins` into the one `--settings` JSON. Probed on Claude Code 2.1.326: `deniedMcpServers: [{"serverName":
"<name>"}]` stops a user, a plugin (`plugin:<plugin>:<server>`) and a connector server and keeps the rest;
`--strict-mcp-config`, `ENABLE_CLAUDEAI_MCP_SERVERS=false` and `enabledPlugins` are coarser and are not used for a
server alone. A failing resolve starts the session with every server (one logged line); nothing in `.claude.json` or
any config file is changed, and your own sessions outside the loop are unaffected. `tests/loop/mcp-per-role.test.ts`,
`tests/loop/skills.test.ts`, `tests/orca-adapter.sh`, `tests/review-unit.sh`, `tests/board-serve.sh`.

## Ship mode: how finished work reaches its target

What it does: picks the delivery pipeline each Builder runs for its unit.
Default: `ce-pipeline`. Allowed: `ce-pipeline`, `no-mistakes`, `direct-PR`,
`local-only` (see `conventions/ship-modes.md` for what each runs).

Resolution order (first match wins):

1. Operator override: the project's `ship-mode` row (`ds config get <label> ship-mode mode`).
2. Committed default: a line in `conventions/projects.conf`:
   `<repo-selector> <mode>` (first field = the project label, or a string in
   its repo selector).
3. Fallback: `ce-pipeline`.

Change it: `/ds-mode <project>` shows the current mode and where it comes
from; `/ds-mode <project> <mode>` sets the override; `/ds-mode <project>
default` clears it. Applies to each squad's next ship — no restart needed.

## Project overrides: the rows and their backup

Until the settings cut-over (U256) a project's overrides were files, `state/<label>/limits.conf`,
`roles.conf`, `models.conf` and `ship-mode`, read on every loop tick. The first loop tick on the new
code (or `bin/loop/db/migrate-host.ts`, or the first `ds limits|roles|ship-mode|config` write) moves them,
once: each file's lines become the project's rows, with one `config_history` row by `migration`; the
file is renamed `<file>.imported-<date>` (kept, never deleted); `state/<label>/settings.export` is
written; and the state root gets the mark `state/.settings-migrated`, written last, so a crash part way
is finished by the next run with the same rows and no second history row.

After that the rows are the only copy:

- `state/<label>/settings.export` is a backup of the project's rows, one `#== <file>` section per file
  in conf syntax, rewritten on every change. Nothing reads it.
- A settings file that appears again in `state/<label>/` (an old script, a restored backup, a hand edit)
  is not read and changes nothing; the Studio gets one `<label>: <file> is not read` alert per file
  version, which clears when the file goes.
- `ds config import --project <label> <path> [--file <file>]` is the only way back in: a
  `settings.export` (every section; a file it lacks loses its rows) or one file, named by `--file` or
  by its own name (`limits.conf`, `limits.conf.imported-2026-11-17`, …). The file's rows become
  exactly the text's, unchecked, each change one history row by `ds config import`.
- `ds config export [--project <label>]` prints the same text as the backup.

## Autonomy: checkpoints vs fire-and-forget

What it does: decides whether a squad stops for your nod at checkpoints
(`plan drafted`, `tests green`, `PR ready`) or decides on its own and logs
each assumption for after-the-fact review. Default: `checkpoints`. Allowed:
`checkpoints`, `lfg`.

Set it per squad at spawn: `/ds-start-squad` (`--autonomy checkpoints|lfg`;
"fire and forget" maps to `lfg`). It is recorded in the squad state file and
shown on the board. `lfg` never covers the "Never decide alone" list in
`conventions/escalation.md` (closing squads, merging PRs, force-push,
scope/cost/secrets) — those still come to you. See
`conventions/autonomy.md`.

## Accounts: whose quota a role spends

Managed Claude accounts live on the host that runs the workers. Check them
with `orca account list`; if it is empty, run `orca account add` once (it signs
in a managed account on the Orca host) before starting squads.

- Usage and limits are cached in `state/accounts.tsv`, rewritten by
  `bin/lib/accounts-refresh.sh` (the loop refreshes the same account data).
- The picker (`bin/ds pick`, called by spawn and add-role) tries the
  role's own model first, then its fallback models in order. For each, it
  tries every account of that agent, the one that resets soonest with room first, and skips
  one at/above `pick_session_max` / `pick_weekly_max` or still limited.
  Unknown usage is eligible. An agent with no managed account runs on its
  default login. When nothing is free, the work waits for the earliest reset.
- The picker also skips an account you disabled (below). Its `why` (`bin/ds pick ... --json`)
  names it, e.g. `fill_first; acct-a disabled`.

No setting to change here day to day: add accounts with `orca account add`,
and tune the skip thresholds with `pick_session_max` / `pick_weekly_max`
above.

**Disable or enable an account** (`/ds-accounts`, `bin/ds account`):

```bash
bin/ds account                                   # JSON: agent, account, label, plan, state, listed, running
bin/ds account disable claude:<account|label>    # no pick uses it any more (label = accounts.tsv's, e.g. an email)
bin/ds account enable  claude:<account|label>    # pickable again
```

- The switch is host-wide (every project). It is stored in loop.db (`accounts.state`), so an
  `accounts.tsv` refresh keeps it. Each change records an `account_disabled` or
  `account_enabled` event.
- A disabled account is never picked: not for a start, a restart, a limit move, a fallback return
  or a held pick. Members already running on it keep running and switch at their next restart.
  A resumed squad's members on it get a fresh pick and start fresh from their journal.
- When every account of an agent is disabled, the picker goes to the next fallback, else waits. It
  never uses that agent's default login instead.
- An override or explicit `--account` on a disabled account waits (reason `account disabled`).
  The board refuses to set such an override.
- An unknown or ambiguous name exits 2.

## Pins: an override for a member, a squad, a role or the project

A pin (override) fixes a model, effort, and an account or plan until it is cleared. It has a scope:

- **member**: one role's session; it ends when that member's work is done.
- **squad**: every member of one squad; it ends when the squad closes.
- **role**: every member of that role in the project (every Builder, say).
- **project**: every member of the project.

The board's pin dialog has a **For** choice for these. A member sees the narrowest pin that sets a field:
a member pin beats a squad pin, which beats a role pin, which beats a project pin, field by field.
The account and the plan count as one choice, so a narrower plan replaces a broader account.
A pin on a model the role cannot use, or on a disabled account, is refused as before.
Squad, role and project pins stay until cleared: the squad card has a Clear button for its pin, and
Settings → Pins lists the role and project ones. From a shell:

```
ds override                       # every open pin with its scope and target
ds override clear <id>            # one pin
ds override clear --squad <project>/<squad> | --role <project>/<role> | --project <project>
```

## Environment variables: host behaviour

These are read where the loop, board, or scripts run. Unset = the default.
The active `DS_SWEEP_LIMIT_PCT` name remains a compatibility alias for `limit_pct`.
The loop also reads the `DS_SWEEP_*` settings listed below under their compatibility names.

| Variable | What it does | Default |
|---|---|---|
| `BACKEND` | Backend adapter behind every `orca` call | `bin/backend/orca.sh` |
| `DS_BIND` | IPs the web board listens on (space-separated) | `127.0.0.1` + the tailnet IP |
| `DS_BOARD_HOSTS` | Extra allowed `Host` values for the web board | localhost, 127.0.0.1, ::1, hostname, tailnet names |
| `DS_PREFIX` | Worktree-name namespace (`ds-…`) | `ds-` |
| `DS_PICK_WAIT_S` | Fallback wait when no account reset time is known | 3600 (1h) |
| `DS_TOKEN_DAYS` | Days of session logs token scans cover | 7 |
| `DS_SWEEP_SPAWN_GRACE_MIN` | Minutes after spawn during which the loop never reports a member dead or exited | 5 |
| `DS_SWEEP_SILENT_MIN` | Minutes quiet before the loop pokes an agent with unread messages; also the usage-limit quiet threshold | 10 |
| `DS_SWEEP_HUNG_MIN` | Minutes without output before the loop reports a worktree hung | 30 (a member whose command is still running waits `long_step_min` more) |
| `DS_SWEEP_RECHECK_MIN` | Minutes between liveness pokes and before checking restart or usage-limit recovery | 5 |
| `DS_SWEEP_REBREAK_MIN` | Window in which a second break stops the loop from restarting a member automatically | 30 |
| `DS_SWEEP_POKES` | Liveness wake-up pokes before the loop escalates a quiet agent | 2 |
| `DS_SWEEP_TOKENS_MIN` | Minutes between loop refreshes of token usage and squad spend | 5 |
| `DS_SIT_NUDGE_MIN` | Minutes a `watch.sh` waiter sits before nudging | 15 |
| `DS_SIT_RESTART_MIN` | Minutes before it restarts instead | 45 |
| `DS_WORKER_START_RETRIES` | Retries starting a worker | 8 |
| `DS_WORKER_START_BACKOFF` | Seconds of backoff between those retries | 2 |
| `DS_REWAKE_BACKOFF_SEC` | Seconds the rewake hook waits before re-arming when a message is still present | 900 |
| `DS_REWAKE_WINDOW_SEC` | How long the rewake hook keeps watching; always peeks at least once | 21600 (6h) |
| `DS_REWAKE_POLL_GAP_SEC` | Seconds between rewake hook polls | 20 |
| `DS_GH` | `gh` binary used for PR queries | `gh` |

### Historical sweep variables

The following settings belonged to the sweep removed in U19, or to the shell scripts the loop replaced (U154, U158). Current loop installs do not read them; their former defaults are retained here as historical notes.

| Variable | Former behaviour | Former default |
|---|---|---|
| `DS_NOTIFY_CMD` | Command run with the alert text when the sweep pings you (e.g. `ntfy publish mytopic`); unset = board only | unset |
| `DS_SWEEP_POKE_TEXT` | The wake-up text poked into a quiet agent's terminal | `dev-studio sweep: you went quiet…` (former default; current text in `bin/loop/reconcilers/liveness.ts`) |
| `DS_SWEEP_ACCOUNTS_FG` | `1` = refresh accounts in the foreground (for debugging) | 0 |
| `DS_SWEEP_LIMIT_POKE_MIN` | Minutes between loop pokes to an agent sitting on a usage limit | 15 |
| `DS_SWEEP_LIMIT_POKES` | Maximum usage-limit pokes from the loop | 24 |
| `DS_RESTART_STAGGER` | Seconds between restarted workers when restarting many squads | 3 |
| `DS_CLOSE_TERMINALS` | `0` = leave terminals open when closing roles/squads | 1 |
| `DS_RELEASE` | `0` = skip worker release when closing or restarting a role | 1 |
| `DS_REAP` | `0` = skip reaping stale terminals on role restart | 1 |
| `DS_RECLAIM` | `0` = skip freeing settled long-poll slots when restarting squads (`/ds-update`) | 1 |

Internal and test hooks (`DS_NOW`, `DS_STATE_ROOT`, `DS_LAVISH_LOG`, `DS_LOOP_LAVISH_WAIT_MS`,
`DS_TOKEN_DIR`, `DS_CLAUDE_HOME`, `DS_USAGE_CACHE`, `DS_USAGE_TTL_S`,
`DS_USAGE_URL`, `DS_INSTR_FILES`, `DS_INSTR_SEEN`,
`DS_REWAKE_LOG`, `DS_REWAKE_PIDDIR`, `DS_REWAKE_SEEN`,
`DS_BOARD_SERVER`, `DS_BOARD_BIND_TRIES`, `DS_LOOP_BOARD_PING_MS`, `DS_LOOP_BOARD_WAIT_MS`,
`DS_LOOP_BOARD_WINDOW_S`, `DS_BOARD_SERVE_WAIT`, `DS_SPAWN`,
`DS_CLAUDE_SYSTEM_JSON_DIR`,
`DS_ACCOUNTS_LIMIT_S`, `DS_ORCA_DATA`, `MUSE_MODEL_CATALOG_DIR`, …) are not
operator settings — leave them alone.
