-- 0013-u68-placed.sql — when the loop last placed a member on its account (U68, bin/loop/capacity/pick.ts loads()).
-- A member placed in the last pick_ttl_s seconds adds its expected load to its account: its use has not
-- reached the account's usage numbers yet. Older members show in the real session %.
ALTER TABLE members ADD COLUMN placed_at INTEGER;
