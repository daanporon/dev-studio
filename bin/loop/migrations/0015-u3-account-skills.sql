-- 0015-u3-account-skills.sql — can the account load the role skills (account-skills U3): accounts.tsv's
-- 11th column, `ok`, `broken: <reason>` or `warn: <reason>`; NULL = not known (a non-claude row, or a
-- 10-column file from before U3). Read by reconcilers/account-skills.ts, the alerts reconciler and the board.
ALTER TABLE observed_accounts ADD COLUMN skills TEXT;
