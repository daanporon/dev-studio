-- 0039-studio-handle.sql — U261: the Studio as a loop member. The loop adopts the project's running
-- Studio (squad `_studio`, role `studio`, bin/loop/squad/studio.ts) and records the one terminal it may
-- ever read or type into. Additive; NULL on older rows.
--   members.handle               the adopted Studio's terminal handle; NULL while none is adopted.
--   observed_terminals.tail_at   when the observer last read that terminal's screen by its handle
--                                (the tail column), so studioReady can tell a tail older than the
--                                terminal's last output.
ALTER TABLE members ADD COLUMN handle TEXT;
ALTER TABLE observed_terminals ADD COLUMN tail_at INTEGER;
