-- 0067-host-env.sql — side-loop-host U17 (issue #127): the board shows where each host key's value comes from.
-- hosts.env: the [host] keys of conventions/limits.conf that the side host has set in its own environment, as the
-- JSON object it sent in its last hello (bin/link/server.ts); NULL when it sent none. Only the board reads it:
-- main cannot see a side host's environment any other way. Not an up-table, so the link's up_migration stays.
ALTER TABLE hosts ADD COLUMN env TEXT;
