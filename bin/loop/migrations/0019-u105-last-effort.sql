-- 0019-u105-last-effort.sql — the effort a Claude member really runs at (U105, bin/loop/observers/state.ts).
-- Transcripts record `perTurnEffort` on each assistant line. Each transcript row now keeps the newest
-- one beside last_model (NULL when the file has none: not a Claude transcript, or an old one), and the
-- board shows it after the model, with a warning when it is not the configured effort.
ALTER TABLE observed_transcripts ADD COLUMN last_effort TEXT;
