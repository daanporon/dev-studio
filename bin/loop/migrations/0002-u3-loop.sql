-- 0002-u3-loop.sql — the columns the loop daemon (U3) needs beyond the v1 schema.
ALTER TABLE health ADD COLUMN tick_ms INTEGER;          -- the last tick's duration
ALTER TABLE members ADD COLUMN limited_until INTEGER;   -- wake() skips the member until then (U8 fills it)
ALTER TABLE episodes ADD COLUMN next_at INTEGER;        -- wake(): no new attempt before this time (backoff)
