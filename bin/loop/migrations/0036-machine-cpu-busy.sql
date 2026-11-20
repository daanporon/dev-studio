-- 0036-machine-cpu-busy.sql — the whole machine's busy CPU (machine-top-ram-clarity U6, R11), written by
-- bin/loop/observers/machine.ts from the /proc/stat aggregate `cpu` line. Additive; NULL on older rows.
--   cpu_busy_pct  100 = one core. Delta of (user+nice+system+irq+softirq+steal) over the delta of all fields
--                 between two samples, times cores. idle+iowait count as not busy. NULL on the first sample
--                 after a loop start and when /proc/stat is unreadable.
ALTER TABLE observed_machine ADD COLUMN cpu_busy_pct REAL;
