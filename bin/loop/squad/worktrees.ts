// worktrees.ts — the loop's own record of every worktree it knows, keyed by host + folder path
// (orca-backend-alternatives U5, migration 0054). One `worktrees` row per (host, path): its project,
// name, branch, parent, owning squad and role, the provider that made it and the provider's own id
// (`orca_id`, `lease`), when it was first recorded and when it went.
//
// Today every such worktree is Orca's: a squad member's (`members.wt`), the Studio's
// (`projects.studio_wt`) or one the Orca observer lists (`observed_worktrees`). syncSql() turns those
// rows into `worktrees` rows; the migration ran it once with `unixepoch()` as the backfill, and the
// host-scope observer `observers/worktrees.ts` runs it after the Orca observer every 30 s. Its parent is
// the one `reconcilers/nesting.ts` wants (Studio > Lead > the Lead's other members), not Orca's: the
// Lead's is its project's Studio, every other member's its squad's Lead, the Studio has none; a
// worktree that is no member keeps Orca's observed parent. When several rows name one path, the
// Studio wins, then the newest member, then the newest live observed row, so every run picks the same.
// It writes only rows it changes, and only the Orca rows it keeps itself: a later provider's row
// (git, treehouse; U7, U8) is never touched, nor one the `orca` worktree provider made (U8b: its rows
// carry `repo`, and that provider keeps them, a worktree Orca stops listing included), and a
// `local::<path>` member (a non-Orca squad, U11) is not one of its sources. Nothing reads the table yet.
import type { Store } from "../core/store.ts";

// The folder path in a worktree id (`<repo id>::<path>`, or a plain absolute path), as SQL over `col`;
// NULL for anything else. Same rule as wtPath() in observers/orca.ts, plus the plain path.
export const pathSql = (col: string) =>
  `CASE WHEN instr(${col}, '::') > 0 THEN substr(${col}, instr(${col}, '::') + 2) WHEN substr(${col}, 1, 1) = '/' THEN ${col} END`;

// Each worktree-id column and the folder-path column beside it (migration 0054). Triggers there fill
// the path whenever a row is added or its id column changes, so every writer fills both; a write that
// sets the path itself keeps it. Readers still read the id column until the clean-up moves them.
export const PATH_COLUMNS: readonly (readonly [table: string, id: string, path: string])[] = [
  ["coordinators", "wt", "wt_path"], ["dispatches", "wt", "wt_path"], ["exposed", "owner_wt", "owner_path"],
  ["finishes", "wt", "wt_path"], ["members", "wt", "wt_path"], ["observed_chat", "wt", "wt_path"],
  ["observed_compacted", "wt", "wt_path"], ["observed_limited", "wt", "wt_path"], ["observed_procs", "wt", "wt_path"],
  ["observed_reviews", "wt", "wt_path"], ["observed_terminals", "wt", "wt_path"], ["observed_transcripts", "wt", "wt_path"],
  ["observed_workers", "wt", "wt_path"], ["observed_worktrees", "parent", "parent_path"], ["projects", "studio_wt", "studio_path"],
  ["questions", "card_wt", "card_path"], ["squads", "lead_wt", "lead_path"], ["unit_cpu", "wt", "wt_path"],
  ["units", "builder_wt", "builder_path"],
];

// The one statement that records the known worktrees; `now` is the SQL for the record time. `skipProviderRows`
// (the observer's run) also leaves alone the rows the `orca` worktree provider made, which carry `repo`
// (migration 0055); the 0054 backfill ran before that column existed.
export function syncSql(now: string, skipProviderRows = false): string {
  return `WITH cand AS (
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
  SELECT o.project, o.wt, COALESCE(o.path, ${pathSql("o.wt")}), NULL, NULL, o.parent_path,
         2, o.gone_at IS NOT NULL, -COALESCE(o.observed_at, 0)
    FROM observed_worktrees o WHERE o.wt NOT LIKE 'local::%'
), best AS (
  SELECT *, row_number() OVER (PARTITION BY path ORDER BY pri, gone, ord, project) AS rn FROM cand WHERE path IS NOT NULL AND path != ''
)
INSERT INTO worktrees (host, path, project, name, parent_path, branch, squad, role, provider, orca_id, created_at, gone_at)
SELECT 'local', b.path, b.project,
       COALESCE(CASE WHEN json_valid(ob.doc) THEN json_extract(ob.doc, '$.displayName') END, replace(b.path, rtrim(b.path, replace(b.path, '/', '')), '')),
       NULLIF(b.parent_path, b.path), ob.branch, b.squad, b.role, 'orca', b.wt, ${now}, ob.gone_at
  FROM best b LEFT JOIN observed_worktrees ob ON ob.project = b.project AND ob.wt = b.wt
 WHERE b.rn = 1
ON CONFLICT (host, path) DO UPDATE SET project = excluded.project, name = excluded.name,
  parent_path = excluded.parent_path, branch = COALESCE(excluded.branch, worktrees.branch), squad = excluded.squad,
  role = excluded.role, orca_id = excluded.orca_id, gone_at = excluded.gone_at
 WHERE worktrees.provider = 'orca'${skipProviderRows ? " AND worktrees.repo IS NULL" : ""} AND (worktrees.project IS NOT excluded.project OR worktrees.name IS NOT excluded.name
   OR worktrees.parent_path IS NOT excluded.parent_path OR worktrees.branch IS NOT COALESCE(excluded.branch, worktrees.branch)
   OR worktrees.squad IS NOT excluded.squad OR worktrees.role IS NOT excluded.role OR worktrees.orca_id IS NOT excluded.orca_id
   OR worktrees.gone_at IS NOT excluded.gone_at)`;
}

// Record the known worktrees now; returns the rows added or changed.
export function syncWorktrees(store: Store, now: number): number {
  return store.db.run(syncSql("?", true), [now]).changes;
}
