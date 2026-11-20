-- 0040-config-history.sql — U255: one row per change a project's settings take through
-- bin/loop/settings/settings.ts (the one writer of a project's limits.conf, roles.conf, models.conf and
-- ship-mode rows). Additive; nothing is ever deleted from it.
--   project, file, key   the config row that changed
--   old_value            its value before; NULL when there was no row
--   new_value            its value after; NULL when the row was dropped (back to the default)
--   actor                who made it: board, ds, migration, …
--   at                   when (epoch seconds)
CREATE TABLE config_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project    TEXT NOT NULL,
  file       TEXT NOT NULL,
  key        TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  actor      TEXT NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX config_history_key ON config_history (project, file, key, id);
