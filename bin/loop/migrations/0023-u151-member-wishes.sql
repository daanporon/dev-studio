-- 0023-u151-member-wishes.sql — a member's one-time wishes (U151), next to its standing `want`
-- (running|stopped|gone; `ds` and the board say archived for gone). Each is an epoch-seconds stamp
-- with who wrote it, written by store.wishOnce() as the newer of old and new, so repeats collapse.
-- Nothing acts on them yet: the decider (U152, U153, U156) does.
ALTER TABLE members ADD COLUMN restart_at INTEGER;    -- restart once after this
ALTER TABLE members ADD COLUMN restart_mode TEXT;     -- now|idle: stop mid-turn, or once idle
ALTER TABLE members ADD COLUMN restart_by TEXT;
ALTER TABLE members ADD COLUMN reload_at INTEGER;     -- re-read the instructions once after this
ALTER TABLE members ADD COLUMN reload_by TEXT;
ALTER TABLE members ADD COLUMN clear_at INTEGER;      -- clear the conversation once after this
ALTER TABLE members ADD COLUMN clear_by TEXT;
-- Reality, written by U156: the role confirmed its reload, the agent's context was cleared.
ALTER TABLE members ADD COLUMN reloaded_at INTEGER;
ALTER TABLE members ADD COLUMN cleared_at INTEGER;
