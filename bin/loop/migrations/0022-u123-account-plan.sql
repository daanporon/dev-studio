-- 0022-u123-account-plan.sql — the account's plan (U123): accounts.tsv's 12th column, `Max`, `Ultra` or the
-- raw tier text (the old shell lib ds_account_plan, one reader per agent); NULL = not known (an agent without a
-- reader, a missing .claude.json or field, or an 11-column file from before U123). The board shows it.
ALTER TABLE observed_accounts ADD COLUMN plan TEXT;
