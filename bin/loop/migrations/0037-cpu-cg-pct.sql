-- 0037-cpu-cg-pct.sql — each worktree row's CPU from its leaf cgroups (machine-top-ram-clarity U9, R9), written by
-- bin/loop/observers/procs.ts. Additive; NULL on older rows.
--   cpu_cg_pct  100 = one core. The cpu.stat usage_usec delta of the leaf cgroups holding the row's processes since the
--               previous scan of each leaf, a shared leaf split by the owners' CPU ticks in it (RSS when none).
--               NULL on the first scan after a loop start, without cgroup v2 and when a cpu.stat can't be read.
--               rss_kb, cpu_pct and unit_cpu are unchanged. Host groups carry the same field in their `groups` JSON.
ALTER TABLE observed_procs ADD COLUMN cpu_cg_pct REAL;
