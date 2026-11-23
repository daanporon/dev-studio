// migrate-paths.test.ts — 0054-worktree-paths.sql (orca-backend-alternatives U5): on a made-up database at
// the migration before it, every worktree-id column gets its folder path, the triggers fill it on every
// later write, and the `worktrees` table holds each known worktree once with the parent nesting.ts wants.
// syncWorktrees() (the observer's statement) agrees with the migration's backfill and writes nothing twice.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { PATH_COLUMNS, pathSql, syncSql, syncWorktrees } from "../../bin/loop/squad/worktrees.ts";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const FILE = "0054-worktree-paths.sql";
const MIGRATIONS = join(import.meta.dir, "../../bin/loop/migrations");
const R = "0b5e0c1a-repo";
const id = (p: string) => `${R}::/w/${p}`;

// A loop.db at the migration before FILE with a made-up project `realp`: a Studio, a live squad `alpha`
// (Lead, Thinker, two Builders, one gone), a closed squad `beta` whose Lead's worktree Orca still lists
// under nothing, an Orca worktree that is no member, and the odd ids the live data holds.
function before(): Store {
  const root = mkdtempSync(join(tmpdir(), "zzmigpath-")); temps.push(root);
  const dir = join(root, "migrations"); mkdirSync(dir);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < FILE)) copyFileSync(join(MIGRATIONS, f), join(dir, f));
  const s = open(root, { migrations: dir }); stores.push(s);
  const run = (sql: string, ...a: (string | number | null)[]) => s.db.run(sql, a);
  run("INSERT INTO projects (label, studio_wt, observed_at) VALUES ('realp', ?, 100)", id("realp-studio"));
  run("INSERT INTO squads (id, project, topic, status, lead_wt, observed_at, updated_at) VALUES (1, 'realp', 'beta', 'closed', ?, 100, 100)", id("beta-lead"));
  run("INSERT INTO squads (id, project, topic, status, lead_wt, observed_at, updated_at) VALUES (2, 'realp', 'alpha', 'running', ?, 100, 100)", id("alpha-lead"));
  const member = (mid: number, squad: string, role: string, suffix: string, wt: string | null, status = "running") =>
    run("INSERT INTO members (id, project, squad, role, suffix, wt, status, since, observed_at, updated_at) VALUES (?, 'realp', ?, ?, ?, ?, ?, 100, 100, 100)", mid, squad, role, suffix, wt, status);
  member(1, "_studio", "studio", "", id("realp-studio"));
  member(2, "beta", "lead", "", id("beta-lead"), "gone");
  member(3, "alpha", "lead", "", id("alpha-lead"));
  member(4, "alpha", "thinker", "", id("alpha-thinker"));
  member(5, "beta", "builder", "u1-first", id("alpha-u1"), "gone");   // an older squad that had the same folder
  member(6, "alpha", "builder", "u2-second", id("alpha-u2"));
  member(7, "alpha", "tester", "", null);   // not started: no worktree
  member(8, "alpha", "builder", "u1-again", id("alpha-u1"));   // the newest member on it wins
  const seen = (p: string, parent: string | null, gone: number | null = null, doc: string | null = null) =>
    run("INSERT INTO observed_worktrees (project, wt, path, branch, doc, observed_at, gone_at, parent) VALUES ('realp', ?, ?, ?, ?, 500, ?, ?)",
      id(p), `/w/${p}`, `b/${p}`, doc, gone, parent === null ? null : id(parent));
  seen("realp-studio", null, null, JSON.stringify({ displayName: "Studio" }));
  seen("beta-lead", null, 400);
  seen("alpha-lead", "realp-studio");
  seen("alpha-thinker", "realp-studio");   // Orca has it at the wrong level: the worktrees row says the Lead
  seen("alpha-u1", "alpha-lead");
  seen("alpha-u2", null);
  seen("scratch", "alpha-lead", null, "not json");
  run("INSERT INTO units (project, squad, slug, status, builder_wt, observed_at, updated_at) VALUES ('realp', 'alpha', 'u1-first', 'done', ?, 1, 1), ('realp', 'alpha', 'u3-x', 'planned', '', 1, 1), ('realp', 'alpha', 'u4-y', 'planned', 'wt_a', 1, 1)", id("alpha-u1"));
  run("INSERT INTO observed_reviews (project, squad, slug, wt, state, observed_at) VALUES ('realp', 'alpha', 'u2-second', '/w/alpha-u2', 'running', 1)");
  run("INSERT INTO questions (id, project, squad, card_wt, title) VALUES ('q1', 'realp', 'alpha', ?, 't')", id("alpha-thinker"));
  return s;
}
const after = (s: Store) => { migrate(s.db); return s; };
const wts = (db: Database) => db.query("SELECT host, path, project, name, parent_path, branch, squad, role, provider, orca_id, gone_at FROM worktrees ORDER BY path").all() as Row[];
const wt = (db: Database, p: string) => db.query("SELECT * FROM worktrees WHERE path = ?").get(`/w/${p}`) as Row;

describe("migration 0054: path columns", () => {
  test("every worktree id gets its folder path; a plain path stays, anything else is NULL", () => {
    const s = after(before());
    for (const [t, col, p] of PATH_COLUMNS) {
      const miss = s.db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE (${col} LIKE '%::%' OR ${col} LIKE '/%') AND ${p} IS NULL`).get() as Row;
      expect([t, miss.n]).toEqual([t, 0]);
    }
    expect(s.db.query("SELECT wt_path FROM members WHERE id = 6").get()).toEqual({ wt_path: "/w/alpha-u2" });
    expect(s.db.query("SELECT studio_path FROM projects").get()).toEqual({ studio_path: "/w/realp-studio" });
    expect(s.db.query("SELECT lead_path FROM squads ORDER BY id").all()).toEqual([{ lead_path: "/w/beta-lead" }, { lead_path: "/w/alpha-lead" }]);
    expect(s.db.query("SELECT parent_path FROM observed_worktrees WHERE path = '/w/alpha-u1'").get()).toEqual({ parent_path: "/w/alpha-lead" });
    expect(s.db.query("SELECT wt_path FROM observed_reviews").get()).toEqual({ wt_path: "/w/alpha-u2" });
    expect(s.db.query("SELECT card_path FROM questions").get()).toEqual({ card_path: "/w/alpha-thinker" });
    expect(s.db.query("SELECT builder_wt, builder_path FROM units ORDER BY slug").all()).toEqual([
      { builder_wt: id("alpha-u1"), builder_path: "/w/alpha-u1" }, { builder_wt: "", builder_path: null }, { builder_wt: "wt_a", builder_path: null }]);
    expect(s.db.query("SELECT wt_path FROM members WHERE id = 7").get()).toEqual({ wt_path: null });
  });

  test("every writer fills both: an insert, an upsert and a change of the id set the path; a clear clears it", () => {
    const s = after(before());
    s.db.run("INSERT INTO members (id, project, squad, role, wt, observed_at, updated_at) VALUES (9, 'realp', 'alpha', 'reviewer', ?, 1, 1)", [id("alpha-rev")]);
    expect(s.db.query("SELECT wt_path FROM members WHERE id = 9").get()).toEqual({ wt_path: "/w/alpha-rev" });
    s.upsert("observed_workers", { project: "realp", wt: id("alpha-rev") }, { observed_at: 1 });
    expect(s.db.query("SELECT wt_path FROM observed_workers").get()).toEqual({ wt_path: "/w/alpha-rev" });
    s.db.run("UPDATE members SET wt = ? WHERE id = 7", [id("alpha-tester")]);
    expect(s.db.query("SELECT wt_path FROM members WHERE id = 7").get()).toEqual({ wt_path: "/w/alpha-tester" });
    s.db.run("UPDATE squads SET lead_wt = ? WHERE id = 2", [id("alpha-lead2")]);
    expect(s.db.query("SELECT lead_path FROM squads WHERE id = 2").get()).toEqual({ lead_path: "/w/alpha-lead2" });
    s.db.run("UPDATE squads SET lead_wt = NULL WHERE id = 2");
    expect(s.db.query("SELECT lead_path FROM squads WHERE id = 2").get()).toEqual({ lead_path: null });
    // A writer that sets the path itself keeps it (a later non-Orca provider, U11).
    s.db.run("INSERT INTO members (id, project, squad, role, wt, wt_path, observed_at, updated_at) VALUES (10, 'realp', 'alpha', 'builder', 'local::/x', '/x', 1, 1)");
    expect(s.db.query("SELECT wt_path FROM members WHERE id = 10").get()).toEqual({ wt_path: "/x" });
    // Every pair has both triggers.
    const trig = new Set((s.db.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Row[]).map((r) => String(r.name)));
    for (const [t, , p] of PATH_COLUMNS) for (const k of ["ins", "upd"]) expect(trig.has(`${t}_${p}_${k}`)).toBe(true);
  });

  test("the migration's SQL is the module's: each pathSql and the sync statement", () => {
    const sql = readFileSync(join(MIGRATIONS, FILE), "utf8");
    for (const [t, col, p] of PATH_COLUMNS) {
      expect(sql).toContain(`ALTER TABLE ${t} ADD COLUMN ${p} TEXT;`);
      expect(sql).toContain(`UPDATE ${t} SET ${p} = ${pathSql(col)} WHERE ${col} IS NOT NULL;`);
    }
    expect(sql).toContain(syncSql("unixepoch()"));
  });
});

describe("migration 0054: the worktrees table", () => {
  test("each known worktree once, its parent the one nesting.ts wants, its squad and role from the newest member", () => {
    const s = after(before());
    const db = s.db;
    expect(wts(db).map((r) => r.path)).toEqual(["/w/alpha-lead", "/w/alpha-thinker", "/w/alpha-u1", "/w/alpha-u2", "/w/beta-lead", "/w/realp-studio", "/w/scratch"]);
    // nesting.ts, for each standing member: the Lead under the Studio, every other member under its squad's
    // Lead, the Studio under nothing.
    const members = db.query("SELECT m.role, m.wt_path, s.lead_path FROM members m LEFT JOIN squads s ON s.project = m.project AND s.topic = m.squad WHERE m.wt_path IS NOT NULL AND m.status != 'gone'").all() as Row[];
    expect(members.length).toBe(5);
    const studio = (db.query("SELECT studio_path FROM projects WHERE label = 'realp'").get() as Row).studio_path;
    for (const m of members) {
      const want = m.role === "studio" ? null : m.role === "lead" ? studio : m.lead_path;
      expect([m.wt_path, wt(db, String(m.wt_path).slice(3)).parent_path]).toEqual([m.wt_path, want]);
    }
    expect(wt(db, "alpha-thinker").parent_path).toBe("/w/alpha-lead");   // not Orca's /w/realp-studio
    expect(wt(db, "alpha-u2").parent_path).toBe("/w/alpha-lead");        // Orca has none
    expect(wt(db, "scratch")).toMatchObject({ parent_path: "/w/alpha-lead", squad: null, role: null, name: "scratch" });
    expect(wt(db, "alpha-u1")).toMatchObject({ squad: "alpha", role: "builder-u1-again", branch: "b/alpha-u1", gone_at: null });
    expect(wt(db, "realp-studio")).toMatchObject({ squad: "_studio", role: "studio", name: "Studio", parent_path: null });
    expect(wt(db, "beta-lead")).toMatchObject({ squad: "beta", role: "lead", parent_path: "/w/realp-studio", gone_at: 400 });
    for (const r of wts(db)) expect(r).toMatchObject({ host: "local", provider: "orca", project: "realp", orca_id: `${R}::${r.path}` });
    expect((db.query("SELECT COUNT(*) AS n FROM worktrees WHERE created_at IS NULL").get() as Row).n).toBe(0);
  });

  test("syncWorktrees agrees with the backfill, writes nothing twice, and follows later facts", () => {
    const s = after(before());
    const fresh = after(before());
    fresh.db.run("DELETE FROM worktrees");
    expect(syncWorktrees(fresh, 900)).toBe(7);
    expect(wts(fresh.db)).toEqual(wts(s.db));
    expect(syncWorktrees(s, 900)).toBe(0);

    s.db.run("INSERT INTO members (id, project, squad, role, suffix, wt, observed_at, updated_at) VALUES (11, 'realp', 'alpha', 'builder', 'u5-z', ?, 1, 1)", [id("alpha-u5")]);
    s.db.run("UPDATE observed_worktrees SET gone_at = 950 WHERE path = '/w/alpha-u2'");
    s.db.run("INSERT INTO worktrees (path, project, provider, created_at) VALUES ('/w/alpha-thinker-copy', 'realp', 'git', 1)");
    s.db.run("UPDATE worktrees SET provider = 'git' WHERE path = '/w/scratch'");
    expect(syncWorktrees(s, 1000)).toBe(2);
    expect(wt(s.db, "alpha-u5")).toMatchObject({ role: "builder-u5-z", parent_path: "/w/alpha-lead", created_at: 1000, branch: null });
    expect(wt(s.db, "alpha-u2").gone_at).toBe(950);
    expect(wt(s.db, "alpha-u1").created_at).not.toBe(1000);              // set once, on insert
    expect(wt(s.db, "scratch")).toMatchObject({ provider: "git" });      // another provider's row is left alone
    expect(syncWorktrees(s, 1100)).toBe(0);

    // The Lead moves: its members' parents follow.
    s.db.run("UPDATE squads SET lead_wt = ? WHERE id = 2", [id("alpha-lead2")]);
    syncWorktrees(s, 1200);
    expect(wt(s.db, "alpha-thinker").parent_path).toBe("/w/alpha-lead2");
  });

  test("a non-Orca member (local::) is not the sync's to record", () => {
    const s = after(before());
    s.db.run("INSERT INTO members (id, project, squad, role, wt, observed_at, updated_at) VALUES (12, 'realp', 'alpha', 'builder', 'local::/w/alpha-local', 1, 1)");
    expect(syncWorktrees(s, 1000)).toBe(0);
    expect(s.db.query("SELECT 1 FROM worktrees WHERE path = '/w/alpha-local'").get()).toBeNull();
  });
});
