-- 0028-u1-machine.sql — the host machine's reality (board machine panel U1): one row per host, written
-- by bin/loop/observers/machine.ts from /proc and statfs. NULL = unreadable.
CREATE TABLE observed_machine (
  host TEXT PRIMARY KEY,
  cores INTEGER, load1 REAL, load5 REAL, load15 REAL,
  mem_total_kb INTEGER, mem_avail_kb INTEGER, swap_total_kb INTEGER, swap_free_kb INTEGER,
  psi_cpu_some REAL, psi_mem_some REAL, psi_mem_full REAL, psi_io_some REAL, psi_io_full REAL,  -- avg10 %
  disks TEXT,    -- JSON [{path, total_kb, free_kb}], one per filesystem
  groups TEXT,   -- JSON [{comm, procs, rss_kb, cpu_pct}], cpu_pct null on the first sample
  scan_ms REAL, observed_at INTEGER NOT NULL);
