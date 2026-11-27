-- 0063-host-config.sql — side-loop-host U25 (issue #127, KTD16): the per-host overrides of the machine keys, the
-- limits.conf keys tagged `[host]` (bin/lib/host-settings.ts). For those keys lookup is the env var on the host that
-- reads it, then this table's row for that host, then the repo default; a project's own row is never read (it stays,
-- unread, and the board's Settings marks it "now per host"). Written on main by bin/loop/settings/host-settings.ts
-- (`ds host set|rm`, `ds host accept`); a side host gets its own rows in the settings copy (bin/link/replica.ts),
-- renamed to `local`, which is how every host names itself.
--   host    `local` (main itself, or a side host's own copy) or a hosts row's name
--   key     a `[host]` key of conventions/limits.conf
--   value   the line after the key, as a project's limits.conf row stores it
--   set_at  when it was last written (epoch seconds)
CREATE TABLE host_config (
  host    TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  set_at  INTEGER NOT NULL,
  PRIMARY KEY (host, key)
);

-- A host override's history row: project '' and file 'limits.conf' with `host` set. A project's rows keep host NULL.
ALTER TABLE config_history ADD COLUMN host TEXT;
CREATE INDEX config_history_host ON config_history (host, key, id) WHERE host IS NOT NULL;

-- Main's brake keeps today's effect: `on` when any project had it on (KTD16, assumption 15).
INSERT INTO host_config (host, key, value, set_at)
  SELECT 'local', 'builder_host_brake', 'on', CAST(strftime('%s', 'now') AS INTEGER)
  WHERE EXISTS (SELECT 1 FROM config WHERE project <> '' AND file = 'limits.conf' AND key = 'builder_host_brake'
                AND (TRIM(value) = 'on' OR TRIM(value) LIKE 'on %'));

-- Main's host tidy and cleanup globs keep today's effect too: `apply` when any project had it, and each glob key the
-- union of the projects' lists (each glob was already allowed for some project; cleanupGlobs splits on spaces and commas).
INSERT INTO host_config (host, key, value, set_at)
  SELECT 'local', 'host_tidy', 'apply', CAST(strftime('%s', 'now') AS INTEGER)
  WHERE EXISTS (SELECT 1 FROM config WHERE project <> '' AND file = 'limits.conf' AND key = 'host_tidy'
                AND (TRIM(value) = 'apply' OR TRIM(value) LIKE 'apply %'));
INSERT INTO host_config (host, key, value, set_at)
  SELECT 'local', key, group_concat(TRIM(value), ' '), CAST(strftime('%s', 'now') AS INTEGER)
  FROM (SELECT key, value FROM config WHERE project <> '' AND file = 'limits.conf'
          AND key IN ('cleanup_tmp_globs', 'cleanup_trim_globs') AND TRIM(value) NOT IN ('', '-') ORDER BY project)
  GROUP BY key;

-- A side host accepted before this migration: its seats (hosts.seats) and its brake on, as `ds host accept` now writes.
INSERT OR IGNORE INTO host_config (host, key, value, set_at)
  SELECT name, 'seats', CAST(seats AS TEXT), CAST(strftime('%s', 'now') AS INTEGER) FROM hosts WHERE status = 'accepted';
INSERT OR IGNORE INTO host_config (host, key, value, set_at)
  SELECT name, 'builder_host_brake', 'on', CAST(strftime('%s', 'now') AS INTEGER) FROM hosts WHERE status = 'accepted';

INSERT INTO config_history (project, file, key, old_value, new_value, actor, at, host)
  SELECT '', 'limits.conf', key, NULL, value, 'migration', set_at, host FROM host_config;
