-- 0058-walk-none-at.sql — catch a dead agent under a stale Orca view (orca-backend-alternatives U21a).
-- After a KILL Orca can keep a member `working` (presence running) while the process walk finds no
-- agent in its worktree. `walk_none_at` is when the walk first read none in the current spell (epoch s):
-- the Orca observer sets it on a walk that reads none (kept while each later walk reads none), clears
-- it on a walk that finds the agent, and leaves it on a failed or split walk (`unknown` proves nothing).
-- A spell begun at or before the member's last start is begun again. decide.ts reality() reads it.
ALTER TABLE observed_workers ADD COLUMN walk_none_at INTEGER;
