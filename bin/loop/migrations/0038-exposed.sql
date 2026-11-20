-- 0038-exposed.sql — what squad members host for the operator to open (expose-hosted-services U1, KTD1).
-- `exposed` holds what roles wrote with `ds expose` (bin/commands/expose.ts, bin/loop/squad/exposed.ts): one
-- open row per (project, squad, owner_wt, name), so exposing a name again updates it in place. An entry
-- ends by setting gone_at + gone_why (ds unexpose, or the loop's reconciler, U2); rows are never deleted.
--   owner_wt  the owner member's worktree id ('<repo>::<path>'); '' for an entry the squad owns from
--             outside a role worktree (--project/--topic: the operator or the Studio)
--   role      the owner's role (operator | studio outside a role worktree); suffix as in members
--   scope     member: ends with its owner member or worktree; squad: only with the squad (or the down timer)
--   created_at defaults to the insert time (store.upsert cannot set a column on insert only)
--   gone_why  unexposed | owner-gone | worktree-removed | squad-closed | down
CREATE TABLE exposed (
  id         INTEGER PRIMARY KEY,
  project    TEXT NOT NULL,
  squad      TEXT NOT NULL,
  owner_wt   TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL,
  suffix     TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  note       TEXT,
  scope      TEXT NOT NULL DEFAULT 'member' CHECK (scope IN ('member', 'squad')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL,
  gone_at    INTEGER,
  gone_why   TEXT
);
CREATE UNIQUE INDEX exposed_open ON exposed (project, squad, owner_wt, name) WHERE gone_at IS NULL;
CREATE INDEX exposed_squad ON exposed (project, squad, gone_at);
-- The loop's probe of each open entry (U2's observer, written with upsert): a TCP connect every minute.
--   status      up | down
--   reach       remote (answers on a non-loopback host or the tailnet IP) | host-only (loopback only) | down
--   down_since  epoch s of the first down probe in the current down run; NULL while up
CREATE TABLE observed_exposed (
  exposed_id INTEGER PRIMARY KEY REFERENCES exposed (id),
  status     TEXT,
  reach      TEXT,
  probed_at  INTEGER,
  down_since INTEGER
);
