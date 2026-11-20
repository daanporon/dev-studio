-- 0014-u65-picked.sql — the pick a limited episode's switch took (U65, bin/loop/reconcilers/limits.ts).
-- JSON {agent, model, effort, account, fallback, rung, reason, why, at}: a switch the actuator holds back
-- keeps it until its account is limited, draining or gone, or it is pick_ttl_s old.
ALTER TABLE episodes ADD COLUMN picked TEXT;
