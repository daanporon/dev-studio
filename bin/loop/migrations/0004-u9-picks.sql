-- 0004-u9-picks.sql — the account picker's answer per pending member (U9).
--
-- The pick reconciler (bin/loop/reconcilers/pick.ts) keeps one row per member with an open
-- `want = 'running'` wish: what it would start on and why, or until when it waits. Rows of members
-- that are no longer pending are deleted, so the table is the host's in-flight load and start budget.
CREATE TABLE picks (
  member      INTEGER PRIMARY KEY,   -- members.id
  project     TEXT NOT NULL,
  squad       TEXT,
  role        TEXT NOT NULL,
  tier        TEXT,                  -- standard|hard|NULL (untiered)
  phase       TEXT,                  -- build (the only v1 phase)
  agent       TEXT,
  model       TEXT,
  effort      TEXT,
  account     TEXT,                  -- NULL: the agent's default login
  fallback    INTEGER,               -- 1: not the first rung of the ladder
  wait_until  INTEGER,               -- set when nothing at or above the floor has room (WAIT)
  wait_known  INTEGER,               -- 1: wait_until is a real reset; 0: now + DS_PICK_WAIT_S (moves each tick)
  slot        INTEGER,               -- 1: holds one of the host-wide start slots; 0: waiting or queued
  reason      TEXT,
  picked_at   INTEGER NOT NULL
);
