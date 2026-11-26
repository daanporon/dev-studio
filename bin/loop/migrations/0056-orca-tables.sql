-- 0056 Orca-only data in its own tables (orca-backend-alternatives U6). Each Orca-only value the core
-- tables hold gets a copy in an `orca_*` table, so the clean-up can move readers there and drop the
-- old columns, and a squad on another backend leaves these tables alone:
--   orca_runs          squads.run_id, squads.task_id                       (one row per squad)
--   orca_coordinators  coordinators (the Run's coordinator terminal)       (one row per squad; ends with gone_at)
--   orca_dispatches    dispatches (each dispatch id and its worktree)      (one row per dispatch)
--   orca_workers       observed_workers.dispatch_id, dispatch, dispatch_at, dispatch_seen_at (one row per worktree)
--   orca_pauses        pause_members.dispatch, task_completed              (one row per paused member)
-- `orca_calls` and `relayed` already hold nothing but Orca data in tables of their own and stay as they
-- are. The migration copies today's rows; triggers on the old tables copy every later write, so every
-- writer (the squad fulfiller, the Orca observer, coordinator binds, pause, `ds import`) fills both
-- while readers stay on the old columns. A row the old table deletes (a re-spawned squad's
-- coordinator) is kept with `gone_at`. tests/loop/orca-tables.test.ts checks both places agree.

CREATE TABLE orca_runs (
  project    TEXT NOT NULL,
  squad      TEXT NOT NULL,      -- the squad's topic
  run_id     TEXT,
  task_id    TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, squad)
);
INSERT INTO orca_runs (project, squad, run_id, task_id, updated_at)
  SELECT project, topic, run_id, task_id, unixepoch() FROM squads WHERE run_id IS NOT NULL OR task_id IS NOT NULL;
CREATE TRIGGER squads_orca_runs_ins AFTER INSERT ON squads WHEN NEW.run_id IS NOT NULL OR NEW.task_id IS NOT NULL BEGIN
  INSERT INTO orca_runs (project, squad, run_id, task_id, updated_at) VALUES (NEW.project, NEW.topic, NEW.run_id, NEW.task_id, unixepoch())
    ON CONFLICT (project, squad) DO UPDATE SET run_id = excluded.run_id, task_id = excluded.task_id, updated_at = excluded.updated_at;
END;
CREATE TRIGGER squads_orca_runs_upd AFTER UPDATE OF run_id, task_id ON squads
  WHEN NEW.run_id IS NOT OLD.run_id OR NEW.task_id IS NOT OLD.task_id BEGIN
  INSERT INTO orca_runs (project, squad, run_id, task_id, updated_at) VALUES (NEW.project, NEW.topic, NEW.run_id, NEW.task_id, unixepoch())
    ON CONFLICT (project, squad) DO UPDATE SET run_id = excluded.run_id, task_id = excluded.task_id, updated_at = excluded.updated_at;
END;

CREATE TABLE orca_coordinators (
  project    TEXT NOT NULL,
  squad      TEXT NOT NULL,      -- '' is the project's outside pane
  run_id     TEXT NOT NULL,
  handle     TEXT NOT NULL,
  pane_key   TEXT,
  wt         TEXT,
  wt_path    TEXT,
  created_at INTEGER NOT NULL,
  bound_at   INTEGER,
  gone_at    INTEGER,            -- the coordinators row was deleted
  PRIMARY KEY (project, squad)
);
INSERT INTO orca_coordinators (project, squad, run_id, handle, pane_key, wt, wt_path, created_at, bound_at)
  SELECT project, squad, run_id, handle, pane_key, wt,
         COALESCE(wt_path, CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END),
         created_at, bound_at FROM coordinators;
CREATE TRIGGER coordinators_orca_ins AFTER INSERT ON coordinators BEGIN
  INSERT INTO orca_coordinators (project, squad, run_id, handle, pane_key, wt, wt_path, created_at, bound_at, gone_at)
    VALUES (NEW.project, NEW.squad, NEW.run_id, NEW.handle, NEW.pane_key, NEW.wt,
            COALESCE(NEW.wt_path, CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END),
            NEW.created_at, NEW.bound_at, NULL)
    ON CONFLICT (project, squad) DO UPDATE SET run_id = excluded.run_id, handle = excluded.handle, pane_key = excluded.pane_key,
      wt = excluded.wt, wt_path = excluded.wt_path, created_at = excluded.created_at, bound_at = excluded.bound_at, gone_at = NULL;
END;
CREATE TRIGGER coordinators_orca_upd AFTER UPDATE ON coordinators BEGIN
  INSERT INTO orca_coordinators (project, squad, run_id, handle, pane_key, wt, wt_path, created_at, bound_at, gone_at)
    VALUES (NEW.project, NEW.squad, NEW.run_id, NEW.handle, NEW.pane_key, NEW.wt,
            COALESCE(NEW.wt_path, CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END),
            NEW.created_at, NEW.bound_at, NULL)
    ON CONFLICT (project, squad) DO UPDATE SET run_id = excluded.run_id, handle = excluded.handle, pane_key = excluded.pane_key,
      wt = excluded.wt, wt_path = excluded.wt_path, created_at = excluded.created_at, bound_at = excluded.bound_at, gone_at = NULL;
END;
CREATE TRIGGER coordinators_orca_del AFTER DELETE ON coordinators BEGIN
  UPDATE orca_coordinators SET gone_at = unixepoch() WHERE project = OLD.project AND squad = OLD.squad AND gone_at IS NULL;
END;

CREATE TABLE orca_dispatches (
  dispatch_id TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  wt          TEXT NOT NULL,     -- the worktree (member) that held the dispatch
  wt_path     TEXT,
  first_seen  INTEGER NOT NULL   -- epoch s the loop first saw it
);
INSERT INTO orca_dispatches (dispatch_id, project, wt, wt_path, first_seen)
  SELECT dispatch_id, project, wt,
         COALESCE(wt_path, CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END),
         first_seen FROM dispatches;
CREATE TRIGGER dispatches_orca_ins AFTER INSERT ON dispatches BEGIN
  INSERT INTO orca_dispatches (dispatch_id, project, wt, wt_path, first_seen)
    VALUES (NEW.dispatch_id, NEW.project, NEW.wt,
            COALESCE(NEW.wt_path, CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END),
            NEW.first_seen)
    ON CONFLICT (dispatch_id) DO UPDATE SET project = excluded.project, wt = excluded.wt, wt_path = excluded.wt_path, first_seen = excluded.first_seen;
END;
CREATE TRIGGER dispatches_orca_upd AFTER UPDATE ON dispatches BEGIN
  INSERT INTO orca_dispatches (dispatch_id, project, wt, wt_path, first_seen)
    VALUES (NEW.dispatch_id, NEW.project, NEW.wt,
            COALESCE(NEW.wt_path, CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END),
            NEW.first_seen)
    ON CONFLICT (dispatch_id) DO UPDATE SET project = excluded.project, wt = excluded.wt, wt_path = excluded.wt_path, first_seen = excluded.first_seen;
END;

CREATE TABLE orca_workers (
  project          TEXT NOT NULL,
  wt               TEXT NOT NULL,
  wt_path          TEXT,
  dispatch_id      TEXT,         -- the worker's current dispatch (observed_workers.dispatch_id)
  dispatch         TEXT,         -- its status
  dispatch_at      INTEGER,      -- when the loop saw it start or settle (NULL: settled before it watched)
  dispatch_seen_at INTEGER,      -- the last Run read that listed it
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (project, wt)
);
INSERT INTO orca_workers (project, wt, wt_path, dispatch_id, dispatch, dispatch_at, dispatch_seen_at, updated_at)
  SELECT project, wt,
         COALESCE(wt_path, CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END),
         dispatch_id, dispatch, dispatch_at, dispatch_seen_at, unixepoch() FROM observed_workers
   WHERE dispatch_id IS NOT NULL OR dispatch IS NOT NULL OR dispatch_at IS NOT NULL OR dispatch_seen_at IS NOT NULL;
CREATE TRIGGER observed_workers_orca_ins AFTER INSERT ON observed_workers
  WHEN NEW.dispatch_id IS NOT NULL OR NEW.dispatch IS NOT NULL OR NEW.dispatch_at IS NOT NULL OR NEW.dispatch_seen_at IS NOT NULL BEGIN
  INSERT INTO orca_workers (project, wt, wt_path, dispatch_id, dispatch, dispatch_at, dispatch_seen_at, updated_at)
    VALUES (NEW.project, NEW.wt,
            COALESCE(NEW.wt_path, CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END),
            NEW.dispatch_id, NEW.dispatch, NEW.dispatch_at, NEW.dispatch_seen_at, unixepoch())
    ON CONFLICT (project, wt) DO UPDATE SET wt_path = excluded.wt_path, dispatch_id = excluded.dispatch_id, dispatch = excluded.dispatch,
      dispatch_at = excluded.dispatch_at, dispatch_seen_at = excluded.dispatch_seen_at, updated_at = excluded.updated_at;
END;
CREATE TRIGGER observed_workers_orca_upd AFTER UPDATE OF dispatch_id, dispatch, dispatch_at, dispatch_seen_at ON observed_workers
  WHEN NEW.dispatch_id IS NOT OLD.dispatch_id OR NEW.dispatch IS NOT OLD.dispatch OR NEW.dispatch_at IS NOT OLD.dispatch_at
    OR NEW.dispatch_seen_at IS NOT OLD.dispatch_seen_at BEGIN
  INSERT INTO orca_workers (project, wt, wt_path, dispatch_id, dispatch, dispatch_at, dispatch_seen_at, updated_at)
    VALUES (NEW.project, NEW.wt,
            COALESCE(NEW.wt_path, CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END),
            NEW.dispatch_id, NEW.dispatch, NEW.dispatch_at, NEW.dispatch_seen_at, unixepoch())
    ON CONFLICT (project, wt) DO UPDATE SET wt_path = excluded.wt_path, dispatch_id = excluded.dispatch_id, dispatch = excluded.dispatch,
      dispatch_at = excluded.dispatch_at, dispatch_seen_at = excluded.dispatch_seen_at, updated_at = excluded.updated_at;
END;

CREATE TABLE orca_pauses (
  project        TEXT NOT NULL,
  squad          TEXT NOT NULL,
  role           TEXT NOT NULL,
  suffix         TEXT NOT NULL DEFAULT '',
  generation     TEXT NOT NULL,  -- the pause generation the values belong to
  dispatch       TEXT,           -- the dispatch the pause instruction was delivered under ('-': none)
  task_completed INTEGER NOT NULL DEFAULT 0,  -- that dispatch read completed at delivery
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (project, squad, role, suffix)
);
INSERT INTO orca_pauses (project, squad, role, suffix, generation, dispatch, task_completed, updated_at)
  SELECT project, squad, role, suffix, generation, dispatch, task_completed, unixepoch() FROM pause_members
   WHERE dispatch IS NOT NULL OR task_completed != 0;
CREATE TRIGGER pause_members_orca_ins AFTER INSERT ON pause_members WHEN NEW.dispatch IS NOT NULL OR NEW.task_completed != 0 BEGIN
  INSERT INTO orca_pauses (project, squad, role, suffix, generation, dispatch, task_completed, updated_at)
    VALUES (NEW.project, NEW.squad, NEW.role, NEW.suffix, NEW.generation, NEW.dispatch, NEW.task_completed, unixepoch())
    ON CONFLICT (project, squad, role, suffix) DO UPDATE SET generation = excluded.generation, dispatch = excluded.dispatch,
      task_completed = excluded.task_completed, updated_at = excluded.updated_at;
END;
CREATE TRIGGER pause_members_orca_upd AFTER UPDATE OF generation, dispatch, task_completed ON pause_members
  WHEN (NEW.dispatch IS NOT OLD.dispatch OR NEW.task_completed IS NOT OLD.task_completed OR NEW.generation IS NOT OLD.generation)
   AND (NEW.dispatch IS NOT NULL OR NEW.task_completed != 0
        OR EXISTS (SELECT 1 FROM orca_pauses o WHERE o.project = NEW.project AND o.squad = NEW.squad AND o.role = NEW.role AND o.suffix = NEW.suffix)) BEGIN
  INSERT INTO orca_pauses (project, squad, role, suffix, generation, dispatch, task_completed, updated_at)
    VALUES (NEW.project, NEW.squad, NEW.role, NEW.suffix, NEW.generation, NEW.dispatch, NEW.task_completed, unixepoch())
    ON CONFLICT (project, squad, role, suffix) DO UPDATE SET generation = excluded.generation, dispatch = excluded.dispatch,
      task_completed = excluded.task_completed, updated_at = excluded.updated_at;
END;
