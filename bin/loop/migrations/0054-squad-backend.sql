-- 0054-squad-backend.sql — U9 of orca-backend-alternatives: the backend a squad runs on. Chosen once, at
-- spawn (bin/backend/registry.ts chooseSquadBackend: `spawn-squad --backend`, else the project's
-- `default_backend`; the worktree tool from `worktree_provider`), written with the squad's wish fill and
-- never changed while the squad lives. Every existing squad reads `orca` on Orca's own worktrees.
--   squads.backend            orca | orca-lite | tmux | herdr
--   squads.backend_host       the machine its terminals run on (`local`); squads.host stays spawn-squad's
--                             --host <saved-env> dev-env host, so this is a column of its own
--   squads.worktree_provider  orca | git | treehouse (the worktree tool, resolved: never `auto`)
ALTER TABLE squads ADD COLUMN backend TEXT NOT NULL DEFAULT 'orca';
ALTER TABLE squads ADD COLUMN backend_host TEXT NOT NULL DEFAULT 'local';
ALTER TABLE squads ADD COLUMN worktree_provider TEXT NOT NULL DEFAULT 'orca';
-- Written once: a squad that has started (its doc is written) and is not closed keeps all three. A
-- closed squad started again under its old topic may start on another backend.
CREATE TRIGGER squads_backend_once BEFORE UPDATE OF backend, backend_host, worktree_provider ON squads
WHEN OLD.doc IS NOT NULL AND COALESCE(OLD.status, '') NOT IN ('closed', 'gone')
  AND (NEW.backend IS NOT OLD.backend OR NEW.backend_host IS NOT OLD.backend_host OR NEW.worktree_provider IS NOT OLD.worktree_provider)
BEGIN
  SELECT RAISE(ABORT, 'squads: a squad''s backend, backend_host and worktree_provider are written once at spawn');
END;
