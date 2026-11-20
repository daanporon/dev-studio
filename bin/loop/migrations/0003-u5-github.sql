-- 0003-u5-github.sql — what the GitHub PR observer (U5) writes beyond the v1 schema.
--
-- observed_prs keeps its (project, ref) key. The observer's rows use ref `<owner>/<name>#<n>`
-- and set `repo`; rows the install imports from sweep/pr-health.json keep ref `<topic>/<slug>`
-- and leave `repo` NULL.
ALTER TABLE observed_prs ADD COLUMN repo TEXT;              -- owner/name
ALTER TABLE observed_prs ADD COLUMN unit TEXT;              -- <topic>/<slug> of the unit that records this PR
ALTER TABLE observed_prs ADD COLUMN url TEXT;
ALTER TABLE observed_prs ADD COLUMN title TEXT;
ALTER TABLE observed_prs ADD COLUMN head TEXT;              -- headRefName
ALTER TABLE observed_prs ADD COLUMN base TEXT;              -- baseRefName
ALTER TABLE observed_prs ADD COLUMN draft INTEGER;
ALTER TABLE observed_prs ADD COLUMN detail TEXT;            -- full (a unit's PR: mergeability, required checks) | light (no mergeability)
ALTER TABLE observed_prs ADD COLUMN mergeable TEXT;         -- MERGEABLE|CONFLICTING|UNKNOWN; NULL when not asked (light)
ALTER TABLE observed_prs ADD COLUMN merge_state TEXT;       -- mergeStateStatus
ALTER TABLE observed_prs ADD COLUMN ci TEXT;                -- green|red|pending
ALTER TABLE observed_prs ADD COLUMN review TEXT;            -- approved|changes|requested|none
ALTER TABLE observed_prs ADD COLUMN threads INTEGER;        -- unresolved review threads
ALTER TABLE observed_prs ADD COLUMN problem TEXT;           -- the blocking reasons as one key (sweep problem_key)
ALTER TABLE observed_prs ADD COLUMN since INTEGER;          -- when the current verdict/problem started (sweep pr-health `since`)
ALTER TABLE observed_prs ADD COLUMN stale INTEGER;          -- blocked for at least pr_stale_min
ALTER TABLE observed_prs ADD COLUMN merge_blocked INTEGER;  -- verdict blocked
ALTER TABLE observed_prs ADD COLUMN updated_at INTEGER;     -- GitHub updatedAt (last activity)
ALTER TABLE observed_prs ADD COLUMN gone_at INTEGER;        -- left the query without a merge; NULL while seen
CREATE INDEX observed_prs_repo ON observed_prs (repo, pr);

-- One row per repo the observer asks about, plus the schedule row (repo ''): when it asks next,
-- the current interval (doubles on a rate limit, up to five minutes) and the last answer.
CREATE TABLE observed_github (
  repo         TEXT PRIMARY KEY,     -- owner/name, '' for the schedule row
  default_branch TEXT,
  open_count   INTEGER,              -- open PRs seen (all pages)
  ok_at        INTEGER,              -- last full answer for this repo
  error        TEXT,                 -- last error, NULL after a full answer
  next_at      INTEGER,              -- schedule row: no request before this
  interval_s   INTEGER,              -- schedule row
  posts        INTEGER,              -- schedule row: POSTs in the last poll
  cost         INTEGER,              -- schedule row: rate-limit points of the last poll
  remaining    INTEGER,              -- schedule row: rate-limit points left
  observed_at  INTEGER NOT NULL
);
