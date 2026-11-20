-- 0005-u13a-questions.sql — operator questions get a table of their own (U13a), so an answer is kept.
-- An open row is a squad's `waiting_on_you` entry; the export writes the open rows back into the squad
-- JSON in `seq` order. Answering marks the row answered and never deletes it. A re-asked id replaces
-- its open row (squad-state.sh enqueue-question drops the old entry and appends the new one).
CREATE TABLE questions (
  seq          INTEGER PRIMARY KEY,  -- asking order; `answered-questions --before <seq>` pages by it
  id           TEXT NOT NULL,        -- the question id (waiting_on_you[].id); not unique over time
  project      TEXT NOT NULL,
  squad        TEXT NOT NULL,
  asker        TEXT,
  card_wt      TEXT,
  title        TEXT,
  question     TEXT,
  options      TEXT,                 -- JSON array
  choices      TEXT,                 -- JSON
  suggestion   TEXT,
  why          TEXT,
  blocking     INTEGER,
  asked_at     INTEGER,              -- epoch of the entry's `since`
  status       TEXT NOT NULL DEFAULT 'open',  -- open|answered
  answer       TEXT,
  answered_via TEXT,                 -- terminal|picker|board|reality
  answered_at  INTEGER,
  doc          TEXT                  -- the waiting_on_you entry as written; the export prints it
);
CREATE INDEX questions_squad ON questions (project, squad, status, seq);

-- A loop.db imported before this migration keeps its open questions only in squads.doc.
INSERT INTO questions (id, project, squad, asker, card_wt, title, question, options, choices, suggestion, why, blocking, asked_at, status, doc)
SELECT json_extract(q.value, '$.id'), s.project, s.topic, json_extract(q.value, '$.asker'), json_extract(q.value, '$.card_wt'),
  json_extract(q.value, '$.title'), json_extract(q.value, '$.question'), json(json_extract(q.value, '$.options')),
  json(json_extract(q.value, '$.choices')), json_extract(q.value, '$.suggestion'), json_extract(q.value, '$.why'),
  json_extract(q.value, '$.blocking'), CAST(strftime('%s', json_extract(q.value, '$.since')) AS INTEGER), 'open', q.value
FROM squads s, json_each(s.doc, '$.waiting_on_you') q
WHERE s.doc IS NOT NULL AND json_valid(s.doc) AND json_type(s.doc, '$.waiting_on_you') = 'array'
  AND json_type(q.value) = 'object' AND json_extract(q.value, '$.id') IS NOT NULL
ORDER BY s.id, q.key;
