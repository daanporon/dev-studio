-- 0003-u4-observed.sql — what the U4 observers need beyond U2's observed tables.
-- observed_at on a row the loop observes is the tick that last confirmed it; a row whose source
-- disappeared keeps its last values and gets gone_at instead of being deleted.
ALTER TABLE observed_worktrees ADD COLUMN gone_at INTEGER;
ALTER TABLE observed_terminals ADD COLUMN gone_at INTEGER;
ALTER TABLE observed_workers ADD COLUMN gone_at INTEGER;
ALTER TABLE observed_workers ADD COLUMN name TEXT;          -- the worktree's display name
ALTER TABLE observed_workers ADD COLUMN since INTEGER;      -- epoch s the newest agent entered its state
ALTER TABLE observed_workers ADD COLUMN said TEXT;          -- the end of its last message, one line
ALTER TABLE observed_workers ADD COLUMN tokens INTEGER;     -- its tokens.tsv output count (a change re-reads the screen)
ALTER TABLE observed_workers ADD COLUMN tail TEXT;          -- the agent terminal's screen bottom, as last read
ALTER TABLE observed_workers ADD COLUMN tail_at INTEGER;
ALTER TABLE observed_workers ADD COLUMN suspect INTEGER;    -- a reconciler's ask: read the screen next tick

-- sweep/limited.json and sweep/compacted.tsv, per project, while the sweep still writes them.
CREATE TABLE observed_limited (
  project TEXT NOT NULL, wt TEXT NOT NULL, line TEXT, since INTEGER, wait_until INTEGER, doc TEXT,
  mtime INTEGER, observed_at INTEGER NOT NULL, PRIMARY KEY (project, wt));
CREATE TABLE observed_compacted (
  project TEXT NOT NULL, wt TEXT NOT NULL, at INTEGER,
  observed_at INTEGER NOT NULL, PRIMARY KEY (project, wt));
