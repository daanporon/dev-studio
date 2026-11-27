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
//
// The big log tables (LOG_TABLES) would hold the write lock for seconds, so after the verified copy they are
// deleted first, in short batches (U6): deleteLogBatch deletes only rows the archive holds identically at the
// same rowid (a rowid bound is not enough: SQLite gives a deleted newest rowid to the next row), and
// deleteRows then expects none of them. Once a batch ran, the archive holds rows loop.db no longer does, so it
// is never rewritten: a later change is added to it with appendRows. Every copy keeps each row's rowid.
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
  account_folders: "each login's folder per host, not a project's",
  health: "the loop process's own health",
  hosts: "host-wide list of side hosts and their public keys (side-loop-host U1)",
  link_shipped: "a side host's record of the observed rows it last sent main over the link (side-loop-host U6)",
  host_config: "per-host overrides of the machine keys, by host not project (side-loop-host U25)",
  side_link: "a side host's own clock of its link to main (side-loop-host U14)",
  observed_accounts: "host-wide account usage",
  observed_account_folders: "login folders each host's scan found",
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

// The tables deleted in batches, each with the column that names a row across an update (null: never
// updated), which is how appendRows tells a changed row from a new one on a reused rowid.
export const LOG_TABLES = ["events", "orca_calls", "relayed"] as const;
export type LogTable = (typeof LOG_TABLES)[number];
const SAME_ROW: Record<LogTable, string | null> = { events: null, orca_calls: "retry_id", relayed: "msg_id" };

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

const tableSql = (db: Database, table: string, schema: string) =>
  (db.query(`SELECT sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string }).sql;
const migrationsOf = (db: Database, schema: string) =>
  (db.query(`SELECT filename FROM ${schema}.schema_migrations ORDER BY filename`).all() as { filename: string }[]).map((r) => r.filename);

// The columns a copy lists so each row keeps its rowid: an INTEGER PRIMARY KEY is the rowid already, any
// other rowid table names it too (`SELECT *` would number the rows anew).
function copyColumns(db: Database, table: string, schema: string): string[] {
  const info = db.query(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string; type: string; pk: number }[];
  const names = info.map((c) => `"${c.name}"`);
  const pk = info.filter((c) => c.pk);
  const keyed = (pk.length === 1 && pk[0].type.toUpperCase() === "INTEGER") || /\bWITHOUT\s+ROWID\b/i.test(tableSql(db, table, schema));
  return keyed ? names : ["rowid", ...names];
}
// Every column of rows `a` and `b` equal, NULLs too.
const identical = (db: Database, table: string, schema: string, a: string, b: string) =>
  columns(db, table, schema).map((c) => `${a}."${c}" IS ${b}."${c}"`).join(" AND ");

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

// The (latest) finish mark of an archive file, or null when the file holds none (an unfinished copy).
export function archiveMeta(path: string): Meta | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'removed_meta'").get()) return null;
    const r = db.query("SELECT * FROM removed_meta WHERE finished_at IS NOT NULL ORDER BY rowid DESC LIMIT 1").get() as Record<string, unknown> | null;
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
    const migrations = migrationsOf(arc, "src");
    const counts = arc.transaction(() => {
      const before = sourceCounts(arc, specs, label, "src.");
      for (const sp of specs) {
        arc.run(tableSql(arc, sp.table, "src"));
        const cols = copyColumns(arc, sp.table, "src").join(", ");
        arc.query(`INSERT INTO main.${sp.table} (${cols}) SELECT ${cols} FROM src.${sp.table} WHERE ${sp.where("src.")}`).run(...sp.params(label));
      }
      const after: Counts = {};
      for (const sp of specs) after[sp.table] = (arc.query(`SELECT COUNT(*) AS n FROM main.${sp.table}`).get() as { n: number }).n;
      if (!sameCounts(before, after)) throw new Error(`project-rows: archive counts ${JSON.stringify(after)} differ from the source's ${JSON.stringify(before)}`);
      arc.run("CREATE TABLE removed_meta (label TEXT NOT NULL, removed_at INTEGER NOT NULL, migrations TEXT NOT NULL, counts TEXT NOT NULL, finished_at INTEGER)");
      finishMark(arc, label, migrations, after);
      return after;
    })();
    arc.run("DETACH DATABASE src");
    return { archive: archivePath, counts, rows: Object.values(counts).reduce((a, b) => a + b, 0), set_aside: setAsideList };
  } finally {
    arc.close();
  }
}

function finishMark(arc: Database, label: string, migrations: string[], counts: Counts): void {
  const at = now();
  arc.run("INSERT INTO removed_meta (label, removed_at, migrations, counts, finished_at) VALUES (?, ?, ?, ?, ?)",
    [label, at, JSON.stringify(migrations), JSON.stringify(counts), at]);
}

export type AppendResult = { archive: string; counts: Counts; source: Counts; rows: number; added: number };

// Adds to the label's finished archive every row of loop.db it does not hold identically, in one transaction,
// with another `removed_meta` entry when it added any. A row changed since it was copied takes its newer version. No archived log
// row is lost: one whose rowid loop.db gave to another row moves to a free rowid. Other tables, still whole in
// loop.db, keep what they held except where a row there now has the same key or rowid.
// `counts` are the archive's totals now, `source` loop.db's rows of the label in the same snapshot.
export function appendRows(dbPath: string, label: string, archivePath: string): AppendResult {
  if (!existsSync(archivePath)) throw new Error(`project-rows: no archive at ${archivePath} to add to`);
  // Read and write, so a journal a crash left is rolled back before anything is read.
  const arc = new Database(archivePath, { readwrite: true });
  try {
    arc.run("PRAGMA busy_timeout = 5000");
    arc.run("PRAGMA foreign_keys = OFF");
    const held = (arc.query("SELECT label FROM removed_meta WHERE finished_at IS NOT NULL LIMIT 1").get() as { label: string } | null)?.label;
    if (held !== label) throw new Error(`project-rows: ${archivePath} is not a finished archive of '${label}'`);
    arc.run("ATTACH DATABASE ? AS src", [dbPath]);
    const specs = projectTables(arc, "src");
    const migrations = migrationsOf(arc, "src");
    const out = arc.transaction(() => {
      const source = sourceCounts(arc, specs, label, "src.");
      const counts: Counts = {};
      let added = 0;
      for (const sp of specs) {
        const t = sp.table;
        if (!tables(arc).includes(t)) arc.run(tableSql(arc, t, "src"));
        const cols = copyColumns(arc, t, "src");
        const missing = `${sp.where("src.")} AND NOT EXISTS (SELECT 1 FROM main.${t} AS a WHERE a.rowid = s.rowid AND ${identical(arc, t, "src", "a", "s")})`;
        const strays = (arc.query(`SELECT s.rowid AS r FROM src.${t} AS s WHERE ${missing}`).all(...sp.params(label)) as { r: number }[]).map((x) => x.r);
        if ((LOG_TABLES as readonly string[]).includes(t) && strays.length) {
          const key = SAME_ROW[t as LogTable];
          const taken = arc.query(`SELECT 1 FROM main.${t} AS a JOIN src.${t} AS s ON s.rowid = a.rowid WHERE a.rowid = ?${key ? ` AND a.${key} IS NOT s.${key}` : ""}`);
          const top = arc.query(`SELECT MAX(COALESCE((SELECT MAX(rowid) FROM main.${t}), 0), COALESCE((SELECT MAX(rowid) FROM src.${t}), 0)) AS n`);
          const move = arc.query(`UPDATE main.${t} SET rowid = ? WHERE rowid = ?`);
          for (const r of strays) if (taken.get(r)) move.run((top.get() as { n: number }).n + 1, r);
        }
        const insert = arc.query(`INSERT OR REPLACE INTO main.${t} (${cols.join(", ")}) SELECT ${cols.join(", ")} FROM src.${t} WHERE rowid = ?`);
        for (const r of strays) insert.run(r);
        added += strays.length;
        counts[t] = (arc.query(`SELECT COUNT(*) AS n FROM main.${t}`).get() as { n: number }).n;
      }
      // Nothing added: the latest entry still holds.
      if (added) finishMark(arc, label, migrations, counts);
      return { counts, source, added };
    })();
    arc.run("DETACH DATABASE src");
    return { archive: archivePath, ...out, rows: Object.values(out.counts).reduce((a, b) => a + b, 0) };
  } finally {
    arc.close();
  }
}

// Runs one write transaction and times its write-lock hold. The automatic WAL checkpoint runs inside COMMIT's
// call but after the lock is released, so it is held off and run by hand (the same passive one) afterwards.
function timed<T>(db: Database, txn: () => T): { out: T; held_ms: number } {
  const ckpt = (db.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number }).wal_autocheckpoint;
  db.run("PRAGMA wal_autocheckpoint = 0");
  let out: T, held_ms = 0;
  const t0 = performance.now();
  try {
    out = txn();
    held_ms = Math.round((performance.now() - t0) * 10) / 10;
  } finally {
    db.run(`PRAGMA wal_autocheckpoint = ${Number(ckpt)}`);
  }
  if (ckpt > 0) db.query("PRAGMA main.wal_checkpoint(PASSIVE)").get();
  return { out, held_ms };
}

export type Batch = { deleted: number; held_ms: number; next: number | null };

// Deletes up to `limit` of the label's rows of one log table that the archive holds identically at the same
// rowid, in one immediate transaction. The rows are picked before the lock is taken, walking the archive from
// rowid `after`, and checked again inside it. `next` is the `after` of the following batch, null when the
// archive has no further row to delete; starting again from 0 is safe and finds what is left.
export function deleteLogBatch(store: Store, label: string, archivePath: string, table: LogTable, limit: number, after = 0): Batch {
  const db = store.db;
  if (db.inTransaction) throw new Error("project-rows: deleteLogBatch runs its own transaction, not inside another");
  if (!(LOG_TABLES as readonly string[]).includes(table)) throw new Error(`project-rows: ${table} is not deleted in batches`);
  // ATTACH would make a missing file.
  if (!existsSync(archivePath)) throw new Error(`project-rows: no archive at ${archivePath}`);
  db.run("ATTACH DATABASE ? AS arc", [archivePath]);
  try {
    const held = (db.query("SELECT label FROM arc.removed_meta WHERE finished_at IS NOT NULL LIMIT 1").get() as { label: string } | null)?.label;
    if (held !== label) throw new Error(`project-rows: ${archivePath} is not a finished archive of '${label}'`);
    const same = identical(db, table, "main", "a", "s");
    // CROSS JOIN keeps the archive outer, so a batch costs its own rows, not a scan of the whole log.
    const ids = (db.query(`SELECT a.rowid AS r FROM arc.${table} AS a CROSS JOIN main.${table} AS s ON s.rowid = a.rowid
      WHERE a.rowid > ?1 AND s.project = ?2 AND ${same} ORDER BY a.rowid LIMIT ?3`).all(after, label, limit) as { r: number }[]).map((x) => x.r);
    if (!ids.length) return { deleted: 0, held_ms: 0, next: null };
    // `+` keeps the project index out of it: the lock is held for the listed rowids, not for all the label's rows.
    const del = db.query(`DELETE FROM main.${table} AS s WHERE s.rowid IN (SELECT value FROM json_each(?2)) AND +s.project = ?1
      AND EXISTS (SELECT 1 FROM arc.${table} AS a WHERE a.rowid = s.rowid AND ${same})`);
    const txn = db.transaction(() => del.run(label, JSON.stringify(ids)).changes);
    const r = timed(db, () => txn.immediate());
    return { deleted: r.out, held_ms: r.held_ms, next: ids.length < limit ? null : ids[ids.length - 1] };
  } finally {
    db.run("DETACH DATABASE arc");
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
      // A table with no row of the label (the log tables, after their batches) is not scanned again.
      else deleted[sp.table] = cur[sp.table] ? db.query(`DELETE FROM ${sp.table} WHERE ${sp.where("")}`).run(...sp.params(label)).changes : 0;
    }
    return { deleted, cleared_pins, cleared_links };
  });
  const fk = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
  db.run("PRAGMA foreign_keys = OFF");
  let r: { out: ReturnType<typeof txn>; held_ms: number };
  try {
    r = timed(db, () => txn.immediate());
  } finally {
    if (fk) db.run("PRAGMA foreign_keys = ON");
  }
  const { out, held_ms } = r;
  if ("mismatch" in out) return { ok: false, mismatch: out.mismatch, held_ms };
  return { ok: true, ...out, rows: Object.values(out.deleted).reduce((a, b) => a + b, 0), held_ms };
}
