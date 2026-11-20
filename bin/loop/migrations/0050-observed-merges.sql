-- 0050-observed-merges.sql — brief-other-prs U1: every merged PR of each repo the GitHub observer
-- watches (bin/loop/observers/github.ts, the merge read), squad PR or not, for the morning brief's
-- "Elsewhere" facts (bin/commands/briefing-input.ts). Bot PRs are never stored; a deleted author is
-- `ghost`. The board reads observed_prs, never this table.
CREATE TABLE observed_merges (
  repo         TEXT NOT NULL,          -- owner/name
  pr           INTEGER NOT NULL,
  title        TEXT,
  author_login TEXT,                   -- `ghost` when GitHub has no author (deleted account)
  author_name  TEXT,                   -- the User's name, else the login; never guessed
  base         TEXT,                   -- baseRefName
  merged_at    INTEGER,                -- epoch s
  observed_at  INTEGER NOT NULL,
  PRIMARY KEY (repo, pr)
);
CREATE INDEX observed_merges_merged ON observed_merges (repo, merged_at);

-- Per repo row: the merge read's cursor. The record covers merges_from..merges_until (epoch s);
-- each read asks GitHub search for merges in [merges_until - 30 min, min(now, that + 1 day)].
ALTER TABLE observed_github ADD COLUMN merges_from INTEGER;    -- where the record starts (first read: now - 4 days)
ALTER TABLE observed_github ADD COLUMN merges_until INTEGER;   -- covered up to
ALTER TABLE observed_github ADD COLUMN merges_ok_at INTEGER;   -- last good merge read
ALTER TABLE observed_github ADD COLUMN merges_error TEXT;      -- last merge read's error, NULL after a good one
ALTER TABLE observed_github ADD COLUMN merges_next_at INTEGER; -- no merge read before this
