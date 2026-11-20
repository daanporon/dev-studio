-- 0017-u98-transcript-entrypoint.sql — whose transcript it is (U98, bin/loop/observers/state.ts).
-- A headless `claude -p` (review-unit.sh's reviewers) writes its transcript in the same worktree's
-- project dir as the member's own session, and the board took the newest transcript's model as the
-- member's own. Each transcript row now keeps its entrypoint (`cli`, `sdk-cli`, ...; NULL when the
-- file has none to read), and the board reads the member's model from the newest non-sdk one.
ALTER TABLE observed_transcripts ADD COLUMN entrypoint TEXT;
