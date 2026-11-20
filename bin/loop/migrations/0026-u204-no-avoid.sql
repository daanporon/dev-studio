-- 0026-u204-no-avoid.sql — a member that crashed twice is not barred from a model (U204): the
-- avoid mark (U64/U65) blamed a model for what is usually an account, a limit or an Orca problem
-- and nothing lifted it. The crash streak (episodes kind `crash`), the alert and the park stay.
-- Dropping the column also clears today's marks.
ALTER TABLE members DROP COLUMN avoid;
