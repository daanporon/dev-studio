-- 0023-u149-observed-agent.sql — per-member reality (U149): the worktree's main agent as the Orca
-- observer reads it from the agent-accounts process walk (bin/loop/observers/orca.ts), next to the
-- account it already had (0010). `state` keeps its Orca meaning (working, waiting, idle, done).
ALTER TABLE observed_workers ADD COLUMN presence TEXT;    -- none / running / unknown: the walk plus a live Orca dispatch
ALTER TABLE observed_workers ADD COLUMN walk TEXT;        -- the last walk's own verdict: running, none, unknown (failed or disagreeing mains)
ALTER TABLE observed_workers ADD COLUMN agent TEXT;       -- the main agent's kind: claude, codex, muse
ALTER TABLE observed_workers ADD COLUMN pid INTEGER;
ALTER TABLE observed_workers ADD COLUMN started_at INTEGER; -- its process start, epoch s (the process table)
ALTER TABLE observed_workers ADD COLUMN rss_kb INTEGER;   -- its resident memory
ALTER TABLE observed_workers ADD COLUMN live_model TEXT;  -- the model it runs now; NULL = unknown (Muse, or nothing to read)
ALTER TABLE observed_workers ADD COLUMN live_effort TEXT;
-- When a transcript's newest model was written (epoch s): newer than the process start, it beats the --model flag.
ALTER TABLE observed_transcripts ADD COLUMN model_at INTEGER;
-- Codex rollouts (bin/loop/observers/codex.ts): a session's cwd and originator (session_meta) and its
-- newest turn's model and effort (turn_context). `read_to` is where the next read of an appended file starts.
CREATE TABLE observed_rollouts (
  path TEXT PRIMARY KEY, cwd TEXT, originator TEXT, mtime INTEGER, size INTEGER, read_to INTEGER,
  model TEXT, effort TEXT, model_at INTEGER, observed_at INTEGER NOT NULL);
CREATE INDEX observed_rollouts_cwd ON observed_rollouts (cwd);
