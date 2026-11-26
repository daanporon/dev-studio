-- 0059-accounts-own-list.sql — dev-studio owns the account list (issue #125, U1, KTD1): the accounts rows become
-- the one host-wide list of logins for every agent with an account kind (bin/lib/account-kinds/).
--   config_dir   the login folder; NULL on an `orca` row means Orca's profile folder
--                (<orcaData>/claude-profiles/<id>/home, KTD2), on a `system` row the agent's own folder
--   source       orca (imported from Orca's list), ds (added by dev-studio) or system (the agent's own login);
--                NULL = not confirmed: the row is not in the list (an old row for a profile Orca no longer lists)
--   login_id     the login's identity, read through the kind (Claude: .claude.json oauthAccount.accountUuid)
--   orca_listed  1 while Orca's last answered list has the account
--   is_default   dev-studio's default for the agent (one per agent), seeded once from Orca's active account
--   removed_at   `ds account remove`: a tombstone (epoch s), so holds and history keep their key and the import
--                never brings the row back
-- observed_account_folders: every login folder the accounts refresh found (account-folders.tsv), owned by the
-- state observer.
ALTER TABLE accounts ADD COLUMN config_dir TEXT;
ALTER TABLE accounts ADD COLUMN source TEXT CHECK (source IN ('orca', 'ds', 'system'));
ALTER TABLE accounts ADD COLUMN login_id TEXT;
ALTER TABLE accounts ADD COLUMN orca_listed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN removed_at INTEGER;
CREATE UNIQUE INDEX accounts_one_default ON accounts (agent) WHERE is_default = 1;

CREATE TABLE observed_account_folders (
  dir TEXT PRIMARY KEY, agent TEXT NOT NULL, login_id TEXT, logged_in INTEGER NOT NULL DEFAULT 0,
  observed_at INTEGER NOT NULL);

-- Backfill: the agents' own logins are system rows (Claude's `system`, and Codex's and Muse's `default`, the one
-- row each has today); a Claude row accounts.tsv has (today Orca's list) is an Orca row Orca lists; every other
-- row stays unconfirmed.
UPDATE accounts SET source = 'system' WHERE account = 'system' OR agent != 'claude';
UPDATE accounts SET source = 'orca', orca_listed = 1
  WHERE source IS NULL AND agent = 'claude'
    AND EXISTS (SELECT 1 FROM observed_accounts o WHERE o.agent = accounts.agent AND o.account = accounts.account);
