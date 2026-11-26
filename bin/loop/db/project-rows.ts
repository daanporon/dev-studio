// project-rows.ts — copy one project's loop.db rows to an archive file, then delete them (remove-project U1).
//
//   const { counts } = copyRows(dbPath(), label, join(archive, "loop-rows.db"));
//   const r = deleteRows(store, label, counts);   // { ok, deleted, cleared_links, cleared_pins, held_ms } or { ok: false, mismatch }
//
// Which rows belong to a project is decided at run time (KTD8): every table with a `project` column, by
// `project = label`, except KEEP_WITH_PROJECT; `projects` by label; `observed_exposed` through the project's
// `exposed` ids; and the open `overrides` pins that name the label, which are copied and closed (cleared_at),
// never deleted. Every other table is in KEPT with its reason, and tests/loop/project-rows.test.ts fails on a
// table that is in neither, so a new project-tied table cannot be skipped silently.
//
// SQLite cannot commit across two files in WAL mode, so the move is copy, verify, then delete (KTD7):
// copyRows writes the archive in one transaction on its own connection (foreign keys off, the source attached
// as `src`, so every archive table is made from the source's own CREATE TABLE text, with no index or trigger)
// and finishes it with a `removed_meta` row; deleteRows opens one immediate transaction on loop.db, counts
// every table again against the archive's counts and deletes only when all match. Nothing here deletes a
// file or reads stateRoot(): the caller names both paths.
import { Database } from "bun:sqlite";
import { existsSync, renameSync } from "node:fs";
import { now, type Store } from "../core/store.ts";

// Tables with a `project` column whose rows stay: the operator's feedback outlives the project (settled).
export const KEEP_WITH_PROJECT = ["feedback_notes", "feedback_drafts"] as const;

// Tables tied to a project by key, not by a `project` column.
export const BY_KEY: Record<string, string> = {
  projects: "the project's own row, by label",
  observed_exposed: "health of the project's exposed entries, through exposed.id (an enforced foreign key)",
  overrides: "open pins naming the label, its squads, roles or members: copied and closed, not deleted",
};

// Every other table, with the reason it stays.
export const KEPT: Record<string, string> = {
  feedback_notes: "the operator's feedback outlives the project (settled decision)",
  feedback_drafts: "the operator's feedback outlives the project (settled decision)",
  accounts: "host-wide account list",
  health: "the loop process's own health",
  observed_accounts: "host-wide account usage",
  observed_cleanup_scan: "host-wide cleanup scan",
  observed_disk_usage: "host-wide disk usage",
  observed_github: "per repo, shared by every project on the repo",
  observed_host_procs: "host-wide process groups",
  observed_machine: "host-wide machine load",
  observed_merges: "per repo, shared by every project on the repo",
  observed_rollouts: "per transcript file, rebuilt from disk",
  observed_tokens: "per worker, rebuilt from transcripts; a stale row harms nothing",
  observed_update: "the host checkout's update state",
  schema_migrations: "the database's own migration list",
  timers: "host-wide timers",
};

export type Spec = {
  table: string;
  // `delete`: the rows go; `clear`: the rows stay with cleared_at set (overrides).
  mode: "delete" | "clear";
  // The WHERE text, with `s` as the schema prefix of any table it names ("" or "src.").
  where: (s: string) => string;
  params: (label: string) => (string | number)[];
};

const tables = (db: Database, schema = "main"): string[] =>
  (db.query(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[])
    .map((r) => r.name);
const columns = (db: Database, table: string, schema = "main"): string[] =>
  (db.query(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

// A pin names the project (scope project), one of its squads or roles (`<label>/…`), or one of its members
// by id, worktree or `<label>/<squad>/<role>[/<suffix>]` (memberIds in store.ts, scopeTargets in pick.ts).
const PIN = (s: string) => `cleared_at IS NULL AND (
    (scope = 'project' AND member = ?1)
    OR (scope IN ('squad', 'role') AND substr(member, 1, length(?2)) = ?2)
    OR (COALESCE(scope, 'member') = 'member' AND (substr(member, 1, length(?2)) = ?2
      OR member IN (SELECT CAST(id AS TEXT) FROM ${s}members WHERE project = ?1)
      OR member IN (SELECT wt FROM ${s}members WHERE project = ?1 AND wt IS NOT NULL))))`;

// The project's tables in delete order: observed_exposed before exposed (foreign key), overrides before
// members (its pins are found through them), projects last.
export function projectTables(db: Database, schema = "main"): Spec[] {
  const all = tables(db, schema);
  const byProject = all.filter((t) => !(KEEP_WITH_PROJECT as readonly string[]).includes(t) && columns(db, t, schema).includes("project"));
  const label = (l: string) => [l];
  const out: Spec[] = [];
  if (all.includes("overrides")) out.push({ table: "overrides", mode: "clear", where: PIN, params: (l) => [l, `${l}/`] });
  if (all.includes("observed_exposed"))
    out.push({ table: "observed_exposed", mode: "delete", where: (s) => `exposed_id IN (SELECT id FROM ${s}exposed WHERE project = ?1)`, params: label });
  for (const t of byProject) out.push({ table: t, mode: "delete", where: () => "project = ?1", params: label });
  if (all.includes("projects")) out.push({ table: "projects", mode: "delete", where: () => "label = ?1", params: label });
  return out;
}

// Tables neither tied to a project nor in KEPT: a migration added one nobody classified.
export function unclassified(db: Database): string[] {
  const tied = new Set(projectTables(db).map((s) => s.table));
  return tables(db).filter((t) => !tied.has(t) && !(t in KEPT));
}

export type Counts = Record<string, number>;
export type Meta = { label: string; removed_at: number; migrations: string[]; counts: Counts; finished_at: number };

// The finish mark of an archive file, or null when the file holds none (an unfinished copy).
export function archiveMeta(path: string): Meta | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'removed_meta'").get()) return null;
    const r = db.query("SELECT * FROM removed_meta WHERE finished_at IS NOT NULL LIMIT 1").get() as Record<string, unknown> | null;
    if (!r) return null;
    return { label: String(r.label), removed_at: Number(r.removed_at), migrations: JSON.parse(String(r.migrations)),
      counts: JSON.parse(String(r.counts)), finished_at: Number(r.finished_at) };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// Renames the archive file (and any journal beside it, so a hot journal never replays into the new copy)
// to the first free `<base>.<tag>-<n>.db`; returns the new path. Nothing is deleted.
function setAside(path: string, tag: string): string {
  const base = path.replace(/\.db$/, "");
  let n = 1;
  while ([".db", ".db-journal", ".db-wal", ".db-shm"].some((x) => existsSync(`${base}.${tag}-${n}${x}`))) n++;
  const to = `${base}.${tag}-${n}.db`;
  for (const x of ["", "-journal", "-wal", "-shm"]) if (existsSync(path + x)) renameSync(path + x, to + x);
  return to;
}

function sourceCounts(db: Database, specs: Spec[], label: string, s: string): Counts {
  const c: Counts = {};
  for (const sp of specs) c[sp.table] = (db.query(`SELECT COUNT(*) AS n FROM ${s}${sp.table} WHERE ${sp.where(s)}`).get(...sp.params(label)) as { n: number }).n;
  return c;
}
const sameCounts = (a: Counts, b: Counts) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);

export type CopyResult = { archive: string; counts: Counts; rows: number; set_aside: string[] };

// Writes every row of `label` from the loop.db at `dbPath` into a fresh SQLite file at `archivePath` and
// returns the per-table counts, checked against the source in the same snapshot. An archive already finished
// for another label is refused. One finished for this label is never reused, since equal counts do not prove
// equal rows (a delete-then-insert keeps the count): it is renamed aside (`.stale-<n>.db`), as an unfinished
// one is (`.partial-<n>.db`), and a fresh copy is written. A caller retrying after its delete committed must
// know that from its own record, not from this file.
export function copyRows(dbPath: string, label: string, archivePath: string): CopyResult {
  const setAsideList: string[] = [];
  const meta = archiveMeta(archivePath);
  if (meta && meta.label !== label) throw new Error(`project-rows: ${archivePath} already holds the rows of '${meta.label}'`);
  if (meta) setAsideList.push(setAside(archivePath, "stale"));
  else if ([archivePath, `${archivePath}-journal`, `${archivePath}-wal`].some(existsSync)) setAsideList.push(setAside(archivePath, "partial"));

  const arc = new Database(archivePath, { create: true });
  try {
    arc.run("PRAGMA busy_timeout = 5000");
    arc.run("PRAGMA foreign_keys = OFF");
    arc.run("PRAGMA journal_mode = DELETE");
    arc.run("ATTACH DATABASE ? AS src", [dbPath]);
    const specs = projectTables(arc, "src");
    const migrations = (arc.query("SELECT filename FROM src.schema_migrations ORDER BY filename").all() as { filename: string }[]).map((r) => r.filename);
    const counts = arc.transaction(() => {
      const before = sourceCounts(arc, specs, label, "src.");
      for (const sp of specs) {
        const sql = (arc.query("SELECT sql FROM src.sqlite_master WHERE type = 'table' AND name = ?").get(sp.table) as { sql: string }).sql;
        arc.run(sql);
        arc.query(`INSERT INTO main.${sp.table} SELECT * FROM src.${sp.table} WHERE ${sp.where("src.")}`).run(...sp.params(label));
      }
      const after: Counts = {};
      for (const sp of specs) after[sp.table] = (arc.query(`SELECT COUNT(*) AS n FROM main.${sp.table}`).get() as { n: number }).n;
      if (!sameCounts(before, after)) throw new Error(`project-rows: archive counts ${JSON.stringify(after)} differ from the source's ${JSON.stringify(before)}`);
      arc.run("CREATE TABLE removed_meta (label TEXT NOT NULL, removed_at INTEGER NOT NULL, migrations TEXT NOT NULL, counts TEXT NOT NULL, finished_at INTEGER)");
      const at = now();
      arc.run("INSERT INTO removed_meta (label, removed_at, migrations, counts, finished_at) VALUES (?, ?, ?, ?, ?)",
        [label, at, JSON.stringify(migrations), JSON.stringify(after), at]);
      return after;
    })();
    arc.run("DETACH DATABASE src");
    return { archive: archivePath, counts, rows: Object.values(counts).reduce((a, b) => a + b, 0), set_aside: setAsideList };
  } finally {
    arc.close();
  }
}

type Mismatch = Record<string, { archive: number; now: number }>;
export type DeleteResult =
  | { ok: true; deleted: Counts; rows: number; cleared_pins: number; cleared_links: number; held_ms: number }
  | { ok: false; mismatch: Mismatch; held_ms: number };

// One immediate transaction on loop.db: count every project table again and compare with `counts` (the
// archive's); on any difference roll back and change nothing. Else set reply_to NULL on other projects'
// replies to this project's messages, close the open pins, and delete the rest. held_ms is the write-lock hold.
//
// Foreign keys are off for this one transaction, so it must not run inside another (the pragma is a no-op
// there): with them on, every deleted message scans the whole table for replies to it (reply_to has no
// index), most of the hold. Each enforced key is handled here instead: other projects' replies are unlinked
// first, observed_exposed goes before exposed, and the test pins the list of foreign keys.
export function deleteRows(store: Store, label: string, counts: Counts): DeleteResult {
  const db = store.db;
  if (db.inTransaction) throw new Error("project-rows: deleteRows runs its own transaction, not inside another");
  const specs = projectTables(db);
  const txn = db.transaction((): { mismatch: Mismatch } | { deleted: Counts; cleared_pins: number; cleared_links: number } => {
    const cur = sourceCounts(db, specs, label, "");
    const mismatch: Mismatch = {};
    for (const k of new Set([...Object.keys(cur), ...Object.keys(counts)]))
      if (cur[k] !== counts[k]) mismatch[k] = { archive: counts[k] ?? 0, now: cur[k] ?? 0 };
    if (Object.keys(mismatch).length) return { mismatch };
    const cleared_links = db.query("UPDATE messages SET reply_to = NULL WHERE project IS NOT ?1 AND reply_to IN (SELECT id FROM messages WHERE project = ?1)")
      .run(label).changes;
    const deleted: Counts = {};
    let cleared_pins = 0;
    for (const sp of specs) {
      if (sp.mode === "clear") cleared_pins = db.query(`UPDATE ${sp.table} SET cleared_at = ${now()} WHERE ${sp.where("")}`).run(...sp.params(label)).changes;
      else deleted[sp.table] = db.query(`DELETE FROM ${sp.table} WHERE ${sp.where("")}`).run(...sp.params(label)).changes;
    }
    return { deleted, cleared_pins, cleared_links };
  });
  // The automatic WAL checkpoint runs inside COMMIT's call but after the write lock is released, so it is
  // held off for this transaction and run by hand (the same passive checkpoint) once held_ms is taken.
  const fk = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
  const ckpt = (db.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number }).wal_autocheckpoint;
  db.run("PRAGMA foreign_keys = OFF");
  db.run("PRAGMA wal_autocheckpoint = 0");
  const t0 = performance.now();
  let out: ReturnType<typeof txn>;
  let held_ms = 0;
  try {
    out = txn.immediate();
    held_ms = Math.round((performance.now() - t0) * 10) / 10;
  } finally {
    if (fk) db.run("PRAGMA foreign_keys = ON");
    db.run(`PRAGMA wal_autocheckpoint = ${Number(ckpt)}`);
  }
  if (ckpt > 0) db.query("PRAGMA wal_checkpoint(PASSIVE)").get();
  if ("mismatch" in out) return { ok: false, mismatch: out.mismatch, held_ms };
  return { ok: true, ...out, rows: Object.values(out.deleted).reduce((a, b) => a + b, 0), held_ms };
}
