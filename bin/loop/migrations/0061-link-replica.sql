-- 0061-link-replica.sql — side-loop-host U6 (issue #127, KTD8/KTD9): rows down and observed rows up over the link
-- (bin/link/replica.ts). A side host uploads the observed rows its observers write; main keeps them beside its own.
--   host   on each up-table that had no host column: the host whose observer wrote the row. Main's own observers
--          write `local` (the default) and scope their deletes and replaces to it, so a main tick never touches a
--          row a side host uploaded. Keys stay as they are: the link rewrites the per-machine part of a key at the
--          boundary (a worktree id `local::<path>` goes up as `<host>::<path>`, a terminal handle as
--          `<host>:<handle>`, a transcript or rollout path as `<host>::<path>`), so two hosts never share a key.
ALTER TABLE observed_procs ADD COLUMN host TEXT NOT NULL DEFAULT 'local';
ALTER TABLE observed_workers ADD COLUMN host TEXT NOT NULL DEFAULT 'local';
ALTER TABLE observed_terminals ADD COLUMN host TEXT NOT NULL DEFAULT 'local';
ALTER TABLE observed_worktrees ADD COLUMN host TEXT NOT NULL DEFAULT 'local';
ALTER TABLE observed_transcripts ADD COLUMN host TEXT NOT NULL DEFAULT 'local';
ALTER TABLE observed_rollouts ADD COLUMN host TEXT NOT NULL DEFAULT 'local';
ALTER TABLE observed_chat ADD COLUMN host TEXT NOT NULL DEFAULT 'local';
ALTER TABLE observed_reviews ADD COLUMN host TEXT NOT NULL DEFAULT 'local';

-- link_shipped (side only; empty on main): what the side last uploaded per up-table row, so a sync sends only the
-- rows whose content changed and the keys that went away. Cleared on each new link, when a full batch goes up.
--   tbl    the up-table   key   the row's key, as JSON of its key columns   hash   the row's content hash
CREATE TABLE link_shipped (
  tbl  TEXT NOT NULL,
  key  TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (tbl, key)
);
