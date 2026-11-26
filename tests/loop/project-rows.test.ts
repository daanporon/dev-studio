// project-rows.test.ts — remove-project U1: copy one project's loop.db rows to an archive file, verify, delete.
// With DS_ROWS_BENCH_DB set to a copy of a live loop.db (never the live one), it also times the delete for each
// project in it (DS_ROWS_BENCH_LABELS narrows them) and prints the write-lock hold in ms.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { open, ROOT, type Store } from "../../bin/loop/core/store.ts";
import { archiveMeta, BY_KEY, copyRows, deleteRows, KEEP_WITH_PROJECT, KEPT, projectTables, unclassified } from "../../bin/loop/db/project-rows.ts";

const temps: string[] = [], stores: Store[] = [];
const closeAll = () => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
};
afterEach(closeAll);
afterAll(closeAll);

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "zzrows-"));
  temps.push(d);
  return d;
}
function store(): Store {
  const s = open(tmp());
  stores.push(s);
  return s;
}
type Col = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };
const cols = (db: Database, t: string) => db.query(`PRAGMA table_info(${t})`).all() as Col[];
let seq = 0;
// Inserts one row into `t` with every NOT NULL column filled; `set` wins.
function put(db: Database, t: string, set: Record<string, unknown> = {}): number {
  const row: Record<string, unknown> = {};
  for (const c of cols(db, t)) {
    if (c.name in set) { row[c.name] = set[c.name]; continue; }
    if (c.pk && /INT/i.test(c.type)) continue;
    if (!c.notnull && !c.pk) continue;
    if (c.dflt_value != null) continue;
    seq++;
    row[c.name] = /INT|REAL|NUM/i.test(c.type) ? seq : `v${seq}`;
  }
  // A CHECK (col IN ('a', …)) the filler broke names the values it takes: use the first and try again.
  for (let tries = 0; ; tries++) {
    const k = Object.keys(row);
    try {
      const r = db.query(`INSERT INTO ${t} (${k.join(", ")}) VALUES (${k.map(() => "?").join(", ")})`).run(...(k.map((x) => row[x]) as never[]));
      return Number(r.lastInsertRowid);
    } catch (e) {
      const m = /CHECK constraint failed: (\w+) IN \('([^']*)'/.exec(String(e));
      if (!m || m[1] in set || tries > 10) throw e;
      row[m[1]] = m[2];
    }
  }
}
const count = (db: Database, t: string, where = "1", ...p: unknown[]) =>
  (db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`).get(...(p as never[])) as { n: number }).n;
const hasProject = (db: Database, t: string) => cols(db, t).some((c) => c.name === "project");
const projectTablesOf = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((r) => r.name).filter((t) => hasProject(db, t));

// Two projects (`gone` is removed, `stay` is kept) with rows in every table that has a project column,
// the projects rows, an exposed entry with health, and messages replying across the two.
function seedTwo(s: Store) {
  const db = s.db;
  for (const p of ["gone", "stay"]) {
    put(db, "projects", { label: p, observed_at: 1 });
    for (const t of projectTablesOf(db)) {
      put(db, t, { project: p });
      try { put(db, t, { project: p }); } catch (e) { if (!/UNIQUE/.test(String(e))) throw e; }   // a second row where the keys allow one
    }
    const ex = put(db, "exposed", { project: p, url: `http://${p}` });
    put(db, "observed_exposed", { exposed_id: ex });
  }
  const goneMsg = put(db, "messages", { project: "gone" });
  const stayMsg = put(db, "messages", { project: "stay" });
  put(db, "messages", { project: "stay", reply_to: goneMsg });   // another project's reply into `gone`: link cleared
  put(db, "messages", { project: "gone", reply_to: stayMsg });   // `gone`'s reply into `stay`: archived intact
  put(db, "messages", { project: "gone", reply_to: goneMsg });   // a reply inside `gone`: both go in one delete
  return { goneMsg, stayMsg };
}
function tally(db: Database, label: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sp of projectTables(db)) out[sp.table] = count(db, sp.table, sp.where(""), ...sp.params(label));
  return out;
}

describe("project-rows", () => {
  test("every table is classified: a project column, tied by key, or kept with a reason", () => {
    const s = store();
    expect(unclassified(s.db)).toEqual([]);
    for (const t of Object.keys(BY_KEY)) expect(hasProject(s.db, t)).toBe(false);
    for (const t of KEEP_WITH_PROJECT) expect(KEPT[t]).toBeTruthy();
    // A new foreign key into a project table needs a decision too: today only these exist.
    const fks = (s.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).flatMap(({ name }) =>
      (s.db.query(`PRAGMA foreign_key_list(${name})`).all() as { table: string; from: string }[]).map((f) => `${name}.${f.from}->${f.table}`));
    expect(fks.sort()).toEqual(["feedback_notes.draft_id->feedback_drafts", "messages.reply_to->messages", "observed_exposed.exposed_id->exposed"]);
  });

  test("the guard names a table nobody classified", () => {
    const s = store();
    s.db.run("CREATE TABLE zz_new (id INTEGER PRIMARY KEY, label TEXT)");
    expect(unclassified(s.db)).toEqual(["zz_new"]);
  });

  test("copy then delete moves every row of one project and leaves the other alone", () => {
    const s = store(), db = s.db;
    seedTwo(s);
    put(db, "feedback_notes", { project: "gone", draft_id: put(db, "feedback_drafts", { title: "from gone", body: "project gone" }) });
    const gone = tally(db, "gone"), stay = tally(db, "stay");
    const feedback = count(db, "feedback_notes"), goneNotes = count(db, "feedback_notes", "project = 'gone'");
    const keptBefore = Object.fromEntries(Object.keys(KEPT).map((t) => [t, count(db, t)]));
    for (const t of projectTablesOf(db).filter((t) => !(KEEP_WITH_PROJECT as readonly string[]).includes(t))) expect(gone[t]).toBeGreaterThan(0);

    const arc = join(tmp(), "loop-rows.db");
    const c = copyRows(join(s.root, "loop.db"), "gone", arc);
    expect(c.counts).toEqual(gone);
    const r = deleteRows(s, "gone", c.counts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cleared_links).toBe(1);
    expect(r.held_ms).toBeGreaterThanOrEqual(0);

    for (const [t, n] of Object.entries(tally(db, "gone"))) expect([t, n]).toEqual([t, 0]);
    expect(tally(db, "stay")).toEqual(stay);
    expect(count(db, "feedback_notes")).toBe(feedback);
    expect(count(db, "feedback_notes", "project = 'gone'")).toBe(goneNotes);
    expect(goneNotes).toBeGreaterThan(0);
    expect(Object.fromEntries(Object.keys(KEPT).map((t) => [t, count(db, t)]))).toEqual(keptBefore);
    expect(count(db, "messages", "project = 'stay' AND reply_to IS NULL")).toBe(4);
    // The delete runs with foreign keys off: they are back on and nothing dangles.
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("PRAGMA wal_autocheckpoint").get()).toEqual({ wal_autocheckpoint: 1000 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

    const a = new Database(arc, { readonly: true });
    try {
      for (const [t, n] of Object.entries(gone)) expect([t, count(a, t)]).toEqual([t, n]);
      // `gone`'s reply into `stay` keeps its reply_to in the archive.
      expect(count(a, "messages", "reply_to IS NOT NULL")).toBe(2);
      for (const t of Object.keys(gone)) expect(cols(a, t).map((x) => x.name)).toEqual(cols(db, t).map((x) => x.name));
      expect(a.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_autoindex%'").get()).toEqual({ n: 0 });
    } finally { a.close(); }
    expect(archiveMeta(arc)?.label).toBe("gone");
    expect(readdirSync(join(arc, "..")).sort()).toEqual(["loop-rows.db"]);
  });

  test("an exposed entry with health goes without a foreign key error", () => {
    const s = store(), db = s.db;
    const ex = put(db, "exposed", { project: "gone", url: "http://g" });
    put(db, "observed_exposed", { exposed_id: ex });
    const c = copyRows(join(s.root, "loop.db"), "gone", join(tmp(), "loop-rows.db"));
    expect(c.counts.observed_exposed).toBe(1);
    expect(deleteRows(s, "gone", c.counts).ok).toBe(true);
    expect(count(db, "exposed")).toBe(0);
    expect(count(db, "observed_exposed")).toBe(0);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("a row written between copy and delete makes the delete refuse and change nothing", () => {
    const s = store(), db = s.db;
    seedTwo(s);
    const c = copyRows(join(s.root, "loop.db"), "gone", join(tmp(), "loop-rows.db"));
    put(db, "events", { project: "gone" });
    const before = tally(db, "gone");
    const r = deleteRows(s, "gone", c.counts);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mismatch.events).toEqual({ archive: c.counts.events, now: c.counts.events + 1 });
    expect(tally(db, "gone")).toEqual(before);
    expect(count(db, "messages", "reply_to IS NOT NULL")).toBe(3);
  });

  test("an unfinished copy is renamed aside and rewritten, nothing deleted", () => {
    const s = store();
    seedTwo(s);
    const dir = tmp(), arc = join(dir, "loop-rows.db");
    const half = new Database(arc, { create: true });
    half.run("CREATE TABLE events (id INTEGER PRIMARY KEY)");
    half.run("INSERT INTO events (id) VALUES (1)");
    half.close();
    writeFileSync(join(dir, "loop-rows.partial-1.db"), "older");
    const c = copyRows(join(s.root, "loop.db"), "gone", arc);
    expect(c.set_aside).toEqual([join(dir, "loop-rows.partial-2.db")]);
    expect(readdirSync(dir).sort()).toEqual(["loop-rows.db", "loop-rows.partial-1.db", "loop-rows.partial-2.db"]);
    expect(c.counts).toEqual(tally(s.db, "gone"));
    expect(deleteRows(s, "gone", c.counts).ok).toBe(true);
  });

  test("a finished copy for another label is refused; one for this label is set aside, never reused", () => {
    const s = store(), db = s.db;
    seedTwo(s);
    const dir = tmp(), arc = join(dir, "loop-rows.db");
    const first = copyRows(join(s.root, "loop.db"), "stay", arc);
    expect(() => copyRows(join(s.root, "loop.db"), "gone", arc)).toThrow(/already holds the rows of 'stay'/);
    // Same counts, different rows: a reused copy would miss the new row and the delete would lose it.
    const ev = db.query("SELECT id FROM events WHERE project = 'stay' LIMIT 1").get() as { id: number };
    db.run("DELETE FROM events WHERE id = ?", [ev.id]);
    const added = put(db, "events", { project: "stay" });
    const fresh = copyRows(join(s.root, "loop.db"), "stay", arc);
    expect(fresh.set_aside).toEqual([join(dir, "loop-rows.stale-1.db")]);
    expect(fresh.counts).toEqual(first.counts);
    const a = new Database(arc, { readonly: true });
    try { expect(count(a, "events", "id = ?", added)).toBe(1); } finally { a.close(); }
    expect(archiveMeta(join(dir, "loop-rows.stale-1.db"))?.label).toBe("stay");
  });

  test("open pins on the label are archived and closed; another project's pins stay", () => {
    const s = store(), db = s.db;
    const m = put(db, "members", { project: "gone", squad: "sq", role: "builder", wt: "/wt/gone-b" });
    put(db, "members", { project: "stay", squad: "sq", role: "builder", wt: "/wt/stay-b" });
    const pins: [string | null, string][] = [
      ["project", "gone"], ["squad", "gone/sq"], ["role", "gone/builder"], ["member", String(m)], [null, "/wt/gone-b"], ["member", "gone/sq/builder"],
    ];
    for (const [scope, member] of pins) put(db, "overrides", { scope, member, model: "opus" });
    put(db, "overrides", { scope: "member", member: "gone/sq/lead", model: "opus", cleared_at: 5 });   // already closed: not touched
    const keep = [["project", "stay"], ["squad", "stay/sq"], ["project", "gonex"], ["role", "gonex/builder"], ["member", "/wt/stay-b"]];
    for (const [scope, member] of keep) put(db, "overrides", { scope, member, model: "opus" });

    const arc = join(tmp(), "loop-rows.db");
    const c = copyRows(join(s.root, "loop.db"), "gone", arc);
    expect(c.counts.overrides).toBe(pins.length);
    const r = deleteRows(s, "gone", c.counts);
    expect(r.ok && r.cleared_pins).toBe(pins.length);
    expect(count(db, "overrides")).toBe(pins.length + 1 + keep.length);
    expect(count(db, "overrides", "cleared_at IS NULL")).toBe(keep.length);
    expect(count(db, "overrides", "cleared_at IS NULL AND (member LIKE 'stay%' OR member LIKE 'gonex%' OR member = '/wt/stay-b')")).toBe(keep.length);
    expect(count(db, "overrides", "cleared_at = 5")).toBe(1);
    const a = new Database(arc, { readonly: true });
    try { expect(count(a, "overrides", "cleared_at IS NULL")).toBe(pins.length); } finally { a.close(); }
  });
});

// The measured lock hold on a copy of a live loop.db (KTD11): DS_ROWS_BENCH_DB names the copy.
const bench = process.env.DS_ROWS_BENCH_DB;
describe.if(!!bench)("project-rows bench", () => {
  test("refuses the live state root, then times copy and delete per project", () => {
    const path = resolve(bench!);
    const live = [join(ROOT, "state"), process.env.DS_LIVE_STATE_ROOT].filter(Boolean).map((p) => existsSync(p!) ? realpathSync(p!) : resolve(p!));
    const real = realpathSync(path);
    if (live.some((l) => real === join(l, "loop.db") || real.startsWith(`${l}/`))) throw new Error(`bench: ${path} is under the live state root; pass a copy`);
    const dir = tmp();
    copyFileSync(path, join(dir, "loop.db"));
    for (const x of ["-wal"]) if (existsSync(path + x)) copyFileSync(path + x, join(dir, `loop.db${x}`));
    const s = open(dir);
    stores.push(s);
    const want = process.env.DS_ROWS_BENCH_LABELS?.split(",").filter(Boolean)
      ?? (s.db.query("SELECT label FROM projects ORDER BY label").all() as { label: string }[]).map((r) => r.label);
    for (const label of want) {
      const t0 = performance.now();
      const c = copyRows(join(dir, "loop.db"), label, join(dir, `rows-${label}.db`));
      const copyMs = Math.round(performance.now() - t0);
      const r = deleteRows(s, label, c.counts);
      expect(r.ok).toBe(true);
      console.log(`bench ${label}: rows=${c.rows} copy_ms=${copyMs} hold_ms=${r.held_ms}${r.ok ? ` cleared_links=${r.cleared_links} cleared_pins=${r.cleared_pins}` : ""}`);
    }
  }, 600_000);
});
