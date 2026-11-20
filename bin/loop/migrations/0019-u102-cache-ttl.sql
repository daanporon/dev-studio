-- 0019-u102-cache-ttl.sql — token-usage.sh --by-worker splits cache_write by its cache TTL (U102).
-- cw_1h (written on the 1-hour TTL, weighs x2) and cw_5m (5-minute TTL, x1.25); NULL on a row
-- read from a tokens.tsv written before the split, which then weighs all of cache_write at x1.25.
ALTER TABLE observed_tokens ADD COLUMN cw_1h INTEGER;
ALTER TABLE observed_tokens ADD COLUMN cw_5m INTEGER;
