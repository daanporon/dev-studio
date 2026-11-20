-- 0031-observed-cleanup.sql — host-disk-cleanup U2: what the hourly cleanup pass found (KTD3).
-- bin/loop/observers/cleanup.ts writes the raw facts of each candidate; reconcilers/cleanup.ts adds
-- the verdict from loop.db alone. `ds observed cleanup` lists every row.
--   class  a  a process whose cwd is a deleted or unreferenced ds-* worktree      key pid:start
--          b  a Claude temp dir (a worktree slug, or a session dir under one)      key path
--          c  a helper checkout in a project clone (<repo>/.claude/worktrees/*)    key path
--          d  a ds-<label>-* git worktree folder Orca no longer tracks, an Orca     key path, or
--             entity nothing references, or a ds-* folder git does not list         entity:<id>
--          e  one valid cleanup_tmp_globs entry, its matches folded into one row   key the glob
-- project is '' when no project can be proven (report only, KTD13).
CREATE TABLE observed_cleanup (
  project TEXT NOT NULL, class TEXT NOT NULL, key TEXT NOT NULL,
  path TEXT, pid INTEGER,
  size_kb INTEGER,           -- best effort (RSS for a process); never part of a decision
  mtime INTEGER,             -- newest mtime seen (epoch s); a process's start time
  first_seen INTEGER NOT NULL,
  orphaned_since INTEGER,    -- the reconciler: first pass that found no keep-set reference (R9 floors)
  facts TEXT,                -- JSON: the class's raw facts
  verdict TEXT,              -- the reconciler: removable | in use by pid N | dirty | … (fixed words)
  observed_at INTEGER NOT NULL, gone_at INTEGER,
  PRIMARY KEY (project, class, key));
-- One row per host: the last finished scan, and what it could not attribute or refused.
CREATE TABLE observed_cleanup_scan (
  host TEXT PRIMARY KEY,
  started_at INTEGER, ms INTEGER, entries INTEGER,
  ps_error TEXT,             -- the backend worktree list failed, was unparseable or empty: c and d refused
  loose_count INTEGER, loose_kb INTEGER, -- loose files in the Claude temp root (A7): report only
  observed_at INTEGER NOT NULL);
