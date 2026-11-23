# Shadow drill and exit (orca-backend-alternatives U10b)

**Status: not run.** This page is the runbook and the empty record. The live drill needs at least 7 days of the
shadow (U10, merged 2026-11-23) on a host that has `ds shadow`, so the earliest exit is 2026-11-30. Nothing below
the "Record" heading is filled in yet.

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

## Record (fill in when run)

- Drill squad: _
- Host updated at: _
- Forced-crash events (time, member, `shadow_crash` event id): _ ×5
- No-PR finish (unit, `finishes` row, event id): _
- Failed finish (unit, `finishes` row, event id): _
- Disagreements found and how each was explained or fixed (event id, why): _
- Final `ds shadow report --since <merge>` output: _
