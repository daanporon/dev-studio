-- 0004-u6-lifecycle.sql — the facts the unit and PR lifecycle reconciler (U6) writes. None of them
-- is in the squad JSON: the export leaves them out, U7 and the board read them from the rows.
ALTER TABLE units ADD COLUMN done_at INTEGER;          -- when the loop marked the unit done on its PR's merge
ALTER TABLE units ADD COLUMN merge_blocked TEXT;       -- the PR's pr_health reasons while it is blocked, else NULL
ALTER TABLE units ADD COLUMN pr_stale INTEGER;         -- 1 while the blocked PR is stale (observed_prs.stale)
ALTER TABLE squads ADD COLUMN all_done_at INTEGER;     -- when every done unit's PR was first seen merged; NULL otherwise
