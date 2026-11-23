-- 0053-orphan-questions.sql — morning-brief-stale-items U2 (R5): the open questions of squads that are
-- already closed are dropped once, the way an archive now drops them (questions.ts `drop`): status
-- `dropped`, answer `squad archived (cleanup)`, answered_via `archive`. No card is raised: they belong to
-- squads long gone, and no board shows them. Nothing is deleted. The closed squads' row docs lose their
-- `waiting_on_you` entries too, so no later questions.sync brings them back as open rows.
INSERT INTO events (at, project, squad, kind, payload)
SELECT CAST(strftime('%s', 'now') AS INTEGER), q.project, q.squad, 'question_dropped',
       json_object('id', q.id, 'title', COALESCE(q.title, q.question), 'blocking', json(CASE WHEN q.blocking = 1 THEN 'true' ELSE 'false' END),
                   'reason', 'squad archived (cleanup)')
FROM questions q
WHERE q.status = 'open'
  AND EXISTS (SELECT 1 FROM squads s WHERE s.project = q.project AND s.topic = q.squad AND s.status = 'closed')
ORDER BY q.seq;

UPDATE questions SET status = 'dropped', answer = 'squad archived (cleanup)', answered_via = 'archive',
       answered_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE status = 'open'
  AND EXISTS (SELECT 1 FROM squads s WHERE s.project = questions.project AND s.topic = questions.squad AND s.status = 'closed');

UPDATE squads SET doc = json_set(doc, '$.waiting_on_you', json('[]'))
WHERE status = 'closed' AND doc IS NOT NULL AND json_valid(doc)
  AND json_type(doc, '$.waiting_on_you') = 'array' AND json_array_length(doc, '$.waiting_on_you') > 0;
