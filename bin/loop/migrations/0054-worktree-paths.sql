-- 0054 worktree paths (orca-backend-alternatives U5). Each worktree-id column gets the folder path beside
-- it, backfilled from the id (`<repo id>::<path>`, or a plain absolute path; anything else stays NULL),
-- and two triggers per column fill it whenever a row is added or its id changes, so every writer fills
-- both while readers stay on the id column; a write that sets the path itself keeps it. The
-- `worktrees` table is the loop's own record of each worktree by host + path; this backfills it from
-- members, projects and observed_worktrees with the statement bin/loop/squad/worktrees.ts syncSql()
-- runs every 30 s. Generated from that module's PATH_COLUMNS, pathSql and syncSql;
-- tests/loop/migrate-paths.test.ts checks they still agree.

ALTER TABLE coordinators ADD COLUMN wt_path TEXT;
UPDATE coordinators SET wt_path = CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END WHERE wt IS NOT NULL;
CREATE TRIGGER coordinators_wt_path_ins AFTER INSERT ON coordinators WHEN NEW.wt_path IS NULL AND NEW.wt IS NOT NULL BEGIN
  UPDATE coordinators SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER coordinators_wt_path_upd AFTER UPDATE OF wt ON coordinators WHEN NEW.wt IS NOT OLD.wt AND NEW.wt_path IS OLD.wt_path BEGIN
  UPDATE coordinators SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE dispatches ADD COLUMN wt_path TEXT;
UPDATE dispatches SET wt_path = CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END WHERE wt IS NOT NULL;
CREATE TRIGGER dispatches_wt_path_ins AFTER INSERT ON dispatches WHEN NEW.wt_path IS NULL AND NEW.wt IS NOT NULL BEGIN
  UPDATE dispatches SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER dispatches_wt_path_upd AFTER UPDATE OF wt ON dispatches WHEN NEW.wt IS NOT OLD.wt AND NEW.wt_path IS OLD.wt_path BEGIN
  UPDATE dispatches SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE exposed ADD COLUMN owner_path TEXT;
UPDATE exposed SET owner_path = CASE WHEN instr(owner_wt, '::') > 0 THEN substr(owner_wt, instr(owner_wt, '::') + 2) WHEN substr(owner_wt, 1, 1) = '/' THEN owner_wt END WHERE owner_wt IS NOT NULL;
CREATE TRIGGER exposed_owner_path_ins AFTER INSERT ON exposed WHEN NEW.owner_path IS NULL AND NEW.owner_wt IS NOT NULL BEGIN
  UPDATE exposed SET owner_path = CASE WHEN instr(NEW.owner_wt, '::') > 0 THEN substr(NEW.owner_wt, instr(NEW.owner_wt, '::') + 2) WHEN substr(NEW.owner_wt, 1, 1) = '/' THEN NEW.owner_wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER exposed_owner_path_upd AFTER UPDATE OF owner_wt ON exposed WHEN NEW.owner_wt IS NOT OLD.owner_wt AND NEW.owner_path IS OLD.owner_path BEGIN
  UPDATE exposed SET owner_path = CASE WHEN instr(NEW.owner_wt, '::') > 0 THEN substr(NEW.owner_wt, instr(NEW.owner_wt, '::') + 2) WHEN substr(NEW.owner_wt, 1, 1) = '/' THEN NEW.owner_wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE finishes ADD COLUMN wt_path TEXT;
UPDATE finishes SET wt_path = CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END WHERE wt IS NOT NULL;
CREATE TRIGGER finishes_wt_path_ins AFTER INSERT ON finishes WHEN NEW.wt_path IS NULL AND NEW.wt IS NOT NULL BEGIN
  UPDATE finishes SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER finishes_wt_path_upd AFTER UPDATE OF wt ON finishes WHEN NEW.wt IS NOT OLD.wt AND NEW.wt_path IS OLD.wt_path BEGIN
  UPDATE finishes SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE members ADD COLUMN wt_path TEXT;
UPDATE members SET wt_path = CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END WHERE wt IS NOT NULL;
CREATE TRIGGER members_wt_path_ins AFTER INSERT ON members WHEN NEW.wt_path IS NULL AND NEW.wt IS NOT NULL BEGIN
  UPDATE members SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER members_wt_path_upd AFTER UPDATE OF wt ON members WHEN NEW.wt IS NOT OLD.wt AND NEW.wt_path IS OLD.wt_path BEGIN
  UPDATE members SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE observed_chat ADD COLUMN wt_path TEXT;
UPDATE observed_chat SET wt_path = CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END WHERE wt IS NOT NULL;
CREATE TRIGGER observed_chat_wt_path_ins AFTER INSERT ON observed_chat WHEN NEW.wt_path IS NULL AND NEW.wt IS NOT NULL BEGIN
  UPDATE observed_chat SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER observed_chat_wt_path_upd AFTER UPDATE OF wt ON observed_chat WHEN NEW.wt IS NOT OLD.wt AND NEW.wt_path IS OLD.wt_path BEGIN
  UPDATE observed_chat SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE observed_compacted ADD COLUMN wt_path TEXT;
UPDATE observed_compacted SET wt_path = CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END WHERE wt IS NOT NULL;
CREATE TRIGGER observed_compacted_wt_path_ins AFTER INSERT ON observed_compacted WHEN NEW.wt_path IS NULL AND NEW.wt IS NOT NULL BEGIN
  UPDATE observed_compacted SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER observed_compacted_wt_path_upd AFTER UPDATE OF wt ON observed_compacted WHEN NEW.wt IS NOT OLD.wt AND NEW.wt_path IS OLD.wt_path BEGIN
  UPDATE observed_compacted SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE observed_limited ADD COLUMN wt_path TEXT;
UPDATE observed_limited SET wt_path = CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END WHERE wt IS NOT NULL;
CREATE TRIGGER observed_limited_wt_path_ins AFTER INSERT ON observed_limited WHEN NEW.wt_path IS NULL AND NEW.wt IS NOT NULL BEGIN
  UPDATE observed_limited SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER observed_limited_wt_path_upd AFTER UPDATE OF wt ON observed_limited WHEN NEW.wt IS NOT OLD.wt AND NEW.wt_path IS OLD.wt_path BEGIN
  UPDATE observed_limited SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE observed_procs ADD COLUMN wt_path TEXT;
UPDATE observed_procs SET wt_path = CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END WHERE wt IS NOT NULL;
CREATE TRIGGER observed_procs_wt_path_ins AFTER INSERT ON observed_procs WHEN NEW.wt_path IS NULL AND NEW.wt IS NOT NULL BEGIN
  UPDATE observed_procs SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER observed_procs_wt_path_upd AFTER UPDATE OF wt ON observed_procs WHEN NEW.wt IS NOT OLD.wt AND NEW.wt_path IS OLD.wt_path BEGIN
  UPDATE observed_procs SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE observed_reviews ADD COLUMN wt_path TEXT;
UPDATE observed_reviews SET wt_path = CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END WHERE wt IS NOT NULL;
CREATE TRIGGER observed_reviews_wt_path_ins AFTER INSERT ON observed_reviews WHEN NEW.wt_path IS NULL AND NEW.wt IS NOT NULL BEGIN
  UPDATE observed_reviews SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER observed_reviews_wt_path_upd AFTER UPDATE OF wt ON observed_reviews WHEN NEW.wt IS NOT OLD.wt AND NEW.wt_path IS OLD.wt_path BEGIN
  UPDATE observed_reviews SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE observed_terminals ADD COLUMN wt_path TEXT;
UPDATE observed_terminals SET wt_path = CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END WHERE wt IS NOT NULL;
CREATE TRIGGER observed_terminals_wt_path_ins AFTER INSERT ON observed_terminals WHEN NEW.wt_path IS NULL AND NEW.wt IS NOT NULL BEGIN
  UPDATE observed_terminals SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER observed_terminals_wt_path_upd AFTER UPDATE OF wt ON observed_terminals WHEN NEW.wt IS NOT OLD.wt AND NEW.wt_path IS OLD.wt_path BEGIN
  UPDATE observed_terminals SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE observed_transcripts ADD COLUMN wt_path TEXT;
UPDATE observed_transcripts SET wt_path = CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END WHERE wt IS NOT NULL;
CREATE TRIGGER observed_transcripts_wt_path_ins AFTER INSERT ON observed_transcripts WHEN NEW.wt_path IS NULL AND NEW.wt IS NOT NULL BEGIN
  UPDATE observed_transcripts SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER observed_transcripts_wt_path_upd AFTER UPDATE OF wt ON observed_transcripts WHEN NEW.wt IS NOT OLD.wt AND NEW.wt_path IS OLD.wt_path BEGIN
  UPDATE observed_transcripts SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE observed_workers ADD COLUMN wt_path TEXT;
UPDATE observed_workers SET wt_path = CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END WHERE wt IS NOT NULL;
CREATE TRIGGER observed_workers_wt_path_ins AFTER INSERT ON observed_workers WHEN NEW.wt_path IS NULL AND NEW.wt IS NOT NULL BEGIN
  UPDATE observed_workers SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER observed_workers_wt_path_upd AFTER UPDATE OF wt ON observed_workers WHEN NEW.wt IS NOT OLD.wt AND NEW.wt_path IS OLD.wt_path BEGIN
  UPDATE observed_workers SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE observed_worktrees ADD COLUMN parent_path TEXT;
UPDATE observed_worktrees SET parent_path = CASE WHEN instr(parent, '::') > 0 THEN substr(parent, instr(parent, '::') + 2) WHEN substr(parent, 1, 1) = '/' THEN parent END WHERE parent IS NOT NULL;
CREATE TRIGGER observed_worktrees_parent_path_ins AFTER INSERT ON observed_worktrees WHEN NEW.parent_path IS NULL AND NEW.parent IS NOT NULL BEGIN
  UPDATE observed_worktrees SET parent_path = CASE WHEN instr(NEW.parent, '::') > 0 THEN substr(NEW.parent, instr(NEW.parent, '::') + 2) WHEN substr(NEW.parent, 1, 1) = '/' THEN NEW.parent END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER observed_worktrees_parent_path_upd AFTER UPDATE OF parent ON observed_worktrees WHEN NEW.parent IS NOT OLD.parent AND NEW.parent_path IS OLD.parent_path BEGIN
  UPDATE observed_worktrees SET parent_path = CASE WHEN instr(NEW.parent, '::') > 0 THEN substr(NEW.parent, instr(NEW.parent, '::') + 2) WHEN substr(NEW.parent, 1, 1) = '/' THEN NEW.parent END WHERE rowid = NEW.rowid;
END;

ALTER TABLE projects ADD COLUMN studio_path TEXT;
UPDATE projects SET studio_path = CASE WHEN instr(studio_wt, '::') > 0 THEN substr(studio_wt, instr(studio_wt, '::') + 2) WHEN substr(studio_wt, 1, 1) = '/' THEN studio_wt END WHERE studio_wt IS NOT NULL;
CREATE TRIGGER projects_studio_path_ins AFTER INSERT ON projects WHEN NEW.studio_path IS NULL AND NEW.studio_wt IS NOT NULL BEGIN
  UPDATE projects SET studio_path = CASE WHEN instr(NEW.studio_wt, '::') > 0 THEN substr(NEW.studio_wt, instr(NEW.studio_wt, '::') + 2) WHEN substr(NEW.studio_wt, 1, 1) = '/' THEN NEW.studio_wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER projects_studio_path_upd AFTER UPDATE OF studio_wt ON projects WHEN NEW.studio_wt IS NOT OLD.studio_wt AND NEW.studio_path IS OLD.studio_path BEGIN
  UPDATE projects SET studio_path = CASE WHEN instr(NEW.studio_wt, '::') > 0 THEN substr(NEW.studio_wt, instr(NEW.studio_wt, '::') + 2) WHEN substr(NEW.studio_wt, 1, 1) = '/' THEN NEW.studio_wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE questions ADD COLUMN card_path TEXT;
UPDATE questions SET card_path = CASE WHEN instr(card_wt, '::') > 0 THEN substr(card_wt, instr(card_wt, '::') + 2) WHEN substr(card_wt, 1, 1) = '/' THEN card_wt END WHERE card_wt IS NOT NULL;
CREATE TRIGGER questions_card_path_ins AFTER INSERT ON questions WHEN NEW.card_path IS NULL AND NEW.card_wt IS NOT NULL BEGIN
  UPDATE questions SET card_path = CASE WHEN instr(NEW.card_wt, '::') > 0 THEN substr(NEW.card_wt, instr(NEW.card_wt, '::') + 2) WHEN substr(NEW.card_wt, 1, 1) = '/' THEN NEW.card_wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER questions_card_path_upd AFTER UPDATE OF card_wt ON questions WHEN NEW.card_wt IS NOT OLD.card_wt AND NEW.card_path IS OLD.card_path BEGIN
  UPDATE questions SET card_path = CASE WHEN instr(NEW.card_wt, '::') > 0 THEN substr(NEW.card_wt, instr(NEW.card_wt, '::') + 2) WHEN substr(NEW.card_wt, 1, 1) = '/' THEN NEW.card_wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE squads ADD COLUMN lead_path TEXT;
UPDATE squads SET lead_path = CASE WHEN instr(lead_wt, '::') > 0 THEN substr(lead_wt, instr(lead_wt, '::') + 2) WHEN substr(lead_wt, 1, 1) = '/' THEN lead_wt END WHERE lead_wt IS NOT NULL;
CREATE TRIGGER squads_lead_path_ins AFTER INSERT ON squads WHEN NEW.lead_path IS NULL AND NEW.lead_wt IS NOT NULL BEGIN
  UPDATE squads SET lead_path = CASE WHEN instr(NEW.lead_wt, '::') > 0 THEN substr(NEW.lead_wt, instr(NEW.lead_wt, '::') + 2) WHEN substr(NEW.lead_wt, 1, 1) = '/' THEN NEW.lead_wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER squads_lead_path_upd AFTER UPDATE OF lead_wt ON squads WHEN NEW.lead_wt IS NOT OLD.lead_wt AND NEW.lead_path IS OLD.lead_path BEGIN
  UPDATE squads SET lead_path = CASE WHEN instr(NEW.lead_wt, '::') > 0 THEN substr(NEW.lead_wt, instr(NEW.lead_wt, '::') + 2) WHEN substr(NEW.lead_wt, 1, 1) = '/' THEN NEW.lead_wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE unit_cpu ADD COLUMN wt_path TEXT;
UPDATE unit_cpu SET wt_path = CASE WHEN instr(wt, '::') > 0 THEN substr(wt, instr(wt, '::') + 2) WHEN substr(wt, 1, 1) = '/' THEN wt END WHERE wt IS NOT NULL;
CREATE TRIGGER unit_cpu_wt_path_ins AFTER INSERT ON unit_cpu WHEN NEW.wt_path IS NULL AND NEW.wt IS NOT NULL BEGIN
  UPDATE unit_cpu SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER unit_cpu_wt_path_upd AFTER UPDATE OF wt ON unit_cpu WHEN NEW.wt IS NOT OLD.wt AND NEW.wt_path IS OLD.wt_path BEGIN
  UPDATE unit_cpu SET wt_path = CASE WHEN instr(NEW.wt, '::') > 0 THEN substr(NEW.wt, instr(NEW.wt, '::') + 2) WHEN substr(NEW.wt, 1, 1) = '/' THEN NEW.wt END WHERE rowid = NEW.rowid;
END;

ALTER TABLE units ADD COLUMN builder_path TEXT;
UPDATE units SET builder_path = CASE WHEN instr(builder_wt, '::') > 0 THEN substr(builder_wt, instr(builder_wt, '::') + 2) WHEN substr(builder_wt, 1, 1) = '/' THEN builder_wt END WHERE builder_wt IS NOT NULL;
CREATE TRIGGER units_builder_path_ins AFTER INSERT ON units WHEN NEW.builder_path IS NULL AND NEW.builder_wt IS NOT NULL BEGIN
  UPDATE units SET builder_path = CASE WHEN instr(NEW.builder_wt, '::') > 0 THEN substr(NEW.builder_wt, instr(NEW.builder_wt, '::') + 2) WHEN substr(NEW.builder_wt, 1, 1) = '/' THEN NEW.builder_wt END WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER units_builder_path_upd AFTER UPDATE OF builder_wt ON units WHEN NEW.builder_wt IS NOT OLD.builder_wt AND NEW.builder_path IS OLD.builder_path BEGIN
  UPDATE units SET builder_path = CASE WHEN instr(NEW.builder_wt, '::') > 0 THEN substr(NEW.builder_wt, instr(NEW.builder_wt, '::') + 2) WHEN substr(NEW.builder_wt, 1, 1) = '/' THEN NEW.builder_wt END WHERE rowid = NEW.rowid;
END;

CREATE TABLE worktrees (
  host        TEXT NOT NULL DEFAULT 'local',  -- where the folder is; 'local' = this host
  path        TEXT NOT NULL,                  -- the folder's absolute path
  project     TEXT,
  name        TEXT,                           -- display name
  parent_path TEXT,                           -- the parent worktree's path (Studio > Lead > the Lead's members)
  branch      TEXT,
  squad       TEXT,                           -- owning squad topic ('_studio' for the Studio), NULL when no member
  role        TEXT,                           -- the member label, <role>[-<suffix>]
  provider    TEXT NOT NULL,                  -- who made it: 'orca' today
  orca_id     TEXT,                           -- Orca's worktree id, when Orca made it
  lease       TEXT,                           -- a provider's lease on the folder (later units)
  created_at  INTEGER NOT NULL,
  gone_at     INTEGER,
  PRIMARY KEY (host, path)
);
CREATE INDEX worktrees_project ON worktrees(project);
CREATE INDEX worktrees_orca_id ON worktrees(orca_id);
WITH cand AS (
  SELECT p.label AS project, p.studio_wt AS wt, p.studio_path AS path, '_studio' AS squad, 'studio' AS role,
         NULL AS parent_path, 0 AS pri, 0 AS gone, 0 AS ord
    FROM projects p WHERE p.studio_path IS NOT NULL AND p.studio_wt NOT LIKE 'local::%'
  UNION ALL
  SELECT m.project, m.wt, m.wt_path, m.squad,
         m.role || CASE WHEN COALESCE(m.suffix, '') != '' THEN '-' || m.suffix ELSE '' END,
         CASE m.role WHEN 'studio' THEN NULL
           WHEN 'lead' THEN (SELECT p.studio_path FROM projects p WHERE p.label = m.project)
           ELSE (SELECT s.lead_path FROM squads s WHERE s.project = m.project AND s.topic = m.squad ORDER BY s.id DESC LIMIT 1) END,
         1, 0, -m.id
    FROM members m WHERE m.wt_path IS NOT NULL AND m.wt NOT LIKE 'local::%'
  UNION ALL
  SELECT o.project, o.wt, COALESCE(o.path, CASE WHEN instr(o.wt, '::') > 0 THEN substr(o.wt, instr(o.wt, '::') + 2) WHEN substr(o.wt, 1, 1) = '/' THEN o.wt END), NULL, NULL, o.parent_path,
         2, o.gone_at IS NOT NULL, -COALESCE(o.observed_at, 0)
    FROM observed_worktrees o WHERE o.wt NOT LIKE 'local::%'
), best AS (
  SELECT *, row_number() OVER (PARTITION BY path ORDER BY pri, gone, ord, project) AS rn FROM cand WHERE path IS NOT NULL AND path != ''
)
INSERT INTO worktrees (host, path, project, name, parent_path, branch, squad, role, provider, orca_id, created_at, gone_at)
SELECT 'local', b.path, b.project,
       COALESCE(CASE WHEN json_valid(ob.doc) THEN json_extract(ob.doc, '$.displayName') END, replace(b.path, rtrim(b.path, replace(b.path, '/', '')), '')),
       NULLIF(b.parent_path, b.path), ob.branch, b.squad, b.role, 'orca', b.wt, unixepoch(), ob.gone_at
  FROM best b LEFT JOIN observed_worktrees ob ON ob.project = b.project AND ob.wt = b.wt
 WHERE b.rn = 1
ON CONFLICT (host, path) DO UPDATE SET project = excluded.project, name = excluded.name,
  parent_path = excluded.parent_path, branch = COALESCE(excluded.branch, worktrees.branch), squad = excluded.squad,
  role = excluded.role, orca_id = excluded.orca_id, gone_at = excluded.gone_at
 WHERE worktrees.provider = 'orca' AND (worktrees.project IS NOT excluded.project OR worktrees.name IS NOT excluded.name
   OR worktrees.parent_path IS NOT excluded.parent_path OR worktrees.branch IS NOT COALESCE(excluded.branch, worktrees.branch)
   OR worktrees.squad IS NOT excluded.squad OR worktrees.role IS NOT excluded.role OR worktrees.orca_id IS NOT excluded.orca_id
   OR worktrees.gone_at IS NOT excluded.gone_at);
