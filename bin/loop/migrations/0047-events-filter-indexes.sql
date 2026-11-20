-- 0047-events-filter-indexes.sql — the board's Event log squad filter (event-log-filters U2). With a
-- squad picked, eventsQuery (bin/board/board-data.ts) reads `project = ? AND squad = ?` newest first,
-- 50 at a time. SQLite appends the rowid to every index, so this walks one squad's rows in id order
-- and stops after a page instead of scanning the table. Partial: rows with no squad are left out.
-- It does not lead with `project`: an index there could tempt the planner into an OR-union plus sort
-- for the default page `(project = ? OR project IS NULL)`, which walks the primary key.
-- No crew index. A bare `member` index took the loop's per-member lookups (switches.ts phaseStop,
-- close-drift.ts stopRetry, fulfil/rebind.ts) away from events_kind_member: 60–130 ms a call on a
-- live copy. A `(squad, member)` index made 10,000 inserts 46 % slower and the db 61 MB larger
-- (the member key is a long path), over the plan's 15 % bar; the crew page walks this index instead.
-- tests/loop/events-index.test.ts checks the plans.
CREATE INDEX IF NOT EXISTS events_squad ON events (squad) WHERE squad IS NOT NULL;
-- Fresh stats for the new index: with the stats of 0032 the board's latest-pick lookup
-- (`project = ? AND squad = ? AND kind = 'pick'`) moved to events_squad and took 150 ms, not 0.1 ms.
ANALYZE events;
