-- 0068-machine-rows-local.sql — main's own machine rows move to host 'local', like its other observed rows
-- (side-loop-host U25b): the observers wrote the machine name, so the Builder host brake, which reads 'local',
-- never saw a sample. A row of a host main ever accepted is that side host's and keeps its name. Of main's own
-- rows the newest is renamed (so an open disk-pressure spell keeps its disks); an older one, left from an earlier
-- machine name, stays and is never read as current.
UPDATE observed_machine SET host = 'local'
  WHERE NOT EXISTS (SELECT 1 FROM observed_machine WHERE host = 'local')
    AND host = (SELECT host FROM observed_machine WHERE host NOT IN (SELECT name FROM hosts WHERE accepted_at IS NOT NULL)
      ORDER BY observed_at DESC LIMIT 1);
UPDATE observed_host_procs SET host = 'local'
  WHERE NOT EXISTS (SELECT 1 FROM observed_host_procs WHERE host = 'local')
    AND host = (SELECT host FROM observed_host_procs WHERE host NOT IN (SELECT name FROM hosts WHERE accepted_at IS NOT NULL)
      ORDER BY observed_at DESC LIMIT 1);
