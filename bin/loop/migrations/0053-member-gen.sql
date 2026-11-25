-- 0053-member-gen.sql — U4 of orca-backend-alternatives: a member's start generation. The loop gives
-- every Claude terminal it starts DS_MEMBER, DS_WT and DS_GEN (bin/backend/orca.ts claudeTab and
-- resumeTab) and records the start's generation id here when the start succeeds: the start call's
-- orca_calls.retry_id (a Studio move's own id), so a replay of the same start keeps it. Additive;
-- NULL on older rows and on starts Orca types itself (Codex, Muse), whose terminal has no DS_GEN.
--   members.gen   the generation id of the member's current start.
ALTER TABLE members ADD COLUMN gen TEXT;
