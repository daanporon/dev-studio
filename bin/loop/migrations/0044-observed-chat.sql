-- 0044-observed-chat.sql — each member's recent conversation, redacted and capped (crew-terminal-access
-- U1). One row per member worktree, written by bin/loop/observers/chat.ts; the board reads only this
-- table and never a transcript.
--   agent       the member's agent (claude, codex, muse, ...)
--   source      transcript (a provider reader under bin/loop/chat/) | screen (the observed screen tail)
--   path        the transcript or rollout read; NULL for screen
--   read_to     where the next read starts: just past the last whole line read
--   size        the file size at the last read (unchanged = nothing to read)
--   turns       JSON [{role, text, at, tool?}], oldest first, at most 20 and 16 KB; text redacted and
--               tool output never kept; a tool call is one line with `tool` set to its name
--   updated_at  when turns last changed
--   gone_at     when the member ended (turns emptied to []); NULL while live
CREATE TABLE observed_chat (
  project TEXT NOT NULL, wt TEXT NOT NULL,
  agent TEXT, source TEXT CHECK (source IN ('transcript', 'screen')),
  path TEXT, read_to INTEGER, size INTEGER,
  turns TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER, gone_at INTEGER,
  PRIMARY KEY (project, wt));
