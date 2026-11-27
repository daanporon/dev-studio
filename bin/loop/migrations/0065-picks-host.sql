-- 0065-picks-host.sql — side-loop-host U11 (issue #127, KTD10): the host a pick placed its start on.
-- NULL: main (or a pick that places nothing: a wait, a queued start, a shell `ds pick`). A side host's name when
-- placement (bin/loop/capacity/place.ts) moved the start there; the picks reconciler writes the same name to
-- members.host before the start, and place.ts counts this walk's rows against that host's seats.
ALTER TABLE picks ADD COLUMN host TEXT;
