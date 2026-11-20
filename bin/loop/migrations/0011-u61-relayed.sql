-- 0011-u61-relayed.sql — the Run mail the loop relays to the Lead (U61, bin/loop/messages/relay.ts). While the
-- loop's pane holds a squad's Run, a worker's ask, status or worker_done to run:<id> lands where only
-- that pane can read it; the loop copies each message here, forwards it to the Lead's worktree inbox,
-- and marks it read in the Run only once every message it saw is forwarded. A consuming check takes
-- the whole unread batch, so a message read in Orca but not yet forwarded lives on here.
CREATE TABLE relayed (
  msg_id        TEXT PRIMARY KEY,
  project       TEXT NOT NULL,
  squad         TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  from_handle   TEXT,
  type          TEXT,
  subject       TEXT,
  body          TEXT,
  payload       TEXT,                -- Orca's payload (an ask's taskId, dispatchId, question, options)
  seen_at       INTEGER NOT NULL,
  forwarded_at  INTEGER,             -- delivered to the Lead's worktree inbox
  taken_at      INTEGER,             -- marked read in the Run
  tries         INTEGER NOT NULL DEFAULT 0,
  error         TEXT                 -- the last failed forward
);
CREATE INDEX relayed_open ON relayed (project, squad, forwarded_at);
