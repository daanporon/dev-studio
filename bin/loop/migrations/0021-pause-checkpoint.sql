ALTER TABLE pause_members ADD COLUMN checkpoint_hash TEXT;
ALTER TABLE pause_members ADD COLUMN task_completed INTEGER NOT NULL DEFAULT 0;
