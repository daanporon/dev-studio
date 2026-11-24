# Shadow drill and exit (orca-backend-alternatives U10b)

**Status: drill run 2026-11-24 (U21), crashes not met.** Steps 2 to 5 ran on a throwaway squad. The finishes are in; the forced
crashes did not register (see the Record). The earliest exit is 2026-11-30 and needs a fix for crash detection first (U22 follows up).

## Exit numbers

`ds shadow report --since <U10's merge>` prints `exit: met` when: 0 unexplained disagreements, at least 20 finishes
with a generation, at least 3 of them no-PR or failed, at least 5 `shadow_crash` events, and at least 7 days.

## Runbook

1. Update the host (`/ds-update`) so `ds shadow` exists; confirm `ds shadow report --project <trial>` runs.
2. Start a throwaway `orca` squad on the trial project (spawn-squad). Let its Builders start.
3. Force five crashes, one per Builder start where possible, with
   `bin/host/shadow-drill.sh crash <builder worktree>` (kills only agent processes inside that folder; `--dry-run` lists them).
   Note the time of each; the loop restarts the member and logs a `shadow_crash` event.
4. End one unit with `finish-unit.sh <state> <unit> --no-pr` and one with `finish-unit.sh <state> <unit> --failed <why>`.
5. Read `ds events --kind shadow_disagree` (or `ds shadow report`). For each unexplained event either fix the signal
   or `ds shadow explain <event id> <why>`.
6. Repeat until `bin/host/shadow-drill.sh report --since <merge> --project <trial>` exits 0 (it prints the report and
   fails unless `exit: met`).

## Record

- Drill squad: `shadow-drill-u21` (project `dev-studio-public`, backend `orca` passed explicitly, `lfg`), started 2026-11-24 about 09:46Z, closed after "drill over" (about 10:40Z).
- Host updated at: shadow running since 2026-11-24T09:05:32Z (the report's `--since`).
- Forced-crash events (time, member, `shadow_crash` event id): **0 of 5 from the drill.**
  - 09:51:23 to 09:51:28Z, `builder-drill-1..4`: killed with `shadow-drill.sh crash` after they had already ended `--no-pr` (finish rows at 09:49:50 to 09:50:06Z). The loop restarted them (events 609440 to 609443); a restart after a finish row is not a crash, so none counted. My mistake: crash only a Builder that is mid-work.
  - 10:02:20Z `builder-drill-6`, 10:02:23Z `builder-drill-7` (KILL), 10:18:32Z `builder-drill-8` (TERM), all mid-work: no `shadow_crash` event and no restart. Orca keeps each agent `working` after its process dies (`observed_workers` state `working`, walk `none`), so the old signal reads the Builder alive, the loop does nothing, and no new generation starts. The 30-minute hung restart had not fired after 34 minutes; a restart the loop itself stops is not a `shadow_crash` either (`reconcilers/shadow.ts` `loopStop`).
  - A kill the old signal cannot see is the thing the shadow is meant to catch, so the new signal was right: start disagreements 609775, 609776, 609993, 610347 to 610349 and 610383 to 610385 (old `running`, new `none`).
  - Other `shadow_crash` events in the window came from other squads (ids 609448, 609804 and later), not the drill.
  - Not tried: killing the pane's whole process group so Orca closes the terminal. Drill-9 and drill-10 ended in seconds, before a kill. Follow-up: a plan unit for crash detection (U22).
- No-PR finish (unit, `finishes` row, event id): `drill-1` #59, `drill-2` #60, `drill-3` #61, `drill-4` #58, `drill-5` #63, `drill-9` #68 (all `--no-pr`).
- Failed finish (unit, `finishes` row, event id): `drill-10` #69 (`--failed`, `worker_done --outcome failed`; disagreement 610481 `finished` old `no`, new `failed`).
- Disagreements found and how each was explained or fixed (event id, why): 24 explained with `ds shadow explain`, none fixed in code:
  - 609212, 609213 (lead, thinker `start`, running vs starting): fresh squad start, the process walk has not seen the agent yet.
  - 609305, 609346, 609355, 609366, 609691 (`finished`, old no, new ok): the finishes row is written before `worker_done`, so the old completed-dispatch signal follows.
  - 609440 to 609443 (`start`) and 609468, 609469, 609475, 609476 (`finished`, old ok, new no): my kills of finished Builders (drill artifact); the new generation has no finish row.
  - The `start` events above (old running, new none) for drill-6, 7, 8: forced crash, Orca state stale.
  - Not explained, other squads: 608822, 608885, 609147, 609444, 609490, 609602, 609788, 610055, 610135, 610644 (the finished-ok/no and member-absent patterns; same mechanisms as above are likely but unchecked).
- Final `ds shadow report --since 2026-11-24T09:05:00Z` output (before the closing events):

```
shadow dev-studio-public since 2026-11-24T09:05:32.000Z (0.1 days)
  start     1 unexplained, 15 explained, 4 transient
  finished  5 unexplained, 9 explained, 3 transient
  retire    0 unexplained, 0 explained, 1 transient
  member    4 unexplained, 0 explained, 4 transient
  finishes 13 (7 no-PR or failed), crashes 3
exit: not met - 10 unexplained, 13 of 20 finishes, 3 of 5 crashes, 0.1 of 7 days
```

## Patterns (U21a)

The unexplained disagreements `ds shadow report --since 2026-11-24T09:05:32Z` listed after the drill fall into these patterns. Each one that would come back every day is now paired so that it agrees (`bin/loop/squad/shadow.ts`); each has a case in `tests/loop/shadow.test.ts` ("U21a patterns agree").

| Pattern | Events | Cause | Fix |
|---|---|---|---|
| A. `finished`, old no, new ok | 609490, 610135, 611117 | `finish-unit` writes the finish row just before it sends `worker_done`, and the relay reads the Run mail a tick or more later. | While the finish row is younger than the loop's report grace (`DONE_GRACE_S`, 120 s) and the old side reads no, the new side reads no. |
| B. `finished`, old ok, new no, a Builder | 608822, 609602, 609788, 610773, 610803 | The Builder sends `worker_done` when it opens its PR. The loop ignores that report while the unit has a PR (liveness `idleBuilder`), restarts the Builder on babysit, and the finish row comes later from the new generation. | No `finished` pair for a Builder whose unit records a PR. The PR's merge (the `retire` point) decides there. |
| C. `finished`, old ok, new no, a Tester | 610433 | The Tester sent `worker_done` without `ds finish --outcome verdict` first. This is a role gap, not a lag. | None in code. It is still flagged, and `roles/tester.md` already asks for the verdict row. |
| D. `retire`, old retire, new keep | 608981, 609983, 610434 | The loop had already set the member's want to gone (unit done and merged, or `tester pass finished`). The new side reads the agent's end a tick or two later. | No `retire` pair for a member the loop wants gone. |
| E. `member`, old absent, new member | 608885, 609444, 608943 (phase); 609147, 610644 (archive) | Right after a `member_phase` babysit switch, Orca has dropped the old dispatch while the stop is still in flight (`member_stopped` is logged once it completes). Or the squad was archived and the member closed, while its want still reads running. | No `member` pair for a member with a `member_phase` event since its last start, or whose effective wish is not running (`effective()`). |
| F. `start`, old running, new starting | 609098, 610055 | A start placed 15 to 27 s earlier that no walk has read yet, while Orca already lists its dispatch. The decider does nothing for either value. | Running against starting agrees. |

### Why the hung restart did not fire on the drill's killed Builders

`builder-drill-6`, `-7` and `-8` each died with a tool call open (an assistant `tool_use` with no result). An open step stretches the hung wait to `long_step_min` (60) plus `HUNG_MIN` (30), 90 minutes in all, and the squad was archived before that. This is intended: a long build or test step must not be cut. The dead agent is now caught by its own rule instead.

A member Orca still reads `working` (presence `running`) is read gone when all of these hold:

- every successful process walk since a time after its last start found no agent in its worktree, for at least `gone_min` (3 minutes; `DS_SWEEP_GONE_MIN`);
- its transcript has not grown since;
- it has no finish row of its generation;
- the loop did not stop it.

The time is the Orca observer's `observed_workers.walk_none_at` (migration 0058). A failed or split walk keeps it, and a walk that finds the agent clears it. The decider then starts the member through the usual restart rules, and the shadow counts the generation change as a crash. While the `gone_min` clock runs, the `start` pair agrees: the old side reads the agent running and the new side reads none, which is a known lag.
