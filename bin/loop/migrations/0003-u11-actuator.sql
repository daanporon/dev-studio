-- 0003-u11-actuator.sql — the actuator's memory (U11): every Orca-changing call with the retry id it
-- was sent under, the sender terminal the loop coordinates each Run through, and the pokes and
-- briefs it still has to verify.

-- One row per Orca mutation, written BEFORE the call (KTD10). A row with no settled_at is a call a
-- crash may have cut short: on boot the actuator asks `request-show` about it. Calls are replayed
-- under the same retry id and from the same sender terminal, so Orca never starts one twice.
CREATE TABLE orca_calls (
  id          INTEGER PRIMARY KEY,
  retry_id    TEXT NOT NULL UNIQUE,  -- Orca's --retry-request
  key         TEXT NOT NULL,         -- what the call is for, e.g. start:<member id>:<want_at>; one live call per key
  op          TEXT NOT NULL,         -- the backend op: worker-start|worker-resume|role-start
  project     TEXT,
  squad       TEXT,
  member      TEXT,
  sender      TEXT,                  -- the sender terminal's handle it went out from
  payload     TEXT,                  -- JSON: the op's arguments
  at          INTEGER NOT NULL,
  state       TEXT NOT NULL,         -- sent|completed|failed|pending|absent
  result      TEXT,                  -- stdout, or the error; NULL when request-show settled it
  dispatch    TEXT,                  -- the dispatch id request-show gave
  settled_at  INTEGER
);
CREATE INDEX orca_calls_key ON orca_calls (key, settled_at);

-- The loop's sender terminal for one squad's Run: a plain shell bound with run-use (one pane
-- coordinates one Run). Orca matches the coordinator by pane, so the pane key survives a new handle.
CREATE TABLE coordinators (
  project     TEXT NOT NULL,
  squad       TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  handle      TEXT NOT NULL,
  pane_key    TEXT,
  wt          TEXT,                  -- the worktree the terminal lives in (the Lead's)
  created_at  INTEGER NOT NULL,
  bound_at    INTEGER,               -- the last run-use
  PRIMARY KEY (project, squad)
);

-- A poke or a start's brief typed with --wait-submit that Orca accepted without seeing a turn
-- start: the next tick checks the member is working, sends it again, and after the configured
-- tries raises one Studio alert.
CREATE TABLE deliveries (
  id          INTEGER PRIMARY KEY,
  project     TEXT NOT NULL,
  squad       TEXT,
  member      TEXT NOT NULL,         -- worktree id
  kind        TEXT NOT NULL,         -- poke|brief
  text        TEXT NOT NULL,
  request     INTEGER,               -- the requests row it fulfils, if any
  tries       INTEGER NOT NULL,
  state       TEXT NOT NULL,         -- accepted|verified|escalated
  at          INTEGER NOT NULL,
  verify_at   INTEGER,
  settled_at  INTEGER
);
CREATE INDEX deliveries_open ON deliveries (state, verify_at);

-- An action the actuator could not finish (a failed send, no free start slot, no account yet)
-- waits in its claim row as `pending` with the action itself, and is acted again from there.
ALTER TABLE episodes ADD COLUMN action TEXT;
CREATE INDEX episodes_pending ON episodes (next_at) WHERE state = 'pending' AND action IS NOT NULL;
