-- 0030-u205-pin-effort-plan.sql — a board pin carries an effort and an account plan (U205):
-- pick.ts's override path runs the pinned model on that effort and picks only among that plan's accounts.
ALTER TABLE overrides ADD COLUMN effort TEXT;
ALTER TABLE overrides ADD COLUMN plan TEXT;
