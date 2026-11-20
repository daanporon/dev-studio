-- 0031-u1-events-kind-at.sql — the board's Flow (bin/board/flow.ts, U1) reads the stage events
-- (unit_dispatched, unit_pr, auto_merge_armed, unit_done) of the last 30 days on every build: an
-- index on (kind, at) makes that a range read instead of a scan of every event in the window.
CREATE INDEX IF NOT EXISTS events_kind_at ON events (kind, at);
