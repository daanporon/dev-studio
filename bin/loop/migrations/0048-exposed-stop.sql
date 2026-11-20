-- 0048-exposed-stop.sql — exposed-cleanup U2: an exposed entry carries how to stop what it hosts, who it
-- is for and the extra ports it covers; the loop runs the stop command once when the entry ends with its
-- squad or owner (bin/loop/squad/exposed.ts, bin/loop/reconcilers/exposed.ts, bin/loop/fulfil/expose-stop.ts).
-- Old rows stay valid: no stop command, audience operator, no ports, never stopped.
--   stop_cmd     the command that stops what this entry hosts (ds expose --stop); NULL: none
--   audience     operator (listed for the operator) | self (only the member's own tool, ds expose --self)
--   ports        JSON array of extra port numbers the entry covers (ds expose --ports); never probed or shown
--   stop_state   NULL (no stop asked) | queued | running | done | failed | timeout | lost | skipped
--   stop_at      epoch s the stop was queued, then claimed
--   stop_result  JSON {ids, code, ms, timed_out, cwd, cwd_fallback, tail} (or {ids, skipped} / {ids, lost})
ALTER TABLE exposed ADD COLUMN stop_cmd TEXT;
ALTER TABLE exposed ADD COLUMN audience TEXT NOT NULL DEFAULT 'operator';
ALTER TABLE exposed ADD COLUMN ports TEXT;
ALTER TABLE exposed ADD COLUMN stop_state TEXT;
ALTER TABLE exposed ADD COLUMN stop_at INTEGER;
ALTER TABLE exposed ADD COLUMN stop_result TEXT;
