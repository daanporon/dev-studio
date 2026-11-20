-- 0012-u64-standing.sql — a standing role that crashes (U64, bin/loop/reconcilers/liveness.ts). A Lead
-- or Thinker whose dispatch settles, or whose agent exits, within crash_window_min of a start crashed;
-- after two crashes in a row on one agent and model its next start avoids that rung.
ALTER TABLE members ADD COLUMN avoid TEXT;                -- <agent>:<model> the pick skips (U65), until a start on it lasts
ALTER TABLE members ADD COLUMN started TEXT;              -- ISO, its last restart (squad-state set-member-model); since stays the first spawn
ALTER TABLE members ADD COLUMN restarting TEXT;           -- ISO, a restart-role.sh under way (mark-member-restarting): no crash until started passes it
ALTER TABLE observed_workers ADD COLUMN dispatch_id TEXT; -- the worktree's newest dispatch in its squad's Run
ALTER TABLE observed_workers ADD COLUMN dispatch TEXT;    -- its status: dispatched, completed, failed, canceled
ALTER TABLE observed_workers ADD COLUMN dispatch_at INTEGER; -- when that status was seen to change; NULL = first seen settled (time unknown)
