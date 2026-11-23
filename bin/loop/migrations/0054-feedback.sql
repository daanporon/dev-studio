-- 0054-feedback.sql — ds-feedback notes as loop.db rows (ds-feedback-github-issues U1). Host scope: every
-- project's roles write here and every project's board reads the same rows; `project` is a label for
-- display only.
--
-- feedback_notes: one row per note a role jotted with bin/role/ds-feedback.sh, or imported once from the
-- old host-local file `state/dev-studio-feedback` (`ds feedback import`). The raw text stays on this host:
-- only a draft is ever sent out. `key` is sha1 of the note's timestamp and text, so a note written here
-- and the same line imported from the file are one row, and a second import adds nothing.
-- `project` is the writer's member's project, `-` for a note written outside a member, `?` for an
-- imported line whose prefix names no known project. State moves new → drafted / project-only /
-- already-fixed → filed → fixed / closed; any not-yet-filed note can be dismissed (and restored to new).
-- No row is ever deleted.
--
-- feedback_drafts: the text the Studio's drafter writes for one or more notes (a duplicate cluster):
-- a new issue (`issue`) or a comment on an open one (`add-to`, `target` = its number). Only these
-- columns ever leave the host. `leak` is the word-list check's last verdict on title + body.
CREATE TABLE feedback_drafts (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,     -- the drafter's idempotency key; also the `ds-key:` line of the body
  kind        TEXT NOT NULL CHECK (kind IN ('issue', 'add-to')),
  title       TEXT,                     -- NULL for an add-to comment
  body        TEXT NOT NULL,
  area        TEXT,                     -- the marker line's area:<a>
  label       TEXT,                     -- the marker line's kind:<k>
  target      INTEGER,                  -- add-to: the issue number it comments on
  evidence    TEXT,                     -- what the drafter checked (paths, the commit of main it read)
  checked_at  TEXT,                     -- the host checkout's commit the drafter read
  leak        TEXT NOT NULL DEFAULT 'unchecked' CHECK (leak IN ('unchecked', 'ok', 'blocked')),
  leak_why    TEXT,                     -- the guard's finding labels when blocked (never the matched value)
  state       TEXT NOT NULL DEFAULT 'review' CHECK (state IN ('review', 'posting', 'filed', 'dismissed', 'fixed', 'closed')),
  reason      TEXT,                     -- a dismiss's reason
  repo        TEXT,                     -- owner/name it was posted to
  issue       INTEGER,                  -- the issue it created or commented on
  url         TEXT,                     -- the issue's or comment's URL
  fix_pr      INTEGER,                  -- the PR that closed the issue, when GitHub names one
  fix_here    INTEGER,                  -- 1 once the host checkout holds that PR's merge commit
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX feedback_drafts_state ON feedback_drafts (state, id);

CREATE TABLE feedback_notes (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  project     TEXT NOT NULL,            -- the member's project label, '-' outside a member, '?' unknown (import)
  squad       TEXT,
  role        TEXT,                     -- <role[-suffix]>
  member      TEXT,                     -- <project>/<squad>/<role[-suffix]>, NULL outside a member
  wt          TEXT,                     -- the worktree it was jotted in, when known
  text        TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('cli', 'import')),
  state       TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'drafted', 'project-only', 'already-fixed', 'filed', 'fixed', 'closed', 'dismissed')),
  draft_id    INTEGER REFERENCES feedback_drafts (id),
  evidence    TEXT,                     -- already-fixed: the commit or path the drafter found
  reason      TEXT,                     -- why it stays new, is project-only, or was dismissed
  at          INTEGER NOT NULL,         -- when the note was jotted
  updated_at  INTEGER NOT NULL
);
CREATE INDEX feedback_notes_state ON feedback_notes (state, id);
CREATE INDEX feedback_notes_draft ON feedback_notes (draft_id);
