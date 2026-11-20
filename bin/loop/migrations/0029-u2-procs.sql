-- 0029-u2-procs.sql — per-worktree process trees (board machine panel U2), written by
-- bin/loop/observers/procs.ts from /proc. A process belongs to at most one worktree: its nearest
-- verified agent ancestor's, else the worktree its cwd is under. Latest sample only.
CREATE TABLE observed_procs (
  project TEXT NOT NULL, wt TEXT NOT NULL,
  procs INTEGER, rss_kb INTEGER,
  cpu_pct REAL,        -- 100 = one core; NULL on the first sample after a loop start
  root_pid INTEGER,    -- the verified agent pid; NULL when only cwd matches attributed
  observed_at INTEGER NOT NULL, PRIMARY KEY (project, wt));
-- The host's processes that belong to no worktree, grouped by name like observed_machine.groups,
-- so a host-groups list does not count squad processes twice.
CREATE TABLE observed_host_procs (
  host TEXT PRIMARY KEY,
  groups TEXT,         -- JSON [{comm, procs, rss_kb, cpu_pct}], by rss_kb descending
  procs INTEGER, rss_kb INTEGER,
  scan_ms REAL, observed_at INTEGER NOT NULL);
