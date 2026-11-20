-- 0024-dispatch-names.sql — remember which member each dispatch belonged to (U2, event-log-polish).
-- observed_workers keeps only a worktree's current dispatch, so an old ctx_* id in the event log
-- could no longer be named once the member was re-dispatched. One row per dispatch ever seen,
-- written insert-or-ignore by the Orca observer and never updated or deleted, so the board can
-- name any dispatch the loop has held. (The plan named this 0023; U149 took that number first.)
CREATE TABLE dispatches (
  dispatch_id TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  wt          TEXT NOT NULL,  -- the worktree (member) that held the dispatch
  first_seen  INTEGER NOT NULL -- epoch s the loop first saw it
);

-- Backfill: the dispatch each worktree holds now.
INSERT OR IGNORE INTO dispatches (dispatch_id, project, wt, first_seen)
  SELECT dispatch_id, project, wt, COALESCE(dispatch_at, dispatch_seen_at, observed_at)
  FROM observed_workers
  WHERE dispatch_id IS NOT NULL AND dispatch_id <> ''
  ORDER BY observed_at;

-- Backfill: dispatches orca_calls recorded, oldest first so the earliest pairing wins. A call's
-- dispatch id is its `dispatch` column, the `$.result.dispatchId` of a JSON result, or a ctx_*
-- id inside its result text (a bare `ctx_…` answer, or `… dispatch:ctx_… …`); anything that does
-- not parse to a ctx_<12 hex> id is skipped and the board falls back to "an earlier dispatch".
INSERT OR IGNORE INTO dispatches (dispatch_id, project, wt, first_seen)
  SELECT dispatch, project, member, at
  FROM orca_calls
  WHERE project IS NOT NULL AND member IS NOT NULL AND member <> ''
    AND dispatch LIKE 'ctx_%'
  ORDER BY at;

INSERT OR IGNORE INTO dispatches (dispatch_id, project, wt, first_seen)
  SELECT json_extract(result, '$.result.dispatchId'), project, member, at
  FROM orca_calls
  WHERE project IS NOT NULL AND member IS NOT NULL AND member <> ''
    AND json_valid(result) AND json_extract(result, '$.result.dispatchId') LIKE 'ctx_%'
  ORDER BY at;

INSERT OR IGNORE INTO dispatches (dispatch_id, project, wt, first_seen)
  SELECT substr(result, instr(result, 'ctx_'), 16), project, member, at
  FROM orca_calls
  WHERE project IS NOT NULL AND member IS NOT NULL AND member <> ''
    AND instr(result, 'ctx_') > 0
    AND substr(result, instr(result, 'ctx_'), 16) GLOB 'ctx_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ORDER BY at;
