-- 0034-unit-lanes.sql — one lane record per finished unit (light-lane plan U5), written by the unit-done
-- path (reconcilers/lifecycle.ts 1b) when the unit's PR merges: the lane and rule the plan gave it (U1),
-- its CPU (unit_cpu, U2), whether it was moved to normal (U3's unit_lane_moved event) and the top-level
-- folders its PR touched (the GitHub observer's `files` on a tracked PR). `ds lanes <project>` reads it.
CREATE TABLE unit_lanes (
  project TEXT NOT NULL, squad TEXT NOT NULL, slug TEXT NOT NULL,
  lane TEXT NOT NULL,             -- light|normal as the plan tagged it
  lane_rule TEXT,                 -- the rule id from `Lane: light (rule: <id>)`, else NULL
  cpu_s REAL NOT NULL DEFAULT 0,  -- CPU-seconds the unit used (NULL-free: 0 when unmeasured)
  peak_cpu_pct REAL,
  moved INTEGER NOT NULL DEFAULT 0, -- 1 when a unit_lane_moved event was recorded for it
  folders TEXT,                   -- JSON array of top-level folders of the PR's files ("." = repo root)
  pr INTEGER, done_at INTEGER NOT NULL,
  PRIMARY KEY (project, squad, slug));
