-- 0016-u90-sub-agents.sql — the live sub-agents of a worker (U90, bin/loop/observers/orca.ts).
-- A worker that starts a second agent (a muse Builder's review-unit `claude -p`) runs on two
-- accounts at once; the board could only show one. The main agent stays in `account` (as
-- before, from the main lines of orca.sh agent-accounts, so a sub line never overwrites it);
-- every live sub-agent (a `sub` line) lands here as JSON [{agent, model, account}], NULL = none
-- known. Refreshed on the same cadence as `account` (and kept, like it, when the read fails);
-- empty again once the sub-agents exit.
ALTER TABLE observed_workers ADD COLUMN sub_agents TEXT;
