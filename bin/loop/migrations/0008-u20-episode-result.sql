-- 0008-u20-episode-result.sql — what a settled action came to (U20): the actuator keeps a done
-- action's result on its claim row, so a later action can act on it: `withdraw` deletes the request
-- file its `request-switch` wrote.
ALTER TABLE episodes ADD COLUMN result TEXT;
