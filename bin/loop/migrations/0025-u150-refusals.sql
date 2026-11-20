-- 0025-u150-refusals.sql — a backend refusal as reality (U150, bin/loop/io/refusals.ts): one row per
-- subject and fingerprint (the wish fields plus the few facts the cause depends on). `transient`
-- counts its tries (one per subject and fingerprint every 15 minutes) until it is treated as
-- `permanent`; a permanent row stops the subject's actions while the fingerprint is unchanged, with one card.
CREATE TABLE refusals (
  project     TEXT NOT NULL,
  subject     TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  squad       TEXT,
  member      TEXT,
  kind        TEXT NOT NULL,             -- the action kind, or the call (pause-release)
  class       TEXT NOT NULL,             -- transient | permanent | unknown (a release whose outcome cannot be known)
  text        TEXT NOT NULL,             -- the backend's answer, last seen
  first_at    INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  next_at     INTEGER,                   -- transient: the subject's next try
  carded_at   INTEGER,                   -- when its one card was written
  PRIMARY KEY (project, subject, fingerprint)
);
CREATE INDEX refusals_subject ON refusals (project, subject, class);
