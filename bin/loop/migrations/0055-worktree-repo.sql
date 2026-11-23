-- 0055-worktree-repo.sql — U7 of orca-backend-alternatives: the repository a worktree belongs to. The
-- worktree providers (bin/loop/io/worktrees.ts, providers/<name>.ts) record it when they make a worktree,
-- so `list` and `prune` can check every row of a repo against the provider's own list, including a row
-- whose folder is already gone. Additive; NULL on the rows U5's sync writes for Orca's worktrees.
--   worktrees.repo   the main checkout's absolute path.
ALTER TABLE worktrees ADD COLUMN repo TEXT;
CREATE INDEX worktrees_repo ON worktrees(repo);
