// migration-reviews.test.ts — 0032-u4-reviews.sql: observed_reviews on an empty database and on a made-up
// database at the migration before it (rows in every table), which migrates forward without losing a row.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, open, type Row, type Store } from "../../bin/loop/core/store.ts";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "zzmigrev-")); temps.push(d); return d; };
const FILE = "0032-u4-reviews.sql";
const MIGRATIONS = join(import.meta.dir, "../../bin/loop/migrations");
const pk = (db: Database) => (db.query("PRAGMA table_info(observed_reviews)").all() as Row[])
  .filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => c.name);
const tables = (db: Database) => (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[])
  .map((t) => String(t.name));
const counts = (db: Database) => Object.fromEntries(tables(db)
  .map((t) => [t, (db.query(`SELECT COUNT(*) AS n FROM "${t}"`).get() as Row).n]));

// A loop.db at the migration before FILE: the earlier migration files only, then two made-up rows in every
// table (each column a value of its declared type, distinct per row so keys stay unique; a column with a
// CHECK list gets a listed value; the one-row health table, CHECK (id = 1), gets one).
const LISTED: Record<string, string> = { "pause_intents.scope": "squad", "pause_intents.source": "manual", "pause_members.state": "paused" };
function before(root: string): void {
  const dir = join(root, "migrations"); mkdirSync(dir);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < FILE)) copyFileSync(join(MIGRATIONS, f), join(dir, f));
  const db = new Database(join(root, "loop.db"));
  try {
    migrate(db, dir);
    for (const t of tables(db)) {
      if (t === "schema_migrations") continue;
      const cols = db.query(`PRAGMA table_info("${t}")`).all() as Row[];
      for (const i of t === "health" ? [1] : [1, 2]) {
        const vals = cols.map((c) => {
          const ty = String(c.type).toUpperCase();
          return LISTED[`${t}.${c.name}`] ?? (ty.includes("INT") ? i : ty.includes("REAL") || ty.includes("FLOA") ? i + 0.5 : `demo-${c.name}-${i}`);
        });
        db.run(`INSERT INTO "${t}" (${cols.map((c) => `"${c.name}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, vals);
      }
    }
  } finally { db.close(); }
}

describe("0032-u4-reviews", () => {
  test("an empty database gets observed_reviews keyed (project, squad, slug); a second migrate is a no-op", () => {
    const s = open(tmp()); stores.push(s);
    expect(s.migrated.applied).toContain(FILE);
    expect(pk(s.db)).toEqual(["project", "squad", "slug"]);
    s.upsert("observed_reviews", { project: "p", squad: "s", slug: "u" }, { state: "coding", round: 0, observed_at: 1 });
    expect(() => s.db.run("INSERT INTO observed_reviews (project, squad, slug, state, observed_at) VALUES ('p', 's', 'u', 'coding', 2)")).toThrow();
    expect(migrate(s.db).applied).toEqual([]);
    expect((s.db.query("SELECT COUNT(*) AS n FROM observed_reviews").get() as Row).n).toBe(1);
  });

  test("a made-up loop.db at the migration before it migrates forward without losing rows", () => {
    const root = tmp();
    before(root);
    const was = (() => { const db = new Database(join(root, "loop.db"), { readonly: true });
      try { return counts(db); } finally { db.close(); } })();
    expect(was.observed_reviews).toBeUndefined();
    expect(Object.keys(was).length).toBeGreaterThan(30);
    for (const [t, n] of Object.entries(was)) if (t !== "schema_migrations") expect([t, Number(n) > 0]).toEqual([t, true]);
    const s = open(root); stores.push(s);
    expect(s.migrated.applied).toContain(FILE);
    const after = counts(s.db);
    for (const [t, n] of Object.entries(was)) if (t !== "schema_migrations") expect([t, after[t]]).toEqual([t, n]);
    expect(after.observed_reviews).toBe(0);
  });
});
