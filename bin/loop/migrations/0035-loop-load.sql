-- 0035-loop-load.sql — the dev-studio loop's own load (machine-top-ram-clarity U5, R13/KTD12), written per host
-- by bin/loop/observers/procs.ts. Additive; every column NULL on rows written before this migration.
--   loop_source    'cgroup' when the loop's own cgroup holds only the loop and its descendants (and is not `/`),
--                  else 'tree' (the loop's process tree from the same scan); NULL when the loop isn't in the scan.
--   loop_cpu_pct   100 = one core. cgroup: cpu.stat usage_usec delta over the time since the previous scan (it
--                  counts helpers that start and exit between scans); tree: the tree's tick delta. NULL on the
--                  first scan after start.
--   loop_mem_kb    cgroup: memory.stat anon + shmem; tree: the tree's RSS.
--   loop_cache_kb  cgroup: memory.stat file (page cache charged to the loop, reclaimable); tree: NULL.
ALTER TABLE observed_host_procs ADD COLUMN loop_cpu_pct REAL;
ALTER TABLE observed_host_procs ADD COLUMN loop_mem_kb INTEGER;
ALTER TABLE observed_host_procs ADD COLUMN loop_cache_kb INTEGER;
ALTER TABLE observed_host_procs ADD COLUMN loop_source TEXT;
