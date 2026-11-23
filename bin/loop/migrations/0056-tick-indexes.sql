-- 0056-tick-indexes.sql — loop-tick-8s U1: three lookups the tick runs many times a round scanned or
-- built an automatic index each time (episodes 8 ms, observed_prs, requests). Each index serves the
-- statements named beside it; tests/loop/hot-queries.test.ts fails if one goes back to a scan.
-- pick.ts reservations() (kind = ? AND state = 'reserved' AND ended_at > ?), pick.ts `kind = 'account'
-- AND ended_at > ?`, observers/github.ts and observers/disk-usage.ts open-episode reads (kind = ? AND ended_at IS NULL).
CREATE INDEX IF NOT EXISTS episodes_kind ON episodes (kind, state, ended_at);
-- reconcilers/lifecycle.ts: the MERGED check and the MAX(pr) ... state = 'OPEN' read, by repo and head.
CREATE INDEX IF NOT EXISTS observed_prs_head ON observed_prs (project, repo, head);
-- reconcilers/lifecycle.ts finish-unit lookup (project, squad, kind).
CREATE INDEX IF NOT EXISTS requests_squad_kind ON requests (project, squad, kind);
ANALYZE episodes;
ANALYZE observed_prs;
ANALYZE requests;
