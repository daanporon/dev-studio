-- 0001-init.sql — the v1 schema of loop.db (U2). Later units add NNNN-u<n>-<what>.sql files;
-- the runner in bin/loop/core/store.ts applies every unapplied file in filename order, one transaction each.
--
-- Three kinds of rows (KTD15): facts (written with one `events` row in the same transaction), wishes
-- (the `want*` columns of squads, members and services), and one-off `requests`. Observed and derived
-- rows carry `observed_at` (epoch seconds) and are written by the loop and the importers only.
-- `doc` columns keep the JSON object the row was imported from, so an export overlays the real
-- columns onto it and stays byte-equal for an unchanged squad.

CREATE TABLE projects (
  label        TEXT PRIMARY KEY,
  home_repo    TEXT,                 -- dispatcher.json home_repo (a repo selector)
  studio_wt    TEXT,
  owner        TEXT,                 -- GitHub owner/name of the repo, when known
  name         TEXT,
  doc          TEXT,                 -- dispatcher.json as imported
  observed_at  INTEGER NOT NULL
);

CREATE TABLE squads (
  id           INTEGER PRIMARY KEY,
  project      TEXT NOT NULL,
  topic        TEXT NOT NULL,
  status       TEXT,                 -- observed: running|blocked|waiting-on-you|suspended|done|failed|gone
  type         TEXT,
  autonomy     TEXT,
  repo         TEXT,
  host         TEXT,
  framing      TEXT,
  task_id      TEXT,
  run_id       TEXT,
  lead_wt      TEXT,
  doc          TEXT,                 -- the squad JSON object, minus nothing; export overlays the columns
  want         TEXT,                 -- running|suspended|gone|NULL
  want_payload TEXT,                 -- only data with no column of its own (v1: replay argv, U13b)
  want_by      TEXT,
  want_at      INTEGER,
  want_result  TEXT,
  observed_at  INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (project, topic)
);

CREATE TABLE members (
  id           INTEGER PRIMARY KEY,
  project      TEXT NOT NULL,
  squad        TEXT NOT NULL,        -- the squad's topic
  ord          INTEGER,              -- position in the squad JSON's members array (NULL: not exported)
  wt           TEXT,                 -- NULL while only wanted
  role         TEXT NOT NULL,
  suffix       TEXT NOT NULL DEFAULT '',
  agent        TEXT,
  model        TEXT,
  effort       TEXT,
  account      TEXT,
  host         TEXT,                 -- v2 hook: multi-host members (U29)
  tier         TEXT,                 -- standard|hard (v2 hook: ladder)
  phase        TEXT,                 -- v2 hook: build|babysit (U22)
  since        TEXT,
  status       TEXT,                 -- observed: running|gone|...
  doc          TEXT,
  want         TEXT,
  want_payload TEXT,
  want_by      TEXT,
  want_at      INTEGER,
  want_result  TEXT,
  observed_at  INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (project, squad, wt)
);
CREATE INDEX members_slot ON members (project, squad, role, suffix);

CREATE TABLE units (
  id            INTEGER PRIMARY KEY,
  project       TEXT NOT NULL,
  squad         TEXT NOT NULL,
  slug          TEXT NOT NULL,
  ord           INTEGER,
  status        TEXT,                -- planned|dispatched|done|cancelled (|merged once U6 lands)
  pr            TEXT,
  tier          TEXT,
  builder_wt    TEXT,
  plan          TEXT,
  plan_unit     TEXT,
  deps          TEXT,                -- JSON array of slugs
  ext_deps      TEXT,                -- JSON array of <squad>/<slug>
  hold          INTEGER,
  wait_until    INTEGER,
  superseded_by TEXT,
  into_merged   INTEGER,
  doc           TEXT,
  observed_at   INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (project, squad, slug)
);

CREATE TABLE accounts (
  agent        TEXT NOT NULL,
  account      TEXT NOT NULL,
  label        TEXT,
  state        TEXT,                 -- v2 hook: active|draining (U25)
  observed_at  INTEGER NOT NULL,
  PRIMARY KEY (agent, account)
);

CREATE TABLE requests (
  id           INTEGER PRIMARY KEY,
  project      TEXT,
  squad        TEXT,
  member       TEXT,
  kind         TEXT NOT NULL,        -- free text: poke, keys, message, restart, switch, role-edit, ...
  payload      TEXT,                 -- JSON
  tier         TEXT,                 -- v2 hook: role requests through the ladder
  key          TEXT UNIQUE,          -- asking twice with one key leaves one row
  requested_by TEXT,
  created_at   INTEGER NOT NULL,
  done_at      INTEGER,
  result       TEXT
);
CREATE INDEX requests_open ON requests (done_at, created_at);

CREATE TABLE events (
  id       INTEGER PRIMARY KEY,
  at       INTEGER NOT NULL,
  project  TEXT,
  squad    TEXT,
  unit     TEXT,
  member   TEXT,
  kind     TEXT NOT NULL,
  payload  TEXT
);
CREATE INDEX events_at ON events (at);

CREATE TABLE timers (
  key      TEXT PRIMARY KEY,
  due_at   INTEGER NOT NULL,
  payload  TEXT
);

CREATE TABLE episodes (
  id           INTEGER PRIMARY KEY,
  project      TEXT NOT NULL,        -- '' for host-wide (.accounts.episodes)
  squad        TEXT,
  subject      TEXT NOT NULL,        -- the sweep's marker key, e.g. <topic>.<role>[-<suffix>]
  kind         TEXT NOT NULL,        -- poke|alerted|limit|park|switch|ready|pending|all-done|req|compacted|limited|account
  started_at   INTEGER,
  ended_at     INTEGER,
  count        INTEGER,
  state        TEXT,
  episode_key  TEXT,
  source       TEXT NOT NULL,        -- sweep|loop
  observed_at  INTEGER NOT NULL,
  UNIQUE (project, subject, kind)
);

CREATE TABLE overrides (
  id          INTEGER PRIMARY KEY,
  member      TEXT NOT NULL,
  model       TEXT,
  account     TEXT,
  scope       TEXT,                  -- v2 hook: override scopes (U24)
  set_by      TEXT,
  set_at      INTEGER,
  cleared_at  INTEGER
);

CREATE TABLE health (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  pid         INTEGER,
  started_at  INTEGER,
  tick_at     INTEGER,
  tick_no     INTEGER,
  version     TEXT
);

CREATE TABLE config (
  project      TEXT NOT NULL,        -- '' for conventions/*
  file         TEXT NOT NULL,        -- roles.conf|limits.conf|models.conf|projects.conf|ship-mode
  key          TEXT NOT NULL,
  value        TEXT,
  observed_at  INTEGER NOT NULL,
  PRIMARY KEY (project, file, key)
);

CREATE TABLE documents (
  project      TEXT NOT NULL,
  path         TEXT NOT NULL,        -- relative to the state root
  mtime        INTEGER,
  body         TEXT,
  observed_at  INTEGER NOT NULL,
  PRIMARY KEY (project, path)
);

-- One observed table per observer source. Each has a natural key and observed_at; U4/U5 fill the
-- Orca and GitHub ones, the importers fill what the state files already hold.
CREATE TABLE observed_worktrees (
  project TEXT NOT NULL, wt TEXT NOT NULL, path TEXT, branch TEXT, doc TEXT,
  observed_at INTEGER NOT NULL, PRIMARY KEY (project, wt));
CREATE TABLE observed_terminals (
  project TEXT NOT NULL, handle TEXT NOT NULL, wt TEXT, title TEXT, tail TEXT, doc TEXT,
  observed_at INTEGER NOT NULL, PRIMARY KEY (project, handle));
CREATE TABLE observed_workers (
  project TEXT NOT NULL, wt TEXT NOT NULL, state TEXT, unread INTEGER, limited TEXT, last_output_at INTEGER, doc TEXT,
  observed_at INTEGER NOT NULL, PRIMARY KEY (project, wt));
CREATE TABLE observed_tokens (
  worker TEXT NOT NULL, model TEXT NOT NULL, topic TEXT, role TEXT, turns INTEGER, input INTEGER,
  cache_write INTEGER, cache_read INTEGER, output INTEGER, ctx INTEGER,
  observed_at INTEGER NOT NULL, PRIMARY KEY (worker, model));
CREATE TABLE observed_prs (
  project TEXT NOT NULL, ref TEXT NOT NULL, pr INTEGER, state TEXT, verdict TEXT, reasons TEXT,
  merged_at INTEGER, doc TEXT,
  observed_at INTEGER NOT NULL, PRIMARY KEY (project, ref));
CREATE TABLE observed_accounts (
  agent TEXT NOT NULL, account TEXT NOT NULL, session_pct TEXT, session_reset TEXT, weekly_pct TEXT,
  weekly_reset TEXT, limited_until TEXT, updated TEXT, label TEXT, note TEXT,
  observed_at INTEGER NOT NULL, PRIMARY KEY (agent, account));
CREATE TABLE observed_transcripts (
  path TEXT PRIMARY KEY, project TEXT, wt TEXT, mtime INTEGER, size INTEGER, last_model TEXT,
  observed_at INTEGER NOT NULL);
CREATE TABLE observed_pickers (
  project TEXT NOT NULL, squad TEXT NOT NULL, id TEXT NOT NULL, doc TEXT,
  observed_at INTEGER NOT NULL, PRIMARY KEY (project, squad, id));
CREATE TABLE observed_sessions (
  project TEXT NOT NULL, file TEXT NOT NULL, url TEXT, status TEXT, doc TEXT,
  observed_at INTEGER NOT NULL, PRIMARY KEY (project, file));
CREATE TABLE observed_markers (
  project TEXT NOT NULL, path TEXT NOT NULL, mtime INTEGER, body TEXT,
  observed_at INTEGER NOT NULL, PRIMARY KEY (project, path));
CREATE TABLE observed_alerts (
  project TEXT NOT NULL, id TEXT NOT NULL, doc TEXT,
  observed_at INTEGER NOT NULL, PRIMARY KEY (project, id));
CREATE TABLE observed_spend (
  project TEXT NOT NULL, squad TEXT NOT NULL, since INTEGER, total INTEGER, lead INTEGER,
  thinker INTEGER, builders INTEGER, other INTEGER, frozen INTEGER,
  observed_at INTEGER NOT NULL, PRIMARY KEY (project, squad));
