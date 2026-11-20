// short-write-lock.test.ts — U243: the loop's pick step reads outside the write lock, and opening an
// up-to-date store takes no write lock at all.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate, open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { accountRows } from "../../bin/loop/db/import-json.ts";
import { reconcile } from "../../bin/loop/capacity/picks.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [], extra: Database[] = [];
afterEach(() => {
  for (const d of extra.splice(0)) { try { d.close(); } catch { /* closed */ } }
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function root(): string { const d = mkdtempSync(join(tmpdir(), "zzloop-")); temps.push(d); return d; }
function fixture(): { s: Store; d: string } {
  const d = root(), conv = root();
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  mkdirSync(join(d, "fx", "squads"), { recursive: true });
  copyFileSync(join(ROOT, "tests", "fixtures", "loop", "accounts.tsv"), join(d, "accounts.tsv"));
  const s = open(d);
  stores.push(s);
  importConfig(s, d, conv);
  for (const r of accountRows(d)) s.upsert(r.table, r.key, r.set);
  return { s, d };
}
function member(s: Store, set: Row): number {
  const row: Row = { project: "fx", squad: "demo", role: "builder", suffix: "", observed_at: T, updated_at: T, want: "running", want_at: T, tier: "hard", ...set };
  const ks = Object.keys(row);
  return Number(s.db.run(`INSERT INTO members (${ks.join(", ")}) VALUES (${ks.map(() => "?").join(", ")})`, ks.map((k) => row[k] as string | number | null)).lastInsertRowid);
}
const ctx = (store: Store): TickCtx => ({ store, now: T } as unknown as TickCtx);
const second = (d: string, ms: number): Database => { const c = new Database(join(d, "loop.db")); c.run(`PRAGMA busy_timeout = ${ms}`); extra.push(c); return c; };

describe("U243 pick step", () => {
  test("every read of the walk runs outside the write transaction; the picks are written", () => {
    const { s } = fixture();
    for (let i = 0; i < 3; i++) member(s, { suffix: `w${i}` });
    const q = s.db.query.bind(s.db);
    const readsInTx: string[] = [];
    let txWrites = 0;
    (s.db as unknown as { query: unknown }).query = (sql: string) => {
      if (s.db.inTransaction && /FROM (episodes|orca_calls|units|picks|overrides)\b/.test(sql) && !/^\s*SELECT \* FROM picks\s*$/.test(sql) && !/rowid AS _rowid/.test(sql)) readsInTx.push(sql.slice(0, 80));
      return q(sql);
    };
    const run = s.db.run.bind(s.db);
    (s.db as unknown as { run: unknown }).run = (sql: string, ...p: never[]) => { if (s.db.inTransaction && /picks/.test(sql)) txWrites++; return run(sql, ...p); };
    const go = reconcile(ctx(s));
    expect(readsInTx).toEqual([]);
    expect(txWrites).toBeGreaterThan(0);
    expect(go.size).toBe(3);
    const rows = s.db.query("SELECT member, slot FROM picks ORDER BY member").all() as Row[];
    expect(rows.map((r) => r.slot)).toEqual([1, 1, 1]);
    expect(s.db.query("SELECT name FROM sqlite_temp_master WHERE name = 'picks'").get()).toBeNull();
  });

  test("another writer takes the write lock while the walk runs", () => {
    const { s, d } = fixture();
    member(s, { suffix: "w1" });
    const other = second(d, 1000);
    const q = s.db.query.bind(s.db);
    let probed = false;
    (s.db as unknown as { query: unknown }).query = (sql: string) => {
      if (!probed && !s.db.inTransaction && /SELECT tier FROM units WHERE project/.test(sql)) {   // a read of the walk
        probed = true;
        const t0 = Date.now();
        other.run("BEGIN IMMEDIATE"); other.run("COMMIT");
        expect(Date.now() - t0).toBeLessThan(500);
      }
      return q(sql);
    };
    reconcile(ctx(s));
    expect(probed).toBe(true);
  });
});

describe("U243 migrate", () => {
  test("an up-to-date store opens while another connection holds the write lock", () => {
    const { d } = fixture();
    const holder = second(d, 100);
    holder.run("BEGIN IMMEDIATE");
    const t0 = Date.now();
    const s = open(d);
    stores.push(s);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(s.migrated.applied).toEqual([]);
    expect(s.migrated.all.length).toBe(readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).length);
    holder.run("ROLLBACK");
  });

  test("a pending migration waits for the lock, then applies once", () => {
    const { s, d } = fixture();
    const dir = root();
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql"))) copyFileSync(join(MIGRATIONS, f), join(dir, f));
    writeFileSync(join(dir, "9999_u243.sql"), "CREATE TABLE u243_probe (a INTEGER);");
    const db = second(d, 150);
    const holder = second(d, 100);
    holder.run("BEGIN IMMEDIATE");
    expect(() => migrate(db, dir)).toThrow();          // the pending file needs the lock
    holder.run("ROLLBACK");
    expect(migrate(db, dir).applied).toEqual(["9999_u243.sql"]);
    expect(migrate(db, dir).applied).toEqual([]);
    expect(s.db.query("SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '9999_u243.sql'").get()).toEqual({ n: 1 });
  });
});
