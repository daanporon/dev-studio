-- 0042-observed-update.sql — whether the host's dev-studio checkout is behind its upstream, and what the
-- missing commits would cost (board-update-button U2). One row per host, written by
-- bin/loop/observers/update.ts; the board reads it (U3) and never runs git itself.
--   root        the dev-studio checkout the row is about
--   branch      the checked-out branch; NULL when detached
--   head        HEAD's sha; upstream: origin/<branch>'s sha after the last fetch
--   behind, ahead  commits origin/<branch> has that HEAD lacks / HEAD has that it lacks
--   dirty       1 when tracked files have uncommitted changes (`reset --hard` would discard them)
--   commits     JSON [{sha, title, classes}], newest first, capped at 20 (classes: update-classes.ts)
--   classes     JSON array of the classes over every behind commit (skills | instructions | code)
--   need        restart | reload | none, the strongest need of those classes (update-classes.ts need())
--   state       ok | detached | no_upstream | fetch_failed
--   error, error_at  the last failed check (one trimmed line, when); the last good counts are kept
--   checked_at  the last successful fetch; every_s: the fetch interval (DS_LOOP_UPDATE_S, 0 = never fetch)
--   last_update JSON of state/loop/host-update.json (update-host's last outcome); NULL when absent
--   squads      JSON {label: {rev, behind, classes, need, unknown?}} for each loop project whose
--               squads-rev.json names a commit other than HEAD
CREATE TABLE observed_update (
  host TEXT PRIMARY KEY,
  root TEXT, branch TEXT, head TEXT, upstream TEXT,
  behind INTEGER, ahead INTEGER, dirty INTEGER,
  commits TEXT, classes TEXT, need TEXT,
  state TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'detached', 'no_upstream', 'fetch_failed')),
  error TEXT, error_at INTEGER,
  checked_at INTEGER, every_s INTEGER,
  last_update TEXT, squads TEXT,
  observed_at INTEGER NOT NULL);
