-- 0017-u100-dispatch-seen.sql — a standing role's dispatch word from the loop's own verdict (U100).
-- The orca observer reads run-dispatches past the crash window too (throttled), and stamps each
-- read; the verdict (liveness.ts dispatchVerdict) reads unknown while no read is fresh.
ALTER TABLE observed_workers ADD COLUMN dispatch_seen_at INTEGER; -- when this worktree's Run dispatches were last read
