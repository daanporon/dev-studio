-- 0007-u16-services.sql — the services the loop runs as its children (U16, R7, KTD16): v1 has one,
-- the web board. A row is a wish like a member row: `ds want board` writes want/want_* through
-- store.want; the services reconciler compares it with the observed pid and /healthz ping and
-- fulfil/board.ts starts, restarts or stops the server. One row per scope, keyed the way board.sh
-- keyed its pidfiles: all (project '' and topic ''), a project, or a project + topic.
CREATE TABLE services (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,         -- 'board'
  project      TEXT NOT NULL DEFAULT '',
  topic        TEXT NOT NULL DEFAULT '',
  port         INTEGER,
  want         TEXT,                  -- running|stopped|NULL
  want_payload TEXT,
  want_by      TEXT,
  want_at      INTEGER,
  want_result  TEXT,                  -- `failed: …` when the loop gave up until the next wish
  status       TEXT,                  -- observed: starting|running|stopped|failed
  pid          INTEGER,
  result       TEXT,                  -- why it last failed (a bind error, the restart cap)
  started_at   INTEGER,
  last_ping_at INTEGER,
  restarts     TEXT,                  -- JSON array of the epochs it was restarted at (the cap's window)
  observed_at  INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (name, project, topic)
);
