-- 0049-procs-listen.sql — exposed-cleanup U3: each worktree's listening TCP ports (bin/loop/observers/procs.ts),
-- read by bin/loop/squad/unexposed.ts to tell a member once about a port no `ds expose` entry covers.
--   listen  JSON array of {port, addr, pid, comm, since, src}: addr loopback | any; src proc (a socket one of
--           the worktree's processes holds, never the agent's own) | docker (a container's published host port,
--           pid null, comm the container name); since = epoch s the port was first seen in this run. NULL: not
--           scanned yet.
ALTER TABLE observed_procs ADD COLUMN listen TEXT;
