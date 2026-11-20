-- 0009-u18-exported.sql — when each squad's JSON last said what its rows say (the file's mtime in ms):
-- set by the export and by the install migration, so a re-switch can tell a file the sweep wrote after
-- a rollback (bin/loop/db/migrate-host.ts).
ALTER TABLE squads ADD COLUMN exported_ms INTEGER;
