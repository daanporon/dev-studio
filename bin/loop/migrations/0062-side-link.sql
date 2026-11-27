-- 0062-side-link.sql — side-loop-host U14 (issue #127, KTD11/KTD13): a side host's own clock of its link to main
-- (bin/link/side-state.ts). Side only; empty on main. One row, written by the side process that holds the link and
-- read by the side fence (reconcilers/side-fence.ts), so a restarted side loop keeps the time the link went down.
--   state       up | down                     the link as the side last saw it
--   pid         the side process that wrote `up`; an `up` from another pid is stale (that process died while up)
--   heard_at    the last time the side saw the link up (each tick while up, and each change)
--   down_since  when the link went down: the last time it was heard up; kept until the link is up again
--   fenced_at   when the side fenced itself for this down_since (pushed, then closed its terminals)
CREATE TABLE side_link (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  state      TEXT NOT NULL,
  pid        INTEGER,
  heard_at   INTEGER,
  down_since INTEGER,
  fenced_at  INTEGER
);
