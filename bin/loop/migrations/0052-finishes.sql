-- 0052-finishes.sql — the finish record (orca-backend-alternatives U3): one row each time a worker
-- ends its work, written by `ds finish` and by finish-unit.sh (PR, --no-pr, --failed) before it sends
-- worker_done. It is the backend-neutral "this member finished" signal that later replaces Orca's
-- worker_done; until then the loop reads nothing here. `key` is the writer's idempotency key: the same
-- finish again (a replayed request, a re-run) is the same row. Only `ds remove-project` deletes one.
CREATE TABLE finishes (
  id       INTEGER PRIMARY KEY,
  key      TEXT NOT NULL UNIQUE,
  project  TEXT NOT NULL,
  squad    TEXT NOT NULL,
  member   TEXT NOT NULL,        -- <project>/<squad>/<role[-suffix]>, the DS_MEMBER shape
  wt       TEXT,                 -- the worktree the finish was run in, when known
  unit     TEXT,                 -- the unit slug; NULL for a finish that names none (`ds finish -`)
  gen      TEXT,                 -- the member's start generation (DS_GEN); NULL when unset
  outcome  TEXT NOT NULL CHECK (outcome IN ('ok', 'failed', 'no-pr', 'verdict')),
  body     TEXT NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX finishes_member ON finishes (member, gen);
CREATE INDEX finishes_squad ON finishes (project, squad, id);
