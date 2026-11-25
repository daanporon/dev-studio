-- 0051-observed-disk-usage.sql — disk-pressure card U3: what uses the host's disk, read async by
-- bin/loop/observers/disk-usage.ts (`docker system df --format json` and `du -sk` over disk_watch_paths).
-- The disk-pressure reconciler and the board read it; nothing here is a decision input for deleting.
CREATE TABLE observed_disk_usage (
  key            TEXT PRIMARY KEY,   -- docker:<type> (build-cache, images, containers, volumes) | du:<path> | meta:docker | meta:du
  label          TEXT,               -- what the card names: "Docker build cache", "~/.bun/install/cache"
  size_kb        INTEGER,            -- NULL = not measured
  reclaimable_kb INTEGER,            -- docker only
  error          TEXT,               -- why a read failed (a meta row holds the last read's outcome)
  read_at        INTEGER,            -- epoch s of the read that wrote the row
  observed_at    INTEGER NOT NULL);
