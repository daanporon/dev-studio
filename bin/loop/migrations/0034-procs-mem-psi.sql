-- 0034-procs-mem-psi.sql — RAM counted once and pressure per worktree (machine-top-ram-clarity U4, KTD6/KTD8/KTD11),
-- written by bin/loop/observers/procs.ts. Additive: rss_kb and cpu_pct keep their meaning (R9).
--   mem_kb   the worktree's share of the memory charged to the leaf cgroups holding its processes (anon + shmem of
--            each leaf, or of its nearest ancestor with the memory controller, split across its owners by RSS).
--            NULL for a whole scan when cgroup v2 or any memory.stat is unreadable, and on rows written before this
--            migration.
--   psi_cpu / psi_mem  `some` avg10 of cpu.pressure / memory.pressure, the max over the worktree's non-root leaves;
--            NULL when none of its pressure files can be read.
ALTER TABLE observed_procs ADD COLUMN mem_kb INTEGER;
ALTER TABLE observed_procs ADD COLUMN psi_cpu REAL;
ALTER TABLE observed_procs ADD COLUMN psi_mem REAL;
