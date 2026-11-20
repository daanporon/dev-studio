-- 0027-u206-parent.sql — a worktree's parent as Orca reports it (`parentWorktreeId` in `ps`, bin/loop/
-- observers/orca.ts): NULL when top-level or not reported. reconcilers/nesting.ts keeps the squad tree.
ALTER TABLE observed_worktrees ADD COLUMN parent TEXT;
