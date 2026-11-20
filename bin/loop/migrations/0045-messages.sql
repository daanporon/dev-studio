-- U45: every role-to-role message is a row in loop.db (`ds msg send|inbox|ack|reply|show`,
-- bin/loop/messages/messages.ts). Orca only wakes the receiver (reconcilers/messages.ts → wake() → poke).
-- A message sent while Orca is down or the receiver is gone stays unread and undelivered and is
-- delivered once the receiver lives again. `key` is the sender's idempotency key: the same send
-- again is the same row. A poke has no Orca retry id, so the row is its own write-ahead: `sending_at`
-- and `to_member` are set before the poke; a row a crash left sending is settled delivered, never
-- poked again.
CREATE TABLE messages (
  id           INTEGER PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  project      TEXT NOT NULL,
  squad        TEXT NOT NULL,
  to_role      TEXT NOT NULL,
  to_suffix    TEXT NOT NULL DEFAULT '',
  to_member    TEXT,                    -- the worktree the wake reached (NULL until delivered)
  from_project TEXT,
  from_squad   TEXT,
  from_role    TEXT,                    -- lead|thinker|builder|…|studio|operator
  from_suffix  TEXT,
  from_member  TEXT,                    -- the sender's worktree, when it is a role
  kind         TEXT NOT NULL DEFAULT 'message',   -- message | peer | reply
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  needs_reply  INTEGER NOT NULL DEFAULT 0,
  reply_to     INTEGER REFERENCES messages(id),
  sent_at      INTEGER NOT NULL,
  sending_at   INTEGER,                 -- write-ahead: the wake poke is going out (cleared when it fails)
  delivered_at INTEGER,                 -- the wake poke went out (started or accepted)
  read_at      INTEGER,                 -- acked by the receiver (`ds msg ack`)
  replied_at   INTEGER                  -- a `ds msg reply` answered it
);
CREATE INDEX messages_to ON messages (project, squad, to_role, to_suffix, read_at);
CREATE INDEX messages_open ON messages (project, read_at, delivered_at);
