-- 0032-u4-reviews.sql — each dispatched unit's review state (PR overview board U4), written by
-- bin/loop/observers/reviews.ts from its Builder's git dir (ds-review-start, ds-review-log, ds-review,
-- ds-review-stop) and the open review_stopped alert. The board splits Building by it. Latest only;
-- a unit that is no longer dispatched has no row.
CREATE TABLE observed_reviews (
  project TEXT NOT NULL, squad TEXT NOT NULL, slug TEXT NOT NULL,
  wt TEXT,             -- the Builder's worktree path
  state TEXT NOT NULL, -- stopped | reviewing | fixing | coding
  since INTEGER,       -- reviewing: the marker's epoch; fixing: the receipt's epoch; else NULL
  kind TEXT,           -- reviewing: full | delta | delta-wide
  round INTEGER,       -- non-carried reviews logged, plus 1 while one runs
  findings INTEGER,    -- fixing: the receipt's actionable count
  head TEXT,           -- the sha the marker or receipt names
  observed_at INTEGER NOT NULL, PRIMARY KEY (project, squad, slug));
