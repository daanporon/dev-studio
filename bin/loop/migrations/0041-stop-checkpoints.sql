-- 0040-stop-checkpoints.sql — U266: the journal checkpoint a planned restart asks for first
-- (bin/loop/pause/stop-checkpoint.ts). One row per ask; a newer stop of the same member is a new row.
--   member_id, project, squad, role, suffix   the member asked (its members row and identity)
--   stop_key       the stop the ask belongs to (`restart:<restart_at>`, `fallback[:<marker>]`,
--                  `pin:<override id>`, `rss:<last rss_restart>`); another key is another stop
--   why            the stop's why: restart | fallback | pin | rss
--   generation     the fresh id the journal line must carry (`checkpoint <generation>: …`)
--   state          asking | verified | failed | dropped
--   created_at     when the stop was first owed; asked_at when the ask was sent; settled_at when
--                  it was verified, failed or dropped; checkpoint_hash checkpointHash() of the line
CREATE TABLE stop_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL, project TEXT NOT NULL, squad TEXT NOT NULL, role TEXT NOT NULL, suffix TEXT NOT NULL DEFAULT '',
  stop_key TEXT NOT NULL, why TEXT NOT NULL, generation TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'asking', created_at INTEGER NOT NULL, asked_at INTEGER, settled_at INTEGER, checkpoint_hash TEXT);
CREATE INDEX stop_checkpoints_member ON stop_checkpoints (member_id, id);
