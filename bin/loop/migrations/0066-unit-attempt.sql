-- 0066-unit-attempt.sql — side-loop-host U15 (issue #127, KTD11): main requeues the units of a host it lost.
-- units.attempt: the Builder attempt the unit is on (NULL is the first). When main fences a host (reconcilers/host-fence.ts),
-- each Builder there is ended and its unit goes to the next attempt: the next Builder starts on `<branch>-r<attempt>` from
-- `retry_from` (the old branch, as pushed to origin; NULL when nothing was pushed and it starts from HEAD again).
-- retry_sha is the old branch's last pushed commit, retry_host the lost host, retry_pr the old branch's PR (one Studio card
-- while it is open).
ALTER TABLE units ADD COLUMN attempt INTEGER;
ALTER TABLE units ADD COLUMN retry_from TEXT;
ALTER TABLE units ADD COLUMN retry_sha TEXT;
ALTER TABLE units ADD COLUMN retry_host TEXT;
ALTER TABLE units ADD COLUMN retry_pr TEXT;
-- members.fenced_at: main ended this member because its host was fenced; fence_closed_at: its stale terminals on that
-- host were closed when the host came back (both NULL for every other member).
ALTER TABLE members ADD COLUMN fenced_at INTEGER;
ALTER TABLE members ADD COLUMN fence_closed_at INTEGER;
