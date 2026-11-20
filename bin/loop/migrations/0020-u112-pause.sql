-- Pause is an activity overlay; lifecycle, wishes and unfinished work stay intact.
CREATE TABLE pause_intents (
  scope TEXT NOT NULL CHECK (scope IN ('project', 'squad', 'member')),
  project TEXT NOT NULL,
  squad TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('manual', 'dependency')),
  generation TEXT NOT NULL,
  prerequisites TEXT,
  requested_by TEXT,
  requested_at INTEGER NOT NULL,
  cleared_at INTEGER,
  PRIMARY KEY (scope, project, squad, role, suffix, source)
);
CREATE TABLE pause_scopes (
  scope TEXT NOT NULL,
  project TEXT NOT NULL,
  squad TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, project, squad, role, suffix)
);
-- Slot identity survives member row rekeying and retained-worktree starts.
CREATE TABLE pause_members (
  project TEXT NOT NULL,
  squad TEXT NOT NULL,
  role TEXT NOT NULL,
  suffix TEXT NOT NULL DEFAULT '',
  generation TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('active', 'pausing', 'paused', 'resuming')),
  reason TEXT,
  requested_at INTEGER NOT NULL,
  resumed_at INTEGER,
  checkpoint TEXT,
  acknowledged_at INTEGER,
  dispatch TEXT,
  session TEXT,
  delivered_at INTEGER,
  closed_at INTEGER,
  terminals TEXT,
  PRIMARY KEY (project, squad, role, suffix)
);
ALTER TABLE relayed ADD COLUMN paused_at INTEGER;
