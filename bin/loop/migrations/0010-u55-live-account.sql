-- 0010-u55-live-account.sql — the account a worker's live agent really runs on (orca.sh agent-accounts),
-- whoever started it: NULL = not known (no agent process, several that disagree, or not Claude).
-- account_at: when it was last read; an old reading (the read keeps failing) is not trusted.
ALTER TABLE observed_workers ADD COLUMN account TEXT;
ALTER TABLE observed_workers ADD COLUMN account_at INTEGER;
