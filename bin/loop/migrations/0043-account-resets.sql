-- 0043-account-resets.sql — the account's free limit resets (account-free-resets U3): accounts.tsv's 13th
-- column, the compact JSON the backend's `account-resets` prints ({"state":"reported|not_reported|unknown",
-- "count":n,"grants":[{id,label,left,total,use_by,refills,usable_now}]}); NULL = not known (a failed
-- `account-resets` call, or a 12-column file from before this column). The board shows it as a Free resets cell.
ALTER TABLE observed_accounts ADD COLUMN resets TEXT;
