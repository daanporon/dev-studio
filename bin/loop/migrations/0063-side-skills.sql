-- 0063-side-skills.sql — side-loop-host U21 (issue #127): a side host checks the role skills of its own logins.
--   observed_account_folders gains `skills`: what bin/lib/account-skills.ts skillsValue reads in a Claude login
--   folder (`ok`, `broken: <reason>` or `warn: <reason>`, as observed_accounts.skills holds it). Only a side
--   host's observer writes it, for its folders with a login; NULL (main's own scan, another agent) is unknown.
--   It comes up the link with the rest of the row (bin/link/replica.ts).
ALTER TABLE observed_account_folders ADD COLUMN skills TEXT;
