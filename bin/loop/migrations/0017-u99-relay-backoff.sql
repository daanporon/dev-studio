-- 0017-u99-relay-backoff.sql — per-message backoff for Run mail the loop relays (U99,
-- bin/loop/messages/relay.ts). A forward that fails waits 1, 5, 15, 60 minutes between its tries; after
-- 5 failed tries the message is set aside (forwarded, with why). NULL (and old rows) means due.
ALTER TABLE relayed ADD COLUMN next_at INTEGER;
