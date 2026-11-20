-- 0033-unit-cpu.sql — CPU per unit (light-lane plan U2), written by bin/loop/observers/procs.ts each
-- sample while the unit's Builder runs: the Builder worktree's CPU since the last sample, its reaped
-- children included (cutime/cstime), added to the unit's row. Keyed on the unit, not the worktree,
-- so a restarted Builder on the same unit keeps adding to the same row.
CREATE TABLE unit_cpu (
  project TEXT NOT NULL, squad TEXT NOT NULL, slug TEXT NOT NULL,
  cpu_s REAL NOT NULL DEFAULT 0,  -- CPU-seconds (1 core busy for 1 s = 1)
  peak_cpu_pct REAL,              -- highest per-sample CPU % (100 = one core); NULL until two samples
  peak_rss_kb INTEGER,            -- highest per-sample RSS of the worktree's processes
  wt TEXT,                        -- the Builder worktree last measured
  first_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, squad, slug));
