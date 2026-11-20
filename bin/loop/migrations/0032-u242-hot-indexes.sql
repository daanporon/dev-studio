-- 0032-u242-hot-indexes.sql — the loop's per-member queries ran as full scans of events (425k rows),
-- orca_calls (78k) and episodes, one after another on the tick's thread, so a tick took ~31s. Each
-- index below serves a query named beside it; tests/loop/hot-queries.test.ts fails if one goes back to a scan.
-- members.ts hasEvent/eventHandle/rebounds, rebind.ts replay: kind + project + squad + member.
CREATE INDEX IF NOT EXISTS events_kind_member ON events (kind, project, squad, member);
-- member-state.ts lock(): only the open calls, a handful of rows.
CREATE INDEX IF NOT EXISTS orca_calls_open ON orca_calls (project, member) WHERE state IN ('sent', 'pending');
-- member-state.ts lock(), decide, phases: the live claims.
CREATE INDEX IF NOT EXISTS episodes_live ON episodes (project, state, kind) WHERE state IN ('acted', 'running');
-- members.ts unfenced(): every state, so the partial index above does not cover it.
CREATE INDEX IF NOT EXISTS orca_calls_member_key ON orca_calls (project, member, key);
-- alerts first-seen lookup and the cancelled-unit lookups.
CREATE INDEX IF NOT EXISTS members_project_wt ON members (project, wt);
CREATE INDEX IF NOT EXISTS units_project_wt ON units (project, builder_wt);
ANALYZE events;
ANALYZE orca_calls;
ANALYZE episodes;
